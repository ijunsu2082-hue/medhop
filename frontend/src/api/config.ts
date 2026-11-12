const DEFAULT_API_BASE = "http://localhost:8010";

function normaliseBase(raw: string | undefined): string {
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
