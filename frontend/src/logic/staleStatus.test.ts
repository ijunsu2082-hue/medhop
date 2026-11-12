import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, STALE_CHECK_MS, isStale } from "./staleStatus";

describe("isStale", () => {
  it("uses a 2 s silence limit checked every 0.5 s", () => {
    expect(STALE_AFTER_MS).toBe(2000);
    expect(STALE_CHECK_MS).toBe(500);
  });

  it("is not stale at or below the limit", () => {
    expect(isStale(1000, 1000)).toBe(false);
    expect(isStale(1200, 1000)).toBe(false); // normal 5 Hz push gap
    expect(isStale(3000, 1000)).toBe(false); // exactly 2000 ms
  });

  it("is stale beyond the limit", () => {
    expect(isStale(3001, 1000)).toBe(true);
    expect(isStale(10_000, 0)).toBe(true);
  });

  it("a check every STALE_CHECK_MS detects silence within STALE_AFTER_MS + STALE_CHECK_MS", () => {
    const last = 500;
    let detectedAt: number | null = null;
    for (let t = last; t <= last + 5000; t += STALE_CHECK_MS) {
      if (isStale(t, last)) {
        detectedAt = t;
        break;
      }
    }
    expect(detectedAt).not.toBeNull();
    expect(detectedAt! - last).toBeLessThanOrEqual(STALE_AFTER_MS + STALE_CHECK_MS);
  });
});
