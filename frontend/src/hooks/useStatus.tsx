// One shared status source for the whole app: WS /ws/status (pushed 5x per second), with a GET /api/status poll
// every 2 s while the socket is not delivering. One request in flight at most. The lifecycle lives in
// logic/statusLink.ts (tested there): a socket counts as delivering only from its first message, so a backend that
// accepts the socket but never sends anything is still reported as not reachable when the poll fails, and an open
// socket that goes silent for STALE_AFTER_MS (logic/staleStatus.ts) is closed so the usual close path takes over.
//
// The socket and the poll go through this build's transport (transport/index.ts). The provider also feeds every
// status to this page's mode guard (logic/modeGuard.ts) for the whole life of the page, on every route. The
// guard's latch is updated before React hears of the status, so the choke points that read it (control sends,
// REST requests) are locked from that moment, not from the next render.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Status } from "../api/types";
import { observePageMode, pageModeChange, type ModeChange } from "../logic/modeGuard";
import { StatusLink, statusMessageValue } from "../logic/statusLink";
import { getTransport } from "../transport";
import { reconnectDelayMs } from "./backoff";

export type SocketState = "connecting" | "open" | "closed";

export interface StatusContextValue {
  status: Status | null;
  /** "open" once the status socket is delivering messages (not merely connected). */
  socket: SocketState;
  /** null: not known yet; false: neither the socket nor the poll reached the backend. */
  reachable: boolean | null;
  /** performance.now() of the last snapshot received */
  lastUpdate: number | null;
  /** Set once the backend's mode has changed since this page opened (logic/modeGuard.ts); it stays set until the
   * page is reloaded. */
  modeChange: ModeChange | null;
}

const StatusContext = createContext<StatusContextValue | null>(null);

const POLL_TIMEOUT_MS = 1500;

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [socket, setSocket] = useState<SocketState>("connecting");
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [modeChange, setModeChange] = useState<ModeChange | null>(pageModeChange);

  useEffect(() => {
    const transport = getTransport();
    const link = new StatusLink<Status>({
      openSocket: (h) => transport.openStatus({ open: h.onOpen, message: h.onMessage, close: h.onClose }),
      fetchStatus: () => api.status(POLL_TIMEOUT_MS),
      parse: (data) => statusMessageValue(data) as Status,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => performance.now(),
      reconnectDelayMs,
      onStatus: (s) => {
        // The latch first: from here on the choke points refuse, whatever React does next.
        setModeChange(observePageMode(s?.mode));
        setStatus(s);
        setReachable(true);
        setLastUpdate(performance.now());
      },
      onUnreachable: () => setReachable(false),
      onSocketState: setSocket,
    });
    link.start();
    return () => link.dispose();
  }, []);

  const value = useMemo(
    () => ({ status, socket, reachable, lastUpdate, modeChange }),
    [status, socket, reachable, lastUpdate, modeChange],
  );
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useStatus(): StatusContextValue {
  const v = useContext(StatusContext);
  if (!v) throw new Error("useStatus must be used inside <StatusProvider>");
  return v;
}

/** Like useStatus, but returns null outside a <StatusProvider> instead of throwing. */
export function useOptionalStatus(): StatusContextValue | null {
  return useContext(StatusContext);
}
