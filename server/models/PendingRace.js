const mongoose = require("mongoose");

const PendingRaceSchema = new mongoose.Schema({
  raceId: { type: String, required: true, unique: true },
  multipliers: { type: Map, of: Number, required: true },
  serverSeed: { type: String, required: true },
  serverSeedHash: { type: String, required: true },
  phase: { type: String, default: "ready" },
  readyCountdown: { type: Number, default: 5 },
  betCountdown: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PendingRace", PendingRaceSchema);
