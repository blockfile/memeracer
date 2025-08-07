import React, { createContext, useState, useEffect, useCallback } from "react";
import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_API_BASE || "http://localhost:3001";

export const WalletContext = createContext();

export const WalletProvider = ({ children }) => {
  const [walletAddress, setWalletAddress] = useState(null);
  const [user, setUser] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const connectWallet = useCallback(async () => {
    if (!window.solana?.isPhantom) {
      setError("Phantom wallet not detected");
      return;
    }
    try {
      setError(null);
      setConnecting(true);

      // Open Phantom and get publicKey
      const resp = await window.solana.connect();
      const publicKey = resp.publicKey;
      if (publicKey) {
        setWalletAddress(publicKey.toString());
      } else {
        throw new Error("No public key returned from wallet");
      }

      // Sign a one-time message
      const message = `Authenticate to MemeRacer at ${Date.now()}`;
      const encoded = new TextEncoder().encode(message);
      const signed = await window.solana.signMessage(encoded, "utf8");

      // Send to backend
      const res = await axios.post(
        `${BACKEND_URL}/api/user/connect`,
        {
          walletAddress: publicKey.toString(),
          message,
          signature: Array.from(signed.signature),
        },
        { headers: { "Content-Type": "application/json" } }
      );
      setUser(res.data);
    } catch (e) {
      console.error("connectWallet error", e);
      setError("Failed to connect: " + (e.message || "Unknown error"));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setWalletAddress(null);
    setUser(null);
    try {
      if (window.solana && window.solana.disconnect) {
        window.solana.disconnect();
      }
    } catch (e) {
      console.warn("Failed to disconnect wallet:", e);
    }
  }, []);

  // Auto-connect and event listeners
  useEffect(() => {
    if (!window.solana?.isPhantom) return;

    // Try silent reconnect
    window.solana
      .connect({ onlyIfTrusted: true })
      .then(({ publicKey }) => {
        if (publicKey) {
          setWalletAddress(publicKey.toString());
          connectWallet();
        }
      })
      .catch((e) => console.warn("Silent reconnect failed:", e));

    const onConnect = (e) => {
      if (e.publicKey) {
        setWalletAddress(e.publicKey.toString());
      }
    };
    const onDisconnect = () => disconnect();

    if (window.solana) {
      window.solana.on("connect", onConnect);
      window.solana.on("disconnect", onDisconnect);
    }

    return () => {
      if (window.solana) {
        window.solana.removeListener("connect", onConnect);
        window.solana.removeListener("disconnect", onDisconnect);
      }
    };
  }, [connectWallet, disconnect]);

  return (
    <WalletContext.Provider
      value={{
        walletAddress,
        user,
        error,
        connecting,
        connectWallet,
        disconnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};
