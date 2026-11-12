// One shared status source for the whole app: WS /ws/status (pushed 5x per second), with a
// GET /api/status poll every 2 s only while the socket is down. One request in flight at most.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { wsUrl } from "../api/config";
import type { Status } from "../api/types";
import { reconnectDelayMs } from "./backoff";

export type SocketState = "connecting" | "open" | "closed";

export interface StatusContextValue {
  status: Status | null;
  socket: SocketState;
  /** null: not known yet; false: neither the socket nor the poll reached the backend. */
  reachable: boolean | null;
  /** performance.now() of the last snapshot received */
  lastUpdate: number | null;
}

const StatusContext = createContext<StatusContextValue | null>(null);

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 1500;

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [socket, setSocket] = useState<SocketState>("connecting");
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const socketOpen = useRef(false);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;

    const accept = (s: Status) => {
      setStatus(s);
      setReachable(true);
      setLastUpdate(performance.now());
    };

    const pollOnce = async () => {
      pollTimer = null;
      if (disposed || socketOpen.current) {
        polling = false;
        return;
      }
      try {
        const s = await api.status(POLL_TIMEOUT_MS);
        if (!disposed && !socketOpen.current) accept(s);
      } catch {
        if (!disposed && !socketOpen.current) setReachable(false);
      }
      if (disposed || socketOpen.current) {
        polling = false;
        return;
      }
      pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
    };

    const startPolling = () => {
      if (polling || disposed) return;
      polling = true;
      void pollOnce();
    };

    const connect = () => {
      reconnectTimer = null;
      if (disposed) return;
      setSocket("connecting");
      try {
        ws = new WebSocket(wsUrl("/ws/status"));
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        socketOpen.current = true;
        setSocket("open");
      };
      ws.onmessage = (ev) => {
        try {
          accept(JSON.parse(String(ev.data)) as Status);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        ws = null;
        socketOpen.current = false;
        if (disposed) return;
        setSocket("closed");
        startPolling();
        scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      reconnectTimer = setTimeout(connect, reconnectDelayMs(attempt));
      attempt += 1;
    };

    // Deferred by a tick so React StrictMode's mount/unmount/mount in development opens one socket, not two.
    reconnectTimer = setTimeout(connect, 0);
    // Also poll once right away (and every 2 s until the socket opens) so the first paint does not wait.
    polling = true;
    pollTimer = setTimeout(pollOnce, 0);

    return () => {
      disposed = true;
      socketOpen.current = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearTimeout(pollTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);

  const value = useMemo(() => ({ status, socket, reachable, lastUpdate }), [status, socket, reachable, lastUpdate]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useStatus(): StatusContextValue {
  const v = useContext(StatusContext);
  if (!v) throw new Error("useStatus must be used inside <StatusProvider>");
  return v;
}
