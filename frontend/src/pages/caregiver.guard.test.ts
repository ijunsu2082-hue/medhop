import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "../testing/cssGuard";

const css = readCss(import.meta.url, "./caregiver.css");
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration blocks whose selector mentions `.dose-status`. */
function doseStatusBlocks(source: string): string[] {
  return [...source.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").includes(".dose-status"))
    .map((m) => m[2] ?? "");
}

describe("caregiver.css design guard", () => {
  it("uses tokens only: no colour literals, shadows, blur, odd radii or literal font families", () => {
    expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
  });

  it("has no fade mask, inner scroller height or dimmed row actions", () => {
    expect(withoutComments).not.toContain("mask-image");
    expect(withoutComments).not.toContain("max-height: 520px");
    expect(withoutComments).not.toContain("opacity: 0.75");
  });

  it("never clips a dose status line", () => {
    const blocks = doseStatusBlocks(withoutComments);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).not.toContain("white-space: nowrap");
  });

  it("sets type through the role tokens only: every font shorthand is a var(--t-*)", () => {
    const shorthands = [...withoutComments.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)].map((m) => (m[1] ?? "").trim());
    expect(shorthands.length).toBeGreaterThan(0);
    for (const value of shorthands) expect(value).toMatch(/^var\(--t-[a-z-]+\)$/);
  });

  it("is scoped under .caregiver", () => {
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((s) => s && !s.startsWith("@"));
    for (const group of selectors) {
      for (const sel of group.split(",")) expect(sel.trim()).toMatch(/^\.caregiver(\s|$|[.>:])/);
    }
  });
});
