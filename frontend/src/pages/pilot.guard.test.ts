import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "../testing/cssGuard";

const css = readCss(import.meta.url, "./pilot.css");

/** Selectors of the rule blocks, comments removed. */
function selectors(source: string): string[] {
  const out: string[] = [];
  for (const m of source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    const sel = m[1]!.trim();
    if (!sel.startsWith("@")) out.push(...sel.split(",").map((s) => s.trim()));
  }
  return out;
}

describe("pilot.css guard", () => {
  it("breaks none of the CSS rules", () => {
    expect(css.length).toBeGreaterThan(2000);
    expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
  });

  it("scopes every rule under .pilot", () => {
    for (const sel of selectors(css)) expect(sel.startsWith(".pilot"), sel).toBe(true);
  });

  it("writes no rule for the classes contract C4 gives the sibling files", () => {
    const sibling = [
      "run-step", "run-mode", "run-track", "run-state", "run-outcome", "run-options", "run-title-chip", "blockers",
      "blocker-step", "confirm-card", "abort-notice", "drift-assist", "key-legend", "key-cluster", "key-singles",
      "key-does", "key-estop", "hold-btn", "axes", "axis", "axis-track", "axis-fill", "axis-zero", "axis-value",
      "stickpad", "stickpad-group", "setup-card", "setup-grid", "setup-summary", "trim-grid", "trim-values", "maxstick",
      "progress-row", "hover-result",
    ];
    for (const name of sibling) expect(new RegExp(`\\.${name}(?![a-z0-9_-])`).test(css), name).toBe(false);
  });

  it("uses none of the removed classes", () => {
    for (const name of ["vchip", "pilot-sim-note", "pilot-camera-head", "eyebrow", "panel", "chip", "badge", "conn"]) {
      expect(new RegExp(`\\.${name}(?![a-z0-9_-])`).test(css), name).toBe(false);
    }
  });

  it("never transitions the hold fill's transform", () => {
    const fill = /\.pilot \.takeoff-fill\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(fill).toMatch(/transition:\s*none/);
    expect(css).not.toMatch(/transition:[^;]*transform/);
  });
});
