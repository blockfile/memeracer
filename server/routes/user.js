// routes/user.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { getSolBalance } = require("../utils/getSolBalance");
const nacl = require("tweetnacl");
const { PublicKey } = require("@solana/web3.js");

// Utility to verify a signed message from Phantom
function verifySignature({ walletAddress, message, signature }) {
  try {
    // Phantom returns signature as Uint8Array; if transmitted as base64 or array, normalize accordingly.
    let sigBuf;
    if (Array.isArray(signature)) {
      sigBuf = Uint8Array.from(signature);
    } else if (typeof signature === "string") {
      // assume base64
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
// Expects: { walletAddress, message, signature }
// Optional: tokenBalance (if you want client-supplied), otherwise server fetches fresh SOL balance.
router.post("/connect", async (req, res) => {
  try {
    const { walletAddress, message, signature, tokenBalance } = req.body;
    if (!walletAddress || !message || !signature) {
      return res.status(400).json({ error: "walletAddress, message and signature required" });
    }

    // verify ownership
    const isValid = verifySignature({ walletAddress, message, signature });
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    // get latest SOL balance from chain (overrides client if provided)
    const solBal = await getSolBalance(walletAddress);

    const update = {
      tokenBalance: String(solBal),
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
    const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (err) {
    console.error("get user error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
