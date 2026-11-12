import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "../testing/cssGuard";

const css = readCss(import.meta.url, "./care.css");

describe("care.css guard", () => {
  it("breaks none of the CSS rules", () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
  });

  it("has no uppercase and no tertiary ink on the Care page", () => {
    expect(/text-transform\s*:\s*uppercase/i.test(css)).toBe(false);
    expect(css.includes("var(--ink-3)")).toBe(false);
  });

  it("uses no mono face", () => {
    expect(css.includes("var(--font-data)")).toBe(false);
  });
});
