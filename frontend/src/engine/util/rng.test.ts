// Replays __fixtures__/rng.json (backend/tools/parity_traces.py rng): PythonRandom against
// random.Random. Everything is bit-identical except gauss(), which goes through Math.log/cos/sin.
import { describe, expect, it } from "vitest";
import { floatsClose, loadFixture } from "../testing/fixtures";
import { PythonRandom, type RandomSource } from "./rng";

interface RngCase {
  seed: string;
  random: number[];
  uniform: [number, number, number][];
  gauss: [number, number, number][];
  getrandbits: [number, number][];
  randrange: [number, number][];
  after: number[];
}

interface RngFixture {
  cases: RngCase[];
  long_run: { seed: string; every_100th: number[]; last: number };
}

const fx = loadFixture<RngFixture>("rng");

describe("PythonRandom against random.Random", () => {
  for (const c of fx.cases) {
    it(`seed ${c.seed}`, () => {
      const r = new PythonRandom(BigInt(c.seed));
      expect(c.random.map(() => r.random())).toEqual(c.random);
      for (const [a, b, out] of c.uniform) expect(r.uniform(a, b)).toBe(out);
      for (const [mu, sigma, out] of c.gauss) {
        const got = r.gauss(mu, sigma);
        expect(floatsClose(got, out, { rel: 1e-14, abs: 1e-15 })).toBe(true);
      }
      for (const [k, out] of c.getrandbits) expect(r.getrandbits(k)).toBe(out);
      for (const [n, out] of c.randrange) expect(r.randrange(n)).toBe(out);
      expect(c.after.map(() => r.random())).toEqual(c.after);
    });
  }

  it("a long run crosses many state refills", () => {
    const r = new PythonRandom(BigInt(fx.long_run.seed));
    const draws = Array.from({ length: 2000 }, () => r.random());
    expect(draws.filter((_, i) => i % 100 === 0)).toEqual(fx.long_run.every_100th);
    expect(draws[draws.length - 1]).toBe(fx.long_run.last);
  });

  it("re-seeding restarts the sequence and drops a cached gauss value", () => {
    const r = new PythonRandom(5);
    const first = [r.random(), r.gauss(), r.random()];
    r.seed(5);
    expect([r.random(), r.gauss(), r.random()]).toEqual(first);
  });

  it("is usable as a RandomSource with sensible statistics", () => {
    const source: RandomSource = new PythonRandom(99);
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = source.normal(1.0, 2.0);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean - 1.0)).toBeLessThan(0.05);
    expect(Math.abs(sd - 2.0)).toBeLessThan(0.05);
    for (let i = 0; i < 1000; i++) {
      const u = source.uniform(-0.5, 0.5);
      expect(u).toBeGreaterThanOrEqual(-0.5);
      expect(u).toBeLessThan(0.5);
    }
  });

  it("rejects what it does not support", () => {
    expect(() => new PythonRandom(0.5)).toThrow();
    expect(() => new PythonRandom(1).getrandbits(54)).toThrow();
    expect(() => new PythonRandom(1).randrange(0)).toThrow();
  });
});
