// Replays __fixtures__/avoid.json (backend/tools/parity_traces.py avoid) through avoid.ts.
//
// The pure functions over grids of boxes (every config: the drone camera, a low camera that sees the
// floor from 0.76 m, the camera on the ground, and a wide lens with every figure changed), and the state
// machine over scripted sequences (tests/test_avoid.py's) and random ones that between them reach every
// state and transition. Every step is compared: the command it returned, the state, the hold count, the
// time held, the blocked reason, the target (which of this step's obstacles, or the previous target
// kept), the snapshot and the number of events; at the end the whole event list, keys in Python's order.
// Floats within the parity tolerance (Math.tan, atan2 and sin may differ from the C library in the last
// bit); everything else exactly.
import { describe, expect, it } from "vitest";
import { assertNoMismatches, compareValues, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import {
  AVOID_CONFIG_DEFAULTS,
  AVOID_STATES,
  Avoider,
  blindDistanceM,
  estimate,
  floorDistanceM,
  focalFh,
  focalFw,
  nearest,
  NOT_MOVING_ON,
  signLateralM,
  type AvoidCommand,
  type AvoidConfig,
  type Box,
  type Seen,
} from "./avoid";

type BoxInput = [kind: string, box: Box];
type StepRow = [
  now: number,
  seen: BoxInput[],
  fresh: boolean,
  sign: [number, number] | null,
  out: unknown[],
  state: string,
  holds: number,
  noProgressS: number,
  blockedReason: string | null,
  target: number | "same" | null,
  snap: unknown[],
  eventsN: number,
];

interface AvoidFixture {
  config_defaults: Record<string, number>;
  configs: Record<string, AvoidConfig>;
  constants: { AVOID_STATES: string[]; NOT_MOVING_ON: string[] };
  functions: {
    ts: number;
    geometry: Record<string, { focal_fw: number; focal_fh: number; blind_distance_m: number }>;
    floor: [cfg: string, y2: number, out: number | null][];
    estimate: [cfg: string, kind: string, box: Box, out: unknown[]][];
    nearest: [items: BoxInput[], index: number | null][];
    sign_lateral: [cfg: string, cx: number, rangeM: number, out: number][];
  };
  sequences: { name: string; cfg: string; steps: StepRow[]; events: Record<string, unknown>[] }[];
}

const fx = loadFixture<AvoidFixture>("avoid");

function commandRow(c: AvoidCommand): unknown[] {
  return [c.state, c.pitch_cap, c.pitch, c.roll, c.freeze_yaw, c.blocked, c.reason];
}

/** Every object's keys in the expected order (Python dicts keep insertion order; so does JSON.parse). */
function assertKeyOrder(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    expected.forEach((item, i) => assertKeyOrder(actual[i], item, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === "object" && actual !== null && typeof actual === "object") {
    expect(Object.keys(actual), `${path}: key order`).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected)) {
      assertKeyOrder((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
}

describe("avoid.ts against avoid.py", () => {
  it("config defaults and constants", () => {
    expect({ ...AVOID_CONFIG_DEFAULTS }).toEqual(fx.config_defaults);
    expect(Object.keys(AVOID_CONFIG_DEFAULTS)).toEqual(Object.keys(fx.config_defaults));
    expect([...AVOID_STATES]).toEqual(fx.constants.AVOID_STATES);
    expect([...NOT_MOVING_ON]).toEqual(fx.constants.NOT_MOVING_ON);
  });

  it("geometry, floor distance and the sign's sideways position", () => {
    const stats = new ParityStats();
    for (const [name, want] of Object.entries(fx.functions.geometry)) {
      const cfg = fx.configs[name]!;
      const got = { focal_fw: focalFw(cfg), focal_fh: focalFh(cfg), blind_distance_m: blindDistanceM(cfg) };
      assertNoMismatches(compareValues(got, want, PARITY, `geometry.${name}`, stats), name);
    }
    for (const [cfgName, y2, out] of fx.functions.floor) {
      const label = `floor ${cfgName} ${y2}`;
      assertNoMismatches(compareValues(floorDistanceM(y2, fx.configs[cfgName]!), out, PARITY, label, stats), label);
    }
    for (const [cfgName, cx, rangeM, out] of fx.functions.sign_lateral) {
      const label = `sign_lateral ${cfgName} ${cx} ${rangeM}`;
      assertNoMismatches(compareValues(signLateralM(cx, rangeM, fx.configs[cfgName]!), out, PARITY, label, stats), label);
    }
    console.info(stats.summary("avoid geometry"));
  });

  it(`estimate over ${fx.functions.estimate.length} boxes (in and out of the lane, cut off, above the horizon, NaN)`, () => {
    expect(fx.functions.estimate.length).toBeGreaterThan(400);
    const stats = new ParityStats();
    let veryClose = 0;
    let inLane = 0;
    for (const [cfgName, kind, box, out] of fx.functions.estimate) {
      const s = estimate(kind, box, fx.functions.ts, fx.configs[cfgName]!);
      const label = `estimate ${cfgName} ${kind} ${JSON.stringify(box)}`;
      expect(s.kind).toBe(kind);
      expect(s.ts).toBe(fx.functions.ts);
      assertNoMismatches(compareValues([...s.box], box, PARITY, label), label);
      const got = [s.distance_m, s.lateral_m, s.half_width_m, s.near_m, s.in_lane];
      assertNoMismatches(compareValues(got, out, PARITY, label, stats), label);
      if (s.veryClose) veryClose += 1;
      if (s.in_lane) inLane += 1;
      expect(s.loM === null).toBe(s.lateral_m === null);
    }
    expect(veryClose).toBeGreaterThan(50);
    expect(inLane).toBeLessThan(fx.functions.estimate.length);
    console.info(stats.summary("estimate"));
  });

  it("nearest: very close first, the first of equals, null for none", () => {
    const cfg = fx.configs["default"]!;
    for (const [items, index] of fx.functions.nearest) {
      const seen = items.map(([kind, box]) => estimate(kind, box, fx.functions.ts, cfg));
      const best = nearest(seen);
      expect(best === null ? null : seen.indexOf(best), JSON.stringify(items)).toBe(index);
    }
  });

  for (const sequence of fx.sequences) {
    it(`state machine: ${sequence.name} (${sequence.steps.length} steps)`, () => {
      const cfg = fx.configs[sequence.cfg]!;
      const avoider = new Avoider(cfg);
      const stats = new ParityStats();
      let previous: Seen | null = null;
      sequence.steps.forEach((row, i) => {
        const [now, items, fresh, sign, out, state, holds, noProgressS, blockedReason, target, snap, eventsN] = row;
        const label = `${sequence.name}[${i}]`;
        const seen = items.map(([kind, box]) => estimate(kind, box, now, cfg));
        const command = avoider.update(now, seen, fresh, sign);
        let ref: number | "same" | null;
        if (avoider.target === null) ref = null;
        else if (seen.includes(avoider.target)) ref = seen.indexOf(avoider.target);
        else {
          expect(avoider.target, `${label}: the target is this step's obstacle or the previous one`).toBe(previous);
          ref = "same";
        }
        previous = avoider.target;
        const s = avoider.snapshot();
        const actual = [
          commandRow(command),
          avoider.state,
          avoider.holds,
          avoider.noProgressS,
          avoider.blockedReason,
          ref,
          [s.state, s.kind, s.distance_m, s.held_s],
          avoider.events.length,
        ];
        const expected = [out, state, holds, noProgressS, blockedReason, target, snap, eventsN];
        assertNoMismatches(compareValues(actual, expected, PARITY, label, stats), label);
        expect(Object.keys(s)).toEqual(["state", "kind", "distance_m", "held_s"]);
      });
      assertNoMismatches(compareValues(avoider.events, sequence.events, PARITY, `${sequence.name}.events`, stats), "events");
      assertKeyOrder(avoider.events, sequence.events, `${sequence.name}.events`);
      console.info(stats.summary(sequence.name));
    });
  }

  it("the sequences reach every state and every transition", () => {
    const transitions = new Set<string>();
    for (const sequence of fx.sequences) {
      sequence.steps.forEach((row, i) => {
        if (i > 0 && sequence.steps[i - 1]![5] !== row[5]) transitions.add(`${sequence.steps[i - 1]![5]}>${row[5]}`);
      });
    }
    for (const t of ["clear>slow", "slow>clear", "clear>hold", "slow>hold", "hold>clear", "hold>blocked"]) {
      expect(transitions, t).toContain(t);
    }
    expect(fx.sequences.some((s) => s.steps.some((row) => row[11] === 200))).toBe(true); // the event list trimmed
  });
});
