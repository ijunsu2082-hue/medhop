// The browser transport on an engine that never runs by itself (no animation frames): status cadence, deep
// copies, close detaching handlers, the control socket's hello / 4001 / replies, and requests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../engine";
import { createTransport, STATUS_PUSH_MS } from "./browser";

const engineFor = () => new Engine({ storage: null, seed: 1, scheduler: null, housekeepingTimer: false });

describe("browser transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens the status stream on the next tick, then pushes about five times a second", () => {
    const t = createTransport(engineFor());
    const got: unknown[] = [];
    const open = vi.fn();
    const handle = t.openStatus({ open, message: (d) => got.push(d), close: vi.fn() });
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(got).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(got).toHaveLength(1 + 1000 / STATUS_PUSH_MS);
    // fresh plain objects every time
    expect(got[1]).not.toBe(got[2]);
    expect((got[1] as { mission: unknown }).mission).not.toBe((got[2] as { mission: unknown }).mission);
    expect(Object.getPrototypeOf(got[1])).toBe(Object.prototype);
    expect((got[1] as { mode: string }).mode).toBe("sim");
    handle.close();
    vi.advanceTimersByTime(2000);
    expect(got).toHaveLength(6);
  });

  it("close before the first tick delivers nothing", () => {
    const t = createTransport(engineFor());
    const message = vi.fn();
    const open = vi.fn();
    t.openStatus({ open, message, close: vi.fn() }).close();
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it("answers requests with copied bodies, errors included", async () => {
    const engine = engineFor();
    const t = createTransport(engine);
    expect(await t.request("GET", "/api/health", undefined, 1000)).toEqual({ status: 200, body: { ok: true, mode: "sim" } });
    expect(await t.request("GET", "/api/nope", undefined, 1000)).toEqual({ status: 404, body: { detail: "Not Found" } });
    const refused = await t.request("POST", "/api/mission/start", { confirm_airborne: true }, 1000);
    expect(refused.status).toBe(409);
    expect((refused.body as { blockers: string[] }).blockers).toContain("no_pilot_link");
    const body = { time: "23:58", label: "Late dose (demo)" };
    const added = await t.request("POST", "/api/schedule", body, 1000);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject(body);
    engine.stop();
  });

  it("the control socket opens, says hello, answers, and a second one is refused with 4001", () => {
    const engine = engineFor();
    const t = createTransport(engine);
    const first = t.createControl();
    const msgs: unknown[] = [];
    const opened = vi.fn();
    first.onopen = opened;
    first.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
    expect(first.readyState).toBe(0);
    vi.advanceTimersByTime(5);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(first.readyState).toBe(t.controlOpenState);
    vi.advanceTimersByTime(5);
    expect(msgs).toEqual([{ type: "hello", pilot: true }]);
    first.send(JSON.stringify({ type: "max_stick", value: 0.8 }));
    first.send("not json");
    first.send(JSON.stringify({ type: "warp_speed" }));
    vi.advanceTimersByTime(5);
    expect(msgs.slice(1)).toEqual([
      { type: "ack", of: "max_stick" },
      { type: "error", of: null, code: "bad_request", message: "invalid JSON" },
      { type: "error", of: "warp_speed", code: "bad_request", message: "unknown message type 'warp_speed'" },
    ]);

    const second = t.createControl();
    const closes: number[] = [];
    second.onclose = (ev) => closes.push(ev.code);
    second.onmessage = vi.fn();
    vi.advanceTimersByTime(5);
    expect(closes).toEqual([4001]);
    expect(second.onmessage).not.toHaveBeenCalled();

    // closing the first releases the slot: a new socket is welcome
    first.onclose = null;
    first.close();
    expect(engine.pilotConnected).toBe(false);
    const third = t.createControl();
    const thirdMsgs: unknown[] = [];
    third.onmessage = (ev) => thirdMsgs.push(JSON.parse(String(ev.data)));
    vi.advanceTimersByTime(5);
    vi.advanceTimersByTime(5);
    expect(thirdMsgs).toEqual([{ type: "hello", pilot: true }]);
    third.close();
    engine.stop();
  });

  it("the camera source hands out SceneFrames while subscribed", () => {
    const engine = engineFor();
    const t = createTransport(engine);
    if (t.camera.kind !== "canvas") throw new Error("expected a canvas camera");
    const frames: unknown[] = [];
    const off = t.camera.subscribe((f) => frames.push(f));
    engine.advance(1.0);
    expect(frames.length).toBeGreaterThanOrEqual(9); // the first frame arrives after the 0.35 s video delay
    expect(frames[0]).toMatchObject({ landingSpot: expect.any(Number), obstacles: [] });
    off();
    const n = frames.length;
    engine.advance(1.0);
    expect(frames.length).toBe(n);
    engine.stop();
  });
});
