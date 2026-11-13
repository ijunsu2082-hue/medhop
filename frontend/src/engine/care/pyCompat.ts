// Python string and conversion semantics that backend/medhop/care/store.py relies on, for the care port.
// Checked against Python by the care fixtures (__fixtures__/care_store.json, care_status.json).
//
// Why these exist (JavaScript differs from Python in each case):
//   pyStrip          str.strip() removes Python's whitespace set (str.isspace): it includes U+001C..U+001F
//                    and U+0085, which String.prototype.trim keeps, and excludes U+FEFF, which trim removes.
//   codePointLength  len(str) counts code points; .length counts UTF-16 units (an emoji counts 2).
//   compareStrings   Python orders strings by code point; JavaScript's < by UTF-16 unit, which differs
//                    once a character outside the BMP meets one at U+E000..U+FFFF.
//   ND_DIGIT         `\d` in a Python str pattern is any Unicode decimal digit (category Nd), and int()
//                    and float() accept those digits too. JavaScript's \d is ASCII only.
//   pyFloatOf        float(x) of a value read from JSON (numbers, booleans and numeric strings).
//   pyIntOf          int(x) of a value read from JSON, as an exact bigint.
//   pyStrOf          str(x) of a value read from JSON (True, None, 5, [1, 'a'], {'k': 2}).
//   pyTruthy         truthiness of a JSON value: [] and {} are false in Python, true in JavaScript.
//
// Known limits: Python 3.12 uses Unicode 15.0 and Node 22 a newer version, so a digit or a character
// added to Unicode after 15.0 may be classified differently. JSON.parse cannot tell 5 from 5.0, so
// str() of a stored 5.0 gives "5" here and "5.0" in Python.

import { pyRepr, pyStrRepr } from "../util/num";

/** The characters for which Python's str.isspace() is true (Unicode 15.0). */
const PY_WHITESPACE =
  "\t\n\u000b\u000c\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
const WS_CLASS = `[${PY_WHITESPACE}]`;
const STRIP_RE = new RegExp(`^${WS_CLASS}+|${WS_CLASS}+$`, "gu");

/** Python's str.strip() with no argument. */
export function pyStrip(text: string): string {
  return text.replace(STRIP_RE, "");
}

/** Python's len() of a str: the number of code points (a lone surrogate counts as one). */
export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Python's ordering of two str values (by code point): negative, zero or positive. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** One Unicode decimal digit, as Python's `\d` in a str pattern matches it. */
export const ND_DIGIT = "\\p{Nd}";
const ND_RE = /\p{Nd}/u;
const ND_GLOBAL_RE = /\p{Nd}/gu;

/** The value 0..9 of one Unicode decimal digit (Nd digits come in runs of ten, from zero to nine). */
export function digitValue(ch: string): number {
  let cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let steps = 0;
  while (cp > 0 && ND_RE.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    steps += 1;
  }
  return steps % 10;
}

/** Replace every Unicode decimal digit with its ASCII digit (what int() and float() do first). */
export function asciiDigits(text: string): string {
  return text.replace(ND_GLOBAL_RE, (ch) => String(digitValue(ch)));
}

/** int() of a string of decimal digits (any Nd digits), exactly. */
export function digitsToBigInt(digits: string): bigint {
  return BigInt(asciiDigits(digits));
}

const PY_INT_RE = /^[+-]?\d(?:_?\d)*$/;
const PY_FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const PY_SPECIAL_RE = /^([+-]?)(inf|infinity|nan)$/i;

/**
 * float(value) for a value read from JSON. null where Python raises (TypeError for None, lists and
 * dicts; ValueError for a string that is not a number): every caller in store.py catches both.
 */
export function pyFloatOf(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1.0 : 0.0;
  if (typeof value !== "string") return null;
  const text = asciiDigits(pyStrip(value));
  const special = PY_SPECIAL_RE.exec(text);
  if (special) {
    if ((special[2] ?? "").toLowerCase() === "nan") return Number.NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!PY_FLOAT_RE.test(text)) return null;
  return Number(text.replace(/_/g, ""));
}

/**
 * int(value) for a value read from JSON, exactly. null where Python raises TypeError or ValueError.
 * Python raises OverflowError for an infinite float, which store.py does not catch (the store then
 * fails to open); this returns null for it, so the caller falls back as for any other bad value.
 */
export function pyIntOf(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value !== "string") return null;
  const text = asciiDigits(pyStrip(value));
  if (!PY_INT_RE.test(text)) return null;
  return BigInt(text.replace(/_/g, ""));
}

/** Python's repr() of a value read from JSON (dicts keep their key order, as json.loads does). */
export function pyReprOf(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return pyStrRepr(value);
  if (typeof value === "number") {
    // JSON.parse gives no int/float distinction: an integral value is shown as Python shows an int.
    if (Number.isInteger(value)) return BigInt(value).toString();
    return pyRepr(value);
  }
  if (Array.isArray(value)) return `[${value.map(pyReprOf).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${pyStrRepr(k)}: ${pyReprOf(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

/** Python's str() of a value read from JSON: a string as it is, anything else as its repr. */
export function pyStrOf(value: unknown): string {
  return typeof value === "string" ? value : pyReprOf(value);
}

/** Python truthiness of a value read from JSON: None, False, 0, "", [] and {} are false. */
export function pyTruthy(value: unknown): boolean {
  // 0 === -0, and NaN is true in Python
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** A plain JSON object (Python: isinstance(x, dict) after json.loads). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
