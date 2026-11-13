// The MedHop backend on this computer (simulator or real drone): REST over fetch, WS /ws/status, WS /ws/control
// and the MJPEG stream at /video.mjpg. This is the network code that used to sit in api/config.ts, api/client.ts,
// hooks/useStatus.tsx, hooks/useControlSocket.ts and components/VideoFeed.tsx, moved here unchanged.

import type { WsLike } from "../control/controlConnection";
import type { StatusStreamHandlers, Transport, TransportResponse } from "./types";

const DEFAULT_API_BASE = "http://localhost:8010";

/** The base URL without a trailing slash; empty or missing gives the default. */
export function normaliseBase(raw: string | undefined): string {
  const base = (raw && raw.trim()) || DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

/** Backend base URL, from VITE_API_BASE (default http://localhost:8010), without a trailing slash. */
export const API_BASE = normaliseBase(import.meta.env.VITE_API_BASE as string | undefined);

/** Derive a WebSocket URL from an http(s) base: http -> ws, https -> wss. */
export function wsUrlFrom(base: string, path: string): string {
  const u = new URL(base.replace(/\/+$/, "") + path);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export function apiUrl(path: string): string {
  return API_BASE + path;
}

export function wsUrl(path: string): string {
  return wsUrlFrom(API_BASE, path);
}

/** A transport to the backend at `base` (already normalised; API_BASE by default). */
export function createTransport(base: string = API_BASE): Transport {
  const http = (path: string) => base + path;

  async function request(method: string, path: string, body: unknown, timeoutMs: number): Promise<TransportResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(http(path), {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  function openStatus(h: StatusStreamHandlers) {
    const ws = new WebSocket(wsUrlFrom(base, "/ws/status"));
    ws.onopen = () => h.open();
    ws.onmessage = (ev) => h.message(ev.data);
    ws.onclose = () => h.close();
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
  }

  return {
    kind: "python",
    request,
    openStatus,
    createControl: () => new WebSocket(wsUrlFrom(base, "/ws/control")) as unknown as WsLike,
    get controlOpenState() {
      return WebSocket.OPEN;
    },
    camera: { kind: "mjpeg", url: http("/video.mjpg") },
  };
}
