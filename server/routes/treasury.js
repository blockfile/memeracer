// routes/treasury.js
const express = require("express");
const router = express.Router();
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const nacl = require("tweetnacl");

/**
 * Load treasury keypair.
 * Priority:
 * 1. TREASURY_SECRET_KEY (full secret: JSON array / base64 / base58)
 * 2. TREASURY_PRIVATE_SEED (32-byte seed hex or base64)
 */
function loadTreasuryKeypair() {
  // 1. Full secret key variants
  const rawSecret = process.env.TREASURY_SECRET_KEY;
  if (rawSecret) {
    // JSON array
    try {
      const parsed = JSON.parse(rawSecret);
      if (Array.isArray(parsed) && parsed.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
    } catch (e) {
      console.warn("Failed to parse TREASURY_SECRET_KEY as JSON array:", e);
    }

    // base64
    try {
      const buf = Buffer.from(rawSecret, "base64");
      if (buf.length === 64) {
        return Keypair.fromSecretKey(new Uint8Array(buf));
      }
    } catch (e) {
      console.warn("Failed to parse TREASURY_SECRET_KEY as base64:", e);
    }

    // base58
    try {
      const decoded = bs58.decode(rawSecret);
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(new Uint8Array(decoded));
      }
    } catch (e) {
      console.warn("Failed to parse TREASURY_SECRET_KEY as base58:", e);
    }
  }

  // 2. Private seed (32 bytes) path
  const seedRaw = process.env.TREASURY_PRIVATE_SEED;
  if (seedRaw) {
    let seed;
    // hex (64 chars)
    if (/^[0-9a-fA-F]+$/.test(seedRaw) && seedRaw.length === 64) {
      seed = Uint8Array.from(Buffer.from(seedRaw, "hex"));
    } else {
      // try base64
      try {
        const buf = Buffer.from(seedRaw, "base64");
        if (buf.length === 32) seed = new Uint8Array(buf);
      } catch (e) {
        console.warn("Failed to parse TREASURY_PRIVATE_SEED as base64:", e);
      }
    }
    if (seed && seed.length === 32) {
      // ed25519 seed -> full keypair
      const kp = nacl.sign.keyPair.fromSeed(seed); // secretKey is 64 bytes
      return Keypair.fromSecretKey(Uint8Array.from(kp.secretKey));
    }
    throw new Error(
      "TREASURY_PRIVATE_SEED provided but invalid (expect 32-byte hex or base64)"
    );
  }

  throw new Error(
    "No treasury key material provided. Set TREASURY_PRIVATE_SEED or TREASURY_SECRET_KEY"
  );
}

router.get("/address", (req, res) => {
  try {
    const treasury = loadTreasuryKeypair();
    res.json({ address: treasury.publicKey.toString() });
  } catch (e) {
    console.error("Failed to get treasury address:", e);
    res
      .status(500)
      .json({ error: e.message || "Failed to load treasury address" });
  }
});

module.exports = { router, loadTreasuryKeypair };
