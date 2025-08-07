import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import reportWebVitals from "./reportWebVitals";
import { WalletProvider } from "../src/components/context/walletConnect";
import { Buffer } from "buffer";
// Polyfill Buffer globally for browser compatibility
window.Buffer = Buffer;
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </React.StrictMode>
);

reportWebVitals();
