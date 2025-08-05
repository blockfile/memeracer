const mongoose = require("mongoose");

const PendingBetSchema = new mongoose.Schema({
  bettorWallet: { type: String, required: true },
  targetName: { type: String, required: true },
  amount: { type: Number, required: true },
  raceId: { type: String, required: true },
  txSignature: { type: String, required: true },
  multiplier: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
});

PendingBetSchema.index({ raceId: 1 });

module.exports = mongoose.model("PendingBet", PendingBetSchema);
