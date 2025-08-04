require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const userRoutes = require("./routes/user"); // stub or implement
const raceRoutes = require("./routes/race");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Attach socket.io to requests
app.use((req, res, next) => {
  req.io = io;
  next();
});

// MongoDB connection
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

// Routes
app.use("/api/user", userRoutes);
app.use("/api/race", raceRoutes);

// Health check
app.get("/ping", (_req, res) => res.send("pong"));

// Socket.io realtime
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.on("joinRace", (raceId) => {
    socket.join(raceId);
  });
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
