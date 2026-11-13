// Lifecycle of the shared status link (WS /ws/status plus the GET /api/status fallback poll), without React so it
// can be tested with a fake clock (statusLink.test.ts). hooks/useStatus.tsx is a thin wrapper around it.
//
// Rules:
// - The socket is preferred. The backend pushes status five times a second.
// - The poll runs every POLL_INTERVAL_MS while the socket is not DELIVERING, with one request in flight at most.
//   A failed poll (error or timeout) is what makes the backend 'not reachable'.
// - A socket counts as delivering only once its first message has arrived, not when it opens. The backend accepts
//   the WebSocket handshake before it reads the first status, so a backend whose status call hangs gives exactly
//   this: the socket opens and then says nothing. If opening alone stopped the poll and silenced its failures, such
//   a backend would never be reported as unreachable. So until the first message the poll keeps running and its
//   failures count, and the socket state stays 'connecting' (the masthead does not say 'Live').
// - A socket that is open but silent for more than STALE_AFTER_MS (frozen backend, half-open connection) is closed
//   without waiting for the close handshake, and the usual close path takes over: poll, then reconnect with backoff.

import { STALE_CHECK_MS, isStale } from "./staleStatus";

export type StatusSocketState = "connecting" | "open" | "closed";

export const POLL_INTERVAL_MS = 2000;

/**
 * One status-stream message as a value. The Python backend sends JSON text, which is parsed; the in-page simulator
 * may hand over the object itself (a plain object), which is taken as it is. Anything else (a binary frame, a
 * class instance) throws, so the link ignores it as malformed.
 */
export function statusMessageValue(data: unknown): unknown {
  if (typeof data === "string") return JSON.parse(data);
  if (typeof data === "object" && data !== null) {
    const proto: unknown = Object.getPrototypeOf(data);
    if (proto === Object.prototype || proto === null) return data;
  }
  throw new Error("A status message must be JSON text or a plain object");
}

/** Handlers the link gives to a new socket. */
export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: unknown) => void;
  onClose: () => void;
}

/** A socket opened by the link. close() must detach the handlers first, so no handler runs after it. */
export interface SocketHandle {
  close: () => void;
}

export interface StatusLinkDeps<S> {
  /** Open a status socket wired to the handlers. May throw (then a reconnect is scheduled). */
  openSocket: (h: SocketHandlers) => SocketHandle;
  /** One status request; it rejects on error or timeout. */
  fetchStatus: () => Promise<S>;
  /** Parse one socket message; throw on a malformed one (it is ignored). */
  parse: (data: unknown) => S;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  reconnectDelayMs: (attempt: number) => number;
  /** A status snapshot arrived (from the socket or the poll): the backend is reachable. */
  onStatus: (s: S) => void;
  /** The poll failed while the socket was not delivering: the backend is not reachable. */
  onUnreachable: () => void;
  /** Called only when the socket state changes. */
  onSocketState: (state: StatusSocketState) => void;
}

export class StatusLink<S> {
  private readonly d: StatusLinkDeps<S>;
  private disposed = false;
  private started = false;
  private sock: SocketHandle | null = null;
  private sockId = 0;
  private seq = 0;
  /** True once the current socket has delivered a message; false again when it closes. */
  private delivering = false;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private pollTimer: unknown = null;
  private polling = false;
  private staleTimer: unknown = null;
  private lastMessageAt = 0;
  private socketState: StatusSocketState = "connecting";

  constructor(deps: StatusLinkDeps<S>) {
    this.d = deps;
  }

  /** True while the current socket is delivering messages (the poll is off). */
  get isDelivering(): boolean {
    return this.delivering;
  }

  /** True while the fallback poll is running (a request in flight or the next one scheduled). */
  get isPolling(): boolean {
    return this.polling;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // Deferred by a tick so React StrictMode's mount/unmount/mount in development opens one socket, not two.
    this.reconnectTimer = this.d.setTimer(() => this.connect(), 0);
    // Also poll once right away (and every POLL_INTERVAL_MS until the socket delivers) so the first paint does
    // not wait for the socket.
    this.polling = true;
    this.pollTimer = this.d.setTimer(() => void this.pollOnce(), 0);
  }

  dispose(): void {
    this.disposed = true;
    this.delivering = false;
    this.stopStaleCheck();
    if (this.reconnectTimer !== null) this.d.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pollTimer !== null) this.d.clearTimer(this.pollTimer);
    this.pollTimer = null;
    this.polling = false;
    const s = this.sock;
    this.sock = null;
    this.sockId = 0;
    s?.close();
  }

  private async pollOnce(): Promise<void> {
    this.pollTimer = null;
    if (this.disposed || this.delivering) {
      this.polling = false;
      return;
    }
    try {
      const s = await this.d.fetchStatus();
      if (!this.disposed && !this.delivering) this.d.onStatus(s);
    } catch {
      if (!this.disposed && !this.delivering) this.d.onUnreachable();
    }
    if (this.disposed || this.delivering) {
      this.polling = false;
      return;
    }
    this.pollTimer = this.d.setTimer(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  private startPolling(): void {
    if (this.polling || this.disposed) return;
    this.polling = true;
    void this.pollOnce();
  }

  private connect(): void {
    this.reconnectTimer = null;
    if (this.disposed) return;
    this.setSocketState("connecting");
    const id = ++this.seq;
    this.sockId = id;
    try {
      this.sock = this.d.openSocket({
        onOpen: () => this.opened(id),
        onMessage: (data) => this.message(id, data),
        onClose: () => this.closed(id),
      });
    } catch {
      this.sockId = 0;
      this.sock = null;
      this.scheduleReconnect();
    }
  }

  private opened(id: number): void {
    if (this.disposed || id !== this.sockId) return;
    // Open is not delivering: the poll keeps running until the first message (see the header).
    this.lastMessageAt = this.d.now();
    this.stopStaleCheck();
    this.armStaleCheck(id);
  }

  private message(id: number, data: unknown): void {
    if (this.disposed || id !== this.sockId) return;
    this.lastMessageAt = this.d.now();
    let s: S;
    try {
      s = this.d.parse(data);
    } catch {
      return; // malformed frame: ignored, but it still shows the socket is alive
    }
    if (!this.delivering) {
      this.delivering = true;
      this.attempt = 0;
      this.setSocketState("open");
    }
    this.d.onStatus(s);
  }

  private closed(id: number): void {
    if (id !== this.sockId) return;
    this.stopStaleCheck();
    this.sock = null;
    this.sockId = 0;
    this.delivering = false;
    if (this.disposed) return;
    this.setSocketState("closed");
    this.startPolling();
    this.scheduleReconnect();
  }

  private armStaleCheck(id: number): void {
    this.staleTimer = this.d.setTimer(() => {
      this.staleTimer = null;
      if (this.disposed || id !== this.sockId) return;
      if (!isStale(this.d.now(), this.lastMessageAt)) {
        this.armStaleCheck(id);
        return;
      }
      // Silent for too long. Do not wait for the close handshake (a half-open socket may never finish it):
      // detach and close, then take the close path now.
      this.sock?.close();
      this.closed(id);
    }, STALE_CHECK_MS);
  }

  private stopStaleCheck(): void {
    if (this.staleTimer !== null) this.d.clearTimer(this.staleTimer);
    this.staleTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = this.d.setTimer(() => this.connect(), this.d.reconnectDelayMs(this.attempt));
    this.attempt += 1;
  }

  private setSocketState(s: StatusSocketState): void {
    if (this.socketState === s) return;
    this.socketState = s;
    this.d.onSocketState(s);
  }
}
