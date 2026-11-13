import { describe, expect, it } from "vitest";
import { cssViolations, customPropertiesUsed, readCss, rootCustomProperties, sourceFiles } from "./testing/cssGuard";

const SRC = new URL("./", import.meta.url);
const read = (path: string) => readCss(import.meta.url, `./${path}`);
const css = read("styles.css");

/** Every stylesheet and every component under src/, as paths relative to src/. */
const STYLESHEETS = sourceFiles(SRC, [".css"]);
const COMPONENTS = sourceFiles(SRC, [".tsx"]);

/** Hex tokens defined in the plain :root block. */
function rootTokens(source: string): Record<string, string> {
  const root = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(source.replace(/\/\*[\s\S]*?\*\//g, ""));
  const tokens: Record<string, string> = {};
  if (!root?.[1]) return tokens;
  for (const m of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
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

/**
 * The page colours: white page, two light greys, a grey for secondary text, near-black ink, one blue accent (with a
 * darker hover and a soft tint), one amber for waiting (with a soft tint), and one red for the emergency stop and faults.
 */
const PAGE: Record<string, string> = {
  "--bg": "#FFFFFF",
  "--fill": "#F4F4F4",
  "--line": "#DADADA",
  "--mid": "#6B6B6B",
  "--ink": "#111111",
  "--accent": "#1F5BD8",
  "--accent-strong": "#1747AD",
  "--accent-soft": "#E8EFFC",
  "--warn": "#8A5300",
  "--warn-soft": "#FBEFD9",
  "--red": "#C8102E",
};

/** The simulated corridor's own colours: the camera view (scene/SceneCanvas.tsx) and the plan view (scene/scene.css). */
const SCENE: Record<string, string> = {
  "--scene-wall": "#F1ECE2",
  "--scene-wall-side": "#E2DBCD",
  "--scene-ceiling": "#F8F6F1",
  "--scene-floor": "#B9CFCB",
  "--scene-floor-line": "#9DB9B4",
  "--scene-floor-plan": "#EAF1EF",
  "--scene-rail": "#7C9A95",
  "--scene-door": "#C99A64",
  "--scene-door-edge": "#9C7443",
  "--scene-picture": "#5B8DB8",
  "--scene-cloth-1": "#2E8B7A",
  "--scene-cloth-2": "#C2573A",
  "--scene-cloth-3": "#474E57",
  "--scene-skin": "#D9A781",
  "--scene-trolley": "#A7B0B8",
  "--scene-trolley-edge": "#5F6C77",
  "--scene-outline": "#2B2F33",
  "--scene-tracking": "#0B7A57",
  "--scene-obstacle": "#A35200",
};

const EXPECTED: Record<string, string> = { ...PAGE, ...SCENE };

/** The only files that may name a --scene-* token: where they are defined, and the two drawings of the corridor. */
const SCENE_FILES = ["styles.css", "scene/scene.css", "scene/SceneCanvas.tsx"];
const SCENE_TOKEN = /--scene-[a-z0-9-]+/;

/** Tokens of the earlier designs. None may be defined or read anywhere. */
const OLD_TOKENS = [
  "--paper", "--sheet", "--sunken", "--ink-hover", "--ink-2", "--ink-3", "--border", "--rule", "--console",
  "--console-2", "--console-inset", "--console-rule", "--console-border", "--on-console", "--on-console-2", "--pass",
  "--fail", "--on-fail", "--pass-on-console", "--warn-on-console", "--fail-on-console", "--signal",
  "--signal-hover", "--signal-on-console", "--sweep-on-ink", "--sweep-on-light", "--focus", "--focus-on-console",
  "--amber", "--estop", "--estop-hover", "--estop-deep", "--estop-text", "--font-display", "--font-body", "--font-data",
  "--font-care", "--t-data", "--t-data-lg", "--t-caption", "--t-stamp", "--t-sub", "--r-0", "--r-1", "--r-2", "--r-pill",
  "--ease", "--icon-lock", "--surface", "--text", "--muted", "--shadow", "--radius", "--sans", "--mono",
];
const oldToken = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
/** The --c-* contextual aliases of the old console/paper split. */
const C_ALIAS = /(?<![\w-])--c-[a-z]/;

/** Classes of the earlier designs: stamps, numbered section labels, dark console surfaces, square status marks. */
const OLD_CLASSES = ["stamp", "section-index", "on-console", "status-sq"];

describe("styles.css tokens", () => {
  it("defines exactly the page colours and the scene colours, with their values", () => {
    expect(tokens).toEqual(EXPECTED);
    expect(Object.keys(tokens).filter((name) => !name.startsWith("--scene-")).sort()).toEqual(Object.keys(PAGE).sort());
  });

  it("meets the contrast floors", () => {
    const t = (name: string) => EXPECTED[name]!;
    const floors: [string, string, string, number][] = [
      ["ink on bg", t("--ink"), t("--bg"), 4.5],
      ["mid on bg", t("--mid"), t("--bg"), 4.5],
      ["ink on fill", t("--ink"), t("--fill"), 4.5],
      ["mid on fill", t("--mid"), t("--fill"), 4.5],
      ["white on red (emergency stop)", t("--bg"), t("--red"), 4.5],
      ["red on bg (faults)", t("--red"), t("--bg"), 4.5],
      ["white on accent (primary buttons)", t("--bg"), t("--accent"), 4.5],
      ["white on accent-strong (hover)", t("--bg"), t("--accent-strong"), 4.5],
      ["white on ink (the hold sweep under a primary label)", t("--bg"), t("--ink"), 4.5],
      ["the hold sweep (ink) against the primary button (accent)", t("--ink"), t("--accent"), 3],
      ["accent on bg (links, done states)", t("--accent"), t("--bg"), 4.5],
      ["accent on accent-soft (the tinted band)", t("--accent"), t("--accent-soft"), 4.5],
      ["ink on accent-soft", t("--ink"), t("--accent-soft"), 4.5],
      ["mid on accent-soft", t("--mid"), t("--accent-soft"), 4.5],
      ["warn on bg (waiting)", t("--warn"), t("--bg"), 4.5],
      ["warn on warn-soft", t("--warn"), t("--warn-soft"), 4.5],
      ["ink on warn-soft", t("--ink"), t("--warn-soft"), 4.5],
      ["ink on line (the hold sweep under an outlined label)", t("--ink"), t("--line"), 4.5],
      ["obstacle label text (white) on its amber plate", t("--bg"), t("--scene-obstacle"), 4.5],
      // The flight logic's marks on the camera view must stand out from the room behind them.
      ["obstacle box on the wall", t("--scene-obstacle"), t("--scene-wall"), 3],
      ["obstacle box on the side wall", t("--scene-obstacle"), t("--scene-wall-side"), 3],
      ["obstacle box on the floor", t("--scene-obstacle"), t("--scene-floor"), 3],
      ["sign outline on the wall", t("--scene-tracking"), t("--scene-wall"), 3],
      ["sign outline on the floor", t("--scene-tracking"), t("--scene-floor"), 3],
    ];
    for (const [what, fg, bg, floor] of floors) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(floor);
    }
  });

  it("keeps the scene colours to the two drawings of the corridor", () => {
    for (const file of [...STYLESHEETS, ...COMPONENTS]) {
      if (SCENE_FILES.includes(file)) continue;
      expect(SCENE_TOKEN.test(read(file)), `${file} names a --scene-* token`).toBe(false);
    }
    // In styles.css the scene colours are defined in :root and read nowhere.
    const outsideRoot = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?:^|\n):root\s*\{[\s\S]*?\n\}/, "");
    expect(SCENE_TOKEN.test(outsideRoot)).toBe(false);
  });

  it("breaks none of the CSS rules", () => {
    expect(css.length).toBeGreaterThan(5000);
    expect(cssViolations(css, { allowRootColours: true })).toEqual([]);
  });

  it("names one typeface and two weights", () => {
    expect(rootCustomProperties(css)).toContain("--font");
    expect(rootCustomProperties(css).filter((name) => name.startsWith("--font-"))).toEqual([]);
    const weights = new Set([...css.matchAll(/--t-[a-z]+:\s*(\d{3})\s/g)].map((m) => m[1]));
    expect([...weights].sort()).toEqual(["400", "600"]);
  });

  it("radius tokens are --r and --r-round only", () => {
    expect(rootCustomProperties(css).filter((name) => /^--r(-|$)/.test(name))).toEqual(["--r", "--r-round"]);
  });
});

describe("every stylesheet under src/", () => {
  const defined = new Set(rootCustomProperties(css));

  it("includes the pages, the panels, the landing page and the scene", () => {
    expect(STYLESHEETS).toEqual(
      expect.arrayContaining([
        "styles.css",
        "fonts.css",
        "pages/pilot.css",
        "pages/care.css",
        "pages/caregiver.css",
        "pages/landing.css",
        "components/pilot/station-run.css",
        "components/pilot/manual.css",
        "components/pilot/setup.css",
        "scene/scene.css",
      ]),
    );
  });

  for (const file of STYLESHEETS.filter((f) => f !== "styles.css")) {
    it(`${file} breaks none of the CSS rules`, () => {
      expect(cssViolations(read(file), { allowRootColours: false })).toEqual([]);
    });
  }

  it("reads only custom properties that styles.css defines in :root", () => {
    for (const file of STYLESHEETS) {
      const missing = customPropertiesUsed(read(file)).filter((name) => !defined.has(name));
      expect(missing, file).toEqual([]);
    }
  });

  it("names none of the old tokens", () => {
    for (const file of STYLESHEETS) {
      const source = read(file);
      for (const name of OLD_TOKENS) expect(oldToken(name).test(source), `${file}: ${name}`).toBe(false);
      expect(C_ALIAS.test(source), `${file}: --c-*`).toBe(false);
    }
  });

  it("styles none of the old classes", () => {
    for (const file of STYLESHEETS) {
      const source = read(file);
      for (const name of [...OLD_CLASSES, "mono", "data"]) {
        expect(new RegExp(`\\.${name}(?![\\w-])`).test(source), `${file}: .${name}`).toBe(false);
      }
    }
  });
});

describe("every component under src/", () => {
  const defined = new Set(rootCustomProperties(css));

  it("finds the pages", () => {
    expect(COMPONENTS).toEqual(expect.arrayContaining(["pages/PilotPage.tsx", "pages/CarePage.tsx", "pages/CaregiverPage.tsx"]));
  });

  it("names none of the old classes", () => {
    for (const file of COMPONENTS) {
      const source = read(file);
      for (const name of OLD_CLASSES) {
        expect(new RegExp(`(?<![\\w-])${name}(?![\\w])`).test(source), `${file}: ${name}`).toBe(false);
      }
    }
  });

  it("gives no element the mono or data class", () => {
    for (const file of COMPONENTS) {
      const source = read(file);
      const classText = [
        ...[...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1] ?? ""),
        ...[...source.matchAll(/className=\{([^\n]*)\}/g)].flatMap((m) =>
          [...(m[1] ?? "").matchAll(/["'`]([^"'`]*)["'`]/g)].map((s) => s[1] ?? ""),
        ),
      ];
      for (const text of classText) expect(text.split(/\s+/), `${file}: "${text}"`).not.toEqual(expect.arrayContaining(["mono"]));
      for (const text of classText) expect(text.split(/\s+/), `${file}: "${text}"`).not.toEqual(expect.arrayContaining(["data"]));
    }
  });

  it("names none of the old tokens and reads only defined custom properties", () => {
    for (const file of COMPONENTS) {
      const source = read(file);
      for (const name of OLD_TOKENS) expect(oldToken(name).test(source), `${file}: ${name}`).toBe(false);
      expect(C_ALIAS.test(source), `${file}: --c-*`).toBe(false);
      const missing = customPropertiesUsed(source).filter((name) => !defined.has(name));
      expect(missing, file).toEqual([]);
    }
  });
});

describe("cssViolations", () => {
  const strict = { allowRootColours: false };
  const loose = { allowRootColours: true };

  it("catches each forbidden pattern", () => {
    const bad = `
      .a { color: #fff; }
      .b { box-shadow: 0 1px 2px var(--ink); }
      .c { backdrop-filter: blur(4px); }
      .d { filter: blur(2px); }
      .e { border-radius: 999px; }
      .f { font-family: Helvetica, sans-serif; }
      .g { background: rgba(0, 0, 0, 0.5); }
      .h { text-transform: uppercase; }
      .i { font-variation-settings: "opsz" 36; }
      .j { background: linear-gradient(var(--ink), var(--bg)); }
      .k { letter-spacing: 0.06em; }
    `;
    expect(cssViolations(bad, loose)).toHaveLength(11);
  });

  it("allows tokens, root literals, data URIs, font faces and tightened headings", () => {
    const good = `
      @font-face { font-family: "X"; src: url(x.woff2); }
      :root { --a: #FFFFFF; --i: url("data:image/svg+xml,%3Csvg fill='%23000'%3E"); }
      .a { color: var(--a); box-shadow: none; border-radius: var(--r) 0 50% var(--r-round); font-family: var(--font); }
      .b { letter-spacing: -0.01em; text-transform: none; }
      @media (max-width: 639px) { .c { font: var(--t-body); } }
    `;
    expect(cssViolations(good, loose)).toEqual([]);
    expect(cssViolations(good, strict)).toHaveLength(1);
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
    for (const rule of cases) expect(cssViolations(rule, loose), rule).toHaveLength(1);
  });

  it("catches functional colour notations", () => {
    const cases = [
      ".a { color: oklch(0.6 0.2 30); }",
      ".a { background: lab(50% 40 59); }",
      ".a { color: color(display-p3 1 0 0); }",
      ".a { background: color-mix(in srgb, var(--ink) 50%, var(--bg)); }",
      ".a { color: hwb(0 0% 0%); }",
    ];
    for (const rule of cases) expect(cssViolations(rule, loose), rule).toHaveLength(1);
  });

  it("allows colour keywords that are not literals, and words that only look like colours", () => {
    const good = `
      .a { color: currentColor; background: transparent; border-color: inherit; outline: none; fill: none; }
      .b { background: var(--red); color: var(--bg); border: 1px solid var(--line); }
      .c { grid-area: red; transition: background-color var(--t-fast); font: var(--t-body); }
      .d { background: currentColor url("icons/white.svg") no-repeat; }
    `;
    expect(cssViolations(good, strict)).toEqual([]);
  });

  it("allows only 0, 50%, var(--r) and var(--r-round) as radii", () => {
    expect(cssViolations(".a { border-radius: var(--r-2); }", loose)).toHaveLength(1);
    expect(cssViolations(".a { border-radius: 4px; }", loose)).toHaveLength(1);
    expect(cssViolations(".a { border-radius: var(--r) var(--r-round) 0 50%; }", loose)).toEqual([]);
  });

  it("accepts a font shorthand only as a role token, inherit, or metrics plus var(--font)", () => {
    const bad = [
      ".a { font: 600 14px/20px Inter; }",
      ".a { font: 600 14px/20px Arial, Helvetica; }",
      ".a { font: 600 14px/20px Arial, var(--font); }",
      '.a { font: 600 14px/20px "Inter", var(--font); }',
      ".a { font: 600 14px/20px var(--font-display); }",
      ".a { font: 16px var(--sans); }",
      ".a { font: menu; }",
    ];
    for (const rule of bad) expect(cssViolations(rule, loose), rule).toHaveLength(1);
    const good = `
      .a { font: var(--t-label); }
      .b { font: inherit; }
      .c { font: 600 18px/28px var(--font); }
      .d { font: 600 clamp(48px, 9vw, 80px)/1.05 var(--font); }
      .e { font: 700 1.25rem/1 var(--font) !important; }
    `;
    expect(cssViolations(good, strict)).toEqual([]);
  });

  it("allows only var(--font) or inherit as a family", () => {
    expect(cssViolations(".a { font-family: var(--font-data); }", loose)).toHaveLength(1);
    expect(cssViolations(".a { font-family: inherit; } .b { font-family: var(--font); }", loose)).toEqual([]);
  });

  it("catches shadows by any name", () => {
    const cases = [
      ".a { -webkit-box-shadow: 0 1px 2px var(--ink); }",
      ".a { text-shadow: 0 1px 2px var(--ink); }",
      ".a { filter: drop-shadow(0 1px 2px var(--ink)); }",
      ".a { -webkit-filter: drop-shadow(0 0 4px var(--ink)); }",
    ];
    for (const rule of cases) expect(cssViolations(rule, loose), rule).toHaveLength(1);
    expect(cssViolations(".a { text-shadow: none; -webkit-box-shadow: none; }", loose)).toEqual([]);
  });

  it("does not read function names as colour keywords", () => {
    const good = ".a { --x: tan(45deg); --y: steps(4); transform: rotate(calc(tan(45deg) * 1turn)); }";
    expect(cssViolations(good, strict)).toEqual([]);
    expect(cssViolations(".a { --x: tan; }", strict)).toHaveLength(1);
  });

  it("lists the custom properties a sheet reads and the ones :root defines", () => {
    const sheet = ":root { --a: 1px; } @media (x) { :root { --b: 2px; } } .c { margin: var(--a) var(--z, var(--b)); }";
    expect(customPropertiesUsed(sheet)).toEqual(["--a", "--b", "--z"]);
    expect(rootCustomProperties(sheet)).toEqual(["--a", "--b"]);
  });
});
