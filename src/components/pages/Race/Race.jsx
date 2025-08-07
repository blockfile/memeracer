// RaceWithBetting.jsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, useAnimation } from "framer-motion";
import axios from "axios";
import { io } from "socket.io-client";
import { sha256 } from "js-sha256";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
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
const TOKEN_MINT_ADDRESS = "8h9iB1HT4WPW3vzFUBHW9m4brea7a8tJwkZh2boHH1y4";
const TREASURY_ADDRESS = "6nE2nkQ4RzHaSx5n2MMBW5f9snevNs8wLBzLmLyrTCnu";

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

const RAW_PROBS = { 5: 0.15, 4: 0.18, 3: 0.25, 2: 0.4 };
function getWeightForMultiplier(m) {
  return 1 / (RAW_PROBS[m] || 0.4);
}

function getProvablyFairRandom(serverSeed, clientSeed, raceId, nonce) {
  const input = `${serverSeed}:${clientSeed}:${raceId}:${nonce}`;
  const hash = sha256(input);
  return parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

function getRaceMultipliers(serverSeed, clientSeed, raceId) {
  const basePool = [2, 2, 2, 3];
  const random = getProvablyFairRandom(
    serverSeed,
    clientSeed,
    raceId,
    "high_multiplier"
  );
  const high = random < 0.1 ? 5 : 4;
  const pool = [...basePool, high];
  for (let i = pool.length - 1; i > 0; i--) {
    const random = getProvablyFairRandom(serverSeed, clientSeed, raceId, i);
    const j = Math.floor(random * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return racers.reduce((m, r, i) => ({ ...m, [r.name]: pool[i] }), {});
}

function verifyRaceOutcome(
  raceId,
  serverSeed,
  multipliers,
  winner,
  serverSeedHash
) {
  const clientSeed = raceId;
  const computedHash = sha256(serverSeed);
  if (computedHash !== serverSeedHash) {
    return { valid: false, message: "Server seed hash does not match" };
  }
  const computedMultipliers = getRaceMultipliers(
    serverSeed,
    clientSeed,
    raceId
  );
  if (JSON.stringify(computedMultipliers) !== JSON.stringify(multipliers)) {
    return { valid: false, message: "Multipliers do not match" };
  }
  const weights = racers.map((r) =>
    getWeightForMultiplier(computedMultipliers[r.name])
  );
  const total = weights.reduce((a, b) => a + b, 0);
  const random = getProvablyFairRandom(
    serverSeed,
    clientSeed,
    raceId,
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
  const computedWinner = idx === -1 ? racers[0].name : racers[idx].name;
  if (computedWinner !== winner) {
    return { valid: false, message: "Winner does not match" };
  }
  return { valid: true, message: "Race outcome verified" };
}

const PHASES = {
  READY: "ready",
  BETTING: "betting",
  RACING: "racing",
  INTERMISSION: "intermission",
};

const multiplierStyles = {
  2: { bg: "rgba(20,60,100,0.9)", border: "#4fb5ff", text: "#4fb5ff" },
  3: { bg: "rgba(80,30,40,0.9)", border: "#ff7171", text: "#ff7171" },
  4: { bg: "rgba(60,30,90,0.9)", border: "#bb35ff", text: "#bb35ff" },
  5: { bg: "rgba(70,40,30,0.9)", border: "#ffb84d", text: "#ffb84d" },
};

function badgeCss(mult) {
  if (typeof mult === "number" && multiplierStyles[mult]) {
    const { bg, border, text } = multiplierStyles[mult];
    return { backgroundColor: bg, border: `2px solid ${border}`, color: text };
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
  const [serverSeedHash, setServerSeedHash] = useState(null);
  const [serverSeed, setServerSeed] = useState(null);
  const [showVerification, setShowVerification] = useState(false);
  const [isWaitingForResult, setIsWaitingForResult] = useState(false);
  const [positions, setPositions] = useState(
    racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
  );

  const countdownRef = useRef(null);
  const animRef = useRef(null);
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

  const placeBetOnchain = useCallback(
    async (targetName) => {
      if (phase !== PHASES.BETTING || betCountdown <= 0) {
        alert("Cannot place bet: Betting phase closed or not started");
        return;
      }
      if (isSubmitting) {
        alert("Cannot place bet: Submission in progress");
        return;
      }
      if (!walletAddress) {
        await connectWallet();
        if (!window.solana?.publicKey) {
          alert("Cannot place bet: Wallet not connected");
          return;
        }
      }
      const amountStr = bets[targetName];
      if (!amountStr || Number(amountStr) <= 0) {
        alert(`Invalid bet amount for ${targetName}`);
        return;
      }
      const amount = Number(amountStr);
      const multiplier = bettingMultipliers?.[targetName];
      if (!multiplier) {
        alert(`No multiplier available for ${targetName}`);
        return;
      }
      if (!raceId) {
        alert("No active race ID");
        return;
      }

      setIsSubmitting(true);
      let signature = null;

      try {
        const connection = getSolConnection();
        const fromPubkey = window.solana.publicKey;
        const toPubkey = new PublicKey(TREASURY_ADDRESS);
        const tokenMint = new PublicKey(TOKEN_MINT_ADDRESS);

        const fromTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          fromPubkey
        );
        const toTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          toPubkey
        );

        const lamports = Math.round(amount * 1e9);

        const tx = new Transaction();

        try {
          await getAccount(connection, fromTokenAccount);
        } catch (e) {
          console.warn("Sender token account does not exist, creating...");
          tx.add(
            createAssociatedTokenAccountInstruction(
              fromPubkey,
              fromTokenAccount,
              fromPubkey,
              tokenMint
            )
          );
        }

        try {
          await getAccount(connection, toTokenAccount);
        } catch (e) {
          alert("Treasury token account not initialized");
          throw new Error("Treasury token account not initialized");
        }

        tx.add(
          createTransferInstruction(
            fromTokenAccount,
            toTokenAccount,
            fromPubkey,
            lamports,
            [],
            TOKEN_PROGRAM_ID
          )
        );
        tx.feePayer = fromPubkey;
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        const signed = await window.solana.signTransaction(tx);

        try {
          signature = await connection.sendRawTransaction(signed.serialize());
          await connection.confirmTransaction(signature, "confirmed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("already been processed")) {
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
                throw err;
              }
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }

        if (!signature) {
          throw new Error("No signature obtained");
        }

        const payload = {
          bettorWallet: window.solana.publicKey.toString(),
          targetName,
          amount,
          raceId,
          txSignature: signature,
          multiplier,
        };
        console.log("Submitting bet payload:", payload);

        const res = await axios
          .post(`${BACKEND_URL}/api/race/bet/submit`, payload, {
            headers: { "Content-Type": "application/json" },
          })
          .catch((err) => {
            console.error("Bet submission failed:", {
              status: err.response?.status,
              data: err.response?.data,
              message: err.message,
            });
            throw err;
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
          setLiveBets((lb) => [betEvent, ...lb].slice(0, 100));
        }
      } catch (e) {
        console.error("placeBetOnchain error", e);
        alert(
          `Bet failed: ${
            e.response?.data?.error || e.message || "Unknown error"
          }`
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      bets,
      bettingMultipliers,
      phase,
      betCountdown,
      raceId,
      walletAddress,
      connectWallet,
      isSubmitting,
    ]
  );

  useEffect(() => {
    socket.connect();
    socket.emit("getCurrentRace");
    socket.on("raceState", (raceState) => {
      console.log("Received raceState:", raceState);
      if (raceState.phase === PHASES.INTERMISSION) {
        // Reset states for intermission
        setPhase(PHASES.INTERMISSION);
        setRaceId(null);
        setBetCountdown(0);
        setReadyCountdown(0);
        setBettingMultipliers(null);
        setServerSeedHash(null);
        setIsRacing(false);
        setWinner(null);
        setPositions(racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {}));
        return;
      }
      setRaceId(raceState.raceId);
      setPhase(raceState.phase);
      setReadyCountdown(raceState.readyCountdown);
      setBetCountdown(raceState.betCountdown);
      setBettingMultipliers(raceState.multipliers);
      setServerSeedHash(raceState.serverSeedHash);

      if (countdownRef.current) clearInterval(countdownRef.current);
      if (raceState.phase === PHASES.READY && raceState.readyCountdown > 0) {
        let t = raceState.readyCountdown;
        countdownRef.current = setInterval(() => {
          t--;
          setReadyCountdown(t);
          if (t <= 0) {
            clearInterval(countdownRef.current);
          }
        }, 1000);
      } else if (
        raceState.phase === PHASES.BETTING &&
        raceState.betCountdown > 0
      ) {
        let t = raceState.betCountdown;
        countdownRef.current = setInterval(() => {
          t--;
          setBetCountdown(t);
          if (t <= 0) {
            clearInterval(countdownRef.current);
          }
        }, 1000);
      }
    });
    socket.on("raceStart", ({ raceId: incomingRaceId, serverSeed }) => {
      if (incomingRaceId === raceId) {
        setServerSeed(serverSeed);
        setIsRacing(true);
        setWinner(null);
        setWinnerIcon(null);
        setIsWaitingForResult(false);
        setPositions(racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {}));
      }
    });
    socket.on(
      "raceProgress",
      ({ raceId: incomingRaceId, positions: newPositions }) => {
        if (incomingRaceId === raceId) {
          setPositions(newPositions);
        }
      }
    );
    socket.on("betPlaced", (b) => {
      if (b.raceId === raceId) {
        setLiveBets((lb) => [b, ...lb].slice(0, 100));
      }
    });
    socket.on("raceResult", ({ raceResult, serverSeed }) => {
      if (raceResult.raceId === raceId) {
        setWinner(raceResult.winner.name);
        setWinnerIcon(
          racers.find((r) => r.name === raceResult.winner.name).gif
        );
        setServerSeed(serverSeed);
        setIsRacing(false);
        setIsWaitingForResult(false);
        setHistory((h) => [raceResult, ...h].slice(0, 50));
      }
    });
    return () => {
      socket.off("raceState");
      socket.off("raceStart");
      socket.off("raceProgress");
      socket.off("betPlaced");
      socket.off("raceResult");
      socket.disconnect();
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [raceId]);

  useEffect(() => {
    fetchHistory();
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [fetchHistory]);

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
    const canvas = canvasRef.current;
    if (!canvas || !boxRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = (canvas.width = boxRef.current.clientWidth);
    const H = (canvas.height = boxRef.current.clientHeight);
    const laneH = H / racers.length;
    const spriteSz = Math.min(85, laneH * 0.8);
    const finishX1 = W - 48;

    let frameCt = 0,
      curFrame = 0;
    let particles = [];

    const loaded = {};
    let loadedCt = 0;

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

      for (let laneIndex = 0; laneIndex < racers.length; laneIndex++) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle =
          laneIndex % 2 === 0 ? "rgba(138,43,226,0.8)" : "rgba(30,144,255,0.8)";
        ctx.fillRect(0, laneIndex * laneH, W, laneH);
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      for (let dividerIndex = 1; dividerIndex < racers.length; dividerIndex++) {
        const y = dividerIndex * laneH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.restore();

      const pulse = 0.5 + 0.5 * Math.sin((Date.now() / 1000) * 4);
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

      let currentLeader = -1;
      let maxPos = -Infinity;
      racers.forEach((r, i) => {
        const p = positions[r.name] * (finishX1 - spriteSz * 2);
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

      racers.forEach((r, racerIndex) => {
        const sprite = loaded[r.name];
        if (!sprite) return;
        const x = Math.min(
          positions[r.name] * (finishX1 - spriteSz * 2),
          finishX1 - spriteSz
        );
        const y = racerIndex * laneH + (laneH - spriteSz) / 2;

        ctx.save();
        const len = 10 + Math.abs(positions[r.name]) * 8;
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.moveTo(x, y + spriteSz / 2);
        ctx.lineTo(x - len, y + spriteSz / 2 - 5);
        ctx.stroke();
        ctx.restore();

        const spinRemaining = spinTimersRef.current[racerIndex];
        let angle = 0;
        if (spinRemaining > 0) {
          const progress = (30 - spinRemaining + 1) / 30;
          angle = progress * Math.PI * 2;
          spinTimersRef.current[racerIndex] = spinRemaining - 1;
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
      if (frameCt % 10 === 0) curFrame++; // Even slower frame change

      animRef.current = requestAnimationFrame(draw);
    }

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [phase, raceId, positions]);

  useEffect(() => {
    if (phase !== PHASES.RACING && canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }, [phase]);

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
      setLaneHeights(
        racers.map((_, laneIndex) => ({
          top: laneIndex * laneH,
          height: laneH,
        }))
      );
    }
    updateLaneHeights();
    window.addEventListener("resize", updateLaneHeights);
    return () => window.removeEventListener("resize", updateLaneHeights);
  }, []);

  const handleBetChange = (name, value) => {
    if (!/^\d*$/.test(value)) return;
    setBets((b) => ({ ...b, [name]: value }));
  };

  const displayRacers = React.useMemo(
    () =>
      racers.map((r) => ({
        ...r,
        multiplier: bettingMultipliers?.[r.name] || "?",
      })),
    [bettingMultipliers]
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
          className="relative w-full max-w-[2400px] h-[50vh] md:h-[60vh] flex items-center"
          ref={(el) => {
            boxRef.current = el;
          }}
        >
          <div className="absolute inset-0 pointer-events-none">
            {laneHeights.length === displayRacers.length &&
              displayRacers.map((r, i) => (
                <div
                  key={r.name}
                  className="absolute text-white font-bold text-xs md:text-2xl"
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
            className="race-canvas rounded-md shadow-lg"
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
          {isWaitingForResult && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-40 pointer-events-none">
              <div className="bg-[rgba(10,10,10,0.7)] rounded-2xl p-6 flex flex-col items-center gap-2">
                <div className="text-2xl font-bold text-white flex items-center gap-2">
                  Awaiting official results...
                </div>
              </div>
            </div>
          )}
          {phase === PHASES.INTERMISSION && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-40 pointer-events-none">
              <div className="bg-[rgba(10,10,10,0.7)] rounded-2xl p-6 flex flex-col items-center gap-2">
                <div className="text-xl font-semibold text-white">
                  Next race starting soon...
                </div>
                <div className="text-sm text-gray-200">Hang tight!</div>
              </div>
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
              Place your bets for the current race
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
                  src={r.icon}
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
                  {r.multiplier >= 3 && (
                    <span className="ml-1 text-yellow-400">★</span>
                  )}
                </div>
                <div className="bet-controls flex flex-col gap-1 w-full mt-2">
                  <input
                    type="text"
                    placeholder="Amount"
                    value={bets[r.name]}
                    onChange={(e) => handleBetChange(r.name, e.target.value)}
                    disabled={
                      phase !== PHASES.BETTING ||
                      betCountdown <= 0 ||
                      isSubmitting
                    }
                    className="bg-[#1e1e35] text-white rounded px-2 py-1 text-xs outline-none border border-gray-600 w-full"
                  />
                  <button
                    onClick={() => placeBetOnchain(r.name)}
                    disabled={
                      phase !== PHASES.BETTING ||
                      betCountdown <= 0 ||
                      isSubmitting
                    }
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
                          placedBets[r.name] +
                          (typeof r.multiplier === "number"
                            ? placedBets[r.name] * (r.multiplier - 1) * 0.95
                            : 0)
                        ).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="verification-panel mt-2 bg-[rgba(0,0,0,0.3)] rounded p-2 text-xs text-white">
            <div className="font-semibold mb-1">Provably Fair Verification</div>
            <div>Server Seed Hash: {serverSeedHash || "Waiting..."}</div>
            {serverSeed && (
              <div>
                Server Seed: {serverSeed}
                <button
                  onClick={() => setShowVerification(!showVerification)}
                  className="ml-2 bg-purple-600 text-white rounded py-1 px-2 text-[10px]"
                >
                  {showVerification ? "Hide" : "Verify"}
                </button>
              </div>
            )}
            {showVerification && (
              <div>
                <div>Client Seed: {raceId}</div>
                <div>Race ID: {raceId}</div>
                <button
                  onClick={() => {
                    const result = verifyRaceOutcome(
                      raceId,
                      serverSeed,
                      bettingMultipliers,
                      winner,
                      serverSeedHash
                    );
                    alert(result.message);
                  }}
                  className="bg-green-600 text-white rounded py-1 px-2 text-[10px]"
                >
                  Verify Outcome
                </button>
              </div>
            )}
          </div>

          {liveBets.length > 0 && (
            <div className="mt-2 bg-[rgba(0,0,0,0.3)] rounded p-2 text-xs text-white overflow-y-auto max-h-32">
              <div className="font-semibold mb-1">Live Bets</div>
              {liveBets.slice(0, 5).map((b) => (
                <div key={b.txSignature} className="flex justify-between mb-1">
                  <div>
                    {b.bettorWallet?.slice(0, 4)}…{b.bettorWallet?.slice(-4)} →{" "}
                    {b.targetName}
                  </div>
                  <div>{b.amount} TOKENS</div>
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
                  {h.winner?.multiplier >= 3 && (
                    <span className="ml-1 text-yellow-400">★</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
