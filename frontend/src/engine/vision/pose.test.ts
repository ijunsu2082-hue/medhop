// Replays __fixtures__/pose.json (backend/tools/parity_traces.py pose) through pose.ts.
//
// project() agrees with Python's _project to rounding (1e-9 relative is far more than it needs).
//
// fitSignPose cannot be bit-identical: numpy evaluates the products in OpenBLAS (another summation
// order, fused multiply-adds), np.linalg.solve is LAPACK's LU, and Math.sin/cos/atan2 differ from the
// C library in the last bit for some arguments. The fit then amplifies those last-bit differences:
//   - its Jacobian is a finite difference with a 1e-6 step, so a one-ulp difference in a projected
//     pixel (about 6e-14 px) becomes about 1e-10 of the Jacobian, and the first step differs by that;
//   - far and degenerate poses lie in a long, flat valley (height against pitch, lateral against yaw)
//     where the default 12 iterations stop before convergence, so the result depends on the whole
//     path, and every step's last bits;
//   - a converged fit can end on a tie: at the cost's rounding floor a tiny step is accepted by one
//     side (trial_cost < cost by one ulp) and refused by the other.
// The fixture therefore records, per case, how far Python's OWN result moves when its input corners
// move by one ulp (`spread`). Each field must agree within the parity tolerance (1e-9 relative,
// 1e-12 absolute) or, where Python's answer is itself that unstable, within SPREAD_FACTOR times
// Python's spread. Well-conditioned poses have a spread around 1e-14 and are held to 1e-9 in effect.
import { describe, expect, it } from "vitest";
import { assertNoMismatches, compareValues, floatsClose, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import type { Corner } from "./marker";
import { fitSignPose, project, solveLinear, type SignPose, type WorldPoint } from "./pose";

/** The largest TypeScript-to-Python difference allowed, in units of Python's own one-ulp spread. */
const SPREAD_FACTOR = 16;

interface FitCase {
  label: string;
  corners: Corner[];
  frame_w: number;
  frame_h: number;
  marker_size_m: number;
  hfov_deg: number;
  iterations: number;
  out: Record<string, number> | null;
  spread: Record<string, number> | null;
  stopped_by_rule: boolean | null;
}

interface PoseFixture {
  fields: string[];
  project: { params: number[]; world: WorldPoint[]; focal: number; cx0: number; cy0: number; out: number[] }[];
  fit: FitCase[];
  degenerate: FitCase[];
}

const fx = loadFixture<PoseFixture>("pose");

interface Outcome {
  cases: number;
  nulls: number;
  withinParity: number;
  neededSpread: number;
  neededSpreadAtCap: number;
  worstRatio: number;
  worstAt: string;
}

function replay(cases: readonly FitCase[], stats: ParityStats): Outcome {
  const outcome: Outcome = { cases: 0, nulls: 0, withinParity: 0, neededSpread: 0, neededSpreadAtCap: 0, worstRatio: 0, worstAt: "" };
  for (const c of cases) {
    outcome.cases += 1;
    const got = fitSignPose(c.corners, c.frame_w, c.frame_h, c.marker_size_m, c.hfov_deg, c.iterations);
    if (c.out === null || got === null) {
      expect(got === null, `${c.label}: null in Python, not in TypeScript (or the other way)`).toBe(c.out === null);
      outcome.nulls += 1;
      continue;
    }
    expect(Object.keys(got).sort(), c.label).toEqual([...fx.fields].sort());
    let needed = false;
    for (const field of fx.fields) {
      const actual = (got as unknown as Record<string, number>)[field]!;
      const expected = c.out[field]!;
      stats.record(`${c.label}.${field}`, actual, expected);
      if (floatsClose(actual, expected, PARITY)) continue;
      const spread = c.spread?.[field] ?? 0;
      expect(Number.isFinite(spread), `${c.label}.${field}: infinite spread leaves the field unchecked`).toBe(true);
      const diff = Math.abs(actual - expected);
      if (!(diff <= SPREAD_FACTOR * spread)) {
        throw new Error(
          `${c.label}.${field}: expected ${expected}, got ${actual}; the difference ${diff.toExponential(2)} is more ` +
            `than ${SPREAD_FACTOR} x Python's own one-ulp spread ${spread.toExponential(2)}`,
        );
      }
      needed = true;
      const ratio = diff / spread;
      if (ratio > outcome.worstRatio) {
        outcome.worstRatio = ratio;
        outcome.worstAt = `${c.label}.${field}`;
      }
    }
    if (!needed) outcome.withinParity += 1;
    else {
      outcome.neededSpread += 1;
      if (c.stopped_by_rule === false) outcome.neededSpreadAtCap += 1;
    }
  }
  return outcome;
}

function describeOutcome(label: string, o: Outcome): string {
  return (
    `${label}: ${o.cases} cases, ${o.nulls} null in both, ${o.withinParity} within 1e-9, ${o.neededSpread} within ` +
    `${SPREAD_FACTOR} x Python's one-ulp spread (${o.neededSpreadAtCap} of them stopped at the iteration cap); ` +
    `largest difference ${o.worstRatio.toFixed(2)} x spread${o.worstAt ? ` at ${o.worstAt}` : ""}`
  );
}

describe("pose.ts against pose.py", () => {
  it("SignPose has the Python fields", () => {
    expect(fx.fields).toEqual(["lateral_m", "distance_m", "height_m", "yaw_deg", "rms_px"]);
    const pose: SignPose | null = fitSignPose(fx.fit[0]!.corners, 640, 360, 0.18, 70);
    expect(pose).not.toBeNull();
  });

  it("project (Python _project), including a clamped depth and a marker behind the camera", () => {
    const stats = new ParityStats();
    fx.project.forEach((c, i) => {
      const got = project(c.params, c.world, c.focal, c.cx0, c.cy0);
      assertNoMismatches(compareValues(got, c.out, PARITY, `project[${i}]`, stats), `project[${i}]`);
    });
    expect(stats.maxRel).toBeLessThan(1e-14);
    console.info(stats.summary("project"));
  });

  it(`fitSignPose over ${fx.fit.length} poses (0.3 to 5 m, both frame sizes, with and without corner noise)`, () => {
    expect(fx.fit.length).toBeGreaterThanOrEqual(200);
    const stats = new ParityStats();
    const outcome = replay(fx.fit, stats);
    console.info(describeOutcome("fit", outcome));
    console.info(stats.summary("fit"));
    // About half the poses agree at the parity tolerance proper; the rest are covered case by case above.
    expect(outcome.withinParity).toBeGreaterThan(80);
  });

  it("fitSignPose on degenerate input", () => {
    const stats = new ParityStats();
    const outcome = replay(fx.degenerate, stats);
    console.info(describeOutcome("degenerate", outcome));
    const nulls = fx.degenerate.filter((c) => c.out === null).map((c) => c.label);
    expect(nulls).toEqual(
      expect.arrayContaining(["tiny: edges under 4 px", "all corners at one point", "NaN corner", "infinite corner", "frame width 0"]),
    );
  });

  it("throws, like numpy's reshape, unless given four (x, y) corners", () => {
    expect(() => fitSignPose([[0, 0]], 640, 360, 0.18, 70)).toThrow();
  });
});

describe("solveLinear", () => {
  it("solves a system that needs row swaps", () => {
    const a = [
      [0, 2, 1],
      [1, -2, -3],
      [-1, 1, 2],
    ];
    const x = solveLinear(a, [-8, 0, 3]);
    expect(x).not.toBeNull();
    const [x0, x1, x2] = x!;
    expect(x0).toBeCloseTo(-4, 12);
    expect(x1).toBeCloseTo(-5, 12);
    expect(x2).toBeCloseTo(2, 12);
  });

  it("returns null for an exactly singular matrix, as numpy raises LinAlgError", () => {
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
    expect(solveLinear([[0]], [1])).toBeNull();
  });

  it("does not treat a NaN pivot as singular (LAPACK does not either)", () => {
    const x = solveLinear([[Number.NaN]], [1]);
    expect(x).not.toBeNull();
    expect(x![0]).toBeNaN();
  });
});
