import "./fonts.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadTransport } from "./transport";

// This build's transport (Python backend or in-page simulator) is loaded before anything renders, so every part of
// the app talks to the same one from its first moment.
async function start(): Promise<void> {
  await loadTransport();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
