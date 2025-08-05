require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const bs58 = require("bs58");
const RaceResult = require("../models/RaceResult");
const PendingRace = require("../models/PendingRace");
const PendingBet = require("../models/PendingBet"); // New model for pending bets
const User = require("../models/User");
const { scheduleRace } = require("../helpers/raceScheduler");
const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  getAccount,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const RAW_PROBS = { 5: 0.05, 4: 0.1, 3: 0.3, 2: 0.7 };
const racers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  { commitment: "confirmed" }
);
const TOKEN_MINT_ADDRESS = "8h9iB1HT4WPW3vzFUBHW9m4brea7a8tJwkZh2boHH1y4";
const TREASURY_ADDRESS = "6nE2nkQ4RzHaSx5n2MMBW5f9snevNs8wLBzLmLyrTCnu";

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

router.get("/next", async (req, res) => {
  try {
    let pending = await PendingRace.findOne().sort({ createdAt: -1 });

    if (!pending) {
      const raceId = `race_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const multipliers = getRaceMultipliers();

      pending = await new PendingRace({ raceId, multipliers }).save();
      scheduleRace(req.io, raceId, multipliers);
    }

    res.json({
      raceId: pending.raceId,
      multipliers: Object.fromEntries(pending.multipliers),
    });
  } catch (e) {
    console.error("GET /api/race/next error:", e);
    res.status(500).json({ error: "Failed to get next race" });
  }
});

router.post("/init", async (req, res) => {
  try {
    const { raceId, multipliers } = req.body;
    if (!raceId || !multipliers)
      return res.status(400).json({ error: "Missing data" });

    // Validate multipliers
    const validRacers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];
    const validMultipliers = [2, 3, 4, 5];
    const multiplierKeys = Object.keys(multipliers);
    if (
      multiplierKeys.length !== validRacers.length ||
      !multiplierKeys.every((key) => validRacers.includes(key)) ||
      !Object.values(multipliers).every((m) => validMultipliers.includes(m))
    ) {
      return res.status(400).json({ error: "Invalid multipliers" });
    }

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

router.get("/init/:raceId", async (req, res) => {
  try {
    const pending = await PendingRace.findOne({ raceId: req.params.raceId });
    if (!pending) return res.status(404).json({ error: "Race not found" });
    res.json({
      raceId: pending.raceId,
      multipliers: Object.fromEntries(pending.multipliers),
    });
  } catch (e) {
    console.error("Error fetching multipliers:", e);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/bet/submit", async (req, res) => {
  try {
    const {
      bettorWallet,
      targetName,
      amount,
      raceId,
      txSignature,
      multiplier,
    } = req.body;

    // Validate required fields
    const missing = [];
    if (!bettorWallet) missing.push("bettorWallet");
    if (!targetName) missing.push("targetName");
    if (!amount) missing.push("amount");
    if (!raceId) missing.push("raceId");
    if (!txSignature) missing.push("txSignature");
    if (!multiplier) missing.push("multiplier");
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required parameters: ${missing.join(", ")}`,
      });
    }

    // Validate bettorWallet
    try {
      new PublicKey(bettorWallet);
    } catch (e) {
      return res.status(400).json({ error: "Invalid bettorWallet" });
    }

    // Validate targetName
    const validRacers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];
    if (!validRacers.includes(targetName)) {
      return res.status(400).json({ error: "Invalid targetName" });
    }

    // Validate amount
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Validate raceId
    const race = await PendingRace.findOne({ raceId });
    if (!race) {
      return res.status(400).json({ error: "Invalid raceId" });
    }

    // Validate multiplier
    const validMultipliers = [2, 3, 4, 5];
    if (
      typeof multiplier !== "number" ||
      !validMultipliers.includes(multiplier)
    ) {
      return res.status(400).json({ error: "Invalid multiplier" });
    }

    // Verify transaction
    const txInfo = await connection.getTransaction(txSignature, {
      commitment: "confirmed",
    });
    if (!txInfo || txInfo.meta?.err) {
      return res.status(400).json({ error: "Invalid or failed transaction" });
    }

    // Save bet to PendingBet
    const bet = new PendingBet({
      bettorWallet,
      targetName,
      amount,
      raceId,
      txSignature,
      multiplier,
      timestamp: new Date(),
    });
    await bet.save();

    // Emit bet event
    if (req.io) {
      req.io.emit("betPlaced", {
        bettorWallet,
        targetName,
        amount,
        raceId,
        txSignature,
        multiplier,
      });
    }

    res.json({ success: true, bet });
  } catch (err) {
    console.error("bet submit error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function payOutWinnersOnchain(raceResult, io) {
  const treasury = getTreasuryKeypair();
  if (!treasury) {
    console.warn("Skipping on-chain payout: treasury keypair missing.");
    return;
  }

  const tokenMint = new PublicKey(TOKEN_MINT_ADDRESS);
  const treasuryPubkey = treasury.publicKey;
  let treasuryTokenAccount;

  // Check or create treasury token account
  try {
    treasuryTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      treasuryPubkey
    );
    await getAccount(connection, treasuryTokenAccount);
  } catch (e) {
    console.warn("Treasury token account does not exist, creating...");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        treasuryPubkey,
        treasuryTokenAccount,
        treasuryPubkey,
        tokenMint
      )
    );
    tx.feePayer = treasuryPubkey;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(treasury);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, "confirmed");
    console.log("Created treasury token account:", signature);
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
        `Payout ${totalPayout} TOKENS to ${bettorWallet} (aggregated winning amount)`
      );
      const toPubkey = new PublicKey(bettorWallet);
      const toTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        toPubkey
      );

      // Check if recipient token account exists
      try {
        await getAccount(connection, toTokenAccount);
      } catch (e) {
        console.warn(
          `Recipient token account for ${bettorWallet} does not exist, skipping payout`
        );
        continue;
      }

      const lamports = Math.round(totalPayout * 1e9); // Assuming 9 decimals

      const tx = new Transaction().add(
        createTransferInstruction(
          treasuryTokenAccount,
          toTokenAccount,
          treasuryPubkey,
          lamports,
          [],
          TOKEN_PROGRAM_ID
        )
      );
      tx.feePayer = treasuryPubkey;
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(treasury);
      const raw = tx.serialize();
      const signature = await connection.sendRawTransaction(raw);
      await connection.confirmTransaction(signature, "confirmed");

      console.log(
        `Paid out ${totalPayout} TOKENS to ${bettorWallet} sig=${signature}`
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
        `Failed to payout ${totalPayout} TOKENS to ${bettorWallet}:`,
        e
      );
    }
  }
}

router.post("/result", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { raceId, multipliers, winner, losers = [], bets = [] } = req.body;
    if (!raceId || !multipliers || !winner || !bets) {
      await session.abortTransaction();
      return res.status(400).json({ error: "Missing required fields" });
    }

    let existing = await RaceResult.findOne({ raceId }).session(session);
    if (existing) {
      await session.commitTransaction();
      return res.status(200).json({
        message: "Already recorded",
        raceResult: existing,
      });
    }

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
    await PendingBet.deleteMany({ raceId }).session(session); // Clean up pending bets

    await session.commitTransaction();

    if (req.io) {
      req.io.emit("raceResult", { raceResult });
    }

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

router.get("/history", async (req, res) => {
  try {
    const results = await RaceResult.find().sort({ timestamp: -1 }).limit(50);
    res.json(results);
  } catch (e) {
    console.error("History fetch error:", e);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

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
