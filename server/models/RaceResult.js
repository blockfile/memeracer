const mongoose = require("mongoose");

const BetSchema = new mongoose.Schema({
  bettorWallet: { type: String, required: true },
  targetName: { type: String, required: true },
  amount: { type: Number, required: true },
  multiplier: { type: Number, required: true },
  payout: { type: Number, required: true },
  won: { type: Boolean, required: true },
  payoutTxSignature: { type: String }, // optional on-chain payout signature
});

const LoserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  walletAddress: { type: String },
  multiplier: { type: Number, required: true },
});

const RaceResultSchema = new mongoose.Schema(
  {
    raceId: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    multipliers: { type: Map, of: Number, required: true },
    winner: {
      name: { type: String, required: true },
      walletAddress: { type: String, required: true },
      multiplier: { type: Number, required: true },
    },
    losers: [LoserSchema],
    bets: [BetSchema],
    serverSeed: { type: String, required: true },
    serverSeedHash: { type: String, required: true },
  },
  { timestamps: true }
);

// indexes
RaceResultSchema.index({ raceId: 1 }, { unique: true });
RaceResultSchema.index({ "winner.walletAddress": 1 });
RaceResultSchema.index({ timestamp: -1 });

module.exports = mongoose.model("RaceResult", RaceResultSchema);
