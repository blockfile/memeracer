require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const userRoutes = require("./routes/user");
const raceRoutes = require("./routes/race");
const PendingRace = require("./models/PendingRace");
const { scheduleRace } = require("./helpers/raceScheduler");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  req.io = io;
  next();
});

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((e) => {
    console.error("MongoDB connection error:", e);
    process.exit(1);
  });

app.use("/api/user", userRoutes);
app.use("/api/race", raceRoutes);

app.get("/ping", (_req, res) => res.send("pong"));

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.on("joinRace", (raceId) => {
    socket.join(raceId);
    console.log(`Socket ${socket.id} joined race ${raceId}`);
  });
  socket.on("getCurrentRace", async () => {
    console.log("Received getCurrentRace from", socket.id);
    try {
      let pending = await PendingRace.findOne().sort({ createdAt: -1 });
      if (!pending) {
        const raceId = `race_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const multipliers = require("./routes/race").getRaceMultipliers();
        pending = new PendingRace({
          raceId,
          multipliers,
          phase: "ready",
          readyCountdown: 5,
          betCountdown: 0,
        });
        await pending.save();
        console.log("Created and saved new race:", raceId);
        scheduleRace(io, raceId, multipliers);
      } else {
        console.log("Found existing race:", pending.raceId);
        if (
          !pending.phase ||
          !["ready", "betting", "racing"].includes(pending.phase)
        ) {
          console.log(
            "Invalid phase detected, resetting to 'ready':",
            pending.phase
          );
          pending.phase = "ready";
          pending.readyCountdown = 5;
          pending.betCountdown = 0;
          await pending.save();
          scheduleRace(
            io,
            pending.raceId,
            Object.fromEntries(pending.multipliers)
          );
        } else if (pending.phase === "ready" && pending.readyCountdown > 0) {
          scheduleRace(
            io,
            pending.raceId,
            Object.fromEntries(pending.multipliers)
          );
        }
      }
      pending = await PendingRace.findOne({ raceId: pending.raceId });
      if (!pending.phase) {
        throw new Error("Phase still undefined after validation");
      }
      console.log("Emitting raceState:", {
        raceId: pending.raceId,
        phase: pending.phase,
        readyCountdown: pending.readyCountdown,
        betCountdown: pending.betCountdown,
        multipliers: Object.fromEntries(pending.multipliers),
      });
      socket.emit("raceState", {
        raceId: pending.raceId,
        phase: pending.phase,
        readyCountdown: pending.readyCountdown,
        betCountdown: pending.betCountdown,
        multipliers: Object.fromEntries(pending.multipliers),
      });
      socket.join(pending.raceId);
    } catch (e) {
      console.error("Error fetching or creating current race:", e);
    }
  });
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
