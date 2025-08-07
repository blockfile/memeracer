// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const userRoutes = require("./routes/user");
const { router: raceRoutes, getRaceMultipliers } = require("./routes/race");
const PendingRace = require("./models/PendingRace");
const { scheduleRace } = require("./helpers/raceScheduler");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Map to track active race timers
const activeRaces = new Map();

// Add this global lock variable
let isStartingRace = false;

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

// Function to start or resume the race loop
async function startRaceLoop() {
  if (isStartingRace) {
    console.log("Race loop already starting, skipping duplicate call");
    return;
  }
  isStartingRace = true;
  try {
    let pending = await PendingRace.findOne().sort({ createdAt: -1 });
    if (
      !pending ||
      pending.phase === "completed" ||
      !pending.serverSeed ||
      !pending.serverSeedHash
    ) {
      const raceId = `race_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const serverSeed = crypto.randomBytes(32).toString("hex");
      const serverSeedHash = crypto
        .createHash("sha256")
        .update(serverSeed)
        .digest("hex");
      const multipliers = getRaceMultipliers(serverSeed, raceId, raceId);
      if (pending && !pending.serverSeed) {
        // Update existing pending race if incomplete
        pending.raceId = raceId;
        pending.multipliers = multipliers;
        pending.phase = "ready";
        pending.readyCountdown = 5;
        pending.betCountdown = 0;
        pending.serverSeed = serverSeed;
        pending.serverSeedHash = serverSeedHash;
        await pending.save();
      } else {
        pending = new PendingRace({
          raceId,
          multipliers,
          phase: "ready",
          readyCountdown: 5,
          betCountdown: 0,
          serverSeed,
          serverSeedHash,
        });
        await pending.save();
      }
      console.log("Created/Updated and saved new race:", raceId);
    }
    if (!activeRaces.has(pending.raceId)) {
      activeRaces.set(pending.raceId, true);
      scheduleRace(
        io,
        pending.raceId,
        Object.fromEntries(pending.multipliers),
        activeRaces,
        startRaceLoop,
        pending.serverSeed,
        pending.serverSeedHash
      );
    } else {
      // Ensure race is scheduled even if it exists but isn't running
      scheduleRace(
        io,
        pending.raceId,
        Object.fromEntries(pending.multipliers),
        activeRaces,
        startRaceLoop,
        pending.serverSeed,
        pending.serverSeedHash
      );
    }
  } catch (e) {
    console.error("Error starting race loop:", e);
    // Retry after a delay to prevent infinite loop crashes
    setTimeout(startRaceLoop, 5000);
  } finally {
    isStartingRace = false;
  }
}

// Start the race loop on server startup
startRaceLoop();

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.join("globalRaceRoom");
  console.log(`Socket ${socket.id} joined globalRaceRoom`);

  socket.on("getCurrentRace", async () => {
    console.log("Received getCurrentRace from", socket.id);
    try {
      const pending = await PendingRace.findOne().sort({ createdAt: -1 });
      if (!pending) {
        // No trigger here—let the server handle starting the next race
        console.log("No pending race; client will wait for server broadcast");
        socket.emit("raceState", { phase: "intermission" });
        return;
      }
      const raceState = {
        raceId: pending.raceId,
        phase: pending.phase,
        readyCountdown: pending.readyCountdown,
        betCountdown: pending.betCountdown,
        multipliers: Object.fromEntries(pending.multipliers),
        serverSeedHash: pending.serverSeedHash,
      };
      socket.emit("raceState", raceState);
    } catch (e) {
      console.error("Error fetching current race:", e);
      socket.emit("error", { message: "Failed to fetch current race" });
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
