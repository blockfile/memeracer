import React, { createContext, useState, useEffect } from "react";

export const WalletContext = createContext({
  wallet: null,
  provider: null,
});

export function WalletProvider({ children }) {
  const [wallet, setWallet] = useState(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.solana?.isPhantom) {
      const sync = () => {
        if (window.solana.isConnected) {
          setWallet(window.solana.publicKey.toString());
        } else {
          setWallet(null);
        }
      };
      sync();
      window.solana.on("connect", sync);
      window.solana.on("disconnect", sync);
      return () => {
        window.solana?.removeListener("connect", sync);
        window.solana?.removeListener("disconnect", sync);
      };
    }
  }, []);

  return (
    <WalletContext.Provider value={{ wallet, provider: window.solana }}>
      {children}
    </WalletContext.Provider>
  );
}
