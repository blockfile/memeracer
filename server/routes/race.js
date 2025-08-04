require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const bs58 = require("bs58"); // pinned to 4.x for .decode
const RaceResult = require("../models/RaceResult");
const PendingRace = require("../models/PendingRace");
const User = require("../models/User");
const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
} = require("@solana/web3.js");

const RAW_PROBS = { 5: 0.05, 4: 0.1, 3: 0.3, 2: 0.7 };
const racers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  { commitment: "confirmed" }
);

// Cache treasury keypair after decode
let _treasuryKeypair = null;
function getTreasuryKeypair() {
  if (_treasuryKeypair) return _treasuryKeypair;
  const raw = process.env.TREASURY_PRIVATE_KEY;
  if (!raw) {
    console.warn("TREASURY_PRIVATE_KEY not set; skipping on-chain payouts.");
    return null;
  }
  try {
    let secretKey;
    if (raw.trim().startsWith("[")) {
      secretKey = Uint8Array.from(JSON.parse(raw));
    } else {
      secretKey = bs58.decode(raw.trim());
    }
    _treasuryKeypair = Keypair.fromSecretKey(secretKey);
    return _treasuryKeypair;
  } catch (e) {
    console.error("Failed to decode TREASURY_PRIVATE_KEY:", e);
    return null;
  }
}

function getWeightForMultiplier(m) {
  return Math.pow(RAW_PROBS[m] || 0, 2);
}
function getRaceMultipliers() {
  const pool = [5, 4, 3, 2, 2];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const m = {};
  racers.forEach((name, i) => {
    m[name] = pool[i];
  });
  return m;
}

// GET or create upcoming pending race
router.get("/next", async (req, res) => {
  try {
    let pending = await PendingRace.findOne().sort({ createdAt: -1 });
    if (!pending) {
      const raceId = `race_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 8)}`;
      const multipliers = getRaceMultipliers();
      pending = new PendingRace({ raceId, multipliers });
      await pending.save();
    }
    res.json({
      raceId: pending.raceId,
      multipliers: Object.fromEntries(pending.multipliers),
    });
  } catch (e) {
    console.error("Failed to get/create next race", e);
    res.status(500).json({ error: "Failed to get next race" });
  }
});

// CREATE pending race
router.post("/init", async (req, res) => {
  try {
    const { raceId, multipliers } = req.body;
    if (!raceId || !multipliers)
      return res.status(400).json({ error: "Missing data" });

    let pending = await PendingRace.findOne({ raceId });
    if (pending) {
      return res.json({
        raceId,
        multipliers: Object.fromEntries(pending.multipliers),
      });
    }
    pending = new PendingRace({ raceId, multipliers });
    await pending.save();
    res.status(201).json({
      raceId,
      multipliers,
    });
  } catch (e) {
    console.error("Failed to init race", e);
    res.status(500).json({ error: "Failed to init race" });
  }
});

// GET multipliers
router.get("/init/:raceId", async (req, res) => {
  try {
    const pending = await PendingRace.findOne({ raceId: req.params.raceId });
    if (!pending) return res.status(404).json({ error: "Not found" });
    res.json({
      raceId: pending.raceId,
      multipliers: Object.fromEntries(pending.multipliers),
    });
  } catch (e) {
    console.error("Error fetching multipliers:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// Submit a bet (verify on-chain transfer to hardcoded wallet)
router.post("/bet/submit", async (req, res) => {
  try {
    const {
      bettorWallet,
      targetName,
      amount,
      txSignature,
      raceId,
      multiplier,
    } = req.body;
    if (
      !bettorWallet ||
      !targetName ||
      amount == null ||
      !txSignature ||
      !raceId ||
      multiplier == null
    ) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const HARDCODED_TREASURY =
      "6nE2nkQ4RzHaSx5n2MMBW5f9snevNs8wLBzLmLyrTCnu";

    const txDetails = await connection.getTransaction(txSignature, {
      commitment: "confirmed",
    });
    if (!txDetails)
      return res.status(400).json({ error: "Transaction not found" });
    if (txDetails.meta?.err)
      return res.status(400).json({ error: "Transaction failed" });

    const lamportsSent = Math.round(amount * 1e9);
    const accountKeys = txDetails.transaction.message.accountKeys.map((k) =>
      k.toString()
    );
    const treasuryIndex = accountKeys.indexOf(HARDCODED_TREASURY);
    if (treasuryIndex === -1)
      return res
        .status(400)
        .json({ error: "Expected recipient not in tx" });

    const preBalances = txDetails.meta.preBalances;
    const postBalances = txDetails.meta.postBalances;
    const delta = postBalances[treasuryIndex] - preBalances[treasuryIndex];
    if (delta < lamportsSent) {
      return res
        .status(400)
        .json({ error: "Insufficient amount sent to hardcoded wallet" });
    }

    if (req.io) {
      req.io.emit("betPlaced", {
        raceId,
        bettorWallet,
        targetName,
        amount,
        txSignature,
        multiplier,
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error("Bet submit error:", e);
    res.status(500).json({ error: "Internal error submitting bet" });
  }
});

// Payout winners on-chain and annotate payoutTxSignature
async function payOutWinnersOnchain(raceResult, io) {
  const treasury = getTreasuryKeypair();
  if (!treasury) {
    console.warn("Skipping on-chain payout: treasury keypair missing.");
    return;
  }

  const payoutsByWallet = {};
  for (const bet of raceResult.bets) {
    if (bet.won && bet.payout > 0) {
      const w = bet.bettorWallet;
      payoutsByWallet[w] = (payoutsByWallet[w] || 0) + bet.payout;
    }
  }

  for (const [bettorWallet, totalPayout] of Object.entries(payoutsByWallet)) {
    try {
      console.log(
        `Payout ${totalPayout} SOL to ${bettorWallet} (aggregated winning amount)`
      );
      const toPubkey = new PublicKey(bettorWallet);
      const lamports = Math.round(totalPayout * 1e9);

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: treasury.publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey,
          lamports,
        })
      );
      tx.sign(treasury);
      const raw = tx.serialize();
      const signature = await connection.sendRawTransaction(raw);
      await connection.confirmTransaction(signature, "confirmed");

      console.log(
        `Paid out ${totalPayout} SOL to ${bettorWallet} sig=${signature}`
      );

      let updated = false;
      raceResult.bets = raceResult.bets.map((bet) => {
        if (bet.bettorWallet === bettorWallet && bet.won && bet.payout > 0) {
          if (!bet.payoutTxSignature) {
            bet.payoutTxSignature = signature;
            updated = true;
          }
        }
        return bet;
      });
      if (updated) {
        await raceResult.save();
      }

      if (io) {
        io.emit("payout", {
          wallet: bettorWallet,
          amount: totalPayout,
          signature,
        });
      }
    } catch (e) {
      console.error(
        `Failed to payout ${totalPayout} SOL to ${bettorWallet}:`,
        e
      );
    }
  }
}

// Submit final race result, update balances, persist, and payout winners
router.post("/result", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { raceId, multipliers, winner, losers = [], bets = [] } = req.body;
    if (!raceId || !multipliers || !winner || !bets) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ error: "Missing required fields" });
    }

    let existing = await RaceResult.findOne({ raceId }).session(session);
    if (existing) {
      await session.commitTransaction();
      return res.status(200).json({
        message: "Already recorded",
        raceResult: existing,
      });
    }

    // Update token balances
    for (const bet of bets) {
      const { bettorWallet, amount, payout, won } = bet;
      let user = await User.findOne({ walletAddress: bettorWallet }).session(
        session
      );
      if (!user) {
        user = new User({ walletAddress: bettorWallet, tokenBalance: 0 });
      }
      if (won) user.tokenBalance = (user.tokenBalance || 0) + payout;
      else user.tokenBalance = Math.max((user.tokenBalance || 0) - amount, 0);
      await user.save({ session });
    }

    const raceResult = new RaceResult({
      raceId,
      multipliers,
      winner: {
        name: winner.name,
        walletAddress: winner.walletAddress,
        multiplier: winner.multiplier,
      },
      losers,
      bets,
    });

    await raceResult.save({ session });
    await PendingRace.deleteOne({ raceId }).session(session);

    await session.commitTransaction();

    if (req.io) {
      req.io.emit("raceResult", { raceResult });
    }

    // Payout winners on-chain (outside DB tx)
    await payOutWinnersOnchain(raceResult, req.io);

    res.status(201).json({ success: true, raceResult });
  } catch (err) {
    await session.abortTransaction();
    console.error("Save race result error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    session.endSession();
  }
});

// History
router.get("/history", async (req, res) => {
  try {
    const results = await RaceResult.find()
      .sort({ timestamp: -1 })
      .limit(50);
    res.json(results);
  } catch (e) {
    console.error("History fetch error:", e);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// Specific result
router.get("/result/:raceId", async (req, res) => {
  try {
    const result = await RaceResult.findOne({ raceId: req.params.raceId });
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json(result);
  } catch (e) {
    console.error("Specific result error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
