// Navbar.jsx
import React, { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { FiMenu, FiX, FiChevronDown, FiChevronUp, FiCreditCard } from "react-icons/fi";

const BACKEND_URL = process.env.REACT_APP_API_BASE || "http://localhost:3001";

function formatNumber(n) {
    if (n == null) return "--";
    const num = Number(n);
    if (isNaN(num)) return n;
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function Navbar() {
    const [walletAddress, setWalletAddress] = useState(null);
    const [user, setUser] = useState(null);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [walletDropdown, setWalletDropdown] = useState(false);

    const isPhantomInstalled =
        typeof window !== "undefined" && window.solana?.isPhantom;

    const connectWallet = useCallback(async () => {
        if (!isPhantomInstalled) {
            setError("Phantom wallet not detected");
            return;
        }
        try {
            setError(null);
            setConnecting(true);
            const resp = await window.solana.connect();
            const publicKey = resp.publicKey.toString();
            setWalletAddress(publicKey);

            const message = `Authenticate to MemeRacer at ${Date.now()}`;
            const encoded = new TextEncoder().encode(message);
            const signed = await window.solana.signMessage(encoded, "utf8");

            const res = await axios.post(
                `${BACKEND_URL}/api/user/connect`,
                {
                    walletAddress: publicKey,
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
    }, [isPhantomInstalled]);

    const disconnect = () => {
        setWalletAddress(null);
        setUser(null);
        try {
            window.solana?.disconnect();
        } catch { }
    };

    useEffect(() => {
        if (!isPhantomInstalled) return;
        const attemptAuto = async () => {
            try {
                if (window.solana.isConnected) {
                    const publicKey = window.solana.publicKey.toString();
                    setWalletAddress(publicKey);
                    const message = `Authenticate to MemeRacer at ${Date.now()}`;
                    const encoded = new TextEncoder().encode(message);
                    const signed = await window.solana.signMessage(encoded, "utf8");
                    const res = await axios.post(
                        `${BACKEND_URL}/api/user/connect`,
                        {
                            walletAddress: publicKey,
                            message,
                            signature: Array.from(signed.signature),
                        },
                        { headers: { "Content-Type": "application/json" } }
                    );
                    setUser(res.data);
                }
            } catch (e) {
                console.warn("auto sync failed", e);
            }
        };
        attemptAuto();

        const handleConnect = (e) => {
            setWalletAddress(e?.publicKey?.toString() || null);
        };
        const handleDisconnect = () => {
            disconnect();
        };
        window.solana.on("connect", handleConnect);
        window.solana.on("disconnect", handleDisconnect);
        return () => {
            window.solana?.removeListener("connect", handleConnect);
            window.solana?.removeListener("disconnect", handleDisconnect);
        };
    }, [isPhantomInstalled]);

    return (
        <header className="w-full bg-[rgba(18,18,35,0.95)] text-white font-sans px-4 py-3 flex items-center justify-between flex-wrap gap-2 relative z-50">
            <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className="text-2xl font-bold bg-gradient-to-r from-[#8c5aff] to-[#ff71ce] bg-clip-text text-transparent whitespace-nowrap">
                    MemeRacer
                </div>
                <div className="hidden md:flex items-center gap-4 flex-wrap flex-1">
                    <button className="px-3 py-2 rounded-lg text-sm hover:bg-white/5 transition">
                        Home
                    </button>
                    <button className="px-3 py-2 rounded-lg text-sm hover:bg-white/5 transition">
                        Play
                    </button>
                </div>
            </div>

            {/* mobile menu toggle */}
            <div className="flex items-center gap-2">
                <div className="hidden md:flex items-center gap-3">
                    {/* desktop right side */}
                    {walletAddress ? (
                        <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1 bg-white/10 rounded-full px-3 py-1 text-xs">
                                <div className="truncate">
                                    {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)}
                                </div>
                            </div>
                            <div className="flex items-center gap-1 bg-white/10 rounded-full px-3 py-1 text-xs font-semibold">
                                {user ? `${formatNumber(user.tokenBalance)} $MEME` : "Loading..."}
                            </div>
                            <button
                                onClick={disconnect}
                                className="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-md text-sm font-medium transition"
                            >
                                Disconnect
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={connectWallet}
                            disabled={connecting}
                            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-md text-sm font-medium transition whitespace-nowrap"
                        >
                            {isPhantomInstalled
                                ? connecting
                                    ? "Connecting..."
                                    : "Connect Wallet"
                                : "Install Phantom"}
                        </button>
                    )}
                </div>

                <button
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-label="menu"
                    className="md:hidden p-2 rounded-md hover:bg-white/10 transition"
                >
                    {menuOpen ? <FiX size={20} /> : <FiMenu size={20} />}
                </button>
            </div>

            {/* mobile dropdown */}
            <div
                className={`w-full md:hidden mt-2 transition-all duration-200 ${menuOpen ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0 overflow-hidden"
                    } bg-[rgba(24,24,40,0.97)] rounded-lg px-4 py-3`}
            >
                <div className="flex flex-col gap-2">
                    <button className="text-left w-full px-3 py-2 rounded-lg hover:bg-white/5 transition">
                        Home
                    </button>
                    <button className="text-left w-full px-3 py-2 rounded-lg hover:bg-white/5 transition">
                        Play
                    </button>
                    <div className="border-t border-white/10 pt-3 mt-2">
                        {walletAddress ? (
                            <div className="flex flex-col gap-2">
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-2">
                                        <div className="text-xs font-medium">Wallet</div>
                                        <div className="flex items-center gap-2 bg-white/10 rounded-full px-3 py-1 text-xs truncate">
                                            {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setWalletDropdown((d) => !d)}
                                        className="p-1 rounded hover:bg-white/10 transition"
                                        aria-label="toggle wallet details"
                                    >
                                        {walletDropdown ? (
                                            <FiChevronUp size={16} />
                                        ) : (
                                            <FiChevronDown size={16} />
                                        )}
                                    </button>
                                </div>
                                {walletDropdown && (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2 text-xs">
                                            <FiCreditCard />
                                            <div>
                                                Balance:{" "}
                                                <span className="font-semibold">
                                                    {user
                                                        ? `${formatNumber(user.tokenBalance)} $MEME`
                                                        : "-- $MEME"}
                                                </span>
                                            </div>
                                        </div>
                                        <button
                                            onClick={disconnect}
                                            className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-md text-sm font-medium transition"
                                        >
                                            Disconnect
                                        </button>
                                    </div>
                                )}
                                {!walletDropdown && (
                                    <div className="text-xs text-gray-300">
                                        Tap the chevron to see balance / disconnect.
                                    </div>
                                )}
                            </div>
                        ) : (
                            <button
                                onClick={connectWallet}
                                disabled={connecting}
                                className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-md text-sm font-medium transition"
                            >
                                {isPhantomInstalled
                                    ? connecting
                                        ? "Connecting..."
                                        : "Connect Wallet"
                                    : "Install Phantom"}
                            </button>
                        )}
                    </div>
                    {error && (
                        <div className="text-red-400 text-sm text-center mt-1">{error}</div>
                    )}
                </div>
            </div>
        </header>
    );
}
