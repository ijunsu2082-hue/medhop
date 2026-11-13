// Replays __fixtures__/mixer.json (backend/tools/parity_traces.py mixer) through mixer.ts.
//
// Every scenario drives the Python ControlMixer through the RecordingLink of backend/tests/harness.py
// (plus `toggle_ok`, see ScriptLink) with a fake clock starting at 1000 s; the same steps are applied
// here. After every step the return value, the snapshot (exact snake_case keys), the link's counters,
// every axes tuple sent, every motor-cut result, every pilot-input callback (with what the link had
// seen at that moment) and every log line must match. The mixer is plain arithmetic, so all floats
// must be bit-identical.
import { describe, expect, it } from "vitest";
import type { Mode } from "../api/types";
import { ControlMixer, type ControlMixerOptions, type PilotInputKind } from "./mixer";
import { FakeClock, RecordingLink } from "./testing/harness";
import { assertNoMismatches, BIT_EXACT, compareValues, loadFixture, ParityStats } from "./testing/fixtures";
import { MemoryLogger } from "./util/log";
import { ValueError } from "./util/num";

interface Step {
  op: string;
  [key: string]: unknown;
  out: unknown;
  snap: unknown[];
  link: [axes: number, toggles: number, estops: number, calibrations: number];
  axes?: number[][];
  estop_results?: boolean[];
  events?: unknown[][];
  logs?: [string, string][];
}

interface Scenario {
  name: string;
  init: {
    clock?: number;
    rate_hz?: number;
    trim?: [number, number];
    max_stick?: number;
    mode?: Mode;
    control?: boolean;
    frame?: boolean;
    callback?: "record" | "none" | "raise" | "reenter";
  };
  steps: Step[];
}

interface MixerFixture {
  snapshot_fields: string[];
  scenarios: Scenario[];
}

const fx = loadFixture<MixerFixture>("mixer");

/** RecordingLink plus `toggleOk`, as the tool's ScriptLink: when set, what takeoffLandToggle() returns. */
class ScriptLink extends RecordingLink {
  toggleOk: boolean | null = null;

  override takeoffLandToggle(): boolean {
    if (this.toggleOk === null) return super.takeoffLandToggle();
    this.toggles += 1;
    return this.toggleOk;
  }
}

function num(value: unknown): number {
  if (typeof value !== "number") throw new Error(`expected a number in the fixture, got ${String(value)}`);
  return value;
}

function applyOp(op: Step, mixer: ControlMixer, link: ScriptLink, clock: FakeClock): unknown {
  let now = op["now"] === undefined ? undefined : num(op["now"]);
  if (op["now_rel"] !== undefined) now = clock.t + num(op["now_rel"]);
  try {
    switch (op.op) {
      case "advance":
        clock.advance(num(op["dt"]));
        return null;
      case "frame":
        link.newFrame(clock.t);
        return null;
      case "no_frame":
        link.frame = null;
        return null;
      case "link":
        if ("control" in op) link.control = op["control"] as boolean;
        if ("mode" in op) link.mode = op["mode"] as Mode;
        if ("toggle_ok" in op) link.toggleOk = op["toggle_ok"] as boolean | null;
        return null;
      case "tick":
        if (op["dt"]) clock.advance(num(op["dt"]));
        if (op["frame"]) link.newFrame(clock.t);
        return [...mixer.tick(now)];
      case "pilot_axes": {
        const [throttle, yaw, pitch, roll] = (op["v"] as number[]).map(num) as [number, number, number, number];
        mixer.pilotAxes(throttle, yaw, pitch, roll, now);
        return null;
      }
      case "pilot_disconnect":
        mixer.pilotDisconnect();
        return null;
      case "pilot_toggle": {
        const result = mixer.pilotToggle(now);
        return [result.ok, result.message, result.code];
      }
      case "mission_toggle":
        return mixer.missionToggle(now, (op["landing"] as boolean | undefined) ?? true);
      case "pilot_estop":
        return mixer.pilotEstop(now);
      case "estop_reset":
        mixer.estopReset();
        return null;
      case "calibrate":
        return mixer.calibrate();
      case "set_max_stick":
        return mixer.setMaxStick(num(op["value"]));
      case "set_trim":
        return mixer.setTrim(num(op["roll"]), num(op["pitch"]));
      case "trim":
        return mixer.trim();
      case "mission_command":
        mixer.missionCommand(num(op["yaw"]), num(op["pitch"]), now, op["roll"] === undefined ? 0.0 : num(op["roll"]));
        return null;
      case "clear_mission_command":
        mixer.clearMissionCommand();
        return null;
      case "seconds_since_toggle":
        return mixer.secondsSinceToggle(now);
      case "estop_active":
        return mixer.estopActive;
      case "snapshot":
        return snapshotRow(mixer, now);
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  } catch (error) {
    if (error instanceof ValueError) return { error: "ValueError", message: error.message };
    throw error;
  }
}

function snapshotRow(mixer: ControlMixer, now?: number): unknown[] {
  const snapshot = mixer.snapshot(now) as unknown as Record<string, unknown>;
  expect(Object.keys(snapshot).sort()).toEqual([...fx.snapshot_fields].sort());
  return fx.snapshot_fields.map((name) => {
    const value = snapshot[name];
    return Array.isArray(value) ? [...value] : value;
  });
}

function runScenario(scenario: Scenario, stats: ParityStats): void {
  const init = scenario.init;
  const clock = new FakeClock(init.clock ?? 1000.0);
  const link = new ScriptLink();
  link.mode = init.mode ?? "sim";
  link.control = init.control ?? true;
  if (init.frame ?? true) link.newFrame(clock.t);
  const events: unknown[][] = [];
  const logger = new MemoryLogger();
  const callbackKind = init.callback ?? "record";
  let mixerRef: ControlMixer | null = null;
  const callback = (kind: PilotInputKind): void => {
    const m = mixerRef!;
    events.push([kind, link.toggles, link.estops, link.axes.length, m.estopActive]);
    if (callbackKind === "raise") throw new Error("callback failed on purpose");
    if (callbackKind === "reenter") {
      if (kind === "toggle") m.missionCommand(0.05, 0.1);
      else if (kind === "estop") m.estopReset();
      else if (kind === "axes") m.clearMissionCommand();
    }
  };
  const options: ControlMixerOptions = {
    clock: clock.now,
    rateHz: init.rate_hz ?? 20.0,
    trim: init.trim ?? [0.0, 0.0],
    maxStick: init.max_stick ?? 0.5,
    onPilotInput: callbackKind === "none" ? null : callback,
    logger,
  };
  const mixer = new ControlMixer(link, options);
  mixerRef = mixer;
  expect(mixer.rateHz).toBe(init.rate_hz ?? 20.0);

  scenario.steps.forEach((step, i) => {
    const label = `${scenario.name}[${i}] ${step.op}`;
    const before = { axes: link.axes.length, results: link.estopResults.length, events: events.length, logs: logger.entries.length };
    const out = applyOp(step, mixer, link, clock);
    const actual = {
      out,
      snap: snapshotRow(mixer),
      axes: link.axes.slice(before.axes).map((a) => [...a]),
      estop_results: link.estopResults.slice(before.results),
      events: events.slice(before.events),
      logs: logger.entries.slice(before.logs),
    };
    const expected = {
      out: step.out,
      snap: step.snap,
      axes: step.axes ?? [],
      estop_results: step.estop_results ?? [],
      events: step.events ?? [],
      logs: step.logs ?? [],
    };
    assertNoMismatches(compareValues(actual, expected, BIT_EXACT, label, stats), label);
    // integers: exact
    expect([link.axes.length, link.toggles, link.estops, link.calibrations], label).toEqual(step.link);
  });
}

describe("ControlMixer against mixer.py", () => {
  it("the fixture covers what it claims", () => {
    const names = fx.scenarios.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["priority", "ramp", "estop", "toggles_and_guards", "real_mode_sticks_blocked", "fuzz_real"]),
    );
    const steps = fx.scenarios.flatMap((s) => s.steps);
    const sources = new Set(steps.map((s) => s.snap[5]));
    expect(sources).toEqual(new Set(["estop", "pilot", "mission", "neutral"]));
    expect(steps.some((s) => s.snap[7] === true)).toBe(true); // estop_confirmed
    expect(steps.some((s) => s.snap[8] === true)).toBe(true); // sticks_blocked
    const codes = new Set(steps.filter((s) => s.op === "pilot_toggle").map((s) => (s.out as unknown[])[2]));
    expect(codes).toEqual(new Set([null, "estop_active", "landing_in_progress", "toggle_guard", "drone_link_down"]));
    expect(steps.some((s) => (s.logs ?? []).some(([, message]) => message === "pilot-input callback failed"))).toBe(true);
  });

  for (const scenario of fx.scenarios) {
    it(`${scenario.name}: ${scenario.steps.length} steps`, () => {
      const stats = new ParityStats();
      runScenario(scenario, stats);
      expect(stats.bitExact).toBe(stats.floats);
    });
  }

  it("throws ValueError where Python raises it", () => {
    const clock = new FakeClock();
    const mixer = new ControlMixer(new RecordingLink(), { clock: clock.now });
    expect(() => mixer.setMaxStick(1.5)).toThrow(ValueError);
    expect(() => mixer.setMaxStick(1.5)).toThrow("max_stick must be between 0.2 and 1.0");
    expect(() => mixer.pilotAxes(0, Number.NaN, 0, 0)).toThrow("axis values must be finite numbers");
    expect(() => mixer.setTrim(Number.POSITIVE_INFINITY, 0)).toThrow(ValueError);
  });
});
