import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "../../testing/cssGuard";

const FILES = ["./station-run.css", "./manual.css", "./setup.css"] as const;

/** Selectors of every rule block, comments removed. */
function selectors(css: string): string[] {
  const out: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{/g)) {
    const prelude = (m[1] ?? "").trim();
    if (!prelude.startsWith("@")) out.push(...prelude.split(",").map((s) => s.trim()));
  }
  return out;
}

describe("pilot panel CSS (station run, manual flying, setup)", () => {
  for (const file of FILES) {
    const css = readCss(import.meta.url, file);

    it(`${file} follows the design rules`, () => {
      expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
    });

    it(`${file} leaves the hold buttons to pilot.css`, () => {
      expect(css).not.toContain(".takeoff");
      expect(css).not.toContain(".calibrate-btn");
    });

    it(`${file} styles nothing owned by the page frame`, () => {
      const owned = /\.(command-|estop|strip-|readout|camera|video-|check|manual-grid|manual-keys|manual-live)/;
      expect(selectors(css).filter((s) => owned.test(s))).toEqual([]);
    });

    it(`${file} scopes every rule under .pilot`, () => {
      const unscoped = selectors(css).filter((s) => s && !s.startsWith(".pilot "));
      expect(unscoped).toEqual([]);
    });

    it(`${file} defines no custom properties of its own`, () => {
      expect(css).not.toMatch(/(^|[;{\s])--[a-z0-9-]+\s*:/);
    });

    it(`${file} sets no red: faults use the shared .msg-fail`, () => {
      expect(css).not.toContain("var(--red)");
    });
  }
});
