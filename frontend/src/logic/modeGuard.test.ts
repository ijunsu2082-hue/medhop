import { describe, expect, it } from "vitest";
import type { ControlMessage } from "../api/types";
import { REQUEST_LOCKED_TEXT, controlLockedText } from "../text/pilotWording";
import {
  ABORT_PATH,
  MODE_GUARD_START,
  controlRefusal,
  guardedControlSend,
  observeMode,
  observePageMode,
  pageModeChange,
  requestRefusal,
  type ModeChange,
  type ModeGuardState,
} from "./modeGuard";

const feed = (modes: unknown[], from: ModeGuardState = MODE_GUARD_START) => modes.reduce<ModeGuardState>(observeMode, from);

describe("mode guard", () => {
  it("starts untripped with nothing pinned", () => {
    expect(MODE_GUARD_START).toEqual({ pinned: null, change: null });
  });

  it("pins the first mode it sees and stays quiet while it does not change", () => {
    expect(feed(["real"])).toEqual({ pinned: "real", change: null });
    expect(feed(["sim", "sim", "sim"])).toEqual({ pinned: "sim", change: null });
  });

  it("trips when a page that saw the real drone is told the backend is now the simulator", () => {
    expect(feed(["real", "real", "sim"])).toEqual({ pinned: "real", change: { from: "real", to: "sim" } });
  });

  it("trips the other way too: a page opened for the simulator must not fly the real drone", () => {
    expect(feed(["sim", "real"])).toEqual({ pinned: "sim", change: { from: "sim", to: "real" } });
  });

  it("stays tripped until the page is reloaded, even when the mode changes back", () => {
    const tripped = feed(["real", "sim"]);
    expect(feed(["real", "real", "sim", "real"], tripped).change).toEqual({ from: "real", to: "sim" });
  });

  it("ignores a status without a known mode (no status yet, an older or a malformed one)", () => {
    expect(feed([null, undefined, "", "REAL", 1])).toBe(MODE_GUARD_START);
    expect(feed(["real", null, undefined, "drone"])).toEqual({ pinned: "real", change: null });
  });

  it("returns the same object when nothing changes, so a state setter does not re-render", () => {
    const pinned = observeMode(MODE_GUARD_START, "real");
    expect(observeMode(pinned, "real")).toBe(pinned);
    expect(observeMode(pinned, null)).toBe(pinned);
    const tripped = observeMode(pinned, "sim");
    expect(observeMode(tripped, "real")).toBe(tripped);
    expect(observeMode(tripped, "sim")).toBe(tripped);
  });
});

const TRIPPED: ModeChange[] = [
  { from: "real", to: "sim" },
  { from: "sim", to: "real" },
];

/** One message of every control type the page can send. */
const ESTOP: ControlMessage = { type: "estop" };
const OTHERS: ControlMessage[] = [
  { type: "axes", throttle: 0.5, yaw: 0, pitch: 0, roll: 0 },
  { type: "axes", throttle: 0, yaw: -0.3, pitch: 0.2, roll: 0.1 },
  { type: "takeoff_land" },
  { type: "calibrate" },
  { type: "max_stick", value: 0.6 },
  { type: "estop_reset" },
];
const STICK_RELEASE: ControlMessage = { type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 };

describe("control choke point", () => {
  it("lets every message through while the guard has not tripped", () => {
    for (const msg of [ESTOP, STICK_RELEASE, ...OTHERS]) expect(controlRefusal(msg, null)).toBeNull();
  });

  it("always lets the emergency stop through", () => {
    for (const change of TRIPPED) expect(controlRefusal(ESTOP, change)).toBeNull();
  });

  it("refuses every other message once tripped, with a reason naming it", () => {
    for (const change of TRIPPED) {
      for (const msg of [...OTHERS, STICK_RELEASE]) {
        expect(controlRefusal(msg, change), msg.type).toBe(controlLockedText(msg.type));
      }
    }
    expect(controlLockedText("axes")).toContain("stick input");
    expect(controlLockedText("takeoff_land")).toContain("takeoff / land");
    expect(controlLockedText("calibrate")).toContain("level calibration");
    expect(controlLockedText("max_stick")).toContain("max stick");
    expect(controlLockedText("estop_reset")).toContain("emergency stop reset");
  });
});

describe("the page's control send path (guardedControlSend)", () => {
  function path(change: ModeChange | null, linkSends = true) {
    const sent: ControlMessage[] = [];
    const refusals: string[] = [];
    const send = guardedControlSend(
      (msg) => {
        sent.push(msg);
        return linkSends;
      },
      () => change,
      (reason) => refusals.push(reason),
    );
    return { send, sent, refusals };
  }

  it("passes everything to the link, and returns its answer, while the guard has not tripped", () => {
    const p = path(null);
    for (const msg of [ESTOP, STICK_RELEASE, ...OTHERS]) expect(p.send(msg)).toBe(true);
    expect(p.sent).toEqual([ESTOP, STICK_RELEASE, ...OTHERS]);
    expect(p.refusals).toEqual([]);
    expect(path(null, false).send(ESTOP)).toBe(false);
  });

  it("once tripped, sends the emergency stop and nothing else", () => {
    for (const change of TRIPPED) {
      const p = path(change);
      expect(p.send(ESTOP)).toBe(true);
      for (const msg of OTHERS) expect(p.send(msg), msg.type).toBe(false);
      expect(p.send(ESTOP)).toBe(true); // "send emergency stop again"
      expect(p.sent).toEqual([ESTOP, ESTOP]);
      expect(p.refusals).toEqual(OTHERS.map((m) => controlLocked(m)));
    }
  });

  it("refuses a stick release too, but without a reason: the pilot did not ask for it", () => {
    const p = path(TRIPPED[0]!);
    expect(p.send(STICK_RELEASE)).toBe(false);
    expect(p.sent).toEqual([]);
    expect(p.refusals).toEqual([]);
  });

  it("reads the guard on every message, so a trip between two messages takes effect at once", () => {
    let change: ModeChange | null = null;
    const sent: ControlMessage[] = [];
    const send = guardedControlSend((m) => (sent.push(m), true), () => change, () => {});
    expect(send({ type: "takeoff_land" })).toBe(true);
    change = { from: "sim", to: "real" };
    expect(send({ type: "takeoff_land" })).toBe(false);
    expect(send(ESTOP)).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["takeoff_land", "estop"]);
  });
});

const controlLocked = (m: ControlMessage) => controlLockedText(m.type);

describe("REST choke point", () => {
  const MUTATING: [string, string][] = [
    ["POST", "/api/mission/start"],
    ["POST", "/api/mission/ready"],
    ["POST", "/api/mission/calibrate-arrival"],
    ["PUT", "/api/mission/settings"],
    ["POST", "/api/hover-test/start"],
    ["PUT", "/api/trim"],
    ["POST", "/api/sim/scenario"],
    ["POST", "/api/schedule"],
    ["PUT", "/api/schedule/a"],
    ["DELETE", "/api/schedule/a"],
    ["POST", "/api/doses/a/acknowledge"],
    ["PUT", ABORT_PATH],
    ["DELETE", ABORT_PATH],
    ["POST", "/api/mission/abort-all"],
  ];
  const ALLOWED: [string, string][] = [
    ["GET", "/api/status"],
    ["GET", "/api/trim"],
    ["GET", "/api/schedule"],
    ["GET", "/api/events?limit=50"],
    ["get", "/api/status"],
    ["POST", "/api/mission/abort"],
    ["post", "/api/mission/abort"],
  ];

  it("lets every request out while the guard has not tripped", () => {
    for (const [m, p] of [...MUTATING, ...ALLOWED]) expect(requestRefusal(m, p, null)).toBeNull();
  });

  it("once tripped, refuses every mutating request with the locked text", () => {
    for (const change of TRIPPED) {
      for (const [m, p] of MUTATING) expect(requestRefusal(m, p, change), `${m} ${p}`).toBe(REQUEST_LOCKED_TEXT);
    }
  });

  it("once tripped, still lets GET requests and the run abort out", () => {
    for (const change of TRIPPED) {
      for (const [m, p] of ALLOWED) expect(requestRefusal(m, p, change), `${m} ${p}`).toBeNull();
    }
  });
});

describe("this page's latch", () => {
  // The latch lives as long as the module, like the page; this one test walks it from start to trip.
  it("starts untripped, trips on a change and stays tripped", () => {
    expect(pageModeChange()).toBeNull();
    expect(observePageMode(null)).toBeNull();
    expect(observePageMode("real")).toBeNull();
    expect(observePageMode("real")).toBeNull();
    const change = observePageMode("sim");
    expect(change).toEqual({ from: "real", to: "sim" });
    expect(observePageMode("real")).toBe(change);
    expect(pageModeChange()).toBe(change);
  });
});
