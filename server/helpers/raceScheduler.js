const mongoose = require("mongoose");
const PendingRace = require("../models/PendingRace");
const RaceResult = require("../models/RaceResult");
const PendingBet = require("../models/PendingBet");
const User = require("../models/User");
const crypto = require("crypto");
const { payOutWinnersOnchain } = require("../routes/race");

const racers = ["Pepe", "Wojak", "Doge", "Chad", "Milady"];

const RAW_PROBS = { 5: 0.146, 4: 0.166, 3: 0.239, 2: 0.349 }; // Sum ≈ 0.9 with 10% house edge
function getWeightForMultiplier(m) {
  return RAW_PROBS[m] || RAW_PROBS[2];
}

function getProvablyFairRandom(serverSeed, clientSeed, raceId, nonce) {
  const input = `${serverSeed}:${clientSeed}:${raceId}:${nonce}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

function getRaceMultipliers(serverSeed, clientSeed, raceId) {
  const random = getProvablyFairRandom(
    serverSeed,
    clientSeed,
    raceId,
    "pool_config"
  );
  const useSpecialPool = random < 0.3; // 30% chance for special pool

  let basePool;
  if (useSpecialPool) {
    const high = random < 0.5 ? 5 : 4;
    basePool = [2, 2, 3, 3, high];
  } else {
    basePool = [2, 3, 4, 5, 2];
  }

  // Fisher–Yates shuffle driven by provably-fair RNG
  for (let i = basePool.length - 1; i > 0; i--) {
    const j = Math.floor(
      getProvablyFairRandom(serverSeed, clientSeed, raceId, i) * (i + 1)
    );
    [basePool[i], basePool[j]] = [basePool[j], basePool[i]];
  }

  return racers.reduce((map, r, i) => {
    map[r] = basePool[i];
    return map;
  }, {});
}

async function scheduleRace(
  io,
  raceId,
  multipliers,
  activeRaces,
  startRaceLoop,
  serverSeed,
  serverSeedHash
) {
  let session = null;

  try {
    const race = await PendingRace.findOne({ raceId });
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
      serverSeedHash: serverSeedHash || race.serverSeedHash,
    };
    io.to("globalRaceRoom").emit("raceState", raceState);
    console.log(`Scheduling race ${raceId} in phase ${race.phase}`);

    // READY phase
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
            scheduleRace(
              io,
              raceId,
              multipliers,
              activeRaces,
              startRaceLoop,
              serverSeed || race.serverSeed,
              serverSeedHash || race.serverSeedHash
            );
          }
        } catch (e) {
          console.error(`Error in ready phase for race ${raceId}:`, e);
          clearInterval(interval);
          activeRaces.delete(raceId);
        }
      }, 1000);
    }

    // BETTING phase
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
            });
            scheduleRace(
              io,
              raceId,
              multipliers,
              activeRaces,
              startRaceLoop,
              serverSeed || race.serverSeed,
              serverSeedHash || race.serverSeedHash
            );
          }
        } catch (e) {
          console.error(`Error in betting phase for race ${raceId}:`, e);
          clearInterval(interval);
          activeRaces.delete(raceId);
        }
      }, 1000);
    }

    // RACING phase
    else if (race.phase === "racing") {
      const raceDur = 15000; // 15 seconds
      const t0 = Date.now();
      const frameDelta = Math.floor(1000 / 60); // ~60 FPS updates
      let positions = racers.map(() => 0);
      const clientSeed = race.raceId;

      // Determine winner index by weighted RNG
      const weights = racers.map((name) =>
        getWeightForMultiplier(race.multipliers.get(name))
      );
      const totalW = weights.reduce((a, b) => a + b, 0);
      const randW =
        getProvablyFairRandom(
          race.serverSeed,
          clientSeed,
          race.raceId,
          "winner"
        ) * totalW;
      let idx = 0,
        acc = 0;
      for (; idx < racers.length; idx++) {
        acc += weights[idx];
        if (randW <= acc) break;
      }
      const winnerIndex = idx % racers.length;

      // Select scenario 0–3
      const scenarioRandom = getProvablyFairRandom(
        race.serverSeed,
        clientSeed,
        race.raceId,
        "scenario"
      );
      const scenario = Math.floor(scenarioRandom * 4);

      // False-leader for scenario 1
      let falseLeaderIndex = -1;
      if (scenario === 1) {
        const flRand = getProvablyFairRandom(
          race.serverSeed,
          clientSeed,
          race.raceId,
          "false_leader"
        );
        falseLeaderIndex = Math.floor(flRand * (racers.length - 1));
        if (falseLeaderIndex >= winnerIndex) falseLeaderIndex++;
      }

      // Base speeds
      let baseSpeeds = racers.map(() => 0.9 + Math.random() * 0.2);
      baseSpeeds[winnerIndex] = Math.max(...baseSpeeds) + 0.1;
      const maxBase = Math.max(...baseSpeeds);
      baseSpeeds = baseSpeeds.map((s) => s / maxBase);

      // Factors to shape each scenario
      let earlyFactors = new Array(racers.length).fill(1.0);
      let lateFactors = new Array(racers.length).fill(1.0);
      let switchPoint = 0.6;

      if (scenario === 0) {
        // Slow start, big boost late
        earlyFactors[winnerIndex] = 0.8;
        lateFactors[winnerIndex] = 1.5;
      } else if (scenario === 1) {
        // False leader leads, then winner overtakes
        earlyFactors[falseLeaderIndex] = 1.3;
        lateFactors[falseLeaderIndex] = 0.8;
        lateFactors[winnerIndex] = 1.3;
      } else if (scenario === 2) {
        // Jittery close race
        switchPoint = 0.4;
        earlyFactors = earlyFactors.map(
          (f) => f * (0.95 + Math.random() * 0.1)
        );
        lateFactors[winnerIndex] = 1.2;
        lateFactors = lateFactors.map((f, i) =>
          i !== winnerIndex ? f * (0.9 + Math.random() * 0.1) : f
        );
      } else if (scenario === 3) {
        // Explosive start, mid-race lull, final sprint
        // Phase 1 (0–30%): big early lead
        earlyFactors[winnerIndex] = 1.5;
        // Phase 2 (30–80%): fatigue
        lateFactors[winnerIndex] = 0.7;
        // shorten initial switch to 30%
        switchPoint = 0.3;
        // We'll implicitly give a final burst via the weighting in progress loop
      }

      // Emit progress ~60×/sec
      const progressInterval = setInterval(() => {
        const elapsed = Date.now() - t0;
        if (elapsed < raceDur) {
          const frac = elapsed / raceDur;
          const earlyP = Math.min(frac / switchPoint, 1);
          const lateP = Math.max((frac - switchPoint) / (1 - switchPoint), 0);
          positions = baseSpeeds.map(
            (s, i) =>
              s *
              (earlyFactors[i] * earlyP * switchPoint +
                lateFactors[i] * lateP * (1 - switchPoint)) *
              1.1
          );
          io.to("globalRaceRoom").emit("raceProgress", {
            raceId,
            positions: racers.reduce((m, r, i) => {
              m[r] = positions[i];
              return m;
            }, {}),
          });
        }
      }, frameDelta);

      // After race duration ends…
      setTimeout(async () => {
        clearInterval(progressInterval);
        try {
          // Determine winner & collate bets
          const winnerName = racers[winnerIndex];
          const winningMult = race.multipliers.get(winnerName);
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

          // Start Mongo transaction
          session = await mongoose.startSession();
          session.startTransaction();

          // Update each user balance
          for (const b of bets) {
            let user = await User.findOne({
              walletAddress: b.bettorWallet,
            }).session(session);
            if (!user) {
              user = new User({
                walletAddress: b.bettorWallet,
                tokenBalance: 0,
              });
            }
            if (b.won) {
              const profit = b.payout - b.amount;
              const rake = profit * 0.05;
              const net = b.payout - rake;
              user.tokenBalance = Number(user.tokenBalance || 0) + net;
            } else {
              user.tokenBalance = Math.max(
                Number(user.tokenBalance || 0) - b.amount,
                0
              );
            }
            await user.save({ session });
          }

          // Save result, clean up pending races/bets
          const raceResult = new RaceResult({
            raceId,
            multipliers: race.multipliers,
            winner: {
              name: winnerName,
              walletAddress: "UNKNOWN",
              multiplier: winningMult,
            },
            losers: racers
              .filter((n) => n !== winnerName)
              .map((n) => ({
                name: n,
                walletAddress: "UNKNOWN",
                multiplier: race.multipliers.get(n),
              })),
            bets,
            serverSeed, // Add this
            serverSeedHash,
            timestamp: new Date(),
          });
          await raceResult.save({ session });
          await PendingRace.deleteOne({ raceId }).session(session);
          await PendingBet.deleteMany({ raceId }).session(session);

          // Commit transaction
          await session.commitTransaction();
          session.endSession();
          session = null;

          // On-chain payout
          if (typeof payOutWinnersOnchain === "function") {
            try {
              await payOutWinnersOnchain(raceResult, io);
            } catch (err) {
              console.error(`On-chain payout error for ${raceId}:`, err);
            }
          } else {
            console.warn(`payOutWinnersOnchain not defined for ${raceId}`);
          }

          // Emit final progress with winner at finish
          const finalPositions = racers.reduce((m, r, i) => {
            m[r] = i === winnerIndex ? 1.0 : 0.95 + Math.random() * 0.04; // Winner at 1, others close but not quite
            return m;
          }, {});
          io.to("globalRaceRoom").emit("raceProgress", {
            raceId,
            positions: finalPositions,
          });

          // Emit results
          io.to("globalRaceRoom").emit("raceResult", {
            raceResult: raceResult.toObject(),
            serverSeed,
          });
          activeRaces.delete(raceId);

          setTimeout(() => {
            io.to("globalRaceRoom").emit("raceState", {
              phase: "intermission",
            });
          }, 5000); // Extended to 15 seconds for verification

          // Kick off the next race
          setTimeout(startRaceLoop, 15000);
        } catch (e) {
          console.error(`Error in racing phase for race ${raceId}:`, e);
          if (session) {
            await session
              .abortTransaction()
              .catch((err) =>
                console.error(`Abort transaction failed for ${raceId}:`, err)
              );
            session.endSession();
          }
          activeRaces.delete(raceId);
        }
      }, raceDur);
    }
  } catch (e) {
    console.error(`Error scheduling race ${raceId}:`, e);
    activeRaces.delete(raceId);
    if (session) {
      await session
        .abortTransaction()
        .catch((err) =>
          console.error(`Abort transaction failed for ${raceId}:`, err)
        );
      session.endSession();
    }
  }
}

module.exports = { scheduleRace };
