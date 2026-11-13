import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "../testing/cssGuard";

const css = readCss(import.meta.url, "./pilot.css");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Selectors of the rule blocks, comments removed. */
function selectors(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1]!.trim();
    if (!sel.startsWith("@")) out.push(...sel.split(",").map((s) => s.trim()));
  }
  return out;
}

/** Innermost blocks as [selector list, body]. */
function blocks(source: string): [string, string][] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [(m[1] ?? "").trim(), m[2] ?? ""]);
}

describe("pilot.css guard", () => {
  it("breaks none of the CSS rules", () => {
    expect(css.length).toBeGreaterThan(2000);
    expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
  });

  it("scopes every rule under .pilot", () => {
    for (const sel of selectors(clean)) expect(sel.startsWith(".pilot"), sel).toBe(true);
  });

  it("writes no rule for the classes the sibling files own", () => {
    const sibling = [
      "run-step", "run-mode", "run-track", "run-state", "run-options", "run-confirm", "blockers", "drift-assist",
      "auto-schedule", "key-legend", "key-cluster", "key-singles", "key-does", "key-estop", "hold-btn", "axes", "axis",
      "axis-track", "axis-fill", "axis-zero", "axis-value", "stickpad", "stickpad-group", "setup-row", "setup-toggle",
      "trim-grid", "trim-values", "maxstick", "progress-row", "hover-result",
    ];
    for (const name of sibling) expect(new RegExp(`\\.${name}(?![a-z0-9_-])`).test(clean), name).toBe(false);
  });

  it("keeps the strip sticky at the top with the emergency stop first", () => {
    const sticky = blocks(clean).find(([sel]) => sel === ".pilot .pilot-sticky")?.[1] ?? "";
    expect(sticky).toMatch(/position:\s*sticky/);
    expect(sticky).toMatch(/top:\s*0/);
    const areas = [...clean.matchAll(/grid-template-areas:\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    const stripAreas = areas.filter((a) => a.includes("estop"));
    expect(stripAreas.length).toBeGreaterThan(0);
    for (const a of stripAreas) expect(a.trim().startsWith("estop"), a).toBe(true);
  });

  it("uses red only for the emergency stop, its band and a video fault", () => {
    const red = blocks(clean).filter(([, body]) => body.includes("var(--red)"));
    expect(red.length).toBeGreaterThan(0);
    for (const [sel] of red) expect(sel, sel).toMatch(/estop|no_video/);
  });

  it("never transitions the hold fill's transform", () => {
    const fill = /\.pilot \.takeoff-fill\s*\{([^}]*)\}/.exec(clean)?.[1] ?? "";
    expect(fill).toMatch(/transition:\s*none/);
    expect(clean).not.toMatch(/transition:[^;]*transform/);
  });
});
