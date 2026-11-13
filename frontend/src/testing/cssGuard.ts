// A small CSS linter for the design rules. Used by *.guard.test.ts files:
//   const css = readCss(import.meta.url, "./pilot.css");
//   expect(cssViolations(css, { allowRootColours: false })).toEqual([]);
// It is deliberately simple: it walks rule blocks, reads each declaration and reports what the system forbids.
// Read CSS with readCss, not `import x from "./a.css?raw"`: Vitest's CSS pipeline turns CSS imports into "".

import { readFileSync, readdirSync } from "node:fs";

/** Read a CSS file relative to the calling test file (pass that file's import.meta.url). */
export function readCss(fromUrl: string, relativePath: string): string {
  return readFileSync(new URL(relativePath, fromUrl), "utf8");
}

/** Every file under `dirUrl` (a directory URL ending in "/") whose name ends in one of `extensions`, as
 * forward-slash paths relative to it, sorted. Test files are left out. */
export function sourceFiles(dirUrl: URL, extensions: string[]): string[] {
  return readdirSync(dirUrl, { recursive: true })
    .map((p) => String(p).replace(/\\/g, "/"))
    .filter((p) => extensions.some((ext) => p.endsWith(ext)) && !/\.test\.tsx?$/.test(p))
    .sort();
}

export interface CssGuardOptions {
  /** Allow colour literals inside a plain `:root { ... }` block (only the token file needs this). */
  allowRootColours: boolean;
}

interface Declaration {
  selector: string;
  property: string;
  value: string;
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
/** Functional colour notations beyond rgb() and hsl(); `(?<![\w-])` keeps `--x-lab(` style names out. */
const COLOUR_FUNCTION = /(?<![\w-])(?:hwb|lab|lch|oklab|oklch|color|color-mix|device-cmyk|light-dark)\(/i;
const GRADIENT = /(?<![\w-])(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
/** The two radius tokens, plus 0 and 50% (a circle). */
const RADIUS_TOKEN = /^(0|50%|inherit|var\(--r\)|var\(--r-round\))$/i;

/** Properties whose value can carry a colour keyword. Custom properties (--*) are checked too. */
const COLOUR_PROPERTY =
  /^(color|background(-[a-z-]+)?|border(-[a-z-]+)?|outline(-[a-z-]+)?|fill|stroke|caret-color|accent-color|text-decoration(-[a-z-]+)?|text-emphasis(-[a-z-]+)?|column-rule(-[a-z-]+)?|text-shadow|box-shadow|scrollbar-color|--[a-z0-9-]+)$/;

/** CSS named colours (CSS Color 4), plus the deprecated system colours. transparent and currentColor are allowed. */
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod " +
    "darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon " +
    "darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray " +
    "dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green " +
    "greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon " +
    "lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon " +
    "lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta " +
    "maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen " +
    "seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato " +
    "turquoise violet wheat white whitesmoke yellow yellowgreen " +
    "canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight " +
    "highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext"
  ).split(" "),
);

/** Named colour keywords in a value, ignoring var() references, url()s and strings. */
function namedColours(value: string): string[] {
  let v = value.replace(/"[^"]*"|'[^']*'/g, " ").replace(/url\([^)]*\)/gi, " ");
  // Drop var(--name) references (innermost first, so fallbacks inside them are still read).
  let previous = "";
  while (previous !== v) {
    previous = v;
    v = v.replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, " ").replace(/var\(\s*--[a-z0-9-]+\s*,/gi, "(");
  }
  // A word directly followed by "(" is a function name (tan(45deg), steps(4)), never a colour keyword.
  v = v.replace(/[a-z][a-z0-9-]*\(/gi, " (");
  return v
    .split(/[\s,()/]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => NAMED_COLOURS.has(token));
}
/** Words allowed before the family in a font shorthand: style, variant, weight and stretch keywords. */
const FONT_KEYWORD =
  /^(?:normal|italic|oblique|small-caps|bold|bolder|lighter|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i;
const FONT_METRIC = /^-?[\d.]+(?:px|em|rem|%|vw|vh|dvh|svh|lvh|vmin|vmax|ch|ex|lh|pt)?$/i;

/**
 * A font shorthand is a type-role token, inherit, or metrics followed by the one family token:
 * `600 14px/20px var(--font)` or `600 clamp(48px, 9vw, 80px)/1.05 var(--font)`.
 * Everything before the family must be a number, a size or a font keyword, so no literal family can ride
 * along: `600 14px/20px Inter` and `600 14px/20px Arial, var(--font)` both fail.
 */
function fontShorthandOk(value: string): boolean {
  if (/^(?:var\(--t-[a-z0-9-]+\)|inherit)$/i.test(value)) return true;
  const match = /^(.*)\svar\(--font\)$/i.exec(value);
  if (!match) return false;
  let rest = match[1] ?? "";
  if (/["']/.test(rest)) return false;
  // Functions in the metrics (clamp(), calc(), var()) count as one number each.
  let previous = "";
  while (previous !== rest) {
    previous = rest;
    rest = rest.replace(/[a-z-]*\([^()]*\)/gi, " 0 ");
  }
  if (/[,()]/.test(rest)) return false;
  return rest
    .split(/[\s/]+/)
    .filter(Boolean)
    .every((token) => FONT_METRIC.test(token) || FONT_KEYWORD.test(token));
}

/** Remove comments, data: URIs and @font-face blocks, which carry legitimate literals. */
function clean(css: string): string {
  let out = css.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out
    .replace(/url\(\s*"data:[^"]*"\s*\)/gi, "url(data)")
    .replace(/url\(\s*'data:[^']*'\s*\)/gi, "url(data)")
    .replace(/url\(\s*data:[^)]*\)/gi, "url(data)");
  out = out.replace(/@font-face\s*\{[^}]*\}/gi, "");
  return out;
}

/** Walk the blocks and collect declarations with the selector of the block they sit in. */
function declarations(css: string): Declaration[] {
  const result: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  const flush = (selector: string) => {
    for (const part of buffer.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const property = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (!property || /[{}@]/.test(property)) continue;
      result.push({ selector, property, value });
    }
    buffer = "";
  };
  for (const ch of css) {
    if (ch === "{") {
      // Text before a nested block is its prelude, not declarations.
      const lastSemi = buffer.lastIndexOf(";");
      const prelude = buffer.slice(lastSemi + 1).trim();
      buffer = buffer.slice(0, lastSemi + 1);
      if (stack.length > 0) flush(stack[stack.length - 1] ?? "");
      buffer = "";
      stack.push(prelude);
    } else if (ch === "}") {
      flush(stack[stack.length - 1] ?? "");
      stack.pop();
    } else {
      buffer += ch;
    }
  }
  return result;
}

function splitValue(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if ((ch === " " || ch === "/") && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Every rule the CSS breaks, as readable lines. An empty list means the file passes. */
export function cssViolations(css: string, options: CssGuardOptions): string[] {
  const problems: string[] = [];
  for (const { selector, property, value } of declarations(clean(css))) {
    const where = `${selector} { ${property}: ${value} }`;
    const v = value.replace(/\s*!important\s*$/i, "").trim();
    const inRoot = selector.trim() === ":root";

    const rootAllowed = options.allowRootColours && inRoot;
    if (!rootAllowed && (COLOUR_LITERAL.test(v) || COLOUR_FUNCTION.test(v))) {
      problems.push(`colour literal outside :root: ${where}`);
    } else if (!rootAllowed && COLOUR_PROPERTY.test(property)) {
      const named = namedColours(v);
      if (named.length > 0) problems.push(`named colour ${named.join(", ")} outside :root: ${where}`);
    }
    if (GRADIENT.test(v)) problems.push(`gradient: ${where}`);
    if ((property === "box-shadow" || property === "-webkit-box-shadow") && v.toLowerCase() !== "none") {
      problems.push(`box-shadow other than none: ${where}`);
    }
    if (property === "text-shadow" && v.toLowerCase() !== "none") {
      problems.push(`text-shadow other than none: ${where}`);
    }
    if (property === "backdrop-filter" || property === "-webkit-backdrop-filter") {
      problems.push(`backdrop-filter: ${where}`);
    }
    if ((property === "filter" || property === "-webkit-filter") && /blur\(/i.test(v)) {
      problems.push(`filter blur: ${where}`);
    }
    if ((property === "filter" || property === "-webkit-filter") && /drop-shadow\(/i.test(v)) {
      problems.push(`filter drop-shadow: ${where}`);
    }
    if (/^border(-[a-z]+)*-radius$/.test(property)) {
      const bad = splitValue(v).filter((token) => !RADIUS_TOKEN.test(token));
      if (bad.length > 0) problems.push(`radius not 0, 50%, var(--r) or var(--r-round): ${where}`);
    }
    if (property === "font-family") {
      if (!/^(var\(--font\)|inherit)$/i.test(v)) problems.push(`font-family not var(--font): ${where}`);
    }
    if (property === "font" && !fontShorthandOk(v)) {
      problems.push(`font shorthand not var(--t-*), inherit or metrics ending in var(--font): ${where}`);
    }
    if (property === "text-transform" && /uppercase/i.test(v)) {
      problems.push(`uppercase: ${where}`);
    }
    if (property === "font-variation-settings") {
      problems.push(`font-variation-settings: ${where}`);
    }
    // Tightening a large heading is allowed; letter-spaced labels are not.
    if (property === "letter-spacing" && /^\+?(?:\d*\.)?\d*[1-9]/.test(v)) {
      problems.push(`positive letter-spacing: ${where}`);
    }
  }
  return problems;
}

/** The custom property names read through var(--name) anywhere in the CSS (comments ignored). */
export function customPropertiesUsed(css: string): string[] {
  const names = new Set<string>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) names.add(m[1]!);
  return [...names].sort();
}

/** The custom property names declared in any block whose selector is exactly `:root` (also inside @media). */
export function rootCustomProperties(css: string): string[] {
  const names = new Set<string>();
  for (const { selector, property } of declarations(clean(css))) {
    if (selector.trim() === ":root" && property.startsWith("--")) names.add(property);
  }
  return [...names].sort();
}
