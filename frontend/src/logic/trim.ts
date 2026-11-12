import type { Trim } from "../api/types";

/** PUT /api/trim clamps each value to [-0.3, 0.3] (SPEC section 7). */
export const TRIM_LIMIT = 0.3;

export function clampTrim(v: number): number {
  return Math.round(Math.max(-TRIM_LIMIT, Math.min(TRIM_LIMIT, v)) * 100) / 100;
}

/**
 * Body for "Apply as trim": the suggested roll trim from the last run (already the full trim value, not a
 * delta: SPEC says it is current trim + mean assist roll) with the current pitch trim left unchanged.
 * Returns null when there is no usable suggestion.
 */
export function suggestedTrimBody(suggestedRoll: number | null | undefined, current: Trim): Trim | null {
  if (suggestedRoll === null || suggestedRoll === undefined || !Number.isFinite(suggestedRoll)) return null;
  return { roll: clampTrim(suggestedRoll), pitch: current.pitch };
}
