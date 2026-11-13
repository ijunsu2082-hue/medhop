// Shared helpers for the parity tests: load a fixture written by backend/tools/parity_traces.py and
// compare the TypeScript results with the recorded Python ones.
//
// Fixtures are read with readFileSync + JSON.parse (not `import`): they are large, and the app's
// tsconfig has no Node types (see src/testing/nodeFs.d.ts). Floats were written with Python's repr,
// which round-trips exactly; NaN and the infinities as {"$float": "nan" | "inf" | "-inf"}.
//
// Comparison rules: strings, booleans and null exactly; numbers within a Tolerance (pass BIT_EXACT to
// require identical doubles). Integers (counts, ids) should be checked with exact expectations by the
// test that knows they are integers: after JSON.parse a JavaScript number cannot tell 1 from 1.0.

import { readFileSync } from "node:fs";

/** Read src/engine/__fixtures__/<name>.json and decode the non-finite float tags. */
export function loadFixture<T>(name: string): T {
  const text = readFileSync(new URL(`../__fixtures__/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(text, reviveFloats) as T;
}

function reviveFloats(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$float") {
      const tag = (value as { $float: unknown }).$float;
      if (tag === "nan") return Number.NaN;
      if (tag === "inf") return Infinity;
      if (tag === "-inf") return -Infinity;
      throw new Error(`unknown $float tag ${String(tag)}`);
    }
  }
  return value;
}

export interface Tolerance {
  /** relative to the larger magnitude of the two values */
  readonly rel: number;
  /** absolute floor, for values that are rounding noise around zero */
  readonly abs: number;
}

/** Identical doubles (NaN equals NaN; 0 equals -0). */
export const BIT_EXACT: Tolerance = Object.freeze({ rel: 0, abs: 0 });
/** The default parity tolerance: 1e-9 relative, 1e-12 absolute. */
export const PARITY: Tolerance = Object.freeze({ rel: 1e-9, abs: 1e-12 });

export function floatsClose(actual: number, expected: number, tol: Tolerance): boolean {
  if (Number.isNaN(expected) || Number.isNaN(actual)) return Number.isNaN(expected) && Number.isNaN(actual);
  if (actual === expected) return true;
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  const diff = Math.abs(actual - expected);
  return diff <= tol.abs || diff <= tol.rel * Math.max(Math.abs(actual), Math.abs(expected));
}

/** How close a run of float comparisons was: how many were bit-identical and the largest differences. */
export class ParityStats {
  floats = 0;
  bitExact = 0;
  maxAbs = 0;
  maxRel = 0;
  worstPath = "";

  record(path: string, actual: number, expected: number): void {
    this.floats += 1;
    if (actual === expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
      this.bitExact += 1;
      return;
    }
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return;
    const diff = Math.abs(actual - expected);
    const scale = Math.max(Math.abs(actual), Math.abs(expected));
    const rel = scale > 0 ? diff / scale : 0;
    if (diff > this.maxAbs) this.maxAbs = diff;
    if (rel > this.maxRel) {
      this.maxRel = rel;
      this.worstPath = path;
    }
  }

  summary(label: string): string {
    const worst = this.worstPath ? ` (worst at ${this.worstPath})` : "";
    return (
      `${label}: ${this.floats} floats, ${this.bitExact} bit-identical to Python, ` +
      `max abs diff ${this.maxAbs.toExponential(2)}, max rel diff ${this.maxRel.toExponential(2)}${worst}`
    );
  }
}

/**
 * Deep comparison. Returns a list of mismatches (empty when everything agrees). Objects must have
 * exactly the same keys, so a snake_case wire key that went missing or got renamed is reported.
 */
export function compareValues(
  actual: unknown,
  expected: unknown,
  tol: Tolerance,
  path = "$",
  stats?: ParityStats,
  mismatches: string[] = [],
): string[] {
  if (typeof expected === "number") {
    if (typeof actual !== "number") {
      mismatches.push(`${path}: expected number ${expected}, got ${describe(actual)}`);
    } else {
      stats?.record(path, actual, expected);
      if (!floatsClose(actual, expected, tol)) mismatches.push(`${path}: expected ${expected}, got ${actual}`);
    }
    return mismatches;
  }
  if (expected === null || typeof expected === "string" || typeof expected === "boolean") {
    if (actual !== expected) mismatches.push(`${path}: expected ${describe(expected)}, got ${describe(actual)}`);
    return mismatches;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(`${path}: expected an array, got ${describe(actual)}`);
      return mismatches;
    }
    if (actual.length !== expected.length) {
      mismatches.push(`${path}: expected length ${expected.length}, got ${actual.length}`);
      return mismatches;
    }
    expected.forEach((item, i) => compareValues(actual[i], item, tol, `${path}[${i}]`, stats, mismatches));
    return mismatches;
  }
  if (typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      mismatches.push(`${path}: expected an object, got ${describe(actual)}`);
      return mismatches;
    }
    const want = Object.keys(expected).sort();
    const got = Object.keys(actual).sort();
    if (want.join(",") !== got.join(",")) {
      mismatches.push(`${path}: expected keys [${want.join(", ")}], got [${got.join(", ")}]`);
      return mismatches;
    }
    for (const key of want) {
      compareValues(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        tol,
        `${path}.${key}`,
        stats,
        mismatches,
      );
    }
    return mismatches;
  }
  mismatches.push(`${path}: unsupported expected value ${describe(expected)}`);
  return mismatches;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return String(value);
}

/** Throw with the first few mismatches (for use inside a test). */
export function assertNoMismatches(mismatches: readonly string[], context: string): void {
  if (mismatches.length === 0) return;
  const shown = mismatches.slice(0, 12).join("\n  ");
  const more = mismatches.length > 12 ? `\n  ... and ${mismatches.length - 12} more` : "";
  throw new Error(`${context}: ${mismatches.length} mismatch(es) with Python\n  ${shown}${more}`);
}
