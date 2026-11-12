import { describe, expect, it } from "vitest";
import type { AxesMessage } from "../api/types";
import { ControlConnection, HELLO_FALLBACK_MS, type ControlState, type ServerMessageAt, type WsLike } from "./controlConnection";
import { FlightInput } from "./flightInput";
import { HoldGuard } from "./holdGuard";
import { PadPointers, releaseOnLinkChange } from "./release";

/** Manual clock for setTimeout-style timers. */
function clock() {
  let now = 1_000_000;
  let id = 0;
  const pending: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      pending.push({ id: ++id, at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > end) break;
        pending.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

const OPEN = 1;
const CLOSED = 3;

class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = CLOSED;
  }
  // test drivers
  open() {
    this.readyState = OPEN;
    this.onopen?.({});
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  serverClose(code: number) {
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }
}

function connection() {
  const c = clock();
  const sockets: FakeWs[] = [];
  const states: ControlState[] = [];
  const messages: ServerMessageAt[] = [];
  const conn = new ControlConnection(
    {
      create: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      OPEN,
      setTimeout: c.setTimeout,
      clearTimeout: c.clearTimeout,
      now: c.now,
    },
    { state: (s) => states.push(s), message: (m) => messages.push(m) },
  );
  conn.start(0);
  c.advance(0);
  return { c, conn, sockets, states, messages, ws: () => sockets.at(-1)! };
}

describe("control socket hello (SPEC 10.4)", () => {
  it("is open only after {type:hello, pilot:true}", () => {
    const { conn, ws, states, c } = connection();
    ws().open();
    expect(conn.current).toBe("connecting");
    c.advance(200);
    expect(conn.current).toBe("connecting");
    expect(conn.send({ type: "takeoff_land" })).toBe(false);
    ws().receive({ type: "hello", pilot: true });
    expect(conn.current).toBe("open");
    expect(states).toEqual(["open"]);
    expect(conn.send({ type: "takeoff_land" })).toBe(true);
    expect(ws().sent).toEqual([JSON.stringify({ type: "takeoff_land" })]);
  });

  it("a socket refused with 4001 before hello never reports open, even past the fallback time", () => {
    const { conn, ws, states, c } = connection();
    ws().open();
    c.advance(100);
    ws().serverClose(4001);
    expect(conn.current).toBe("refused");
    c.advance(HELLO_FALLBACK_MS * 2);
    expect(states).not.toContain("open");
    expect(states).toEqual(["refused"]);
  });

  it("an older backend (no hello): still open 1.5 s after the socket opened counts as open", () => {
    const { conn, ws, c } = connection();
    ws().open();
    c.advance(HELLO_FALLBACK_MS - 1);
    expect(conn.current).toBe("connecting");
    c.advance(1);
    expect(conn.current).toBe("open");
  });

  it("hello with pilot false does not open; acks and errors are passed on with their receive time", () => {
    const { conn, ws, messages, c } = connection();
    ws().open();
    ws().receive({ type: "hello", pilot: false });
    expect(conn.current).toBe("connecting");
    ws().receive({ type: "hello", pilot: true });
    ws().receive({ type: "ack", of: "estop", delivered: false });
    ws().receive({ type: "error", of: "takeoff_land", code: "drone_link_down", message: "x" });
    expect(messages.map((m) => m.msg)).toEqual([
      { type: "ack", of: "estop", delivered: false },
      { type: "error", of: "takeoff_land", code: "drone_link_down", message: "x" },
    ]);
    expect(messages[0]!.at).toBe(c.now());
  });

  it("an emergency stop goes out on an open socket even before hello; other commands wait", () => {
    const { conn, ws } = connection();
    expect(conn.send({ type: "estop" })).toBe(false); // socket not open yet
    ws().open();
    expect(conn.send({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 })).toBe(false);
    expect(conn.send({ type: "estop" })).toBe(true);
    expect(ws().sent).toEqual([JSON.stringify({ type: "estop" })]);
  });

  it("an ordinary close goes to closed and reconnects with backoff; the new socket waits for its own hello", () => {
    const { conn, ws, sockets, c } = connection();
    ws().open();
    ws().receive({ type: "hello", pilot: true });
    ws().serverClose(1011);
    expect(conn.current).toBe("closed");
    expect(conn.send({ type: "estop" })).toBe(false);
    c.advance(500);
    expect(sockets.length).toBe(2);
    expect(conn.current).toBe("connecting");
    ws().open();
    expect(conn.current).toBe("connecting");
    ws().receive({ type: "hello", pilot: true });
    expect(conn.current).toBe("open");
  });

  it("stop() sends zero axes on an open socket and closes it", () => {
    const { conn, ws } = connection();
    ws().open();
    ws().receive({ type: "hello", pilot: true });
    conn.stop();
    expect(ws().sent.at(-1)).toBe(JSON.stringify({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 }));
    expect(ws().closed).toBe(true);
  });
});

describe("release held inputs when the control link leaves open (SPEC 10.5)", () => {
  function setup() {
    const sent: AxesMessage[] = [];
    const flight = new FlightInput((m) => sent.push(m), 50, {
      setInterval: () => 1,
      clearInterval: () => {},
    });
    const c = clock();
    let fired = 0;
    const takeoff = new HoldGuard(() => fired++, 600, c);
    return { sent, flight, takeoff, c, fired: () => fired };
  }

  it("drops keyboard and on-screen pad holds, sends zeros, and cancels a takeoff hold in progress", () => {
    const { sent, flight, takeoff, c, fired } = setup();
    flight.press("key:KeyW", { axis: "pitch", dir: 1 });
    flight.press("pad:throttle+", { axis: "throttle", dir: 1 });
    takeoff.start();
    c.advance(300);
    expect(releaseOnLinkChange(false, flight, [takeoff])).toBe(true);
    expect(flight.isHolding()).toBe(false);
    expect(sent.at(-1)).toEqual({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 });
    expect(takeoff.holding).toBe(false);
    c.advance(1000);
    expect(fired()).toBe(0); // the takeoff hold never completes across the reconnect
    // After the reconnect nothing is held: a pad must be pressed again to send stick input.
    expect(flight.current()).toEqual({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  });

  it("does nothing while the link is open", () => {
    const { flight, takeoff } = setup();
    flight.press("pad:yaw+", { axis: "yaw", dir: 1 });
    takeoff.start();
    expect(releaseOnLinkChange(true, flight, [takeoff])).toBe(false);
    expect(flight.isHolding()).toBe(true);
    expect(takeoff.holding).toBe(true);
  });

  it("window-level pointerup releases the pad held by that pointer only (two-finger holds keep working)", () => {
    const { flight } = setup();
    const pads = new PadPointers();
    pads.down(1, "pad:throttle+");
    flight.press("pad:throttle+", { axis: "throttle", dir: 1 });
    pads.down(2, "pad:yaw-");
    flight.press("pad:yaw-", { axis: "yaw", dir: -1 });
    const s = pads.up(2);
    expect(s).toBe("pad:yaw-");
    flight.release(s!);
    expect(flight.current()).toEqual({ throttle: 1, yaw: 0, pitch: 0, roll: 0 });
    flight.release(pads.up(1)!);
    expect(flight.isHolding()).toBe(false);
    expect(pads.up(1)).toBeNull();
    expect(pads.up(99)).toBeNull();
  });
});
