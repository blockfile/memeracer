const express = require("express");
const router = express.Router();
const User = require("../models/User");
const nacl = require("tweetnacl");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddress, getAccount } = require("@solana/spl-token");

const TOKEN_MINT_ADDRESS = "8h9iB1HT4WPW3vzFUBHW9m4brea7a8tJwkZh2boHH1y4";
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  { commitment: "confirmed" }
);

// Utility to verify a signed message from Phantom
function verifySignature({ walletAddress, message, signature }) {
  try {
    let sigBuf;
    if (Array.isArray(signature)) {
      sigBuf = Uint8Array.from(signature);
    } else if (typeof signature === "string") {
      sigBuf = Uint8Array.from(Buffer.from(signature, "base64"));
    } else if (signature instanceof Uint8Array) {
      sigBuf = signature;
    } else {
      return false;
    }

    const messageUint8 = new TextEncoder().encode(message);
    const pubkey = new PublicKey(walletAddress);
    const pubkeyBytes = pubkey.toBytes();
    return nacl.sign.detached.verify(messageUint8, sigBuf, pubkeyBytes);
  } catch (e) {
    console.warn("signature verification failed", e);
    return false;
  }
}

// POST /api/user/connect
router.post("/connect", async (req, res) => {
  try {
    const { walletAddress, message, signature } = req.body;
    if (!walletAddress || !message || !signature) {
      return res
        .status(400)
        .json({ error: "walletAddress, message and signature required" });
    }

    const isValid = verifySignature({ walletAddress, message, signature });
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    let tokenBalance = 0;
    try {
      const tokenMint = new PublicKey(TOKEN_MINT_ADDRESS);
      const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        new PublicKey(walletAddress)
      );
      const accountInfo = await getAccount(connection, tokenAccount);
      tokenBalance = Number(accountInfo.amount) / 1e9; // Assuming 9 decimals
    } catch (e) {
      console.warn(`Failed to fetch token balance for ${walletAddress}:`, e);
    }

    const update = {
      tokenBalance: String(tokenBalance),
    };

    const user = await User.findOneAndUpdate(
      { walletAddress: walletAddress.toLowerCase() },
      {
        $set: update,
        $setOnInsert: { walletAddress: walletAddress.toLowerCase() },
      },
      { upsert: true, new: true }
    );

    return res.json(user);
  } catch (err) {
    console.error("connect error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/user/:walletAddress
router.get("/:walletAddress", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const user = await User.findOne({
      walletAddress: walletAddress.toLowerCase(),
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    let tokenBalance = Number(user.tokenBalance) || 0;
    try {
      const tokenMint = new PublicKey(TOKEN_MINT_ADDRESS);
      const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        new PublicKey(walletAddress)
      );
      const accountInfo = await getAccount(connection, tokenAccount);
      tokenBalance = Number(accountInfo.amount) / 1e9; // Assuming 9 decimals
      user.tokenBalance = String(tokenBalance);
      await user.save();
    } catch (e) {
      console.warn(`Failed to refresh token balance for ${walletAddress}:`, e);
    }

    return res.json(user);
  } catch (err) {
    console.error("get user error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
