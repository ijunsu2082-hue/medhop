// Closed-loop outcome tests of runner.ts with the real TypeScript pieces together: the simulator
// (drone/sim.ts), the synthetic sign detector (vision/detector.ts), the mixer and the runner, in
// simulated time (testing/missionHarness.ts). Not replays: the simulator's noise and the detector differ
// from Python's, so these assert outcomes, with the bounds the Python closed-loop tests assert
// (backend/tests/test_automatic.py, test_sim_closed_loop.py, test_avoid_sim.py). Clearance is simulator
// truth (SimLink.clearanceM) while the drone is more than 0.2 m up. Every measured figure is printed.
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
  it("from the display-profile start: 20 seeds end done and land on the sign's centre line", () => {
    const rows = seeds(20).map((seed) => fly({ seed, config: display(seed), profile: "display", automatic: true, limitS: 70, settleS: 1.5 }));
    report("automatic, display profile, 3.2 m start", rows);
    checkBounds("automatic, display profile", rows, AUTOMATIC_BOUNDS);
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

  it("drift with the drift assist on: cuts the sideways offset (test_h_on, 10 seeds)", () => {
    const rows = seeds(10).map((seed) => station(seed, seed % 3 ? 0.08 : -0.08, { assist: true }));
    report("manual, drift assist on, +-0.08 m/s", rows);
    checkBounds("manual, drift assist on", rows, [
      ["done", (r) => r.state === "done" && r.reason === null, (r) => [r.state, r.reason]],
      ["one toggle", (r) => r.toggles === 1, (r) => r.toggles],
      ["within 0.30 m of the centre line", (r) => Math.abs(r.xM) < 0.3, (r) => r.xM],
      ["never closer than 0.33 m to the wall", (r) => r.minWallM > 0.33, (r) => r.minWallM],
      ["roll within 0.15", (r) => r.maxRoll <= 0.15 + 1e-9, (r) => r.maxRoll],
      ["no throttle", (r) => r.maxThrottle === 0.0, (r) => r.maxThrottle],
      ["the assist stayed on", (r) => r.assistDisabled === null, (r) => r.assistDisabled],
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
    expect(rows.reduce((s, r) => s + Math.abs(r.xM), 0) / rows.length).toBeLessThan(0.2);
  });

  it("the drone answers roll the other way: the assist switches itself off (test_i, 10 runs)", () => {
    const rows = [0.08, 0.2].flatMap((drift) => seeds(5).map((seed) => station(seed, drift, { assist: true, lateral_gain: -1.0 })));
    report("manual, drift assist on, roll reversed", rows);
    checkBounds("manual, roll reversed", rows, [
      ["the assist switched itself off", (r) => r.assistDisabled === "off_axis_worsening", (r) => r.assistDisabled],
      ["no trim suggestion", (r) => r.suggestedTrim === null, (r) => r.suggestedTrim],
      ["drift_assist_disabled in the closing event", (r) => r.closing["drift_assist_disabled"] === true, (r) => r.closing["drift_assist_disabled"]],
      ["roll within 0.15", (r) => r.maxRoll <= 0.15 + 1e-9, (r) => r.maxRoll],
      ["never closer than 0.40 m to the wall", (r) => r.minWallM > 0.4, (r) => [r.minWallM, r.reason]],
      [
        "ended done or aborted, never a toggle on an abort",
        (r) => (r.state === "done" || r.state === "aborted") && (r.state !== "aborted" || r.toggles === 0),
        (r) => [r.state, r.toggles],
      ],
    ]);
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
