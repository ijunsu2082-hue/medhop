import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "../testing/cssGuard";

const css = readCss(import.meta.url, "./care.css");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Innermost blocks as [selector list, body]. */
function blocks(source: string): [string, string][] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [(m[1] ?? "").trim(), m[2] ?? ""]);
}

/** The smallest px size a font shorthand or font-size can take: a plain size, or the floor of clamp()/max(). */
function minSizePx(value: string): number | null {
  const v = value.trim();
  const clamp = /^(?:clamp|max)\(\s*([\d.]+)px/.exec(v.replace(/^(?:\d{3}\s+)?/, ""));
  if (clamp) return Number(clamp[1]);
  const plain = /(?:^|\s)([\d.]+)px(?:\/|\s|$)/.exec(v);
  return plain ? Number(plain[1]) : null;
}

const sizes = blocks(clean).flatMap(([sel, body]) =>
  [...body.matchAll(/(?:^|[;\s])(font|font-size)\s*:\s*([^;]+)/g)].map((m) => ({ sel, prop: m[1]!, value: m[2]!.trim() })),
);

describe("care.css guard", () => {
  it("breaks none of the CSS rules", () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
  });

  it("is scoped under .care, or under .app--care for the shell on this page", () => {
    for (const [group] of blocks(clean)) {
      if (group.startsWith("@")) continue;
      for (const sel of group.split(",")) expect(sel.trim(), sel).toMatch(/^\.(care|app--care)(\s|$|[.>:])/);
    }
  });

  it("sets nothing under 18px, and no role token smaller than that", () => {
    expect(sizes.length).toBeGreaterThan(5);
    for (const { sel, prop, value } of sizes) {
      // The shared role tokens are 14-16px for body text: the Care page sets its own sizes.
      expect(value, `${sel} ${prop}`).not.toMatch(/var\(--t-/);
      const px = minSizePx(value);
      expect(px, `${sel} { ${prop}: ${value} }`).not.toBeNull();
      expect(px!, `${sel} { ${prop}: ${value} }`).toBeGreaterThanOrEqual(18);
    }
  });

  it("sets the clock and the dose label very large", () => {
    const of = (selector: string) => sizes.filter((s) => s.sel === selector && s.prop === "font").map((s) => minSizePx(s.value)!);
    expect(of(".care .care-clock").length).toBeGreaterThan(0);
    for (const px of of(".care .care-clock")) expect(px).toBeGreaterThanOrEqual(64);
    expect(of(".care .care-dose").length).toBeGreaterThan(0);
    for (const px of of(".care .care-dose")) expect(px).toBeGreaterThanOrEqual(44);
  });

  it("sets no red of its own: the one fault line uses the shared .tone-fail", () => {
    expect(clean).not.toContain("var(--red)");
  });
});
