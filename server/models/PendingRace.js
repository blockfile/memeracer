const mongoose = require("mongoose");

const PendingRaceSchema = new mongoose.Schema({
  raceId: { type: String, required: true, unique: true },
  multipliers: { type: Map, of: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

PendingRaceSchema.index({ createdAt: 1 });

const PendingRace = mongoose.model("PendingRace", PendingRaceSchema);
module.exports = PendingRace;
