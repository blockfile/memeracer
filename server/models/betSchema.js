const BetSchema = new mongoose.Schema({
    bettorWallet: { type: String, required: true }, // who placed the bet
    targetName: { type: String, required: true }, // e.g., "Pepe"
    amount: { type: Number, required: true },
    multiplier: { type: Number, required: true }, // x2, x3 etc at time of bet
    payout: { type: Number, required: true }, // computed: amount * multiplier (or 0 if lost)
    won: { type: Boolean, required: true },
  });
  