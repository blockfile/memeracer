// utils/getSolBalance.js
const { Connection, clusterApiUrl, PublicKey } = require("@solana/web3.js");

// You can make the RPC endpoint configurable via env
const endpoint = process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
const connection = new Connection(endpoint, { commitment: "confirmed" });

/**
 * Fetch native SOL balance for a given wallet address (public key string)
 * Returns balance in SOL (not lamports) as a number.
 */
async function getSolBalance(walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const lamports = await connection.getBalance(pubkey);
    return lamports / 1e9; // convert lamports to SOL
  } catch (err) {
    console.warn("getSolBalance error:", err);
    return 0;
  }
}

module.exports = { getSolBalance };
