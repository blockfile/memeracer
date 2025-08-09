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
import pepeSpriteSheet from "../../assets/images/pepe-sprite.png";
import wojakSpriteSheet from "../../assets/images/wojack-sprite.png";
import dogeSpriteSheet from "../../assets/images/doge-sprite.png";
import chadSpriteSheet from "../../assets/images/chad-sprite.png";
import miladySpriteSheet from "../../assets/images/milady-sprite.png";

// ICONS
import icon1 from "../../assets/images/pepe.png";
import icon2 from "../../assets/images/wojack.png";
import icon3 from "../../assets/images/doge.png";
import icon4 from "../../assets/images/chad.png";
import icon5 from "../../assets/images/milady.png";

// GIFs
import pepeGif from "../../assets/gifs/pepe-run.gif";
import aGif from "../../assets/gifs/wojack.gif";
import a2Gif from "../../assets/gifs/doge.gif";
import a3Gif from "../../assets/gifs/chad.gif";
import a4Gif from "../../assets/gifs/milady.gif";

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

// Reorder racers to match visual order: Pepe, Wojak, Doge, Chad, Milady
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

// Align RAW_PROBS with backend for consistency
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
  const random = getProvablyFairRandom(
    serverSeed,
    clientSeed,
    raceId,
    "pool_config"
  );
  const useSpecialPool = random < 0.3; // Match backend probability
  let basePool;
  if (useSpecialPool) {
    const high = random < 0.5 ? 5 : 4;
    basePool = [2, 2, 3, 3, high];
  } else {
    basePool = [2, 3, 4, 2, 2]; // Match backend default pool
  }
  for (let i = basePool.length - 1; i > 0; i--) {
    const j = Math.floor(
      getProvablyFairRandom(serverSeed, clientSeed, raceId, i) * (i + 1)
    );
    [basePool[i], basePool[j]] = [basePool[j], basePool[i]];
  }
  return racers.reduce((m, r, i) => ({ ...m, [r.name]: basePool[i] }), {});
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
    return {
      valid: false,
      message: "Multipliers do not match",
      computedMultipliers,
    };
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
    return {
      valid: false,
      message: "Winner does not match",
      computedMultipliers,
      computedWinner,
    };
  }
  return {
    valid: true,
    message: "Race outcome verified",
    computedMultipliers,
    computedWinner,
  };
}

const PHASES = {
  READY: "ready",
  BETTING: "betting",
  RACING: "racing",
  INTERMISSION: "intermission",
  RESULT: "result", // New phase for post-race verification
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
  const [resultCountdown, setResultCountdown] = useState(0); // Countdown for result phase
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
  const [payouts, setPayouts] = useState([]);
  const [currentRacePayouts, setCurrentRacePayouts] = useState([]); // For current round winners
  const [showPayoutCredits, setShowPayoutCredits] = useState(false); // Control credits animation
  const [isRacing, setIsRacing] = useState(false);
  const [liveBets, setLiveBets] = useState([]);
  const [walletAddress, setWalletAddress] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverSeedHash, setServerSeedHash] = useState(null);
  const [serverSeed, setServerSeed] = useState(null);
  const [showVerification, setShowVerification] = useState(false);
  const [selectedRace, setSelectedRace] = useState(null);
  const [inputServerSeed, setInputServerSeed] = useState("");
  const [inputServerSeedHash, setInputServerSeedHash] = useState("");
  const [verificationResult, setVerificationResult] = useState(null);
  const [isWaitingForResult, setIsWaitingForResult] = useState(false);
  const [positions, setPositions] = useState(
    racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
  );
  const [spritesLoaded, setSpritesLoaded] = useState(false);
  const countdownRef = useRef(null);
  const animRef = useRef(null);
  const prevLeaderRef = useRef(-1);
  const spinTimersRef = useRef(racers.map(() => 0));
  const trackControls = useAnimation();
  const winnerControls = useAnimation();
  const solConnectionRef = useRef(null);
  const positionsRef = useRef(
    racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
  );
  const lastPositionsRef = useRef(
    racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
  );
  const timeSinceUpdateRef = useRef(0);
  const spritesRef = useRef({});
  const frameCtRef = useRef(0);
  const curFrameRef = useRef(0);
  const particlesRef = useRef([]);
  const lastTimeRef = useRef(performance.now());
  const UPDATE_INTERVAL = 1000 / 60;

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

  const fetchPayouts = useCallback(async () => {
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/race/payouts`);
      setPayouts(data);
    } catch (e) {
      console.warn("Failed to fetch payouts", e);
    }
  }, []);

  const connectWallet = useCallback(async () => {
    if (!window.solana || !window.solana.isPhantom) {
      alert("Install Phantom wallet");
      return;
    }
    try {
      const resp = await window.solana.connect();
      const publicKey = resp.publicKey;
      if (publicKey) {
        setWalletAddress(publicKey.toString());
      }
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
          if (e.name === "TokenAccountNotFoundError") {
            console.warn(
              "Sender token account not found, creating...",
              fromTokenAccount.toString()
            );
            tx.add(
              createAssociatedTokenAccountInstruction(
                fromPubkey,
                fromTokenAccount,
                fromPubkey,
                tokenMint
              )
            );
          } else {
            throw e;
          }
        }
        try {
          await getAccount(connection, toTokenAccount);
        } catch (e) {
          if (e.name === "TokenAccountNotFoundError") {
            console.warn(
              "Treasury token account not found, creating...",
              toTokenAccount.toString()
            );
            tx.add(
              createAssociatedTokenAccountInstruction(
                fromPubkey,
                toTokenAccount,
                toPubkey,
                tokenMint
              )
            );
          } else {
            throw e;
          }
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
          setLiveBets((lb) => {
            const uniqueBets = lb.filter(
              (existing) => existing.txSignature !== betEvent.txSignature
            );
            return [betEvent, ...uniqueBets].slice(0, 100);
          });
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

  const effectiveRaceId = selectedRace ? selectedRace.raceId : raceId;
  const effectiveMultipliers = selectedRace
    ? selectedRace.multipliers
    : bettingMultipliers;
  const effectiveWinner = selectedRace ? selectedRace.winner.name : winner;
  const effectiveServerSeed = selectedRace
    ? selectedRace.serverSeed
    : serverSeed;
  const effectiveServerSeedHash = selectedRace
    ? selectedRace.serverSeedHash
    : serverSeedHash;

  useEffect(() => {
    if (showVerification) {
      setInputServerSeed(effectiveServerSeed || "");
      setInputServerSeedHash(effectiveServerSeedHash || "");
    }
  }, [
    showVerification,
    selectedRace,
    effectiveServerSeed,
    effectiveServerSeedHash,
  ]);

  useEffect(() => {
    socket.connect();
    socket.emit("getCurrentRace");
    socket.on("raceState", (raceState) => {
      console.log("Received raceState:", raceState);
      if (raceState.phase === PHASES.INTERMISSION) {
        setPhase(PHASES.INTERMISSION);
        setRaceId(null);
        setBetCountdown(0);
        setReadyCountdown(0);
        setResultCountdown(0);
        setServerSeed(null);
        setIsRacing(false);
        setWinner(null);
        setWinnerIcon(null);
        setPositions(racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {}));
        setPlacedBets({});
        setLiveBets([]);
        setBets(racers.reduce((acc, r) => ({ ...acc, [r.name]: "" }), {}));
        if (currentRacePayouts.length > 0) {
          setShowPayoutCredits(true); // Trigger animation
        }
        return;
      }
      setRaceId(raceState.raceId);
      setPhase(raceState.phase);
      setReadyCountdown(raceState.readyCountdown);
      setBetCountdown(raceState.betCountdown);
      setResultCountdown(raceState.resultCountdown || 0);
      setBettingMultipliers(raceState.multipliers);
      setServerSeedHash(raceState.serverSeedHash);
      if (raceState.phase === PHASES.READY) {
        setPlacedBets({});
        setLiveBets([]);
        setBets(racers.reduce((acc, r) => ({ ...acc, [r.name]: "" }), {}));
        setCurrentRacePayouts([]); // Clear for new race
      }
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
      } else if (
        raceState.phase === PHASES.RESULT &&
        raceState.resultCountdown > 0
      ) {
        let t = raceState.resultCountdown;
        countdownRef.current = setInterval(() => {
          t--;
          setResultCountdown(t);
          if (t <= 0) {
            clearInterval(countdownRef.current);
          }
        }, 1000);
      }
    });
    socket.on("raceStart", ({ raceId: incomingRaceId }) => {
      if (incomingRaceId === raceId) {
        setIsRacing(true);
        setWinner(null);
        setWinnerIcon(null);
        setIsWaitingForResult(false);
        setServerSeed(null);
        setPositions(racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {}));
        lastPositionsRef.current = racers.reduce(
          (acc, r) => ({ ...acc, [r.name]: 0 }),
          {}
        );
        timeSinceUpdateRef.current = 0;
      }
    });
    socket.on(
      "raceProgress",
      ({ raceId: incomingRaceId, positions: newPositions }) => {
        if (incomingRaceId === raceId) {
          lastPositionsRef.current = positionsRef.current;
          setPositions(newPositions);
          timeSinceUpdateRef.current = 0;
        }
      }
    );
    socket.on("betPlaced", (b) => {
      if (b.raceId === raceId) {
        setLiveBets((lb) => {
          const isDuplicate = lb.some(
            (existing) => existing.txSignature === b.txSignature
          );
          if (!isDuplicate) {
            return [b, ...lb.filter((bet) => bet.raceId === raceId)].slice(
              0,
              100
            );
          }
          return lb;
        });
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
        setPhase(PHASES.RESULT); // Transition to result phase
        setResultCountdown(5); // Set 5 seconds for result phase
        setHistory((h) => [raceResult, ...h].slice(0, 50));
      }
    });
    socket.on("payout", (payout) => {
      const formattedPayout = {
        treasuryAddress: TREASURY_ADDRESS,
        bettorWallet: payout.wallet,
        amount: payout.amount,
        payoutTxSignature: payout.signature,
      };
      setPayouts((p) => [formattedPayout, ...p].slice(0, 50));
      setCurrentRacePayouts((crp) => [...crp, formattedPayout]); // Accumulate all payouts for current race
      console.log("Payout received:", formattedPayout); // Debug log
    });
    return () => {
      socket.off("raceState");
      socket.off("raceStart");
      socket.off("raceProgress");
      socket.off("betPlaced");
      socket.off("raceResult");
      socket.off("payout");
      socket.disconnect();
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [raceId]);

  useEffect(() => {
    if (phase === PHASES.INTERMISSION && currentRacePayouts.length > 0) {
      setShowPayoutCredits(true);
      const timer = setTimeout(() => {
        setShowPayoutCredits(false);
        setCurrentRacePayouts([]); // Clear after display
      }, 5000); // Display for 5 seconds
      return () => clearTimeout(timer);
    }
  }, [phase, currentRacePayouts]);

  useEffect(() => {
    // Fetch data on every mount to ensure latest payouts
    fetchHistory();
    fetchPayouts();
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [fetchHistory, fetchPayouts]);

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
    let loadedCt = 0;
    racers.forEach((r) => {
      const img = new window.Image();
      img.src = spriteMap[r.name].sheet;
      img.onload = () => {
        spritesRef.current[r.name] = img;
        loadedCt++;
        if (loadedCt === racers.length) {
          setSpritesLoaded(true);
        }
      };
      img.onerror = () => console.warn("sprite load fail", r.name);
    });
  }, []);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    if (phase !== PHASES.RACING || !raceId || !spritesLoaded) return;
    const canvas = canvasRef.current;
    if (!canvas || !boxRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = boxRef.current.clientWidth;
    canvas.height = boxRef.current.clientHeight;
    function draw(currentTime) {
      const delta = currentTime - lastTimeRef.current;
      lastTimeRef.current = currentTime;
      timeSinceUpdateRef.current += delta;
      const W = canvas.width;
      const H = canvas.height;
      const laneH = H / racers.length;
      const spriteSz = Math.min(85, laneH * 0.8);
      const finishX1 = W - 48;
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < racers.length; i++) {
        ctx.fillStyle =
          i % 2 === 0 ? "rgba(138,43,226,0.8)" : "rgba(30,144,255,0.8)";
        ctx.globalAlpha = 0.9;
        ctx.fillRect(0, i * laneH, W, laneH);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      for (let i = 1; i < racers.length; i++) {
        const y = i * laneH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      const pulse = 0.5 + 0.5 * Math.sin(currentTime / 250);
      ctx.lineWidth = 8;
      ctx.setLineDash([18, 10]);
      ctx.strokeStyle = `rgba(255,215,0,${pulse})`;
      ctx.beginPath();
      ctx.moveTo(finishX1, 0);
      ctx.lineTo(finishX1, H);
      ctx.stroke();
      ctx.moveTo(finishX1 + 20, 0);
      ctx.lineTo(finishX1 + 20, H);
      ctx.stroke();
      ctx.setLineDash([]);
      let currentLeader = -1;
      let maxPos = -Infinity;
      racers.forEach((r, i) => {
        const p = positionsRef.current[r.name] * (finishX1 - spriteSz * 2);
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
      const interpFactor = Math.min(
        1,
        timeSinceUpdateRef.current / UPDATE_INTERVAL
      );
      racers.forEach((r, i) => {
        const sprite = spritesRef.current[r.name];
        if (!sprite) return;
        const lastPos = lastPositionsRef.current[r.name];
        const currPos = positionsRef.current[r.name];
        const interpPos = lastPos + (currPos - lastPos) * interpFactor;
        const rawX = interpPos * (finishX1 - spriteSz * 2);
        const x = Math.min(rawX, finishX1 - spriteSz);
        const y = i * laneH + (laneH - spriteSz) / 2;
        const len = 10 + Math.abs(interpPos) * 8;
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.moveTo(x, y + spriteSz / 2);
        ctx.lineTo(x - len, y + spriteSz / 2 - 5);
        ctx.stroke();
        let angle = 0;
        const spinRemaining = spinTimersRef.current[i];
        if (spinRemaining > 0) {
          const progress = (30 - spinRemaining + delta / 16.67) / 30;
          angle = progress * Math.PI * 2;
          spinTimersRef.current[i] = Math.max(0, spinRemaining - delta / 16.67);
        }
        ctx.save();
        ctx.translate(x + spriteSz / 2, y + spriteSz / 2);
        if (angle !== 0) ctx.rotate(angle);
        ctx.drawImage(
          sprite,
          (curFrameRef.current % spriteMap[r.name].totalFrames) *
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
        if (frameCtRef.current % 4 === 0) {
          particlesRef.current.push({
            x: x + spriteSz / 2,
            y: y + spriteSz,
            alpha: 1,
            vx: (Math.random() - 0.5) * 2,
            vy: -1.5,
          });
        }
      });
      particlesRef.current.forEach((p) => {
        p.x += p.vx * (delta / 16.67);
        p.y += p.vy * (delta / 16.67);
        p.alpha -= 0.015 * (delta / 16.67);
        if (p.alpha > 0) {
          ctx.fillStyle = `rgba(255,215,0,${p.alpha})`;
          ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        }
      });
      particlesRef.current = particlesRef.current.filter((p) => p.alpha > 0);
      frameCtRef.current++;
      if (frameCtRef.current % 2 === 0) curFrameRef.current++;
      animRef.current = requestAnimationFrame(draw);
    }
    lastTimeRef.current = performance.now();
    animRef.current = requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [phase, raceId, spritesLoaded]);

  useEffect(() => {
    if (!isRacing) {
      frameCtRef.current = 0;
      curFrameRef.current = 0;
      particlesRef.current = [];
      timeSinceUpdateRef.current = 0;
    }
  }, [isRacing]);

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

  const handleVerifyCurrent = () => {
    setSelectedRace(null);
    setShowVerification(!showVerification);
  };

  const handleVerifyPast = (h) => {
    setSelectedRace(h);
    setShowVerification(true);
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
      <div className="w-full flex justify-center px-4 mt-4">
        <div
          className="relative w-full h-[50vh] md:h-[60vh] flex items-center"
          ref={boxRef}
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
            ref={canvasRef}
            className="race-canvas rounded-md shadow-lg"
            style={{ zIndex: 20, width: "100%", height: "100%" }}
            animate={trackControls}
          />
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
                <div className="text-xl font-bold text-red-700 flex items-center gap-2">
                  WARNING!
                </div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  DO NOT PROCEED ANY TX IF NOT ON BETTING PHASE.
                </div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  THIS WILL LEAD TO LOSE OF FUNDS
                </div>
                <div className="text-2xl font-bold text-white flex items-center gap-2">
                  🎯 Betting Phase
                </div>
                <div className="text-sm text-gray-200">
                  Ends in: {betCountdown}s
                </div>
              </div>
            </div>
          )}
          {(phase === PHASES.RACING && winner && !isRacing) ||
          phase === PHASES.RESULT ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-40 pointer-events-none">
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
                  {phase === PHASES.RESULT && (
                    <div className="text-sm text-gray-200">
                      Verification available: {resultCountdown}s remaining
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          ) : null}
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
                {showPayoutCredits && currentRacePayouts.length > 0 && (
                  <motion.div
                    className="absolute right-4 top-0 bottom-0 flex flex-col justify-center items-end overflow-hidden text-white text-xs"
                    initial={{ y: "100%" }}
                    animate={{ y: "0%" }}
                    transition={{ duration: 5, ease: "linear" }}
                    onAnimationComplete={() => setShowPayoutCredits(false)}
                  >
                    {currentRacePayouts.map((p, idx) => (
                      <div key={idx} className="mb-2">
                        {p.treasuryAddress?.slice(0, 4) || "N/A"}…
                        {p.treasuryAddress?.slice(-4) || "N/A"} paying{" "}
                        {p.amount.toLocaleString()} $MEME to{" "}
                        {p.bettorWallet?.slice(0, 4) || "N/A"}…
                        {p.bettorWallet?.slice(-4) || "N/A"}
                      </div>
                    ))}
                  </motion.div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="bet-history-wrapper w-full flex flex-col lg:flex-row gap-4 px-4 mt-6">
        <div className="betting-panel flex-1 bg-[rgba(24,24,40,0.95)] border border-gray-700 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex flex-wrap justify-between items-center mb-1">
            <div className="font-semibold text-sm text-white">
              {phase === PHASES.READY
                ? "Getting Ready..."
                : phase === PHASES.BETTING
                ? `Betting ends in: ${betCountdown}s`
                : phase === PHASES.RACING
                ? "Race in progress – betting locked"
                : phase === PHASES.RESULT
                ? `Winner: ${winner} (Verification phase)`
                : "Waiting..."}
            </div>
            <div className="text-xs text-gray-300">
              Place your bets for the current race
            </div>
          </div>
          <div className="bet-grid relative flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-[rgba(24,24,40,0.95)] to-transparent" />
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-[rgba(24,24,40,0.95)] to-transparent" />
            {displayRacers.map((r) => (
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
            {serverSeed && phase === PHASES.RESULT && (
              <div>
                Server Seed: {serverSeed}
                <button
                  onClick={handleVerifyCurrent}
                  className="ml-2 bg-purple-600 text-white rounded py-1 px-2 text-[10px]"
                >
                  {showVerification ? "Hide" : "Verify Current Race"}
                </button>
              </div>
            )}
            {showVerification && (
              <div>
                <div>Verifying Race: {effectiveRaceId}</div>
                <div>Recorded Winner: {effectiveWinner}</div>
                <div>Recorded Multipliers:</div>
                {effectiveMultipliers &&
                  Object.entries(effectiveMultipliers).map(([name, mult]) => (
                    <div key={name}>
                      {name}: {mult}x
                    </div>
                  ))}
                <div>
                  Server Seed:
                  <input
                    value={inputServerSeed}
                    onChange={(e) => setInputServerSeed(e.target.value)}
                    className="bg-gray-800 text-white ml-2 p-1 text-xs"
                  />
                </div>
                <div>
                  Server Seed Hash:
                  <input
                    value={inputServerSeedHash}
                    onChange={(e) => setInputServerSeedHash(e.target.value)}
                    className="bg-gray-800 text-white ml-2 p-1 text-xs"
                  />
                </div>
                <button
                  onClick={() => {
                    const result = verifyRaceOutcome(
                      effectiveRaceId,
                      inputServerSeed,
                      effectiveMultipliers,
                      effectiveWinner,
                      inputServerSeedHash
                    );
                    setVerificationResult(result);
                  }}
                  className="bg-green-600 text-white rounded py-1 px-2 text-[10px] mt-2"
                >
                  Verify Outcome
                </button>
                {verificationResult && (
                  <div className="mt-2">
                    <p>Valid: {verificationResult.valid ? "Yes" : "No"}</p>
                    <p>{verificationResult.message}</p>
                    {verificationResult.computedMultipliers && (
                      <div>
                        Computed Multipliers:
                        {Object.entries(
                          verificationResult.computedMultipliers
                        ).map(([name, mult]) => (
                          <div key={name}>
                            {name}: {mult}x
                          </div>
                        ))}
                      </div>
                    )}
                    {verificationResult.computedWinner && (
                      <div>
                        Computed Winner: {verificationResult.computedWinner}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {liveBets.length > 0 && (
            <div className="mt-2 bg-[rgba(0,0,0,0.3)] rounded p-2 text-xs text-white overflow-y-auto max-h-32">
              <div className="font-semibold mb-1">Live Bets</div>
              {liveBets
                .filter((bet) => bet.raceId === raceId)
                .slice(0, 5)
                .map((b) => (
                  <div
                    key={`${b.txSignature}-${b.raceId}`}
                    className="flex justify-between mb-1"
                  >
                    <div>
                      {b.bettorWallet?.slice(0, 4)}…{b.bettorWallet?.slice(-4)}{" "}
                      → {b.targetName}
                    </div>
                    <div>{b.amount} TOKENS</div>
                  </div>
                ))}
            </div>
          )}
        </div>
        <div className="history-payouts-wrapper w-full lg:w-[640px] flex flex-col lg:flex-row gap-4">
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
                  <button
                    onClick={() => handleVerifyPast(h)}
                    className="bg-blue-600 text-white rounded py-1 px-2 text-[10px]"
                  >
                    Verify
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="payouts-box w-full lg:w-[320px] bg-[rgba(24,24,40,0.95)] border border-gray-700 rounded-lg p-4 flex flex-col gap-2">
            <div className="payouts-header flex justify-between items-center font-bold text-sm text-white">
              <div>Past Payouts</div>
            </div>
            <div className="payouts-list flex flex-col gap-2 overflow-y-auto max-h-[280px]">
              {payouts.length === 0 && (
                <div className="payouts-empty italic text-gray-400">
                  No payouts yet
                </div>
              )}
              {payouts.map((p, idx) => (
                <div
                  key={`${p.payoutTxSignature}-${idx}`}
                  className="payout-item bg-[rgba(40,40,70,0.9)] rounded-md p-2 flex items-center gap-2 text-xs"
                >
                  <div className="payout-time flex-[0_0-60px] text-gray-400"></div>
                  <div className="payout-details flex-1 text-white">
                    {p.treasuryAddress?.slice(0, 4) || "N/A"}…
                    {p.treasuryAddress?.slice(-4) || "N/A"} →{" "}
                    {p.amount.toLocaleString()} $MEME →{" "}
                    {p.bettorWallet?.slice(0, 4) || "N/A"}…
                    {p.bettorWallet?.slice(-4) || "N/A"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
