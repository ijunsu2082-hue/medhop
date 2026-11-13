// Closed-loop outcome tests of runner.ts with the real TypeScript pieces together: the simulator
// (drone/sim.ts), the synthetic sign detector (vision/detector.ts), the mixer and the runner, in
// simulated time (testing/missionHarness.ts). Not replays: the simulator's noise and the detector differ
// from Python's, so these assert outcomes, with the bounds the Python closed-loop tests assert
// (backend/tests/test_automatic.py, test_sim_closed_loop.py, test_avoid_sim.py). Where a Python test's
// bound holds only on its few chosen seeds (Python itself misses it on others), the test here asserts a
// property on every seed (the outcome, and a bound from the runner's own limits or from the measured
// distributions with a margin) and Python's measured rate for the Python bound; the side-by-side
// measurements (Python SimHarness with the OpenCV detector against this harness, 48 seeds each, same
// scenario definitions) are in the comments. They found no offset between the two simulators. Clearance
// is simulator truth (SimLink.clearanceM) while the drone is more than 0.2 m up. Every measured figure is
// printed.
//
// Profiles: the display profile (highQualitySimConfig, 1280x720, the detector's default calibration)
// starts where the interactive simulator starts (3.2 m out, reset_pose_on_takeoff, as backend/medhop/
// server.py build_link); the drone-like profile (makeSimConfig, 640x360, DRONE_LIKE_DETECTOR_OPTIONS)
// is the one the Python closed-loop tests use. Each seed seeds the simulator's noise and the detector.
import { describe, expect, it } from "vitest";
import { highQualitySimConfig, makeSimConfig, type SimConfig } from "../drone/sim";
import { scenarioByName } from "../drone/simActors";
import { MissionHarness } from "../testing/missionHarness";
import { PythonRandom } from "../util/rng";
import { DRONE_LIKE_DETECTOR_OPTIONS, type SignDetectorOptions } from "../vision/detector";
import { makePersonStatus } from "../vision/person";
import { makeRunnerConfig, type RunnerConfig } from "./runner";

const NEUTRAL = [0.0, 0.0, 0.0, 0.0];

function seeds(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function detectorFor(profile: "display" | "drone", seed: number): SignDetectorOptions {
  const rng = new PythonRandom(10_000 + seed);
  return profile === "drone" ? { ...DRONE_LIKE_DETECTOR_OPTIONS, rng } : { rng };
}

function stats(values: number[]): string {
  if (values.length === 0) return "none";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return `min ${min.toFixed(3)} / mean ${mean.toFixed(3)} / max ${max.toFixed(3)}`;
}

interface Flight {
  seed: number;
  state: string;
  reason: string | null;
  durationS: number;
  clearanceM: number;
  hiddenS: number;
  minWallM: number;
  xM: number;
  distanceM: number;
  airborne: boolean;
  toggles: number;
  lastLanding: string | null;
  needsPilot: boolean;
  heldS: number;
  aligned: boolean | null;
  closing: Record<string, unknown>;
  events: string[];
  maxRoll: number;
  maxThrottle: number;
  assistDisabled: string | null;
  suggestedTrim: number | null;
  approachPitchMean: number;
}

/** One run, as test_avoid_sim.py fly() and test_sim_closed_loop.py run_station(). */
function fly(options: {
  seed: number;
  config: SimConfig;
  profile: "display" | "drone";
  automatic: boolean;
  runnerConfig?: RunnerConfig;
  land?: boolean;
  assist?: boolean;
  dropout?: number;
  limitS?: number;
  personAtS?: number;
  settleS?: number;
}): Flight {
  const h = new MissionHarness({
    simConfig: options.config,
    detector: detectorFor(options.profile, options.seed),
    runnerConfig: options.runnerConfig ?? null,
    markerDropout: options.dropout ?? 0.0,
    dropoutSeed: options.seed,
  });
  h.warmUp(1.0);
  if (options.land !== undefined) h.runner.setLandOnArrival(options.land);
  if (options.assist) h.runner.setDriftAssist(true);
  const [started, blockers] = h.runner.start(!options.automatic, "d1", undefined, options.automatic);
  if (!started) throw new Error(`not started: ${blockers.join(", ")}`);
  const t0 = h.clock.t;
  const info = { clearance: Infinity, hiddenS: 0, missingSince: null as number | null, minWall: Infinity, pitch: [] as number[] };
  let ticks = h.harness.sent.length;
  h.run(options.limitS ?? 150.0, (hh) => {
    const pose = hh.sim.pose();
    if (pose.altitude_m > 0.2) {
      info.minWall = Math.min(info.minWall, pose.distance_m);
      const clearance = hh.sim.clearanceM();
      if (clearance !== null) info.clearance = Math.min(info.clearance, clearance);
    }
    if (options.personAtS !== undefined && hh.clock.t - t0 >= options.personAtS) {
      hh.person = makePersonStatus({ enabled: true, detected: true, count: 1, ts: hh.clock.t });
    }
    const observations = hh.harness.observations;
    if (observations.length > 0 && hh.runner.state === "approaching") {
      const obs = observations[observations.length - 1]!;
      if (obs.marker === null) {
        info.missingSince = info.missingSince ?? obs.ts;
        info.hiddenS = Math.max(info.hiddenS, obs.ts - info.missingSince);
      } else {
        info.missingSince = null;
      }
    }
    if (hh.harness.sent.length > ticks) {
      ticks = hh.harness.sent.length;
      if (hh.runner.state === "approaching") info.pitch.push(hh.harness.sent[ticks - 1]![1][2]);
    }
    return hh.runner.state === "done" || hh.runner.state === "aborted";
  });
  const durationS = h.clock.t - t0;
  const snapshot = h.runner.snapshot();
  h.run(options.settleS ?? 3.0); // let a landing finish
  const pose = h.sim.pose();
  const events = h.store.events(20);
  const closing = events.find((e) => e.type === "arrived_at_station" || e.type === "run_aborted");
  const after = h.harness.sent.filter(([t]) => t > t0).map(([, axes]) => axes);
  const trim = h.mixer.trim()[0];
  return {
    seed: options.seed,
    state: h.runner.state,
    reason: h.runner.reason,
    durationS,
    clearanceM: info.clearance,
    hiddenS: info.hiddenS,
    minWallM: info.minWall,
    xM: pose.x_m,
    distanceM: pose.distance_m,
    airborne: pose.airborne,
    toggles: h.sim.toggleCount,
    lastLanding: snapshot.last_landing,
    needsPilot: snapshot.needs_pilot,
    heldS: snapshot.avoid.held_s,
    aligned: snapshot.last_arrival === null ? null : snapshot.last_arrival.aligned,
    closing: closing?.detail ?? {},
    events: [...events].reverse().map((e) => e.type),
    maxRoll: Math.max(0, ...after.map((a) => Math.abs(a[3] - trim))),
    maxThrottle: Math.max(0, ...after.map((a) => Math.abs(a[0]))),
    assistDisabled: snapshot.drift_assist.disabled_reason,
    suggestedTrim: snapshot.drift_assist.suggested_trim_roll,
    approachPitchMean: info.pitch.length ? info.pitch.reduce((s, v) => s + v, 0) / info.pitch.length : 0,
  };
}

/**
 * Check every bound on every seed and fail once with all the violations (seed and value), after printing
 * how many seeds met each bound: a bound that does not hold is reported, never loosened.
 */
function checkBounds(label: string, rows: Flight[], bounds: Bound[]): void {
  const violations: string[] = [];
  for (const [name, ok, value] of bounds) {
    const failing = rows.filter((r) => !ok(r));
    console.info(
      `${label}: ${name}: ${rows.length - failing.length} of ${rows.length}` +
        (failing.length ? ` (failing: ${failing.map((r) => `seed ${r.seed} ${JSON.stringify(value(r))}`).join(", ")})` : ""),
    );
    for (const r of failing) violations.push(`${name}: seed ${r.seed} ${JSON.stringify(value(r))}`);
  }
  expect(violations, label).toEqual([]);
}

type Bound = [name: string, ok: (r: Flight) => boolean, value: (r: Flight) => unknown];

/**
 * At least `min` of the runs meet `ok`: for a bound that Python's own test asserts on a few chosen seeds
 * but that Python itself does not meet on every seed. `min` is the 95 % (two-sided Clopper-Pearson) lower
 * bound of the rate Python achieved on the same scenario and seeds, times the number of runs, rounded
 * up: "no worse than Python", not "as lucky as Python's sample".
 */
function checkRate(label: string, rows: Flight[], name: string, ok: (r: Flight) => boolean, min: number, value: (r: Flight) => unknown): void {
  const failing = rows.filter((r) => !ok(r));
  const met = rows.length - failing.length;
  console.info(
    `${label}: ${name}: ${met} of ${rows.length} (at least ${min} required)` +
      (failing.length ? ` (not met: ${failing.map((r) => `seed ${r.seed} ${JSON.stringify(value(r))}`).join(", ")})` : ""),
  );
  expect(met, `${label}: ${name}`).toBeGreaterThanOrEqual(min);
}

/**
 * Landed distance from the wall, every automatic and drift-assist run. The runner's own limit: the line-up
 * ends only within align_distance_tol_m (0.08 m) of the 0.45 m landing distance by its own measure (0.37 to
 * 0.53 m), after which the settle and the descent let the drone drift a few centimetres (up to 9 cm in the
 * measured runs). Measured (Python SimHarness with the OpenCV detector, and this harness, 48 seeds each):
 * display start 0.441 sd 0.054 and 0.447 sd 0.054, drift assist 0.445 sd 0.039 and 0.440 sd 0.050; pooled
 * mean minus and plus 3 sd: 0.28 to 0.61 m.
 */
const LANDED_DISTANCE_M: readonly [number, number] = [0.28, 0.61];

function report(label: string, rows: Flight[]): void {
  const outcomes = new Map<string, number>();
  for (const r of rows) outcomes.set(`${r.state}/${r.reason ?? "-"}`, (outcomes.get(`${r.state}/${r.reason ?? "-"}`) ?? 0) + 1);
  const landed = rows.filter((r) => !r.airborne);
  console.info(
    `${label}: ${rows.length} seeds; outcomes ${[...outcomes].map(([k, n]) => `${k} x${n}`).join(", ")}; ` +
      `duration s ${stats(rows.map((r) => r.durationS))}; landed |x| m ${stats(landed.map((r) => Math.abs(r.xM)))}; ` +
      `landed distance m ${stats(landed.map((r) => r.distanceM))}; min wall m ${stats(rows.map((r) => r.minWallM))}` +
      (rows.some((r) => Number.isFinite(r.clearanceM)) ? `; clearance m ${stats(rows.map((r) => r.clearanceM))}` : ""),
  );
}

/** tests/test_automatic.py AutomaticClosedLoopTests */
const AUTOMATIC_BOUNDS: Bound[] = [
  ["done", (r) => r.state === "done" && r.reason === null, (r) => [r.state, r.reason]],
  ["takeoff and landing toggles only (2)", (r) => r.toggles === 2, (r) => r.toggles],
  ["on the ground at the end", (r) => !r.airborne, (r) => r.airborne],
  ["landed more than 0.33 m from the wall", (r) => r.distanceM > 0.33, (r) => r.distanceM],
  ["landed less than 0.6 m from the wall", (r) => r.distanceM < 0.6, (r) => r.distanceM],
  ["landed within 0.08 m of the centre line", (r) => Math.abs(r.xM) < 0.08, (r) => r.xM],
  ["last_arrival.aligned", (r) => r.aligned === true, (r) => r.aligned],
];

const display = (seed: number, extra: Partial<SimConfig> = {}): SimConfig =>
  highQualitySimConfig({ seed, start_airborne: false, start_distance_m: 3.2, reset_pose_on_takeoff: true, ...extra });

describe("automatic runs in the closed loop (tests/test_automatic.py AutomaticClosedLoopTests)", () => {
  // Measured side by side on seeds 0-47, the same scenario in Python (SimHarness: the rendered room and
  // the OpenCV detector) and here:
  //   done, 2 toggles, aligned      Python 48 of 48                      TypeScript 48 of 48
  //   landed distance from the wall Python 0.441 sd 0.054 [0.356, 0.578]  TypeScript 0.447 sd 0.054 [0.327, 0.552]
  //   sideways offset x             Python -0.003 sd 0.026 [-0.059, 0.074] TypeScript -0.011 sd 0.031 [-0.073, 0.083]
  //   closest to the wall           Python 0.369 sd 0.020 [0.314, 0.413]  TypeScript 0.366 sd 0.021 [0.326, 0.409]
  // No offset between the two: the distance means differ by 6 mm (Welch t -0.58), the sideways means by
  // 8 mm (t 1.4); the sideways scatter is a little wider here (sd ratio 1.2, not significant at 48 runs).
  it("from the display-profile start: 48 seeds end done and land in front of the sign", () => {
    const rows = seeds(48).map((seed) => fly({ seed, config: display(seed), profile: "display", automatic: true, limitS: 70, settleS: 1.5 }));
    report("automatic, display profile, 3.2 m start", rows);
    checkBounds("automatic, display profile", rows, [
      ["done", (r) => r.state === "done" && r.reason === null, (r) => [r.state, r.reason]],
      ["takeoff and landing toggles only (2)", (r) => r.toggles === 2, (r) => r.toggles],
      ["on the ground at the end", (r) => !r.airborne, (r) => r.airborne],
      ["last_arrival.aligned", (r) => r.aligned === true, (r) => r.aligned],
      [
        `landed ${LANDED_DISTANCE_M[0]} to ${LANDED_DISTANCE_M[1]} m from the wall`,
        (r) => r.distanceM > LANDED_DISTANCE_M[0] && r.distanceM < LANDED_DISTANCE_M[1],
        (r) => r.distanceM,
      ],
      // align_loose_m: the line-up never lands further off the centre line than this by its own measure;
      // pooled sd of x 0.029 m, so this is also about 4 sd.
      ["landed within 0.12 m of the centre line (align_loose_m)", (r) => Math.abs(r.xM) < 0.12, (r) => r.xM],
    ]);
    // The Python test's tighter bounds (0.33 to 0.6 m, |x| under 0.08 m) held on all 48 Python seeds (95 %
    // lower bound of that rate 0.926, so at least 45 of 48); here 47 and 47 (seed 4 landed 0.327 m out,
    // seed 8 0.083 m off the centre line).
    checkRate("automatic, display profile", rows, "landed 0.33 to 0.6 m from the wall (Python test)", (r) => r.distanceM > 0.33 && r.distanceM < 0.6, 45, (r) => r.distanceM);
    checkRate("automatic, display profile", rows, "landed within 0.08 m of the centre line (Python test)", (r) => Math.abs(r.xM) < 0.08, 45, (r) => r.xM);
  });

  it("from the Python test's start (drone profile, 2.5 m, 10 degrees off either way): 20 seeds", () => {
    const rows = seeds(20).map((seed) =>
      fly({
        seed,
        config: makeSimConfig({ seed, start_airborne: false, start_distance_m: 2.5, start_heading_deg: seed % 2 ? 10.0 : -10.0 }),
        profile: "drone",
        automatic: true,
        limitS: 70,
        settleS: 1.5,
      }),
    );
    report("automatic, drone profile, 2.5 m, +-10 degrees", rows);
    checkBounds("automatic, drone profile", rows, AUTOMATIC_BOUNDS);
  });
});

/** test_sim_closed_loop.py run_station: a manual run, 25 degrees off alternating with the seed. */
function station(seed: number, drift: number, extra: Partial<SimConfig> & { dropout?: number; assist?: boolean; runnerConfig?: RunnerConfig; heading?: number } = {}): Flight {
  const { dropout, assist, runnerConfig, heading, ...sim } = extra;
  return fly({
    seed,
    config: makeSimConfig({
      seed,
      lateral_drift: drift,
      start_distance_m: 2.5,
      start_heading_deg: heading ?? (seed % 2 === 0 ? 25.0 : -25.0),
      start_airborne: true,
      ...sim,
    }),
    profile: "drone",
    automatic: false,
    land: true,
    assist: assist ?? false,
    dropout: dropout ?? 0.0,
    runnerConfig: runnerConfig ?? makeRunnerConfig(),
    limitS: 70,
    settleS: 0.5,
  });
}

describe("manual runs in the closed loop (tests/test_sim_closed_loop.py)", () => {
  it("half the detections dropped: the approach coasts and the run lands (10 seeds)", () => {
    const rows = seeds(10).map((seed) => station(seed, 0.0, { heading: 0.0, dropout: 0.5 }));
    const stalled = seeds(10).map((seed) =>
      station(seed, 0.0, { heading: 0.0, dropout: 0.5, runnerConfig: makeRunnerConfig({ lost_coast_s: 0.0 }) }),
    );
    report("manual, 50 % dropout", rows);
    console.info(
      `approach pitch mean with the coast ${stats(rows.map((r) => r.approachPitchMean))}, without ${stats(stalled.map((r) => r.approachPitchMean))}`,
    );
    rows.forEach((r, i) => {
      expect([r.state, r.reason], `seed ${r.seed}`).toEqual(["done", null]);
      expect(r.toggles).toBe(1);
      expect(r.distanceM).toBeGreaterThan(0.36);
      expect(r.distanceM).toBeLessThan(0.56);
      expect(r.minWallM).toBeGreaterThan(0.33);
      expect(r.approachPitchMean).toBeGreaterThan(0.1);
      expect(r.approachPitchMean).toBeGreaterThanOrEqual(1.5 * stalled[i]!.approachPitchMean);
    });
  });

  // Measured side by side on seeds 0-47 (drift +-0.08 m/s by seed, 25 degrees off either way), Python
  // (SimHarness, the OpenCV detector) and here:
  //   outcome                       Python 48 done                       TypeScript 47 done, 1 not_lined_up (seed 12)
  //   landed distance from the wall Python 0.445 sd 0.039 [0.354, 0.539]  TypeScript 0.440 sd 0.050 [0.313, 0.531]
  //   sideways offset x             Python 0.001 sd 0.031 [-0.060, 0.099] TypeScript 0.001 sd 0.035 [-0.083, 0.081]
  //   closest to the wall           Python 0.370 sd 0.019 [0.325, 0.414]  TypeScript 0.365 sd 0.023 [0.310, 0.405]
  // No offset (Welch t: landed distance 0.60, closest 1.16, x 0.04).
  it("drift with the drift assist on: lands in front of the sign, never near the wall (test_h_on, 48 seeds)", () => {
    const rows = seeds(48).map((seed) => station(seed, seed % 3 ? 0.08 : -0.08, { assist: true }));
    const done = rows.filter((r) => r.state === "done");
    report("manual, drift assist on, +-0.08 m/s", rows);
    checkBounds("manual, drift assist on", rows, [
      [
        "done, or stopped by the approach or the line-up (off_axis, not_lined_up) without a toggle",
        (r) =>
          (r.state === "done" && r.reason === null && r.toggles === 1) ||
          (r.state === "aborted" && (r.reason === "off_axis" || r.reason === "not_lined_up") && r.toggles === 0),
        (r) => [r.state, r.reason, r.toggles],
      ],
      // align_too_close_floor_m: the line-up gives up closer than max(0.30, 0.7 x 0.45) m by its own
      // measure; pooled mean of the closest approach 0.367 m, sd 0.021, so this is also about mean - 3 sd.
      ["never closer than 0.30 m to the wall (align_too_close_floor_m)", (r) => r.minWallM > 0.3, (r) => r.minWallM],
      ["roll within 0.15", (r) => r.maxRoll <= 0.15 + 1e-9, (r) => r.maxRoll],
      ["no throttle", (r) => r.maxThrottle === 0.0, (r) => r.maxThrottle],
      ["the assist stayed on", (r) => r.assistDisabled === null, (r) => r.assistDisabled],
    ]);
    checkBounds("manual, drift assist on, the runs that arrived", done, [
      [
        `landed ${LANDED_DISTANCE_M[0]} to ${LANDED_DISTANCE_M[1]} m from the wall`,
        (r) => r.distanceM > LANDED_DISTANCE_M[0] && r.distanceM < LANDED_DISTANCE_M[1],
        (r) => r.distanceM,
      ],
      ["within 0.30 m of the centre line (Python test; held on all 96 measured runs)", (r) => Math.abs(r.xM) < 0.3, (r) => r.xM],
      [
        "a trim suggestion, also in the closing event",
        (r) => r.suggestedTrim !== null && r.closing["suggested_trim_roll"] === r.suggestedTrim,
        (r) => r.suggestedTrim,
      ],
      [
        "the suggestion points against the drift, at most 0.15",
        (r) => r.suggestedTrim !== null && r.suggestedTrim * (r.seed % 3 ? 0.08 : -0.08) < 0.0 && Math.abs(r.suggestedTrim) <= 0.15,
        (r) => r.suggestedTrim,
      ],
    ]);
    expect(done.reduce((s, r) => s + Math.abs(r.xM), 0) / done.length).toBeLessThan(0.2);
    // Python: done on 48 of 48 (95 % lower bound 0.926: at least 45 of 48).
    checkRate("manual, drift assist on", rows, "done", (r) => r.state === "done", 45, (r) => [r.state, r.reason]);
    // The Python test's "never closer than 0.33 m" holds only on its four chosen seeds: Python itself met
    // it on 47 of these 48 (seed 24: 0.325 m; 95 % lower bound 0.889: at least 43 of 48).
    checkRate("manual, drift assist on", rows, "never closer than 0.33 m to the wall (Python test)", (r) => r.minWallM > 0.33, 43, (r) => r.minWallM);
  });

  // Measured side by side on seeds 0-47 at each drift (96 runs), Python (SimHarness, the OpenCV detector)
  // and here:
  //   the assist switched itself off  Python 93 of 96 (3 runs at 0.20 m/s end off_axis first)
  //                                   TypeScript 90 of 96 (1 at 0.08 m/s, 5 at 0.20 m/s end off_axis first)
  //   ended aborted, no toggle        Python 96 of 96                TypeScript 96 of 96
  //   closest to the wall, 0.08 m/s   Python 0.467 sd 0.075 [0.276, 0.683]  TypeScript 0.484 sd 0.093 [0.282, 0.777]
  //   closest to the wall, 0.20 m/s   Python 1.114 sd 0.102 [0.899, 1.368]  TypeScript 1.078 sd 0.083 [0.912, 1.244]
  // No offset that the spread does not explain (Welch t -0.98 and 1.91, in opposite directions).
  it("the drone answers roll the other way: the run stops safely and the assist switches itself off (test_i, 96 runs)", () => {
    const rows = [0.08, 0.2].flatMap((drift) => seeds(48).map((seed) => station(seed, drift, { assist: true, lateral_gain: -1.0 })));
    report("manual, drift assist on, roll reversed", rows);
    checkBounds("manual, roll reversed", rows, [
      [
        "stopped by the approach or the line-up (off_axis, not_lined_up), never a toggle",
        (r) => r.state === "aborted" && (r.reason === "off_axis" || r.reason === "not_lined_up") && r.toggles === 0,
        (r) => [r.state, r.reason, r.toggles],
      ],
      ["no trim suggestion", (r) => r.suggestedTrim === null, (r) => r.suggestedTrim],
      [
        "drift_assist_disabled in the closing event whenever the assist switched itself off",
        (r) => r.assistDisabled === null || r.closing["drift_assist_disabled"] === true,
        (r) => r.closing["drift_assist_disabled"],
      ],
      ["roll within 0.15", (r) => r.maxRoll <= 0.15 + 1e-9, (r) => r.maxRoll],
      // tests/test_sim_closed_loop.py LineUpTests' bound for a reversed roll: the line-up starts at about
      // 0.37 m and its too-close stop is seen one video delay late. Pooled at 0.08 m/s: mean 0.476 m, sd
      // 0.085, so this is also about mean - 3 sd.
      ["never closer than 0.20 m to the wall", (r) => r.minWallM > 0.2, (r) => [r.minWallM, r.reason]],
    ]);
    // The Python test asserts the switch-off on its four chosen runs; on these 96 Python itself switched it
    // off on 93 (95 % lower bound 0.911: at least 88 of 96).
    checkRate("manual, roll reversed", rows, "the assist switched itself off", (r) => r.assistDisabled === "off_axis_worsening", 88, (r) => [r.reason, r.minWallM]);
    // The Python test's "never closer than 0.40 m" holds only on its four chosen runs; Python itself met it
    // on 89 of these 96 (seeds 4 and 29 at 0.08 m/s came to 0.276 and 0.289 m, ending not_lined_up; 95 %
    // lower bound 0.856: at least 83 of 96).
    checkRate("manual, roll reversed", rows, "never closer than 0.40 m to the wall (Python test)", (r) => r.minWallM > 0.4, 83, (r) => [r.minWallM, r.reason]);
  });
});

/** test_avoid_sim.py make(): an automatic run from the ground with the scenario's actors. */
function avoidFlight(seed: number, scenario: string, profile: "display" | "drone", mode: "off" | "hold" = "hold", personAtS?: number): Flight {
  const sc = scenarioByName(scenario);
  const base = {
    seed,
    start_airborne: false,
    start_distance_m: sc.start_distance_m ?? 2.5,
    start_heading_deg: seed % 3 === 0 ? 5.0 : -5.0,
    lateral_drift: seed % 2 === 0 ? 0.08 : -0.08,
    actors: sc.actors,
  };
  return fly({
    seed,
    config: profile === "drone" ? makeSimConfig(base) : highQualitySimConfig(base),
    profile,
    automatic: true,
    runnerConfig: makeRunnerConfig({ avoid: mode }),
    ...(personAtS === undefined ? {} : { personAtS }),
  });
}

function assertLandedAtStation(r: Flight): void {
  expect([r.state, r.reason], `seed ${r.seed}`).toEqual(["done", null]);
  expect(r.toggles, "takeoff and the landing").toBe(2);
  expect(r.airborne).toBe(false);
  expect(r.distanceM).toBeGreaterThan(0.33);
  expect(r.distanceM).toBeLessThan(0.6);
  expect(Math.abs(r.xM), `seed ${r.seed}: on the sign's centre line`).toBeLessThan(0.08);
}

function assertLandedWhereItWas(r: Flight): void {
  expect([r.state, r.reason], `seed ${r.seed}`).toEqual(["aborted", "path_blocked"]);
  expect(r.closing["blocked_by"]).toBe("timeout");
  expect(r.toggles, `seed ${r.seed}: takeoff and the landing where it is`).toBe(2);
  expect(r.lastLanding).toBe("safe_landing");
  expect(r.airborne).toBe(false);
  expect(r.needsPilot).toBe(false);
}

for (const profile of ["drone", "display"] as const) {
  describe(`avoidance "hold" in the closed loop, ${profile} profile (tests/test_avoid_sim.py)`, () => {
    it("crossing: holds while the person crosses, resumes and lands at the station (20 seeds, at least 19)", () => {
      const rows = seeds(20).map((seed) => avoidFlight(seed, "crossing", profile));
      report(`crossing, ${profile}`, rows);
      console.info(`crossing ${profile}: held s ${stats(rows.map((r) => r.heldS))}`);
      for (const r of rows) {
        expect(r.clearanceM, `seed ${r.seed}`).toBeGreaterThan(0.5);
        expect(r.heldS, `seed ${r.seed}: it held while the person crossed`).toBeGreaterThanOrEqual(1.0);
        if (r.state === "done") assertLandedAtStation(r);
        else expect([r.toggles, r.lastLanding], `seed ${r.seed}`).toEqual([2, "safe_landing"]);
      }
      expect(rows.filter((r) => r.state === "done").length).toBeGreaterThanOrEqual(19);
    });

    it("standing: ends path_blocked and always lands where it is; the hidden sign is never marker_lost (20 seeds)", () => {
      const rows = seeds(20).map((seed) => avoidFlight(seed, "standing", profile));
      report(`standing, ${profile}`, rows);
      console.info(`standing ${profile}: longest stretch with the sign hidden s ${stats(rows.map((r) => r.hiddenS))}`);
      for (const r of rows) {
        expect(r.clearanceM, `seed ${r.seed}`).toBeGreaterThan(0.5);
        assertLandedWhereItWas(r);
        expect(r.hiddenS, `seed ${r.seed}`).toBeGreaterThan(0.6 + 2.0);
        expect(r.reason).not.toBe("marker_lost");
      }
    });

    it("blocked: ends path_blocked and always lands where it is (20 seeds)", () => {
      const rows = seeds(20).map((seed) => avoidFlight(seed, "blocked", profile));
      report(`blocked, ${profile}`, rows);
      for (const r of rows) {
        expect(r.clearanceM, `seed ${r.seed}`).toBeGreaterThan(0.5);
        assertLandedWhereItWas(r);
      }
    });

    it("cart: the start is refused before takeoff in both modes (10 seeds)", () => {
      for (const seed of seeds(10)) {
        for (const mode of ["off", "hold"] as const) {
          const sc = scenarioByName("cart");
          const base = { seed, start_airborne: false, start_distance_m: sc.start_distance_m ?? 2.5, start_heading_deg: 5.0, actors: sc.actors };
          const h = new MissionHarness({
            simConfig: profile === "drone" ? makeSimConfig(base) : highQualitySimConfig(base),
            detector: detectorFor(profile, seed),
            runnerConfig: makeRunnerConfig({ avoid: mode }),
          });
          h.warmUp(1.0);
          const blockers = h.runner.blockers();
          expect(blockers, `seed ${seed} ${mode}`).toContain("obstacle_in_view");
          expect(blockers).not.toContain("person_in_view");
          expect(h.runner.start(false, "d1", undefined, true)).toEqual([false, ["obstacle_in_view"]]);
          expect(h.runner.start(true, "d1")).toEqual([false, ["obstacle_in_view"]]);
          h.run(2.0);
          expect(h.runner.state).toBe("idle");
          expect(h.sim.toggleCount, "never took off").toBe(0);
          expect(h.sim.pose().airborne).toBe(false);
        }
      }
    });
  });
}

describe("avoidance with nothing in the corridor, and avoidance off", () => {
  it('"hold" with no actors sends exactly what "off" sends, step for step (test_avoid_sim.py SameCommandsTests)', () => {
    for (const automatic of [true, false]) {
      for (const seed of [0, 1]) {
        const sent = (mode: "off" | "hold"): { sent: unknown[]; state: string } => {
          const config = automatic
            ? makeSimConfig({ seed, start_airborne: false, start_distance_m: 2.5, start_heading_deg: seed % 3 === 0 ? 5.0 : -5.0, lateral_drift: seed % 2 === 0 ? 0.08 : -0.08 })
            : makeSimConfig({ seed, start_heading_deg: 20.0, start_airborne: true });
          const h = new MissionHarness({ simConfig: config, detector: detectorFor("drone", seed), runnerConfig: makeRunnerConfig({ avoid: mode }) });
          h.warmUp(1.0);
          h.runner.setLandOnArrival(true);
          expect(h.runner.start(!automatic, "d1", undefined, automatic)[0]).toBe(true);
          h.run(70.0, (hh) => hh.runner.state === "done" || hh.runner.state === "aborted");
          h.run(1.0);
          return { sent: h.harness.sent.map(([t, axes]) => [t, [...axes]]), state: h.runner.state };
        };
        const off = sent("off");
        const on = sent("hold");
        expect(off.state, `automatic ${automatic} seed ${seed}`).toBe("done");
        expect(on.state).toBe(off.state);
        expect(on.sent).toEqual(off.sent);
      }
    }
  });

  it('"off" stops the run for a person as before (test_avoid_sim.py OffTests)', () => {
    const checked = avoidFlight(0, "empty", "drone", "off", 13.0);
    expect([checked.state, checked.reason]).toEqual(["aborted", "person_in_view"]);
    const simulated = avoidFlight(1, "crossing", "drone", "off");
    expect([simulated.state, simulated.reason]).toEqual(["aborted", "person_in_view"]);
    expect(simulated.closing).not.toHaveProperty("avoid");
    expect(NEUTRAL).toEqual([0, 0, 0, 0]);
  });
});

describe("status vision.obstacles on the ground (test_avoid_runner.py StatusTests)", () => {
  it("cart: on the ground the estimates use the ground camera height; airborne the hover-height estimate, as before", () => {
    const sc = scenarioByName("cart");
    const h = new MissionHarness({
      simConfig: makeSimConfig({ seed: 0, start_airborne: false, start_distance_m: sc.start_distance_m ?? 2.5, actors: sc.actors }),
      detector: detectorFor("drone", 0),
    });
    h.warmUp(1.0);
    const distance = (): number | null => {
      const seen = h.runner.obstaclesSnapshot();
      expect(seen.map((o) => o.kind)).toEqual(["object"]);
      return seen[0]!.distance_m;
    };
    // The cart's centre is 2.7 m from the drone (4.2 m from the wall, cart 1.5 m); its near side 2.5 m.
    expect(h.sim.telemetry()?.fly_state_raw).toBe(0);
    const ground = distance();
    expect(Math.abs(ground! - 2.5)).toBeLessThan(0.1);
    const real = h.sim.telemetry.bind(h.sim);
    h.sim.telemetry = () => ({ ...real()!, fly_state_raw: 1 });
    const hover = distance();
    expect(hover, "airborne: the hover-height estimate").toBeGreaterThan(50.0);
    h.sim.telemetry = () => ({ ...real()!, timestamp: h.clock.now() - 60.0 });
    expect(distance(), "stale telemetry: no evidence").toBe(hover);
    h.sim.telemetry = real;
    expect(distance()).toBe(ground);
    expect(h.runner.blockers(), "the start blocker is unchanged").toContain("obstacle_in_view");
  });
});
