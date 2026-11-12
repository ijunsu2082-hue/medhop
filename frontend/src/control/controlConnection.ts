// WS /ws/control connection logic, without React so it can be tested with a fake WebSocket (control.test.ts).
// One pilot at a time. Reconnects with backoff up to 3 s. When the server refuses us with close code 4001
// (another pilot window is connected) we retry no more than once every 5 s.
//
// SPEC 10.4: the link counts as "open" only after the server's {"type":"hello","pilot":true}, so a socket that
// is refused with 4001 never flashes "connected". An older backend sends no hello: if a socket is still open
// HELLO_FALLBACK_MS after it opened, it is treated as open.

import type { ControlMessage, ControlServerMessage } from "../api/types";
import { CONTROL_REFUSED_CODE, CONTROL_REFUSED_RETRY_MS, reconnectDelayMs } from "../hooks/backoff";

export type ControlState = "connecting" | "open" | "closed" | "refused";

export const HELLO_FALLBACK_MS = 1500;

/** The parts of a WebSocket this uses. */
export interface WsLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ConnectionDeps {
  create: () => WsLike;
  /** WebSocket.OPEN */
  OPEN: number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}

export interface ServerMessageAt {
  msg: ControlServerMessage;
  at: number;
}

export interface ConnectionListener {
  state: (s: ControlState) => void;
  message: (m: ServerMessageAt) => void;
}

// When this page closes its own control socket and a new one opens right away (route change and back),
// the server may not have processed the close yet and refuse the new socket with 4001. In that one case
// we allow a single quick retry instead of waiting the full 5 s.
let lastOwnCloseAt = 0;
const OWN_CLOSE_GRACE_MS = 2000;
const OWN_CLOSE_RETRY_MS = 1000;

export class ControlConnection {
  private ws: WsLike | null = null;
  private state: ControlState = "connecting";
  private attempt = 0;
  private timer: unknown = null;
  private helloTimer: unknown = null;
  private disposed = false;
  private readonly deps: ConnectionDeps;
  private readonly on: ConnectionListener;

  constructor(deps: ConnectionDeps, on: ConnectionListener) {
    this.deps = deps;
    this.on = on;
  }

  get current(): ControlState {
    return this.state;
  }

  /** Connect after `delayMs` (0 by default; the hook defers by a tick for React StrictMode). */
  start(delayMs = 0): void {
    this.timer = this.deps.setTimeout(() => this.connect(), delayMs);
  }

  /**
   * Returns false when the message was NOT sent. Commands go out only once the link is open (after hello).
   * An emergency stop goes out on any open socket, even before hello: a stop is never harmful to send.
   */
  send(msg: ControlMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.deps.OPEN) return false;
    if (this.state !== "open" && msg.type !== "estop") return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  stop(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.clearHello();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      lastOwnCloseAt = this.deps.now();
      // Server zeroes pilot axes on disconnect (SPEC section 5); send zeros first anyway.
      if (ws.readyState === this.deps.OPEN) {
        ws.send(JSON.stringify({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 }));
      }
      ws.close();
    }
  }

  private setState(s: ControlState): void {
    if (this.state === s) return;
    this.state = s;
    this.on.state(s);
  }

  private clearHello(): void {
    if (this.helloTimer !== null) this.deps.clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private connect(): void {
    this.timer = null;
    if (this.disposed) return;
    if (this.state !== "refused") this.setState("connecting");
    let ws: WsLike;
    try {
      ws = this.deps.create();
    } catch {
      this.retry(reconnectDelayMs(this.attempt++));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.disposed || this.ws !== ws) return;
      // Not "open" yet: wait for the server's hello (or, from an older backend, for the fallback).
      this.clearHello();
      this.helloTimer = this.deps.setTimeout(() => {
        this.helloTimer = null;
        if (!this.disposed && this.ws === ws && ws.readyState === this.deps.OPEN) this.becomeOpen();
      }, HELLO_FALLBACK_MS);
    };
    ws.onmessage = (ev) => {
      if (this.disposed || this.ws !== ws) return;
      let msg: ControlServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ControlServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "hello") {
        if (msg.pilot === true) {
          this.clearHello();
          this.becomeOpen();
        }
        return;
      }
      if (msg.type === "ack" || msg.type === "error") this.on.message({ msg, at: this.deps.now() });
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      this.clearHello();
      if (this.disposed) return;
      if (ev.code === CONTROL_REFUSED_CODE) {
        this.setState("refused");
        const ownRace = this.deps.now() - lastOwnCloseAt < OWN_CLOSE_GRACE_MS;
        lastOwnCloseAt = 0; // the quick retry is allowed once only
        this.retry(ownRace ? OWN_CLOSE_RETRY_MS : CONTROL_REFUSED_RETRY_MS);
      } else {
        this.setState("closed");
        this.retry(reconnectDelayMs(this.attempt++));
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private becomeOpen(): void {
    this.attempt = 0;
    this.setState("open");
  }

  private retry(ms: number): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = this.deps.setTimeout(() => this.connect(), ms);
  }
}
