// Wording for the app shell: the mode label beside the site name and the backend banner.

import type { BackendKind } from "../transport/kind";

export const BACKEND_DOWN = "Backend not reachable. Retrying every 2 seconds.";

export interface ModeLabel {
  text: string;
  /** "sim": a simulator, nothing real moves. "real": a real drone. "down": nothing is connected. "wait": not known yet. */
  tone: "sim" | "real" | "down" | "wait";
}

/**
 * What this page is connected to, always shown beside the site name.
 * `reachable` is null until the first answer; `mode` is the backend's own report ("sim" or "real").
 */
export function modeLabel(kind: BackendKind, reachable: boolean | null, mode: "sim" | "real" | null): ModeLabel {
  if (kind === "browser") return { text: "Browser simulator", tone: "sim" };
  if (reachable === false) return { text: "Not connected", tone: "down" };
  if (reachable === null || mode === null) return { text: "Connecting", tone: "wait" };
  if (mode === "real") return { text: "Real drone", tone: "real" };
  return { text: "Python simulator", tone: "sim" };
}
