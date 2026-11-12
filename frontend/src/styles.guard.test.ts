import { describe, expect, it } from "vitest";
import { cssViolations, readCss } from "./testing/cssGuard";

const css = readCss(import.meta.url, "./styles.css");

/** Hex tokens defined in the plain :root block. */
function rootTokens(source: string): Record<string, string> {
  const root = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(source.replace(/\/\*[\s\S]*?\*\//g, ""));
  const tokens: Record<string, string> = {};
  if (!root?.[1]) return tokens;
  for (const m of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1]!] = m[2]!.toUpperCase();
  }
  return tokens;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = rootTokens(css);

const EXPECTED: Record<string, string> = {
  "--paper": "#F3F0E8",
  "--sheet": "#FCFBF7",
  "--sunken": "#E8E4D9",
  "--ink": "#14130F",
  "--ink-hover": "#2B2A25",
  "--ink-2": "#3D3B34",
  "--ink-3": "#5C594F",
  "--border": "#77736A",
  "--rule": "#CFC9BA",
  "--console": "#14130F",
  "--console-2": "#24231F",
  "--console-inset": "#0C0C0A",
  "--console-rule": "#45433C",
  "--console-border": "#8C887C",
  "--on-console": "#F3F0E8",
  "--on-console-2": "#B9B5A8",
  "--pass": "#1A5C38",
  "--warn": "#7A4A00",
  "--fail": "#7E1B12",
  "--on-fail": "#FFFFFF",
  "--pass-on-console": "#62D394",
  "--warn-on-console": "#F5B841",
  "--fail-on-console": "#FF9482",
  "--signal": "#1F3FD1",
  "--signal-hover": "#17309F",
  "--signal-on-console": "#9DB2FF",
  "--sweep-on-ink": "#3D5BF0",
  "--sweep-on-light": "#6880F2",
  "--focus": "#1F3FD1",
  "--focus-on-console": "#9DB2FF",
  "--amber": "#F5B301",
  "--estop": "#D4210B",
  "--estop-hover": "#B31B08",
  "--estop-deep": "#941505",
  "--estop-text": "#FFFFFF",
};

describe("styles.css guard", () => {
  it("breaks none of the CSS rules", () => {
    expect(css.length).toBeGreaterThan(5000);
    expect(cssViolations(css, { allowRootColours: true })).toEqual([]);
  });

  it("defines every palette token with its exact value", () => {
    for (const [name, value] of Object.entries(EXPECTED)) expect(tokens[name], name).toBe(value);
  });

  it("defines none of the legacy tokens", () => {
    const legacy = [
      "--bg", "--surface", "--surface-2", "--surface-3", "--line", "--line-strong", "--text", "--text-2", "--muted",
      "--faint", "--accent", "--e1", "--e2", "--e3", "--shadow", "--radius", "--r-pill", "--sp-1", "--fs-xs", "--sans",
      "--mono", "--info", "--sim",
    ];
    for (const name of legacy) {
      expect(new RegExp(`(^|[\\s;{])${name}\\s*:`).test(css), name).toBe(false);
    }
  });

  it("uses none of the removed selectors", () => {
    const removed = [
      "panel", "card", "card-raised", "divider", "eyebrow", "chip", "badge", "conn", "btn-secondary", "btn-ghost",
      "btn-danger-outline", "input-lg", "select-lg", "topnav", "verdict-pass", "verdict-warn", "verdict-fail",
      "verdict-info",
    ];
    for (const name of removed) {
      expect(new RegExp(`\\.${name}(?![a-z0-9_-])`).test(css), name).toBe(false);
    }
  });

  it("meets the contrast floors", () => {
    const t = (name: string) => {
      const v = tokens[name];
      if (!v) throw new Error(`missing ${name}`);
      return v;
    };
    const floors: [string, string, number][] = [
      ["--ink", "--paper", 15],
      ["--ink-2", "--paper", 9],
      ["--ink-3", "--paper", 6],
      ["--ink-2", "--sunken", 8],
      ["--border", "--paper", 4],
      ["--border", "--sunken", 3],
      ["--estop-text", "--estop", 4.5],
      ["--estop-text", "--estop-deep", 7],
      ["--fail", "--paper", 7],
      ["--warn", "--paper", 4.5],
      ["--pass", "--paper", 4.5],
      ["--signal", "--paper", 4.5],
      ["--ink", "--amber", 7],
      ["--on-console-2", "--console", 7],
      ["--on-console-2", "--console-2", 7],
      ["--console-border", "--console-2", 3],
      ["--pass-on-console", "--console", 7],
      ["--warn-on-console", "--console", 7],
      ["--fail-on-console", "--console", 7],
      ["--signal-on-console", "--console", 7],
      ["--sweep-on-ink", "--ink", 3],
      ["--paper", "--sweep-on-ink", 4.5],
      ["--sweep-on-light", "--paper", 3],
      ["--ink", "--sweep-on-light", 4.5],
    ];
    for (const [fg, bg, floor] of floors) {
      expect(contrast(t(fg), t(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe("cssViolations", () => {
  it("catches each forbidden pattern", () => {
    const bad = `
      .a { color: #fff; }
      .b { box-shadow: 0 1px 2px var(--ink); }
      .c { backdrop-filter: blur(4px); }
      .d { filter: blur(2px); }
      .e { border-radius: 999px; }
      .f { font-family: Helvetica, sans-serif; }
      .g { background: rgba(0, 0, 0, 0.5); }
    `;
    expect(cssViolations(bad, { allowRootColours: true })).toHaveLength(7);
  });

  it("allows tokens, root literals, data URIs and font faces", () => {
    const good = `
      @font-face { font-family: "X"; src: url(x.woff2); }
      :root { --a: #FFFFFF; --i: url("data:image/svg+xml,%3Csvg fill='%23000'%3E"); }
      .a { color: var(--a); box-shadow: none; border-radius: var(--r-2) 0 50%; font-family: var(--font-body); }
      @media (max-width: 639px) { .b { font: var(--t-body); } }
    `;
    expect(cssViolations(good, { allowRootColours: true })).toEqual([]);
    expect(cssViolations(good, { allowRootColours: false })).toHaveLength(1);
  });

  it("catches named colours on colour-bearing properties and in custom properties", () => {
    const cases = [
      ".a { color: white; }",
      ".a { background: black; }",
      ".a { border: 1px solid red; }",
      ".a { outline: 3px solid White; }",
      ".a { border-top-color: teal; }",
      ".a { fill: navy; }",
      ".a { --tone: tomato; }",
      ".a { color: var(--missing, white); }",
      ".a { text-decoration-color: gray; }",
    ];
    for (const rule of cases) expect(cssViolations(rule, { allowRootColours: true }), rule).toHaveLength(1);
  });

  it("catches functional colour notations", () => {
    const cases = [
      ".a { color: oklch(0.6 0.2 30); }",
      ".a { background: lab(50% 40 59); }",
      ".a { color: color(display-p3 1 0 0); }",
      ".a { background: color-mix(in srgb, var(--ink) 50%, var(--paper)); }",
      ".a { color: hwb(0 0% 0%); }",
    ];
    for (const rule of cases) expect(cssViolations(rule, { allowRootColours: true }), rule).toHaveLength(1);
  });

  it("allows colour keywords that are not literals, and words that only look like colours", () => {
    const good = `
      .a { color: currentColor; background: transparent; border-color: inherit; outline: none; fill: none; }
      .b { background: var(--red-ish); color: var(--white); border: 1px solid var(--c-border); }
      .c { grid-area: red; transition: background-color var(--t-fast) var(--ease); font: var(--t-body); }
      .d { background: currentColor url("icons/white.svg") no-repeat; }
    `;
    expect(cssViolations(good, { allowRootColours: false })).toEqual([]);
  });

  it("allows only the three radius tokens", () => {
    expect(cssViolations(".a { border-radius: var(--r-pill); }", { allowRootColours: true })).toHaveLength(1);
    expect(cssViolations(".a { border-radius: var(--r-3); }", { allowRootColours: true })).toHaveLength(1);
    expect(cssViolations(".a { border-radius: var(--r-0) var(--r-1) var(--r-2) 50%; }", { allowRootColours: true }))
      .toEqual([]);
  });

  it("accepts a font shorthand only as a role token, inherit, or metrics plus one var(--font-*)", () => {
    const bad = [
      ".a { font: 600 14px/20px Inter; }",
      ".a { font: 600 14px/20px Arial, Helvetica; }",
      ".a { font: 600 14px/20px Arial, var(--font-body); }",
      '.a { font: 600 14px/20px "Inter", var(--font-body); }',
      ".a { font: 16px var(--sans); }",
      ".a { font: menu; }",
    ];
    for (const rule of bad) expect(cssViolations(rule, { allowRootColours: true }), rule).toHaveLength(1);
    const good = `
      .a { font: var(--t-label); }
      .b { font: inherit; }
      .c { font: 600 18px/28px var(--font-body); }
      .d { font: 500 clamp(26px, 3.2vw, 32px)/1.2 var(--font-display); }
      .e { font: italic small-caps 700 1.25rem/1 var(--font-care) !important; }
    `;
    expect(cssViolations(good, { allowRootColours: false })).toEqual([]);
  });

  it("catches shadows by any name", () => {
    const cases = [
      ".a { -webkit-box-shadow: 0 1px 2px var(--ink); }",
      ".a { text-shadow: 0 1px 2px var(--ink); }",
      ".a { filter: drop-shadow(0 1px 2px var(--ink)); }",
      ".a { -webkit-filter: drop-shadow(0 0 4px var(--ink)); }",
    ];
    for (const rule of cases) expect(cssViolations(rule, { allowRootColours: true }), rule).toHaveLength(1);
    expect(cssViolations(".a { text-shadow: none; -webkit-box-shadow: none; }", { allowRootColours: true }))
      .toEqual([]);
  });

  it("does not read function names as colour keywords", () => {
    const good = ".a { --x: tan(45deg); --y: steps(4); transform: rotate(calc(tan(45deg) * 1turn)); }";
    expect(cssViolations(good, { allowRootColours: false })).toEqual([]);
    expect(cssViolations(".a { --x: tan; }", { allowRootColours: false })).toHaveLength(1);
  });

  it("names a removed token pattern nowhere: no --*-bg alias", () => {
    expect(/--[a-z0-9-]*-bg\s*:/.test(css)).toBe(false);
  });
});
