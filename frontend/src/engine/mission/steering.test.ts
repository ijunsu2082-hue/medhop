// Replays __fixtures__/steering.json (backend/tools/parity_traces.py steering) through steering.ts.
//
// The pure functions and the Steering sequences are plain IEEE arithmetic in the same order as the
// Python, so they must be bit-identical. DriftAssist is bit-identical too, except its smoothed
// slide_rate: that is `rate + (new - rate) * (1 - exp(-dt / tau))`, and Math.exp differs from the C
// library's exp in the last bit for some arguments (7 of 60 typical ones, see num.test.ts), so
// slide_rate is compared at the parity tolerance (1e-9 relative, 1e-12 absolute; the largest difference
// seen is 1.1e-16 absolute). slide_rate only feeds the self-check's comparisons, so the roll, the trim
// suggestion and every flag stay bit-identical. The axis smoothing also uses exp(); in these traces its
// last-bit differences never reach the roll. If a regenerated fixture shows a roll off by one ulp, that
// is where to look.
import { describe, expect, it } from "vitest";
import { assertNoMismatches, BIT_EXACT, compareValues, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import type { Corner } from "../vision/marker";
import {
  DriftAssist,
  type DriftAssistConfig,
  forwardForWidth,
  limitRise,
  makeDriftAssistConfig,
  makeSteeringConfig,
  markerSkew,
  type MarkerSample,
  pendingYaw,
  predictCx,
  steer,
  Steering,
  type SteeringConfig,
  type YawLog,
} from "./steering";

type Row = [ts: number, cx: number, width: number];

interface SteeringFixture {
  configs: Record<string, SteeringConfig>;
  functions: {
    pending_yaw: { yaw_log: [number, number][]; start: number; now: number; out: number }[];
    predict_cx: { history: Row[]; yaw_log: [number, number][]; now: number; cfg: string; out: number }[];
    forward_for_width: { width: number; arrive_width: number; cfg: string; out: number }[];
    steer: { history: Row[]; yaw_log: [number, number][]; now: number; arrive_width: number; cfg: string | null; out: [number, number] }[];
    limit_rise: { fields: string[]; rows: [number, number, number, number, number][] };
    marker_skew: { corners: Corner[]; out: number }[];
  };
  sequences: { name: string; cfg: string; steps: SteeringStep[] }[];
  drift_state_fields: string[];
  drift_sequences: { name: string; cfg: DriftAssistConfig; assumed_yaw_rate: number; steps: DriftStep[] }[];
}

type SteeringStep =
  | { op: "update"; history: Row[]; now: number; arrive_width: number; no_forward: boolean; out: [number, number] }
  | { op: "search"; now: number; direction: number; creep: boolean; out: [number, number] }
  | { op: "neutral"; now: number; out: [number, number] }
  | { op: "shape"; yaw: number; pitch: number; now: number; out: [number, number] }
  | { op: "yaw_seen_between"; earlier: number; later: number; out: number }
  | { op: "reset"; out: null };

type DriftStep =
  | { op: "update"; in: [number, number, number, number, number, number, boolean]; out: number; st: unknown[] }
  | { op: "pause"; out: number; st: unknown[] }
  | { op: "reset"; out: null; st: unknown[] };

const fx = loadFixture<SteeringFixture>("steering");

function samples(rows: readonly Row[]): MarkerSample[] {
  return rows.map(([ts, cx, width]) => ({ ts, cx, width }));
}

function cfgOf(name: string | null): SteeringConfig | null {
  if (name === null) return null;
  const cfg = fx.configs[name];
  if (cfg === undefined) throw new Error(`unknown config ${name}`);
  return makeSteeringConfig(cfg);
}

function check(label: string, actual: unknown, expected: unknown, stats: ParityStats, tol = BIT_EXACT): void {
  assertNoMismatches(compareValues(actual, expected, tol, label, stats), label);
}

describe("steering.ts functions against steering.py", () => {
  it("the fixture's configs are complete SteeringConfigs", () => {
    for (const cfg of Object.values(fx.configs)) expect(Object.keys(cfg).sort()).toEqual(Object.keys(makeSteeringConfig()).sort());
  });

  it("pendingYaw", () => {
    const stats = new ParityStats();
    fx.functions.pending_yaw.forEach((c, i) => check(`pending_yaw[${i}]`, pendingYaw(c.yaw_log as YawLog, c.start, c.now), c.out, stats));
    expect(stats.floats).toBeGreaterThan(150);
  });

  it("predictCx", () => {
    const stats = new ParityStats();
    fx.functions.predict_cx.forEach((c, i) =>
      check(`predict_cx[${i}]`, predictCx(samples(c.history), c.yaw_log, c.now, cfgOf(c.cfg)!), c.out, stats),
    );
  });

  it("forwardForWidth", () => {
    const stats = new ParityStats();
    fx.functions.forward_for_width.forEach((c, i) =>
      check(`forward_for_width[${i}]`, forwardForWidth(c.width, c.arrive_width, cfgOf(c.cfg)!), c.out, stats),
    );
  });

  it("steer (including an empty history, the deadband and window edges, and a NaN centre)", () => {
    const stats = new ParityStats();
    fx.functions.steer.forEach((c, i) =>
      check(`steer[${i}]`, steer(samples(c.history), c.yaw_log, c.now, c.arrive_width, cfgOf(c.cfg)), c.out, stats),
    );
    expect(stats.floats).toBeGreaterThan(300);
  });

  it("limitRise over a grid with sign changes, signed zeros, NaN and negative dt", () => {
    const stats = new ParityStats();
    fx.functions.limit_rise.rows.forEach(([previous, target, dt, rise, out], i) =>
      check(`limit_rise[${i}]`, limitRise(previous, target, dt, rise), out, stats),
    );
    expect(stats.floats).toBe(fx.functions.limit_rise.rows.length);
  });

  it("markerSkew", () => {
    const stats = new ParityStats();
    fx.functions.marker_skew.forEach((c, i) => check(`marker_skew[${i}]`, markerSkew(c.corners), c.out, stats));
    expect(() => markerSkew([[0, 0]])).toThrow();
  });
});

describe("Steering sequences against steering.py", () => {
  for (const seq of fx.sequences) {
    it(`${seq.name}: ${seq.steps.length} steps, bit-identical`, () => {
      const st = new Steering(cfgOf(seq.cfg));
      const stats = new ParityStats();
      seq.steps.forEach((step, i) => {
        const label = `${seq.name}[${i}] ${step.op}`;
        switch (step.op) {
          case "update":
            check(label, st.update(samples(step.history), step.now, step.arrive_width, step.no_forward), step.out, stats);
            break;
          case "search":
            check(label, st.search(step.now, step.direction, step.creep), step.out, stats);
            break;
          case "neutral":
            check(label, st.neutral(step.now), step.out, stats);
            break;
          case "shape":
            check(label, st.shape(step.yaw, step.pitch, step.now), step.out, stats);
            break;
          case "yaw_seen_between":
            check(label, st.yawSeenBetween(step.earlier, step.later), step.out, stats);
            break;
          case "reset":
            st.reset();
            break;
        }
      });
      expect(stats.bitExact).toBe(stats.floats);
    });
  }
});

describe("DriftAssist sequences against steering.py", () => {
  it("records the state fields the replay reads", () => {
    expect(fx.drift_state_fields).toEqual([
      "active",
      "slide_rate",
      "yaw_rate",
      "calibrated",
      "disabled_reason",
      "disabled_by",
      "mean_roll_near_end",
    ]);
  });

  for (const seq of fx.drift_sequences) {
    it(`${seq.name}: ${seq.steps.length} frames`, () => {
      const assist = new DriftAssist(makeDriftAssistConfig(seq.cfg), seq.assumed_yaw_rate);
      const stats = new ParityStats();
      const inexact = new Map<string, number>();
      seq.steps.forEach((step, i) => {
        const label = `${seq.name}[${i}] ${step.op}`;
        let out: number | null = null;
        if (step.op === "update") out = assist.update(...step.in);
        else if (step.op === "pause") out = assist.pause();
        else assist.reset();
        const state = [
          assist.active,
          assist.slideRate,
          assist.yawRate,
          assist.calibrated,
          assist.disabledReason,
          assist.disabledBy,
          assist.meanRollNearEnd(),
        ];
        // slide_rate (index 1) at the parity tolerance, everything else bit-identical
        const [stActive, stSlide, ...stRest] = state;
        const [wantActive, wantSlide, ...wantRest] = step.st;
        assertNoMismatches(compareValues(stSlide, wantSlide, PARITY, `${label}.slide_rate`, stats), label);
        assertNoMismatches(compareValues(out, step.out, BIT_EXACT, `${label}.out`, stats), label);
        assertNoMismatches(
          compareValues([stActive, ...stRest], [wantActive, ...wantRest], BIT_EXACT, `${label}.st`, stats),
          label,
        );
        expect(assist.roll).toBe(out ?? assist.roll);
        const fields: [string, unknown, unknown][] = [["roll", out, step.out]];
        fx.drift_state_fields.forEach((name, k) => fields.push([name, state[k], step.st[k]]));
        for (const [name, got, want] of fields) {
          if (typeof want === "number" && !Object.is(got, want)) inexact.set(name, (inexact.get(name) ?? 0) + 1);
        }
      });
      const which = [...inexact].map(([name, n]) => `${name} x${n}`).join(", ") || "none";
      console.info(`${stats.summary(`drift ${seq.name}`)}; not bit-identical: ${which}`);
    });
  }

  it("covers both self-check switch-offs (as recorded)", () => {
    const reasons = fx.drift_sequences.flatMap((s) => s.steps.map((step) => step.st[5])).filter((v) => v !== null);
    expect(new Set(reasons)).toEqual(new Set(["slide", "aspect"]));
  });
});
