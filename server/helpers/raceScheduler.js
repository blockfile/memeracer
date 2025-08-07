// helpers/raceScheduler.js
const mongoose = require("mongoose");
const PendingRace = require("../models/PendingRace");
const RaceResult = require("../models/RaceResult");
const PendingBet = require("../models/PendingBet");
const User = require("../models/User");
const crypto = require("crypto");
const { payOutWinnersOnchain } = require("../routes/race");

const RAW_PROBS = { 5: 0.15, 4: 0.18, 3: 0.25, 2: 0.4 };
const racers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];

function getWeightForMultiplier(m) {
  return 1 / (RAW_PROBS[m] || 0.4);
}

function getProvablyFairRandom(serverSeed, clientSeed, raceId, nonce) {
  const input = `${serverSeed}:${clientSeed}:${raceId}:${nonce}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

async function scheduleRace(
  io,
  raceId,
  multipliers,
  activeRaces,
  startRaceLoop
) {
  let session = null;
  try {
    let race = await PendingRace.findOne({ raceId });
    if (!race) {
      console.error(`Race ${raceId} not found`);
      activeRaces.delete(raceId);
      return;
    }

    const raceState = {
      raceId: race.raceId,
      phase: race.phase,
      readyCountdown: race.readyCountdown,
      betCountdown: race.betCountdown,
      multipliers: Object.fromEntries(race.multipliers),
      serverSeedHash: race.serverSeedHash,
    };
    io.to("globalRaceRoom").emit("raceState", raceState);
    console.log(`Scheduling race ${raceId} in phase ${race.phase}`);

    // Ready phase
    if (race.phase === "ready") {
      let t = race.readyCountdown;
      const interval = setInterval(async () => {
        try {
          t--;
          race.readyCountdown = t;
          await race.save();
          io.to("globalRaceRoom").emit("raceState", {
            ...raceState,
            readyCountdown: t,
          });
          if (t <= 0) {
            clearInterval(interval);
            race.phase = "betting";
            race.betCountdown = 20;
            await race.save();
            console.log(`Race ${raceId} transitioning to betting phase`);
            scheduleRace(io, raceId, multipliers, activeRaces, startRaceLoop);
          }
        } catch (e) {
          console.error(`Error in ready phase for race ${raceId}:`, e);
          clearInterval(interval);
          activeRaces.delete(raceId);
        }
      }, 1000);
    }
    // Betting phase
    else if (race.phase === "betting") {
      let t = race.betCountdown;
      const interval = setInterval(async () => {
        try {
          t--;
          race.betCountdown = t;
          await race.save();
          io.to("globalRaceRoom").emit("raceState", {
            ...raceState,
            betCountdown: t,
          });
          if (t <= 0) {
            clearInterval(interval);
            race.phase = "racing";
            await race.save();
            console.log(`Race ${raceId} transitioning to racing phase`);
            io.to("globalRaceRoom").emit("raceStart", {
              raceId,
              serverSeed: race.serverSeed,
            });
            scheduleRace(io, raceId, multipliers, activeRaces, startRaceLoop);
          }
        } catch (e) {
          console.error(`Error in betting phase for race ${raceId}:`, e);
          clearInterval(interval);
          activeRaces.delete(raceId);
        }
      }, 1000);
    }
    // Racing phase
    else if (race.phase === "racing") {
      const raceDur = 15000; // 15 seconds
      const t0 = Date.now();
      const frameDelta = 1000 / 30; // 30 FPS updates to reduce load
      let positions = racers.map(() => 0);
      const clientSeed = race.raceId;
      const weights = racers.map((name) =>
        getWeightForMultiplier(race.multipliers.get(name))
      );
      const total = weights.reduce((a, b) => a + b, 0);
      const random = getProvablyFairRandom(
        race.serverSeed,
        clientSeed,
        race.raceId,
        "winner"
      );
      let r = random * total;
      let idx = -1;
      for (let k = 0; k < racers.length; ++k) {
        if (r < weights[k]) {
          idx = k;
          break;
        }
        r -= weights[k];
      }
      const winnerIndex = idx === -1 ? 0 : idx;

      // Set speeds based on multipliers, but ensure winner has the highest speed
      let speeds = racers.map((r, i) => {
        const mult = multipliers[r] || 2;
        const baseSpeed = 1 / mult; // Lower multiplier (higher prob) gets higher base speed
        const jitter = 0.9 + Math.random() * 0.2;
        return baseSpeed * jitter;
      });
      // Swap or adjust to make winner fastest
      const maxSpeed = Math.max(...speeds);
      speeds[winnerIndex] = maxSpeed + 0.1; // Make winner slightly faster
      // Normalize speeds so max is 1
      const newMaxSpeed = Math.max(...speeds);
      speeds = speeds.map((s) => s / newMaxSpeed);

      const progressInterval = setInterval(() => {
        const timeElapsed = Date.now() - t0;
        if (timeElapsed < raceDur) {
          const progressFraction = timeElapsed / raceDur;
          positions = speeds.map((s) => progressFraction * s * 1.1); // Slight boost to reach beyond 1 if needed
          io.to("globalRaceRoom").emit("raceProgress", {
            raceId,
            positions: racers.reduce(
              (acc, r, i) => ({ ...acc, [r]: positions[i] }),
              {}
            ),
          });
        }
      }, frameDelta);

      setTimeout(async () => {
        clearInterval(progressInterval);
        try {
          const winnerName = racers[winnerIndex];
          const winningMultiplier = race.multipliers.get(winnerName);

          const winner = {
            name: winnerName,
            walletAddress: "UNKNOWN",
            multiplier: winningMultiplier,
          };

          const losers = racers
            .filter((name) => name !== winnerName)
            .map((name) => ({
              name,
              walletAddress: "UNKNOWN",
              multiplier: race.multipliers.get(name),
            }));

          const pendingBets = await PendingBet.find({ raceId });
          const bets = pendingBets.map((bet) => ({
            bettorWallet: bet.bettorWallet,
            targetName: bet.targetName,
            amount: bet.amount,
            multiplier: bet.multiplier,
            payout:
              bet.targetName === winnerName ? bet.amount * bet.multiplier : 0,
            won: bet.targetName === winnerName,
          }));

          session = await mongoose.startSession();
          session.startTransaction();

          for (const bet of bets) {
            const { bettorWallet, amount, payout, won } = bet;
            let user = await User.findOne({
              walletAddress: bettorWallet,
            }).session(session);
            if (!user) {
              user = new User({ walletAddress: bettorWallet, tokenBalance: 0 });
            }
            if (won) {
              const profit = payout - amount;
              const rake = profit * 0.05;
              const netPayout = payout - rake;
              user.tokenBalance = Number(user.tokenBalance || 0) + netPayout;
            } else {
              user.tokenBalance = Math.max(
                Number(user.tokenBalance || 0) - amount,
                0
              );
            }
            await user.save({ session });
          }

          const raceResult = new RaceResult({
            raceId,
            multipliers: race.multipliers,
            winner,
            losers,
            bets,
            timestamp: new Date(),
          });

          await raceResult.save({ session });
          await PendingRace.deleteOne({ raceId }).session(session);
          await PendingBet.deleteMany({ raceId }).session(session);

          await session.commitTransaction();
          session.endSession();
          session = null;

          // Verify payOutWinnersOnchain exists before calling
          if (typeof payOutWinnersOnchain === "function") {
            try {
              await payOutWinnersOnchain(raceResult, io);
            } catch (payoutError) {
              console.error(
                `Error in payOutWinnersOnchain for race ${raceId}:`,
                payoutError
              );
              // Continue despite payout error to avoid blocking race loop
            }
          } else {
            console.warn(
              `payOutWinnersOnchain is not a function for race ${raceId}`
            );
          }

          io.to("globalRaceRoom").emit("raceResult", {
            raceResult: raceResult.toObject(),
            serverSeed: race.serverSeed,
          });
          activeRaces.delete(raceId);
          // Delay intermission emission to allow winner display
          setTimeout(() => {
            io.to("globalRaceRoom").emit("raceState", {
              phase: "intermission",
            });
          }, 5000);

          // Start a new race after completion
          setTimeout(startRaceLoop, 5000);
        } catch (e) {
          console.error(`Error in racing phase for race ${raceId}:`, e);
          if (session) {
            try {
              await session.abortTransaction();
            } catch (abortError) {
              console.error(
                `Error aborting transaction for race ${raceId}:`,
                abortError
              );
            }
            session.endSession();
            session = null;
          }
          activeRaces.delete(raceId);
        }
      }, raceDur);
    }
  } catch (e) {
    console.error(`Error scheduling race ${raceId}:`, e);
    activeRaces.delete(raceId);
    if (session) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        console.error(
          `Error aborting transaction for race ${raceId}:`,
          abortError
        );
      }
      session.endSession();
    }
  }
}

module.exports = { scheduleRace };
