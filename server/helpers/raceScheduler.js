// helpers/raceScheduler.js
const PendingRace = require("../models/PendingRace");
const { getRaceMultipliers } = require("../models/PendingRace"); // or wherever you define it

/**
 * scheduleRace(io, raceId, multipliers)
 *   Emits phaseChange & tick events into the room `raceId`:
 *     – READY (5s)  → BETTING (20s) → RACING
 */
function scheduleRace(io, raceId, multipliers) {
  // 1) READY phase
  let ready = 5;
  io.in(raceId).emit("phaseChange", { phase: "ready", multipliers });
  io.in(raceId).emit("readyTick", { t: ready });

  const readyInterval = setInterval(() => {
    ready--;
    io.in(raceId).emit("readyTick", { t: ready });
    if (ready <= 0) {
      clearInterval(readyInterval);

      // 2) BETTING phase
      let bet = 20;
      io.in(raceId).emit("phaseChange", { phase: "betting" });
      io.in(raceId).emit("betTick", { bt: bet });

      const betInterval = setInterval(() => {
        bet--;
        io.in(raceId).emit("betTick", { bt: bet });
        if (bet <= 0) {
          clearInterval(betInterval);

          // 3) RACING phase
          io.in(raceId).emit("phaseChange", { phase: "racing" });
        }
      }, 1000);
    }
  }, 1000);
}

module.exports = { scheduleRace };
