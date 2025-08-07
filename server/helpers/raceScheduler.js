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
  return RAW_PROBS[m] || 0.349; // Use adjusted probability
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
  const useSpecialPool = random < 0.3; // 30% chance for [2, 2, 3, 3, 4/5]

  let basePool;
  if (useSpecialPool) {
    const high = random < 0.5 ? 5 : 4; // 50% chance for 5x, 50% for 4x
    basePool = [2, 2, 3, 3, high];
  } else {
    basePool = [2, 3, 4, 5, 2]; // Default balanced pool
  }

  for (let i = basePool.length - 1; i > 0; i--) {
    const j = Math.floor(
      getProvablyFairRandom(serverSeed, clientSeed, raceId, i) * (i + 1)
    );
    [basePool[i], basePool[j]] = [basePool[j], basePool[i]];
  }

  return racers.reduce((m, r, i) => ({ ...m, [r.name]: basePool[i] }), {});
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
      serverSeedHash: serverSeedHash || race.serverSeedHash,
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
              serverSeed: serverSeed || race.serverSeed,
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
    // Racing phase
    else if (race.phase === "racing") {
      const raceDur = 15000; // 15 seconds
      const t0 = Date.now();
      const frameDelta = Math.floor(1000 / 60); // 60 FPS updates
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

      // Provably fair scenario selection (0,1,2)
      const scenarioRandom = getProvablyFairRandom(
        race.serverSeed,
        clientSeed,
        race.raceId,
        "scenario"
      );
      const scenario = Math.floor(scenarioRandom * 3);

      // Provably fair false leader for scenarios that need it (not the winner)
      let falseLeaderIndex = -1;
      if (scenario === 1) {
        const falseLeaderRandom = getProvablyFairRandom(
          race.serverSeed,
          clientSeed,
          race.raceId,
          "false_leader"
        );
        falseLeaderIndex = Math.floor(falseLeaderRandom * (racers.length - 1));
        if (falseLeaderIndex >= winnerIndex) falseLeaderIndex++;
      }

      // Set base speeds
      let baseSpeeds = racers.map(() => 0.9 + Math.random() * 0.2); // Random base speed between 0.9 and 1.1
      baseSpeeds[winnerIndex] = Math.max(...baseSpeeds) + 0.1;
      const newMaxBaseSpeed = Math.max(...baseSpeeds);
      baseSpeeds = baseSpeeds.map((s) => s / newMaxBaseSpeed);

      // Scenario-specific logic
      let earlyFactors = new Array(racers.length).fill(1.0);
      let lateFactors = new Array(racers.length).fill(1.0);
      let switchPoint = 0.6;

      if (scenario === 0) {
        // Scenario 0: Winner slow start, boost end
        earlyFactors[winnerIndex] = 0.8; // Slow early
        lateFactors[winnerIndex] = 1.5; // Boost late
      } else if (scenario === 1) {
        // Scenario 1: False leader leads early, winner overtakes
        earlyFactors[falseLeaderIndex] = 1.3; // False leader fast early
        lateFactors[falseLeaderIndex] = 0.8; // False leader slows late
        lateFactors[winnerIndex] = 1.3; // Winner boost late
      } else if (scenario === 2) {
        // Scenario 2: Close race, winner gradual pull ahead with jitter
        switchPoint = 0.4; // Earlier switch for gradual pull
        earlyFactors = earlyFactors.map(
          (f, i) => f * (0.95 + Math.random() * 0.1)
        ); // Small jitter early
        lateFactors[winnerIndex] = 1.2; // Winner slight advantage late
        lateFactors = lateFactors.map((f, i) =>
          i !== winnerIndex ? f * (0.9 + Math.random() * 0.1) : f
        ); // Jitter for others late
      }

      const progressInterval = setInterval(() => {
        const timeElapsed = Date.now() - t0;
        if (timeElapsed < raceDur) {
          const progressFraction = timeElapsed / raceDur;
          const earlyP = Math.min(progressFraction / switchPoint, 1);
          const lateP = Math.max(
            (progressFraction - switchPoint) / (1 - switchPoint),
            0
          );
          positions = baseSpeeds.map(
            (s, i) =>
              s *
              (earlyFactors[i] * earlyP * switchPoint +
                lateFactors[i] * lateP * (1 - switchPoint)) *
              1.1
          );
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
            serverSeed: serverSeed,
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
