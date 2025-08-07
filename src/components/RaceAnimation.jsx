// components/RaceAnimation.jsx
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// SPRITES (Adjusted paths to a common structure; verify your project structure)
import pepeSpriteSheet from "../components/assets/images/pepe_sprite_sheet.png";
import wojakSpriteSheet from "../components/assets/images/a.png";
import dogeSpriteSheet from "../components//assets/images/a2.png";
import chadSpriteSheet from "../components//assets/images/a3_sprite_sheet.png";
import miladySpriteSheet from "../components//assets/images/a4.png";

const BACKEND_URL = process.env.REACT_APP_API_BASE || "http://localhost:3001";

const socket = io(BACKEND_URL, { autoConnect: false });

const racers = [
  { name: "Pepe" },
  { name: "Wojak" },
  { name: "Doge" },
  { name: "Chad" },
  { name: "Milady" },
];

const spriteMap = {
  Pepe: { sheet: pepeSpriteSheet, frameWidth: 112, totalFrames: 6 },
  Wojak: { sheet: wojakSpriteSheet, frameWidth: 112, totalFrames: 31 },
  Doge: { sheet: dogeSpriteSheet, frameWidth: 112, totalFrames: 31 },
  Chad: { sheet: chadSpriteSheet, frameWidth: 112, totalFrames: 30 },
  Milady: { sheet: miladySpriteSheet, frameWidth: 112, totalFrames: 34 },
};

const RaceAnimation = () => {
  const canvasRef = useRef(null);
  const boxRef = useRef(null);
  const [positions, setPositions] = useState(
    racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
  );
  const [targetPositions, setTargetPositions] = useState(
    racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
  );
  const [winner, setWinner] = useState(null);
  const animRef = useRef(null);
  const prevLeaderRef = useRef(-1);
  const spinTimersRef = useRef(racers.map(() => 0));
  const lastUpdate = useRef(0);

  useEffect(() => {
    console.log(
      "RaceAnimation: Component mounted, initiating socket connection..."
    );
    try {
      socket.connect();
      console.log("RaceAnimation: Socket connected successfully.");
    } catch (error) {
      console.error("RaceAnimation: Failed to connect socket:", error);
    }

    socket.on("raceState", (raceState) => {
      console.log("RaceAnimation: Received raceState:", raceState);
    });
    socket.on("raceStart", ({ raceId }) => {
      console.log("RaceAnimation: Race started:", raceId);
      setWinner(null);
      setPositions(racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {}));
      setTargetPositions(
        racers.reduce((acc, r) => ({ ...acc, [r.name]: 0 }), {})
      );
    });
    socket.on("raceProgress", ({ positions: newPositions }) => {
      console.log("RaceAnimation: Received raceProgress:", newPositions);
      setTargetPositions(newPositions);
      lastUpdate.current = Date.now();
    });
    socket.on("raceResult", ({ raceResult }) => {
      console.log("RaceAnimation: Received raceResult:", raceResult);
      setWinner(raceResult.winner.name);
    });

    return () => {
      console.log("RaceAnimation: Cleaning up socket...");
      socket.off("raceState");
      socket.off("raceStart");
      socket.off("raceProgress");
      socket.off("raceResult");
      socket.disconnect();
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, []);

  useEffect(() => {
    console.log("RaceAnimation: Setting up resize observer...");
    if (!boxRef.current) return;
    const observer = new ResizeObserver(() => {
      if (canvasRef.current && boxRef.current) {
        canvasRef.current.width = boxRef.current.clientWidth;
        canvasRef.current.height = boxRef.current.clientHeight;
        console.log("RaceAnimation: Canvas resized to", {
          width: boxRef.current.clientWidth,
          height: boxRef.current.clientHeight,
        });
      }
    });
    observer.observe(boxRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    console.log("RaceAnimation: Initializing canvas and animation...");
    if (!canvasRef.current || !boxRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) {
      console.error("RaceAnimation: Failed to get 2D context");
      return;
    }

    const W = (canvasRef.current.width = boxRef.current.clientWidth);
    const H = (canvasRef.current.height = boxRef.current.clientHeight);
    const laneH = H / racers.length;
    const spriteSz = Math.min(85, laneH * 0.8);
    const finishX1 = W - 48;

    let frameCt = 0,
      curFrame = 0;

    const loaded = {};
    let loadedCt = 0;

    racers.forEach((r) => {
      const img = new window.Image();
      img.crossOrigin = "anonymous"; // Attempt to handle CORS if applicable
      img.src = spriteMap[r.name].sheet;
      img.onload = () => {
        loaded[r.name] = img;
        loadedCt++;
        console.log(
          `RaceAnimation: Loaded sprite for ${r.name} (Size: ${img.width}x${img.height})`
        );
        if (loadedCt === racers.length) {
          console.log(
            "RaceAnimation: All sprites loaded, starting animation..."
          );
          requestAnimationFrame(draw);
        }
      };
      img.onerror = (error) =>
        console.error(`RaceAnimation: Failed to load sprite ${r.name}:`, error);
    });

    function draw(timestamp) {
      try {
        const deltaTime = (timestamp - lastUpdate.current) / 1000; // Time since last update in seconds
        const interpolatedPositions = {};
        for (const racer of racers) {
          const current = positions[racer.name] || 0;
          const target = targetPositions[racer.name] || 0;
          interpolatedPositions[racer.name] =
            current + (target - current) * Math.min(deltaTime * 2, 1); // Smooth interpolation
        }
        setPositions(interpolatedPositions);

        ctx.clearRect(0, 0, W, H);

        for (let laneIndex = 0; laneIndex < racers.length; laneIndex++) {
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle =
            laneIndex % 2 === 0
              ? "rgba(138,43,226,0.8)"
              : "rgba(30,144,255,0.8)";
          ctx.fillRect(0, laneIndex * laneH, W, laneH);
          ctx.restore();
        }

        ctx.save();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2;
        for (
          let dividerIndex = 1;
          dividerIndex < racers.length;
          dividerIndex++
        ) {
          const y = dividerIndex * laneH;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
          ctx.stroke();
        }
        ctx.restore();

        const pulse = 0.5 + 0.5 * Math.sin((timestamp / 1000) * 4);
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
          const p = interpolatedPositions[r.name] * (finishX1 - spriteSz * 2);
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
          if (!sprite) {
            console.warn(`RaceAnimation: Sprite for ${r.name} not loaded`);
            return;
          }
          const x = Math.min(
            interpolatedPositions[r.name] * (finishX1 - spriteSz * 2),
            finishX1 - spriteSz
          );
          const y = racerIndex * laneH + (laneH - spriteSz) / 2;

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
        });

        frameCt++;
        if (frameCt % 10 === 0) curFrame++;
      } catch (error) {
        console.error("RaceAnimation: Error in draw function:", error);
      }

      animRef.current = requestAnimationFrame(draw);
    }

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [targetPositions]);

  return (
    <div className="race-animation">
      <div
        className="relative w-full h-[50vh] md:h-[60vh] flex items-center"
        ref={boxRef}
      >
        <canvas
          ref={canvasRef}
          className="race-canvas rounded-md shadow-lg"
          style={{ width: "100%", height: "100%", zIndex: 20 }}
        />
        {winner && (
          <div className="absolute inset-0 flex items-center justify-center z-40 pointer-events-none">
            <div className="absolute inset-0 bg-black/60" />
            <div className="bg-[rgba(10,10,10,0.9)] rounded-2xl p-6 flex flex-col items-center gap-3 shadow-xl">
              <div className="flex items-center gap-2 text-2xl font-bold text-white">
                <span role="img" aria-label="trophy">
                  🏆
                </span>{" "}
                {winner} Wins!
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RaceAnimation;
