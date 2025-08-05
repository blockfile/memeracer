import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, useAnimation } from "framer-motion";
import axios from "axios";
import { io } from "socket.io-client";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  SendTransactionError,
} from "@solana/web3.js";
import Navbar from "../Navbar/Navbar";
import bs58 from "bs58";

// SPRITES
import pepeSpriteSheet from "../../assets/images/pepe_sprite_sheet.png";
import wojakSpriteSheet from "../../assets/images/a.png";
import dogeSpriteSheet from "../../assets/images/a2.png";
import chadSpriteSheet from "../../assets/images/a3_sprite_sheet.png";
import miladySpriteSheet from "../../assets/images/a4.png";

// ICONS
import icon1 from "../../assets/images/1.png";
import icon2 from "../../assets/images/2.png";
import icon3 from "../../assets/images/3.png";
import icon4 from "../../assets/images/4.png";
import icon5 from "../../assets/images/5.png";

// GIFs
import pepeGif from "../../assets/gifs/pepe-run.gif";
import aGif from "../../assets/gifs/a.gif";
import a2Gif from "../../assets/gifs/a2.gif";
import a3Gif from "../../assets/gifs/a3.gif";
import a4Gif from "../../assets/gifs/a4.gif";

// BACKGROUND
import bgImage from "../../assets/images/bg.jpg";

const BACKEND_URL = process.env.REACT_APP_API_BASE || "http://localhost:3001";
const SOLANA_RPC_URL =
  process.env.REACT_APP_SOLANA_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

const socket = io(BACKEND_URL, { autoConnect: false });

const racers = [
  { name: "Pepe", gif: pepeGif, icon: icon1 },
  { name: "Wojak", gif: aGif, icon: icon2 },
  { name: "Doge", gif: a2Gif, icon: icon3 },
  { name: "Chad", gif: a3Gif, icon: icon4 },
  { name: "Milady", gif: a4Gif, icon: icon5 },
];

const spriteMap = {
  Pepe: { sheet: pepeSpriteSheet, frameWidth: 112, totalFrames: 6 },
  Wojak: { sheet: wojakSpriteSheet, frameWidth: 112, totalFrames: 31 },
  Doge: { sheet: dogeSpriteSheet, frameWidth: 112, totalFrames: 31 },
  Chad: { sheet: chadSpriteSheet, frameWidth: 112, totalFrames: 30 },
  Milady: { sheet: miladySpriteSheet, frameWidth: 112, totalFrames: 34 },
};

const RAW_PROBS = { 5: 0.05, 4: 0.1, 3: 0.3, 2: 0.7 };
function getWeightForMultiplier(m) {
  return Math.pow(RAW_PROBS[m] || 0, 2);
}
function getRaceMultipliers() {
  const pool = [5, 4, 3, 2, 2];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return racers.reduce((m, r, i) => ({ ...m, [r.name]: pool[i] }), {});
}

const PHASES = {
  READY: "ready",
  BETTING: "betting",
  RACING: "racing",
};

const multiplierStyles = {
  2: {
    bg: "rgba(20,60,100,0.9)",
    border: "#4fb5ff",
    text: "#4fb5ff",
  },
  3: {
    bg: "rgba(80,30,40,0.9)",
    border: "#ff7171",
    text: "#ff7171",
  },
  4: {
    bg: "rgba(60,30,90,0.9)",
    border: "#bb35ff",
    text: "#bb35ff",
  },
  5: {
    bg: "rgba(70,40,30,0.9)",
    border: "#ffb84d",
    text: "#ffb84d",
  },
};

function badgeCss(mult) {
  if (typeof mult === "number" && multiplierStyles[mult]) {
    const { bg, border, text } = multiplierStyles[mult];
    return {
      backgroundColor: bg,
      border: `2px solid ${border}`,
      color: text,
    };
  }
  return {
    backgroundColor: "rgba(60,60,90,0.9)",
    border: "2px solid rgba(120,120,140,0.4)",
    color: "#fff",
  };
}

export default function RaceWithBetting() {
  const canvasRef = useRef(null);
  const boxRef = useRef(null);

  const [phase, setPhase] = useState(PHASES.READY);
  const [betCountdown, setBetCountdown] = useState(0);
  const [readyCountdown, setReadyCountdown] = useState(5);
  const [bets, setBets] = useState(() =>
    racers.reduce((acc, r) => ({ ...acc, [r.name]: "" }), {})
  );
  const [placedBets, setPlacedBets] = useState({});
  const [bettingMultipliers, setBettingMultipliers] = useState(null);
  const [raceId, setRaceId] = useState(null);
  const [winner, setWinner] = useState(null);
  const [winnerIcon, setWinnerIcon] = useState(null);
  const [laneHeights, setLaneHeights] = useState([]);
  const [history, setHistory] = useState([]);
  const [isRacing, setIsRacing] = useState(false);
  const [liveBets, setLiveBets] = useState([]);
  const [walletAddress, setWalletAddress] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const countdownRef = useRef(null);
  const animRef = useRef(null);
  const speedJitterTimerRef = useRef(null);
  const hasSubmittedRef = useRef(false);
  const bettingMultipliersRef = useRef(null);
  const prevLeaderRef = useRef(-1);
  const spinTimersRef = useRef(racers.map(() => 0));

  const trackControls = useAnimation();
  const winnerControls = useAnimation();

  const solConnectionRef = useRef(null);

  const getSolConnection = () => {
    if (!solConnectionRef.current) {
      solConnectionRef.current = new Connection(SOLANA_RPC_URL, "confirmed");
    }
    return solConnectionRef.current;
  };

  const fetchHistory = useCallback(async () => {
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/race/history`);
      setHistory(data);
    } catch (e) {
      console.warn("Failed to fetch history", e);
    }
  }, []);

  const startReadyPhase = useCallback(async () => {
    setPhase(PHASES.READY);
    setReadyCountdown(5);
    setBettingMultipliers(null);
    setRaceId(null);
    setWinner(null);
    setWinnerIcon(null);
    setIsRacing(false);
    hasSubmittedRef.current = false;
    setPlacedBets({});
    setBets(racers.reduce((acc, r) => ({ ...acc, [r.name]: "" }), {}));

    const multipliers = getRaceMultipliers();
    const newRaceId = `race_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 8)}`;

    try {
      await axios.post(`${BACKEND_URL}/api/race/init`, {
        raceId: newRaceId,
        multipliers,
      });
      setRaceId(newRaceId);
    } catch (e) {
      console.error("Failed to init race in DB", e);
      return;
    }

    let t = 5;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      t--;
      setReadyCountdown(t);
      if (t <= 0) {
        clearInterval(countdownRef.current);
        setPhase(PHASES.BETTING);
      }
    }, 1000);
  }, []);

  useEffect(() => {
    if (phase !== PHASES.BETTING || !raceId) return;
    setBetCountdown(20);
    setPlacedBets({});
    setBets(racers.reduce((acc, r) => ({ ...acc, [r.name]: "" }), {}));

    axios
      .get(`${BACKEND_URL}/api/race/init/${raceId}`)
      .then((res) => {
        setBettingMultipliers(res.data.multipliers);
        bettingMultipliersRef.current = res.data.multipliers;
      })
      .catch((e) => {
        setBettingMultipliers(null);
        bettingMultipliersRef.current = null;
        console.error("Failed to fetch multipliers from DB", e);
      });

    let t = 20;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      t--;
      setBetCountdown(t);
      if (t <= 0) {
        clearInterval(countdownRef.current);
        setPhase(PHASES.RACING);
      }
    }, 1000);
  }, [phase, raceId]);

  const submitResult = useCallback(
    async (payload) => {
      try {
        const { data } = await axios.post(
          `${BACKEND_URL}/api/race/result`,
          payload
        );
        await fetchHistory();
        socket.emit("raceResult", { raceResult: data.raceResult || data });
      } catch (err) {
        console.error("Failed to save race result", err);
      }
    },
    [fetchHistory]
  );

  // wallet connect (minimal)
  const connectWallet = useCallback(async () => {
    if (!window.solana || !window.solana.isPhantom) {
      alert("Install Phantom wallet");
      return;
    }
    try {
      const resp = await window.solana.connect();
      setWalletAddress(resp.publicKey.toString());
    } catch (e) {
      console.warn("Wallet connect failed", e);
    }
  }, []);

  // handle placing bet with duplicate-send protection and "already processed" recovery
  const placeBetOnchain = useCallback(
    async (targetName) => {
      if (phase !== PHASES.BETTING) return;
      if (isSubmitting) return; // guard
      if (!walletAddress) {
        await connectWallet();
        if (!window.solana?.publicKey) return;
      }
      const amountStr = bets[targetName];
      if (!amountStr || Number(amountStr) <= 0) return;
      const amount = Number(amountStr);
      const multiplier = bettingMultipliers?.[targetName] || 0;

      setIsSubmitting(true);
      let signature = null;

      try {
        const connection = getSolConnection();
        const fromPubkey = window.solana.publicKey;
        const toPubkey = new PublicKey(
          "6nE2nkQ4RzHaSx5n2MMBW5f9snevNs8wLBzLmLyrTCnu"
        );
        const lamports = Math.round(amount * 1e9);

        const transferIx = SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports,
        });

        const tx = new Transaction().add(transferIx);
        tx.feePayer = fromPubkey;
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        const signed = await window.solana.signTransaction(tx);

        try {
          signature = await connection.sendRawTransaction(signed.serialize());
          await connection.confirmTransaction(signature, "confirmed");
        } catch (err) {
          // handle already processed
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("already been processed")) {
            // try to recover signature from signed transaction if available
            const possibleSig = signed.signatures?.[0]?.signature
              ? bs58.encode(signed.signatures[0].signature)
              : null;
            if (possibleSig) {
              const txInfo = await connection.getTransaction(possibleSig, {
                commitment: "confirmed",
              });
              if (txInfo && !txInfo.meta?.err) {
                signature = possibleSig;
                console.log("Recovered already-processed tx:", signature);
              } else {
                throw err; // fallback real failure
              }
            } else {
              // unknown signature, rethrow
              throw err;
            }
          } else {
            throw err;
          }
        }

        if (!signature) {
          throw new Error("No signature obtained");
        }

        const res = await axios.post(`${BACKEND_URL}/api/race/bet/submit`, {
          bettorWallet: window.solana.publicKey.toString(),
          targetName,
          amount,
          raceId,
          txSignature: signature,
          multiplier,
        });

        if (res.data.success) {
          setPlacedBets((p) => ({ ...p, [targetName]: amount }));
          setBets((b) => ({ ...b, [targetName]: "" }));
          const betEvent = {
            raceId,
            bettorWallet: window.solana.publicKey.toString(),
            targetName,
            amount,
            txSignature: signature,
            multiplier,
          };
          socket.emit("betPlaced", betEvent);
          setLiveBets((lb) => [betEvent, ...lb].slice(0, 100));
        }
      } catch (e) {
        console.error("placeBetOnchain error", e);
        alert("Bet failed: " + (e?.message || "unknown"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      bets,
      bettingMultipliers,
      phase,
      raceId,
      walletAddress,
      connectWallet,
      isSubmitting,
    ]
  );

  useEffect(() => {
    socket.connect();
    socket.on("betPlaced", (b) => {
      setLiveBets((lb) => [b, ...lb].slice(0, 100));
    });
    socket.on("raceResult", ({ raceResult }) => {
      setHistory((h) => [raceResult, ...h].slice(0, 50));
    });
    return () => {
      socket.off("betPlaced");
      socket.off("raceResult");
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    bettingMultipliersRef.current = bettingMultipliers;
  }, [bettingMultipliers]);

  useEffect(() => {
    startReadyPhase();
    fetchHistory();
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (speedJitterTimerRef.current)
        clearInterval(speedJitterTimerRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [startReadyPhase, fetchHistory]);

  useEffect(() => {
    if (winner) {
      winnerControls.start({
        scale: [0.8, 1.1, 1],
        opacity: [0, 1, 1],
        transition: { duration: 0.5 },
      });
    }
  }, [winner, winnerControls]);

  useEffect(() => {
    if (phase !== PHASES.RACING || !raceId) return;
    setIsRacing(true);
    setWinner(null);
    setWinnerIcon(null);

    const canvas = canvasRef.current;
    if (!canvas || !boxRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = (canvas.width = boxRef.current.clientWidth);
    const H = (canvas.height = boxRef.current.clientHeight);
    const laneH = H / racers.length;
    const spriteSz = Math.min(85, laneH * 0.8);
    const finishX1 = W - 48;
    const raceDur = 15;
    const t0 = Date.now();

    let frameCt = 0,
      curFrame = 0;
    const positions = racers.map(() => 0);
    const baseSpeed = (finishX1 - spriteSz * 2) / (raceDur * 60);
    const effectiveMultipliers =
      bettingMultipliersRef.current || getRaceMultipliers();

    let speeds = racers.map((r) => {
      const mult = effectiveMultipliers[r.name] || 2;
      const speedFactor = 1 / Math.pow(mult, 0.3);
      const jitter = 0.9 + Math.random() * 0.2;
      const raw = baseSpeed * speedFactor * jitter;
      return Math.max(raw, baseSpeed * 0.25);
    });

    const adjustSpeeds = () => {
      speeds = speeds.map((s) =>
        Math.max(s * (0.98 + Math.random() * 0.04), baseSpeed * 0.25)
      );
    };
    speedJitterTimerRef.current = setInterval(adjustSpeeds, 2000);

    const loaded = {};
    let loadedCt = 0;
    let particles = [];
    let winnerIdx = -1;

    racers.forEach((r) => {
      const img = new window.Image();
      img.src = spriteMap[r.name].sheet;
      img.onload = () => {
        loaded[r.name] = img;
        loadedCt++;
        if (loadedCt === racers.length) {
          requestAnimationFrame(draw);
        }
      };
      img.onerror = () => console.warn("sprite load fail", r.name);
    });

    function draw() {
      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < racers.length; i++) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle =
          i % 2 === 0 ? "rgba(138,43,226,0.8)" : "rgba(30,144,255,0.8)";
        ctx.fillRect(0, i * laneH, W, laneH);
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      for (let i = 1; i < racers.length; i++) {
        const y = i * laneH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.restore();

      const pulse = 0.5 + 0.5 * Math.sin(((Date.now() - t0) / 1000) * 4);
      ctx.save();
      ctx.lineWidth = 8;
      ctx.setLineDash([18, 10]);
      ctx.strokeStyle = `rgba(255,215,0,${pulse})`;
      [finishX1, finishX1 + 20].forEach((fx) => {
        ctx.beginPath();
        ctx.moveTo(fx, 0);
        ctx.lineTo(fx, H);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.restore();

      racers.forEach((r, i) => {
        positions[i] += speeds[i];
      });

      let currentLeader = -1;
      let maxPos = -Infinity;
      positions.forEach((p, i) => {
        if (p > maxPos) {
          maxPos = p;
          currentLeader = i;
        }
      });
      if (
        prevLeaderRef.current !== -1 &&
        prevLeaderRef.current !== currentLeader
      ) {
        spinTimersRef.current[prevLeaderRef.current] = 30;
      }
      prevLeaderRef.current = currentLeader;

      if (frameCt % 120 === 0 && frameCt !== 0) {
        speeds = speeds.map((s) => {
          const factor = 0.5 + Math.random();
          return Math.max(
            Math.min(s * factor, baseSpeed * 2),
            baseSpeed * 0.25
          );
        });
      }

      if (winnerIdx < 0) {
        const crossed = racers
          .map((r, i) => ({
            i,
            crossed: positions[i] + spriteSz >= finishX1,
          }))
          .filter((x) => x.crossed);
        if (crossed.length) {
          const weights = crossed.map(({ i }) =>
            getWeightForMultiplier(effectiveMultipliers[racers[i].name])
          );
          const total = weights.reduce((a, b) => a + b, 0);
          let r = Math.random() * total;
          let idx = -1;
          for (let k = 0; k < crossed.length; ++k) {
            if (r < weights[k]) {
              idx = crossed[k].i;
              break;
            }
            r -= weights[k];
          }
          winnerIdx = idx === -1 ? crossed[0].i : idx;
        }
      }

      racers.forEach((r, i) => {
        const sprite = loaded[r.name];
        if (!sprite) return;
        const x = positions[i];
        const y = i * laneH + (laneH - spriteSz) / 2;

        ctx.save();
        const len = 10 + Math.abs(speeds[i]) * 8;
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.moveTo(x, y + spriteSz / 2);
        ctx.lineTo(x - len, y + spriteSz / 2 - 5);
        ctx.stroke();
        ctx.restore();

        const spinRemaining = spinTimersRef.current[i];
        let angle = 0;
        if (spinRemaining > 0) {
          const progress = (30 - spinRemaining + 1) / 30;
          angle = progress * Math.PI * 2;
          spinTimersRef.current[i] = spinRemaining - 1;
        }

        ctx.save();
        ctx.translate(x + spriteSz / 2, y + spriteSz / 2);
        if (angle !== 0) ctx.rotate(angle);
        ctx.globalAlpha = 1;
        ctx.drawImage(
          sprite,
          (curFrame % spriteMap[r.name].totalFrames) *
            spriteMap[r.name].frameWidth,
          0,
          spriteMap[r.name].frameWidth,
          spriteMap[r.name].frameWidth,
          -spriteSz / 2,
          -spriteSz / 2,
          spriteSz,
          spriteSz
        );
        ctx.restore();

        particles.push({
          x: x + spriteSz / 2,
          y: y + spriteSz,
          alpha: 1,
          vx: Math.random() - 0.5,
          vy: -2,
        });
      });

      ctx.save();
      particles.forEach((p) => {
        ctx.fillStyle = `rgba(255,215,0,${p.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.02;
      });
      ctx.restore();
      particles = particles.filter((p) => p.alpha > 0);

      frameCt++;
      if (frameCt % 5 === 0) curFrame++;
      if (frameCt % 180 === 0) {
        speeds = speeds.map((s) =>
          Math.max(s * (0.98 + Math.random() * 0.04), baseSpeed * 0.25)
        );
      }

      if (winnerIdx >= 0) {
        const winName = racers[winnerIdx].name;
        const winGif = racers[winnerIdx].gif;
        const winningMultiplier = effectiveMultipliers[winName];

        setWinner(winName);
        setWinnerIcon(winGif);
        setIsRacing(false);

        if (!hasSubmittedRef.current) {
          hasSubmittedRef.current = true;

          const winnerWalletAddress = "UNKNOWN";
          const losers = racers
            .filter((_, i) => i !== winnerIdx)
            .map((r) => ({
              name: r.name,
              walletAddress: "UNKNOWN",
              multiplier: effectiveMultipliers[r.name],
            }));

          const currentBettorWallet =
            window?.solana?.publicKey?.toString() || "unknown_bettor";
          const betsArray = Object.entries(placedBets).map(
            ([targetName, amount]) => {
              const multiplier = effectiveMultipliers[targetName];
              const won = targetName === winName;
              return {
                bettorWallet: currentBettorWallet,
                targetName,
                amount: Number(amount),
                multiplier,
                payout: won ? Number(amount) * multiplier : 0,
                won,
              };
            }
          );

          const payload = {
            raceId,
            multipliers: effectiveMultipliers,
            winner: {
              name: winName,
              walletAddress: winnerWalletAddress,
              multiplier: winningMultiplier,
            },
            losers,
            bets: betsArray,
          };

          submitResult(payload).then(() => {
            setTimeout(() => {
              startReadyPhase();
            }, 3000);
          });
        }

        return;
      }

      animRef.current = requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      if (speedJitterTimerRef.current)
        clearInterval(speedJitterTimerRef.current);
    };
  }, [phase, raceId, placedBets, startReadyPhase, fetchHistory, submitResult]);

  useEffect(() => {
    if (!boxRef.current) return;
    const observer = new ResizeObserver(() => {
      if (canvasRef.current && boxRef.current) {
        canvasRef.current.width = boxRef.current.clientWidth;
        canvasRef.current.height = boxRef.current.clientHeight;
      }
    });
    observer.observe(boxRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function updateLaneHeights() {
      if (!boxRef.current) return;
      const H = boxRef.current.clientHeight;
      const laneH = H / racers.length;
      setLaneHeights(racers.map((_, i) => ({ top: i * laneH, height: laneH })));
    }
    updateLaneHeights();
    window.addEventListener("resize", updateLaneHeights);
    return () => window.removeEventListener("resize", updateLaneHeights);
  }, []);

  const handleBetChange = (name, value) => {
    if (!/^\d*$/.test(value)) return;
    setBets((b) => ({ ...b, [name]: value }));
  };
  const placeBet = (name) => {
    placeBetOnchain(name);
  };

  const displayRacers = React.useMemo(
    () =>
      racers.map((r) => ({
        ...r,
        multiplier: bettingMultipliers?.[r.name] || "?",
      })),
    [bettingMultipliers]
  );
  const reversedIcons = React.useMemo(
    () => racers.map((r) => r.icon).reverse(),
    []
  );

  return (
    <div
      className="race-stage min-h-screen flex flex-col items-center relative font-spacemono"
      style={{
        backgroundImage: `url(${bgImage})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <Navbar />

      {/* Track */}
      <div className="w-full flex justify-center px-4 mt-4 ">
        <div
          className="relative w-full max-w-[2400px] h-[50vh] md:h-[60vh] flex items-center  "
          ref={(el) => {
            boxRef.current = el;
          }}
        >
          <div className="absolute inset-0 pointer-events-none  ">
            {laneHeights.length === displayRacers.length &&
              displayRacers.map((r, i) => (
                <div
                  key={r.name}
                  className="absolute text-white font-bold text-xs md:text-2xl "
                  style={{
                    top: laneHeights[i].top + laneHeights[i].height / 2,
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    width: 120,
                    textAlign: "center",
                    textShadow: "0 0 8px rgba(0,0,0,0.7)",
                  }}
                >
                  {r.name}
                </div>
              ))}
          </div>

          <motion.canvas
            ref={(el) => {
              canvasRef.current = el;
            }}
            className="race-canvas rounded-md shadow-lg "
            style={{ zIndex: 20, width: "100%", height: "100%" }}
            animate={trackControls}
          />

          {/* Overlays */}
          {phase === PHASES.READY && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-40 pointer-events-none">
              <div className="bg-[rgba(10,10,10,0.7)] rounded-2xl p-6 flex flex-col items-center gap-2">
                <div className="text-xl font-semibold text-white">
                  Getting Ready...
                </div>
                <div className="text-sm text-gray-200">
                  Starting soon: {readyCountdown}s
                </div>
              </div>
            </div>
          )}
          {phase === PHASES.BETTING && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-40 pointer-events-none">
              <div className="bg-[rgba(10,10,10,0.7)] rounded-2xl p-6 flex flex-col items-center gap-2">
                <div className="text-2xl font-bold text-white flex items-center gap-2">
                  🎯 Betting Phase
                </div>
                <div className="text-sm text-gray-200">
                  Ends in: {betCountdown}s
                </div>
              </div>
            </div>
          )}
          {winner && !isRacing && phase === PHASES.RACING && (
            <div className="absolute inset-0 flex items-center justify-center z-40 pointer-events-none">
              <div className="absolute inset-0 bg-black/60" />
              <motion.div
                className="relative"
                initial={{ scale: 0.85, opacity: 0 }}
                animate={winnerControls}
              >
                <div className="bg-[rgba(10,10,10,0.9)] rounded-2xl p-6 flex flex-col items-center gap-3 shadow-xl">
                  <div className="flex items-center gap-2 text-2xl font-bold text-white">
                    <span role="img" aria-label="trophy">
                      🏆
                    </span>
                    {winner} Wins!
                  </div>
                  {winnerIcon && (
                    <img
                      src={winnerIcon}
                      alt="Winner GIF"
                      className="winner-img-large w-24 h-auto rounded"
                    />
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </div>
      </div>

      {/* Betting + History */}
      <div className="bet-history-wrapper w-full flex flex-col lg:flex-row gap-4 px-4 mt-6 max-w-[1400px]">
        <div className="betting-panel flex-1 bg-[rgba(24,24,40,0.95)] border border-gray-700 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex flex-wrap justify-between items-center mb-1">
            <div className="font-semibold text-sm text-white">
              {phase === PHASES.READY
                ? "Getting Ready..."
                : phase === PHASES.BETTING
                ? `Betting ends in: ${betCountdown}s`
                : isRacing
                ? "Race in progress – betting locked"
                : winner
                ? `Winner: ${winner}`
                : "Waiting..."}
            </div>
            <div className="text-xs text-gray-300">
              Place your bets for the next race
            </div>
          </div>

          <div className="bet-grid relative flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-[rgba(24,24,40,0.95)] to-transparent" />
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-[rgba(24,24,40,0.95)] to-transparent" />

            {displayRacers.map((r, i) => (
              <div
                key={r.name}
                className="bet-card flex-shrink-0 snap-start bg-[rgba(40,40,70,0.93)] border border-gray-600 rounded-lg p-2 min-w-[120px] sm:min-w-[140px] flex flex-col items-center relative"
                aria-label={`Bet card for ${r.name}`}
              >
                <img
                  src={reversedIcons[i]}
                  alt={r.name}
                  className="bet-icon w-10 h-10 rounded-full border-2 border-white object-cover"
                />
                <div
                  className="bet-multiplier mt-1 px-2 py-1 rounded-full font-bold text-xs"
                  style={badgeCss(
                    typeof r.multiplier === "number" ? r.multiplier : null
                  )}
                  title={r.multiplier ? `${r.multiplier}x payout` : "loading"}
                >
                  x{r.multiplier}
                </div>
                <div className="bet-controls flex flex-col gap-1 w-full mt-2">
                  <input
                    type="text"
                    placeholder="Amount"
                    value={bets[r.name]}
                    onChange={(e) => handleBetChange(r.name, e.target.value)}
                    disabled={phase !== PHASES.BETTING || isSubmitting}
                    className="bg-[#1e1e35] text-white rounded px-2 py-1 text-xs outline-none border border-gray-600 w-full"
                  />
                  <button
                    onClick={() => placeBet(r.name)}
                    disabled={phase !== PHASES.BETTING || isSubmitting}
                    className="bg-purple-600 text-white rounded py-1 text-[10px] font-semibold disabled:opacity-50 w-full"
                  >
                    {isSubmitting ? "Submitting..." : "Bet"}
                  </button>
                </div>
                {placedBets[r.name] != null && placedBets[r.name] > 0 && (
                  <div className="placed absolute bottom-1 text-[10px] bg-[rgba(0,0,0,0.6)] px-2 py-1 rounded text-white">
                    <div>Bet: {placedBets[r.name]}</div>
                    {phase === PHASES.BETTING && (
                      <div className="mult-preview">
                        Payout:{" "}
                        {(
                          placedBets[r.name] *
                          (typeof r.multiplier === "number" ? r.multiplier : 0)
                        ).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {liveBets.length > 0 && (
            <div className="mt-2 bg-[rgba(0,0,0,0.3)] rounded p-2 text-xs text-white overflow-y-auto max-h-32">
              <div className="font-semibold mb-1">Live Bets</div>
              {liveBets.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between mb-1">
                  <div>
                    {b.bettorWallet?.slice(0, 4)}…{b.bettorWallet?.slice(-4)} →{" "}
                    {b.targetName}
                  </div>
                  <div>{b.amount} SOL</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="history-box w-full lg:w-[320px] bg-[rgba(24,24,40,0.95)] border border-gray-700 rounded-lg p-4 flex flex-col gap-2">
          <div className="history-header flex justify-between items-center font-bold text-sm text-white">
            <div>History</div>
          </div>
          <div className="history-list flex flex-col gap-2 overflow-y-auto max-h-[280px]">
            {history.length === 0 && (
              <div className="history-empty italic text-gray-400">
                No races yet
              </div>
            )}
            {history.map((h, idx) => (
              <div
                key={idx}
                className="history-item bg-[rgba(40,40,70,0.9)] rounded-md p-2 flex items-center gap-2 text-xs"
              >
                <div className="history-time flex-[0_0_60px] text-gray-400">
                  {h.timestamp
                    ? new Date(h.timestamp).toLocaleTimeString("en-US", {
                        hour12: false,
                      })
                    : h.createdAt
                    ? new Date(h.createdAt).toLocaleTimeString("en-US", {
                        hour12: false,
                      })
                    : "-"}
                </div>
                <div className="history-winner flex-1 font-semibold text-white">
                  {h.winner?.name || "Unknown"}
                </div>
                <div
                  className="history-multiplier px-2 py-1 rounded-full text-[10px] font-bold"
                  style={
                    typeof h.winner?.multiplier === "number"
                      ? badgeCss(h.winner.multiplier)
                      : {
                          backgroundColor: "rgba(80,80,100,0.9)",
                          border: "1px solid rgba(120,120,140,0.5)",
                          color: "#fff",
                        }
                  }
                >
                  x{h.winner?.multiplier || "?"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
