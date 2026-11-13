// The one transport this page uses, chosen when the site is built and never changed while the page is open: a page
// that was controlling a real drone must not quietly turn into a simulator. So there is no second choice here, no
// query parameter and no stored preference: VITE_BACKEND (vite.config.ts checks it) picks one side, and the other
// side's module is not in the bundle at all. If the chosen module fails to load, the page does not start.

import type { Transport } from "./types";

export type { CameraSource, Closable, StatusStreamHandlers, Transport, TransportResponse } from "./types";

let current: Transport | null = null;

/** Load this build's transport. main.tsx awaits it before the app renders. */
export async function loadTransport(): Promise<Transport> {
  if (current) return current;
  const chosen =
    import.meta.env.VITE_BACKEND === "browser"
      ? (await import("./browser")).createTransport()
      : (await import("./python")).createTransport();
  current ??= chosen;
  return current;
}

/** This build's transport. Throws when called before loadTransport() has finished, which is a programming error. */
export function getTransport(): Transport {
  if (!current) throw new Error("getTransport() was called before loadTransport() finished");
  return current;
}
