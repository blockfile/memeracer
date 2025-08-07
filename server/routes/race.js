// routes/race.js
require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto");
const bs58 = require("bs58");
const RaceResult = require("../models/RaceResult");
const PendingRace = require("../models/PendingRace");
const PendingBet = require("../models/PendingBet");
const User = require("../models/User");
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

const RAW_PROBS = { 5: 0.15, 4: 0.18, 3: 0.25, 2: 0.4 };
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
  return 1 / (RAW_PROBS[m] || 0.4);
}

function getProvablyFairRandom(serverSeed, clientSeed, raceId, nonce) {
  const input = `${serverSeed}:${clientSeed}:${raceId}:${nonce}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

function getRaceMultipliers(serverSeed, clientSeed, raceId) {
  const basePool = [2, 2, 2, 3];
  const random = getProvablyFairRandom(
    serverSeed,
    clientSeed,
    raceId,
    "high_multiplier"
  );
  const high = random < 0.1 ? 5 : 4;
  const pool = [...basePool, high];
  for (let i = pool.length - 1; i > 0; i--) {
    const random = getProvablyFairRandom(serverSeed, clientSeed, raceId, i);
    const j = Math.floor(random * (i + 1));
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
    const pending = await PendingRace.findOne().sort({ createdAt: -1 });
    if (!pending) {
      return res.status(404).json({ error: "No active race found" });
    }
    res.json({
      raceId: pending.raceId,
      multipliers: Object.fromEntries(pending.multipliers),
      serverSeedHash: pending.serverSeedHash,
    });
  } catch (e) {
    console.error("GET /api/race/next error:", e);
    res.status(500).json({ error: "Failed to get current race" });
  }
});

router.post("/init", async (req, res) => {
  try {
    const { raceId, multipliers } = req.body;
    if (!raceId || !multipliers)
      return res.status(400).json({ error: "Missing data" });

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
        serverSeedHash: pending.serverSeedHash,
      });
    }
    const serverSeed = crypto.randomBytes(32).toString("hex");
    const serverSeedHash = crypto
      .createHash("sha256")
      .update(serverSeed)
      .digest("hex");
    pending = new PendingRace({
      raceId,
      multipliers,
      serverSeed,
      serverSeedHash,
    });
    await pending.save();
    res.status(201).json({
      raceId,
      multipliers,
      serverSeedHash,
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
      serverSeedHash: pending.serverSeedHash,
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

    try {
      new PublicKey(bettorWallet);
    } catch (e) {
      return res.status(400).json({ error: "Invalid bettorWallet" });
    }

    const validRacers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];
    if (!validRacers.includes(targetName)) {
      return res.status(400).json({ error: "Invalid targetName" });
    }

    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const race = await PendingRace.findOne({ raceId });
    if (!race || race.phase !== "betting") {
      return res
        .status(400)
        .json({ error: "Invalid raceId or betting closed" });
    }

    const validMultipliers = [2, 3, 4, 5];
    if (
      typeof multiplier !== "number" ||
      !validMultipliers.includes(multiplier)
    ) {
      return res.status(400).json({ error: "Invalid multiplier" });
    }

    const txInfo = await connection.getTransaction(txSignature, {
      commitment: "confirmed",
    });
    if (!txInfo || txInfo.meta?.err) {
      return res.status(400).json({ error: "Invalid or failed transaction" });
    }

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

    if (req.io) {
      req.io.to("globalRaceRoom").emit("betPlaced", {
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
      const profit = bet.payout - bet.amount;
      const rake = profit * 0.05;
      const netPayout = bet.payout - rake;
      payoutsByWallet[w] = (payoutsByWallet[w] || 0) + netPayout;
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

      try {
        await getAccount(connection, toTokenAccount);
      } catch (e) {
        console.warn(
          `Recipient token account for ${bettorWallet} does not exist, skipping payout`
        );
        continue;
      }

      const lamports = Math.round(totalPayout * 1e9);

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
        io.to("globalRaceRoom").emit("payout", {
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

module.exports = { router, getRaceMultipliers, payOutWinnersOnchain };
