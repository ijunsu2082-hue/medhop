// A small seeded random generator for the browser simulator.
//
// PythonRandom reproduces CPython's `random.Random(seed)` for integer seeds: the same Mersenne Twister
// (MT19937, Modules/_randommodule.c) seeded the same way, so random(), uniform(), getrandbits() and
// randrange(n) give the very numbers Python gives (checked by rng.test.ts against __fixtures__/rng.json).
// gauss() is Python's Box-Muller with the cached second value; it uses Math.log/cos/sin/sqrt, which may
// differ from the C library in the last bit, so its values agree with Python to about 1e-15 only.
//
// It does NOT reproduce numpy's generators (np.random.default_rng is PCG64 with ziggurat normals).
// backend/medhop/drone/sim.py draws its noise from numpy, so a port of the simulator cannot replay
// Python's noise bit for bit with this; it can replay recorded inputs, or match statistics.

/** What simulator code should depend on, so the generator can be swapped (for example for recorded draws). */
export interface RandomSource {
  /** Uniform in [0, 1). */
  random(): number;
  /** Uniform in [a, b) (Python's a + (b - a) * random()). */
  uniform(a: number, b: number): number;
  /** Normal with mean mu and standard deviation sigma. */
  normal(mu?: number, sigma?: number): number;
}

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;
const TWOPI = 2.0 * Math.PI;

export class PythonRandom implements RandomSource {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;
  private gaussNext: number | null = null;

  /** `seed` is an integer (number or bigint); like Python, its absolute value is used. */
  constructor(seed: number | bigint = 0) {
    this.seed(seed);
  }

  seed(seed: number | bigint): void {
    if (typeof seed === "number" && !Number.isSafeInteger(seed)) {
      throw new TypeError("PythonRandom only supports integer seeds (Python hashes other types)");
    }
    let n = BigInt(seed);
    if (n < 0n) n = -n;
    const key: number[] = [];
    do {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    } while (n > 0n);
    this.initByArray(key);
    this.gaussNext = null;
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]!;
      mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]!;
      const mixed = (mt[i]! ^ Math.imul((prev ^ (prev >>> 30)) >>> 0, 1664525)) >>> 0;
      mt[i] = (mixed + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]!;
      const mixed = (mt[i]! ^ Math.imul((prev ^ (prev >>> 30)) >>> 0, 1566083941)) >>> 0;
      mt[i] = (mixed - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32(): the next 32-bit output. */
  nextUint32(): number {
    const mt = this.mt;
    if (this.index >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      const y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK);
      mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53 random bits in [0, 1). */
  random(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** random.uniform(a, b) */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** random.gauss(mu, sigma): Box-Muller, the second value of each pair kept for the next call. */
  gauss(mu = 0.0, sigma = 1.0): number {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * TWOPI;
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }

  /** RandomSource.normal: the same draw as gauss(). */
  normal(mu = 0.0, sigma = 1.0): number {
    return this.gauss(mu, sigma);
  }

  /** random.getrandbits(k) for 0 <= k <= 53 (Python allows more; a double cannot hold them). */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k > 53) throw new RangeError("getrandbits supports 0 <= k <= 53 here");
    if (k === 0) return 0;
    if (k <= 32) return this.nextUint32() >>> (32 - k);
    // Python fills 32-bit words from the least significant one; the last word keeps its top bits.
    const low = this.nextUint32();
    const high = this.nextUint32() >>> (64 - k);
    return high * 4294967296 + low;
  }

  /** random.randrange(n) for an integer 1 <= n < 2**53 (Python's _randbelow_with_getrandbits). */
  randrange(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n >= 2 ** 53) throw new RangeError("randrange supports 1 <= n < 2**53 here");
    const k = n.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }
}
