// Replays __fixtures__/num.json (backend/tools/parity_traces.py num): the Python number semantics
// that engine/util/num.ts mirrors. Everything here must match bit for bit, including the sign of zero,
// except the C library functions at the end, which are only reported.
import { describe, expect, it } from "vitest";
import { loadFixture, ParityStats } from "../testing/fixtures";
import { clamp, degrees, pyFormatFixed, pyHypot, pyMax, pyMedian, pyMin, pyOr, pyRepr, pyRound, pySum, pyTruthy, radians } from "./num";

interface NumFixture {
  round: { x: number; ndigits: number | null; out: number | { error: string } }[];
  format_fixed: { x: number; digits: number; out: string }[];
  repr: { x: number; out: string }[];
  hypot: { args: number[]; out: number }[];
  sum: { values: number[]; out: number }[];
  median: { values: number[]; out: number }[];
  clamp: { args: [number, number, number]; out: number }[];
  angles: { x: number; radians: number; degrees: number }[];
  libm: { f: "exp" | "sin" | "cos" | "tan" | "atan2"; args: number[]; out: number }[];
}

const fx = loadFixture<NumFixture>("num");

/** Identical doubles, -0 and 0 told apart, NaN equal to NaN. */
function same(a: number, b: number): boolean {
  return Object.is(a, b);
}

function failures<T>(cases: readonly T[], check: (c: T) => string | null): string[] {
  return cases.map(check).filter((m): m is string => m !== null);
}

describe("num.ts against CPython 3.12", () => {
  it("pyRound is round(): exact decimal rounding, ties to even, sign of zero kept", () => {
    expect(fx.round.length).toBeGreaterThan(400);
    const bad = failures(fx.round, (c) => {
      if (typeof c.out === "object") {
        try {
          pyRound(c.x);
          return `round(${c.x}) should throw (${c.out.error})`;
        } catch {
          return null;
        }
      }
      const got = c.ndigits === null ? pyRound(c.x) : pyRound(c.x, c.ndigits);
      return same(got, c.out) ? null : `round(${c.x}, ${c.ndigits}) = ${c.out}, got ${got}`;
    });
    expect(bad).toEqual([]);
  });

  it("pyFormatFixed is format(x, '.Nf')", () => {
    const bad = failures(fx.format_fixed, (c) => {
      const got = pyFormatFixed(c.x, c.digits);
      return got === c.out ? null : `format(${c.x}, '.${c.digits}f') = ${c.out}, got ${got}`;
    });
    expect(bad).toEqual([]);
  });

  it("pyRepr is repr(float)", () => {
    const bad = failures(fx.repr, (c) => (pyRepr(c.x) === c.out ? null : `repr(${c.x}) = ${c.out}, got ${pyRepr(c.x)}`));
    expect(bad).toEqual([]);
  });

  it("pyHypot is math.hypot, bit for bit", () => {
    expect(fx.hypot.length).toBeGreaterThan(600);
    const bad = failures(fx.hypot, (c) => {
      const got = pyHypot(...c.args);
      return same(got, c.out) ? null : `hypot(${c.args.join(", ")}) = ${c.out}, got ${got}`;
    });
    expect(bad).toEqual([]);
  });

  it("pySum is sum() (Neumaier compensated, Python 3.12)", () => {
    const bad = failures(fx.sum, (c) => {
      const got = pySum(c.values);
      return same(got, c.out) ? null : `sum of ${c.values.length} values = ${c.out}, got ${got}`;
    });
    expect(bad).toEqual([]);
    // the classic case where a naive loop differs
    expect(pySum(Array.from({ length: 10 }, () => 0.1))).toBe(1.0);
  });

  it("pyMedian is statistics.median", () => {
    const bad = failures(fx.median, (c) => (same(pyMedian(c.values), c.out) ? null : `median(${c.values.join(", ")})`));
    expect(bad).toEqual([]);
    expect(() => pyMedian([])).toThrow();
  });

  it("clamp is drone/base.py clamp: non-finite counts as 0.0", () => {
    const bad = failures(fx.clamp, (c) => {
      const got = clamp(...c.args);
      return same(got, c.out) ? null : `clamp(${c.args.join(", ")}) = ${c.out}, got ${got}`;
    });
    expect(bad).toEqual([]);
  });

  it("radians and degrees are math.radians and math.degrees", () => {
    for (const c of fx.angles) {
      expect(same(radians(c.x), c.radians)).toBe(true);
      expect(same(degrees(c.x), c.degrees)).toBe(true);
    }
  });

  it("pyMin/pyMax keep Python's NaN behaviour, pyTruthy/pyOr Python's truthiness", () => {
    expect(pyMin(0.25, Number.NaN)).toBe(0.25); // min(0.25, nan) == 0.25
    expect(pyMin(Number.NaN, 0.25)).toBeNaN(); // min(nan, 0.25) is nan
    expect(pyMax(1e-3, Number.NaN)).toBe(1e-3);
    expect(Object.is(pyMax(0.0, -0.0), 0.0)).toBe(true);
    expect(Object.is(pyMax(-0.0, 0.0), -0.0)).toBe(true);
    expect(pyTruthy(Number.NaN)).toBe(true);
    expect(pyTruthy(-0.0)).toBe(false);
    expect(pyOr(null, 0.0)).toBe(0.0);
    expect(pyOr(Number.NaN, 0.0)).toBeNaN();
  });

  it("the browser's exp/sin/cos/tan/atan2 against the C library's (reported, within 2 ulp)", () => {
    const fns = { exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2 } as const;
    const stats = new Map<string, ParityStats>();
    for (const c of fx.libm) {
      const got = (fns[c.f] as (...a: number[]) => number)(...c.args);
      const s = stats.get(c.f) ?? new ParityStats();
      stats.set(c.f, s);
      s.record(`${c.f}(${c.args.join(", ")})`, got, c.out);
      expect(Math.abs(got - c.out)).toBeLessThanOrEqual(4.5e-16 * Math.abs(c.out));
    }
    for (const [name, s] of stats) console.info(s.summary(`libm ${name}`));
  });
});
