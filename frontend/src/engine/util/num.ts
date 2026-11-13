// Ports the number semantics of CPython 3.12 that the flight logic depends on, plus `clamp` from
// backend/medhop/drone/base.py. Every helper here is checked against Python by num.test.ts
// (fixture: __fixtures__/num.json, written by backend/tools/parity_traces.py num).
//
// Why these exist (JavaScript differs from Python in each case):
//   pyMin / pyMax    Python's min/max keep the first argument unless a later one compares smaller/larger,
//                    so a NaN is kept or dropped depending on its position; Math.min/Math.max always
//                    return NaN. Write them in the same argument order as the Python.
//   pyTruthy / pyOr  `x or 0.0` and `if x:` treat 0.0 and None alike but NaN as true; JS treats NaN as false.
//   pyRound          round() is correctly rounded with ties to even; Math.round rounds ties up.
//   pyFormatFixed    f"{x:.3f}" / "%.1f" use the same exact half-even rounding (toFixed rounds ties away).
//   pyHypot          math.hypot is CPython's own near-correctly-rounded algorithm, not Math.hypot.
//   pySum            sum() of floats uses Neumaier compensated summation since Python 3.12.
//   pyMedian         statistics.median averages the middle pair.
//   pyRepr           repr(float) / str(float) switch to exponent notation at different points than String().
//   radians/degrees  math.radians(x) is x * (pi / 180), with the constant rounded once.

/** Python's ValueError, so ported code can throw the same kind of error at the same place. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Python's KeyError (a lookup by an unknown key, such as an unknown simulator scenario name). */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** Python's two-or-more argument `max(a, b, ...)`: a later value replaces the current one only if it is larger. */
export function pyMax(first: number, ...rest: number[]): number {
  let current = first;
  for (const value of rest) if (value > current) current = value;
  return current;
}

/** Python's two-or-more argument `min(a, b, ...)`: a later value replaces the current one only if it is smaller. */
export function pyMin(first: number, ...rest: number[]): number {
  let current = first;
  for (const value of rest) if (value < current) current = value;
  return current;
}

/** Python truthiness of a number, bool or None: false only for 0, -0, false, null and undefined (NaN is true). */
export function pyTruthy(value: number | boolean | null | undefined): boolean {
  return value !== null && value !== undefined && value !== 0 && value !== false;
}

/** Python's `value or fallback` for an optional number. */
export function pyOr(value: number | null | undefined, fallback: number): number {
  return value !== null && value !== undefined && pyTruthy(value) ? value : fallback;
}

/** clamp() from backend/medhop/drone/base.py: a value that is not a finite number counts as 0.0. */
export function clamp(value: number, low = -1.0, high = 1.0): number {
  let v = value;
  if (!Number.isFinite(v)) v = 0.0;
  return pyMax(low, pyMin(high, v));
}

const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;

/** math.radians */
export function radians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

/** math.degrees */
export function degrees(radiansValue: number): number {
  return radiansValue * RAD_TO_DEG;
}

// ---------------------------------------------------------------------------------------------- //
// exact access to a double

const VIEW = new DataView(new ArrayBuffer(8));

/** |x| = mantissa * 2^exponent exactly, for a finite x other than zero. */
function exactParts(x: number): [mantissa: bigint, exponent: number] {
  VIEW.setFloat64(0, Math.abs(x));
  const hi = VIEW.getUint32(0);
  const lo = VIEW.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return [fraction, -1074];
  return [fraction | (1n << 52n), biased - 1075];
}

/** 2^k exactly, for an integer k in [-1074, 1023]. */
function pow2(k: number): number {
  if (k >= -1022) {
    VIEW.setUint32(0, (k + 1023) << 20);
    VIEW.setUint32(4, 0);
  } else {
    const bit = k + 1074; // subnormal: a single fraction bit
    VIEW.setUint32(0, bit >= 32 ? 2 ** (bit - 32) : 0);
    VIEW.setUint32(4, bit < 32 ? 2 ** bit : 0);
  }
  return VIEW.getFloat64(0);
}

/** The exponent of C's frexp(x) (x = m * 2^e with 0.5 <= |m| < 1) for a finite x other than zero. */
function frexpExponent(x: number): number {
  const [mantissa, exponent] = exactParts(x);
  return exponent + mantissa.toString(2).length;
}

/** round(|x| * 10^digits) to an integer, ties to even, computed exactly (digits may be negative). */
function roundScaled(x: number, digits: number): bigint {
  if (x === 0) return 0n;
  const [mantissa, exponent] = exactParts(x);
  let num = mantissa;
  let den = 1n;
  if (exponent >= 0) num <<= BigInt(exponent);
  else den <<= BigInt(-exponent);
  if (digits >= 0) num *= 10n ** BigInt(digits);
  else den *= 10n ** BigInt(-digits);
  let q = num / den;
  const twice = 2n * (num - q * den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  return q;
}

function isNegative(x: number): boolean {
  return x < 0 || Object.is(x, -0);
}

/**
 * Python's round(). With `ndigits` (any integer, also negative) it returns a float like Python:
 * NaN and the infinities come back unchanged and -0.0 keeps its sign. Without it, it returns an
 * integer value (ties to even) and throws for NaN or an infinity, as Python does.
 */
export function pyRound(x: number, ndigits?: number): number {
  if (ndigits === undefined) {
    if (Number.isNaN(x)) throw new ValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new RangeError("cannot convert float infinity to integer");
    const q = roundScaled(x, 0);
    const value = Number(q);
    return isNegative(x) && value !== 0 ? -value : value;
  }
  if (!Number.isInteger(ndigits)) throw new TypeError("ndigits must be an integer");
  if (!Number.isFinite(x)) return x;
  const q = roundScaled(x, ndigits);
  const sign = isNegative(x) ? "-" : "";
  return Number.parseFloat(`${sign}${q.toString()}e${-ndigits}`);
}

/** Python's f"{x:.{digits}f}" (and "%.{digits}f" % x) for a float: exact, ties to even. */
export function pyFormatFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (!Number.isInteger(digits) || digits < 0) throw new RangeError("digits must be a non-negative integer");
  let text = roundScaled(x, digits).toString();
  if (digits > 0) {
    text = text.padStart(digits + 1, "0");
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return (isNegative(x) ? "-" : "") + text;
}

/** Python's repr(float), which is also str(float) and what an f-string shows for {x}. */
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  // toExponential() without an argument gives the same shortest round-trip digits as Python's repr.
  const [mantissa = "", exponentText = "0"] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  const decpt = exponent + 1; // digits d1 d2 ... with the decimal point after decpt of them
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const rest = digits.slice(1);
  const magnitude = Math.abs(exponent).toString().padStart(2, "0");
  return `${sign}${digits.slice(0, 1)}${rest ? `.${rest}` : ""}e${exponent < 0 ? "-" : "+"}${magnitude}`;
}

/** Python's repr() of a plain str (used to reproduce error messages such as "got 'x'"). */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** Python's repr() of a tuple of strings, e.g. ('sim', 'real'). */
export function pyTupleRepr(items: readonly string[]): string {
  if (items.length === 1) return `(${pyStrRepr(items[0] ?? "")},)`;
  return `(${items.map(pyStrRepr).join(", ")})`;
}

// ---------------------------------------------------------------------------------------------- //
// math.hypot: CPython 3.12 Modules/mathmodule.c, vector_norm() with dl_mul() and dl_fast_sum()

const DBL_MIN = 2.2250738585072014e-308;

/** x * y as an unevaluated sum hi + lo, exactly (Dekker's two-product; CPython uses fma for lo). */
function dlMul(x: number, y: number): [number, number] {
  const z = x * y;
  const tx = 134217729.0 * x; // Veltkamp split, 2**27 + 1
  const xh = tx - (tx - x);
  const xl = x - xh;
  const ty = 134217729.0 * y;
  const yh = ty - (ty - y);
  const yl = y - yh;
  const zz = xh * yh - z + xh * yl + xl * yh + xl * yl;
  return [z, zz];
}

function vectorNorm(vec: readonly number[], max: number, foundNan: boolean): number {
  if (max === Infinity) return max;
  if (foundNan) return Number.NaN;
  if (max === 0.0 || vec.length <= 1) return max;
  const maxE = frexpExponent(max);
  if (maxE < -1023) {
    // When max_e < -1023, ldexp(1.0, -max_e) would overflow: convert subnormals to normals first.
    return DBL_MIN * vectorNorm(vec.map((v) => v / DBL_MIN), max / DBL_MIN, foundNan);
  }
  const scale = pow2(-maxE);
  let csum = 1.0;
  let frac1 = 0.0;
  let frac2 = 0.0;
  for (const value of vec) {
    const x = value * scale; // lossless scaling
    const [prHi, prLo] = dlMul(x, x); // lossless squaring
    const sum = csum + prHi; // dl_fast_sum(csum, pr.hi)
    const sumLo = csum - sum + prHi;
    csum = sum;
    frac1 += prLo;
    frac2 += sumLo;
  }
  let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
  const [prHi, prLo] = dlMul(-h, h);
  const sum = csum + prHi;
  const sumLo = csum - sum + prHi;
  csum = sum;
  frac1 += prLo;
  frac2 += sumLo;
  const x = csum - 1.0 + (frac1 + frac2);
  h += x / (2.0 * h); // differential correction
  return h / scale;
}

/** Python's math.hypot(*coordinates). */
export function pyHypot(...coordinates: number[]): number {
  let max = 0.0;
  let foundNan = false;
  const vec = coordinates.map((c) => {
    const x = Math.abs(c);
    foundNan = foundNan || Number.isNaN(x);
    if (x > max) max = x;
    return x;
  });
  return vectorNorm(vec, max, foundNan);
}

// ---------------------------------------------------------------------------------------------- //
// sum() and statistics.median

/**
 * Python 3.12's built-in sum() over floats (start 0): Neumaier compensated summation, the
 * compensation added once at the end. An empty input gives 0, as in Python.
 */
export function pySum(values: Iterable<number>): number {
  let started = false;
  let total = 0.0;
  let c = 0.0;
  for (const x of values) {
    if (!started) {
      total = 0 + x; // int 0 + the first float
      started = true;
      continue;
    }
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += total - t + x;
    else c += x - t + total;
    total = t;
  }
  if (started && c !== 0 && Number.isFinite(c)) total += c;
  return total;
}

/** statistics.median: the middle value, or the mean of the middle two. Throws on empty input. */
export function pyMedian(values: Iterable<number>): number {
  const data = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = data.length;
  if (n === 0) throw new ValueError("no median for empty data");
  if (n % 2 === 1) return data[(n - 1) / 2]!;
  const i = n / 2;
  return (data[i - 1]! + data[i]!) / 2;
}
