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
      const pk = resp.publicKey.toString();
      setWalletAddress(pk);

      // Sign a one-time message
      const message = `Authenticate to MemeRacer at ${Date.now()}`;
      const encoded = new TextEncoder().encode(message);
      const signed = await window.solana.signMessage(encoded, "utf8");

      // Send to backend
      const res = await axios.post(
        `${BACKEND_URL}/api/user/connect`,
        {
          walletAddress: pk,
          message,
          signature: Array.from(signed.signature),
        },
        { headers: { "Content-Type": "application/json" } }
      );
      setUser(res.data);
    } catch (e) {
      console.error("connectWallet error", e);
      setError("Failed to connect");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setWalletAddress(null);
    setUser(null);
    try {
      window.solana.disconnect();
    } catch (e) {
      console.warn("Failed to disconnect wallet:", e); // Log the error instead of empty block
    }
  }, []);

  // Auto-connect and event listeners
  useEffect(() => {
    if (!window.solana?.isPhantom) return;

    // Try silent reconnect
    window.solana
      .connect({ onlyIfTrusted: true })
      .then(({ publicKey }) => {
        if (publicKey) connectWallet();
      })
      .catch((e) => console.warn("Silent reconnect failed:", e));

    const onConnect = (e) => setWalletAddress(e.publicKey.toString());
    const onDisconnect = () => disconnect();

    window.solana.on("connect", onConnect);
    window.solana.on("disconnect", onDisconnect);

    return () => {
      window.solana.removeListener("connect", onConnect);
      window.solana.removeListener("disconnect", onDisconnect);
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
