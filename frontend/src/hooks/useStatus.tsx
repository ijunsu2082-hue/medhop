// One shared status source for the whole app: WS /ws/status (pushed 5x per second), with a GET /api/status poll
// every 2 s while the socket is not delivering. One request in flight at most. The lifecycle lives in
// logic/statusLink.ts (tested there): a socket counts as delivering only from its first message, so a backend that
// accepts the socket but never sends anything is still reported as not reachable when the poll fails, and an open
// socket that goes silent for STALE_AFTER_MS (logic/staleStatus.ts) is closed so the usual close path takes over.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { wsUrl } from "../api/config";
import type { Status } from "../api/types";
import { StatusLink } from "../logic/statusLink";
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
}

const StatusContext = createContext<StatusContextValue | null>(null);

const POLL_TIMEOUT_MS = 1500;

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [socket, setSocket] = useState<SocketState>("connecting");
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  useEffect(() => {
    const link = new StatusLink<Status>({
      openSocket: (h) => {
        const ws = new WebSocket(wsUrl("/ws/status"));
        ws.onopen = () => h.onOpen();
        ws.onmessage = (ev) => h.onMessage(ev.data);
        ws.onclose = () => h.onClose();
        ws.onerror = () => {
          /* onclose follows */
        };
        return {
          close: () => {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
          },
        };
      },
      fetchStatus: () => api.status(POLL_TIMEOUT_MS),
      parse: (data) => JSON.parse(String(data)) as Status,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => performance.now(),
      reconnectDelayMs,
      onStatus: (s) => {
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

  const value = useMemo(() => ({ status, socket, reachable, lastUpdate }), [status, socket, reachable, lastUpdate]);
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
