// Checks the synthetic sign detector against __fixtures__/detector_calibration.json (backend/tools/
// parity_traces.py detector_calibration).
//
// `cases` (deterministic): the sign's true corners through the Python simulator's camera, and the
// MarkerObs that MarkerDetector.detect's own code builds from exactly those corners (its OpenCV call
// stubbed to report them). The synthetic detector's noise-free corners must equal the truth and its
// MarkerObs fields Python's, within 1e-9.
//
// `measured` (not a replay): the real OpenCV detector on the Python simulator's pictures. These tests
// check that the measurement says what detector.ts's header says, that the chosen defaults follow from
// it, that the hiding and edge rules agree with where the real detector stopped finding the sign, and
// that the silhouettes this module builds reach into the marker exactly as far as the Python geometry
// that placed the actors said.
import { describe, expect, it } from "vitest";
import { cameraExtrinsics, cameraMatrix } from "../camera/projection";
import type { Frame } from "../drone/link";
import type { SimConfig } from "../drone/sim";
import { Actor, cameraPoints, convexHull, project } from "../drone/simActors";
import { assertNoMismatches, compareValues, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import { actorFromRow, configFromFixture } from "../testing/simFixtures";
import { PythonRandom, type RandomSource } from "../util/rng";
import {
  borderMargin,
  DETECTOR_DEFAULTS,
  DRONE_LIKE_DETECTOR_OPTIONS,
  estimatedBrightness,
  markerObsFromCorners,
  obstaclesOf,
  signCorners,
  SignDetector,
  type SignView,
} from "./detector";
import { MIN_WIDTH, type MarkerObs } from "./marker";

interface ObsFields {
  id: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  corners: number[][];
  ts: number;
  frame_w: number;
  frame_h: number;
}

interface Stats {
  mean: number;
  median: number;
  p95: number;
  max: number;
}

interface Measured {
  profile: string;
  width: number;
  height: number;
  focal_px: number;
  by_distance: {
    distance_m: number;
    in_view: number;
    found: number;
    miss_rate: number | null;
    found_outside_view: number;
    corner_error_px: Stats | null;
    corner_error_vs_drawn_px: Stats | null;
  }[];
  overall: {
    in_view: number;
    found: number;
    miss_rate: number;
    corner_error_px: Stats;
    rms_per_coordinate_px: number;
    std_per_coordinate_without_bias_px: number;
    corner_error_vs_drawn_px: Stats;
  };
  edge: { rows: { distance_m: number; edge: string; margin_px: number; found: boolean }[] };
  hiding: { rows: { distance_m: number; from: string; reach_px: number; found: boolean; actor: unknown[] }[] };
  brightness: { hover_median: number; ground_at_start: number };
}

interface CalibrationFixture {
  min_width: number;
  cases: {
    profile: string;
    snap: [number, number, number, number];
    ts: number;
    depth: number[];
    corners: number[][];
    obs: ObsFields | null;
  }[];
  measured: Measured[];
}

const fx = loadFixture<CalibrationFixture>("detector_calibration");
const QUIET = { noise_velocity: 0.0, noise_yaw_deg: 0.0, sensor_noise: 0.0 };
const CONFIGS: Record<string, SimConfig> = {
  drone: configFromFixture("drone", QUIET),
  high: configFromFixture("high", QUIET),
};

function view([x, z, heading, cam_y]: readonly number[], actors: readonly Actor[] = []): SignView {
  return { x: x!, z: z!, heading: heading!, cam_y: cam_y!, marker_hidden: false, actors };
}

function hover(distance: number, actors: readonly Actor[] = []): SignView {
  return view([0.0, -distance, 0.0, 1.04], actors);
}

function fields(obs: MarkerObs | null): ObsFields | null {
  if (obs === null) return null;
  return {
    id: obs.id,
    cx: obs.cx,
    cy: obs.cy,
    width: obs.width,
    height: obs.height,
    corners: obs.corners.map((c) => [c[0], c[1]]),
    ts: obs.ts,
    frame_w: obs.frame_w,
    frame_h: obs.frame_h,
  };
}

function measured(profile: string): Measured {
  const m = fx.measured.find((x) => x.profile === profile);
  if (m === undefined) throw new Error(`no measurement for ${profile}`);
  return m;
}

const EXACT_DETECTOR = { corner_noise_px: 0, dropout: 0, edge_margin_px: 0, hide_margin_px: null };

describe("true corners and MarkerObs against Python", () => {
  it("MIN_WIDTH and both frame sizes are covered", () => {
    expect(fx.min_width).toBe(MIN_WIDTH);
    expect(new Set(fx.cases.map((c) => c.profile))).toEqual(new Set(["drone", "high"]));
    expect(fx.cases.some((c) => c.obs === null)).toBe(true); // below MIN_WIDTH
    expect(fx.cases.some((c) => c.depth.some((d) => d <= 0))).toBe(true); // behind the camera
  });

  it(`signCorners and markerObsFromCorners: ${fx.cases.length} poses`, () => {
    const stats = new ParityStats();
    fx.cases.forEach((case_, i) => {
      const g = CONFIGS[case_.profile]!;
      const { camera, pixels } = signCorners(g, view(case_.snap));
      const got = {
        depth: camera.map((p) => p[2]),
        corners: pixels.map((p) => [p[0], p[1]]),
        obs: fields(markerObsFromCorners(case_.corners as [number, number][], g.width, g.height, 7, case_.ts)),
      };
      const want = { depth: case_.depth, corners: case_.corners, obs: case_.obs };
      assertNoMismatches(compareValues(got, want, PARITY, `cases[${i}]`, stats), `cases[${i}]`);
    });
    console.log(stats.summary("detector cases"));
  });

  it("the noise-free detector reports exactly Python's MarkerObs, or says why not", () => {
    const stats = new ParityStats();
    const reasons = new Set<string>();
    fx.cases.forEach((case_, i) => {
      const g = CONFIGS[case_.profile]!;
      const detector = new SignDetector(g, EXACT_DETECTOR);
      const got = detector.detect(view(case_.snap), case_.ts);
      const behind = case_.depth.some((d) => d <= 0);
      const outside = borderMargin(case_.corners as [number, number][], g.width, g.height) < 0;
      if (behind) expect(detector.lastMiss, `cases[${i}]`).toBe("behind");
      else if (outside) expect(detector.lastMiss, `cases[${i}]`).toBe("outside");
      else if (case_.obs === null) expect(detector.lastMiss, `cases[${i}]`).toBe("small");
      else assertNoMismatches(compareValues(fields(got), case_.obs, PARITY, `cases[${i}]`, stats), `cases[${i}]`);
      if (detector.lastMiss !== null) reasons.add(detector.lastMiss);
      else expect(got).not.toBeNull();
    });
    expect(reasons).toEqual(new Set(["behind", "outside", "small"]));
    expect(stats.floats).toBeGreaterThan(200);
  });
});

describe("the measured Python detector and the chosen defaults", () => {
  const display = measured("high");
  const drone = measured("drone");

  it("the projection is the renderer's: corner error well under a pixel", () => {
    expect([display.width, display.height]).toEqual([1280, 720]);
    expect(display.overall.corner_error_px.mean).toBeLessThan(0.6);
    expect(display.overall.corner_error_vs_drawn_px.mean).toBeLessThan(0.3);
    expect(display.overall.corner_error_vs_drawn_px.max).toBeLessThan(0.5);
    expect(drone.overall.corner_error_vs_drawn_px.mean).toBeLessThan(0.7);
    for (const m of [display, drone]) {
      const g = CONFIGS[m.profile]!;
      expect(new SignDetector(g).focal).toBeCloseTo(m.focal_px, 9);
      // no detection where the geometry says the sign is not in view
      expect(m.by_distance.every((row) => row.found_outside_view === 0)).toBe(true);
    }
  });

  it("the display defaults follow from the display numbers", () => {
    expect(display.overall.miss_rate).toBe(0);
    expect(DETECTOR_DEFAULTS.dropout).toBe(display.overall.miss_rate);
    expect(Math.abs(DETECTOR_DEFAULTS.corner_noise_px - display.overall.std_per_coordinate_without_bias_px)).toBeLessThan(0.01);
    expect(Math.abs(DRONE_LIKE_DETECTOR_OPTIONS.corner_noise_px - drone.overall.std_per_coordinate_without_bias_px)).toBeLessThan(0.01);
    // the header's quoted numbers
    expect(display.overall.corner_error_px.mean).toBeCloseTo(0.47, 2);
    expect(display.overall.rms_per_coordinate_px).toBeCloseTo(0.36, 2);
    expect(display.overall.corner_error_vs_drawn_px.mean).toBeCloseTo(0.21, 2);
    expect(drone.overall.corner_error_px.mean).toBeCloseTo(0.94, 2);
  });

  for (const [name, options] of [
    ["display", DETECTOR_DEFAULTS],
    ["drone-like", DRONE_LIKE_DETECTOR_OPTIONS],
  ] as const) {
    it(`the edge rule agrees with where the real detector stopped (${name})`, () => {
      const m = name === "display" ? display : drone;
      const rows = m.edge.rows;
      const agree = rows.filter((r) => r.margin_px >= options.edge_margin_px === r.found).length;
      console.log(`${name} edge rule: ${agree} of ${rows.length} edge renders agree`);
      expect(agree / rows.length).toBeGreaterThanOrEqual(0.95);
      // every miss of the rule is within a pixel of its threshold
      for (const r of rows) {
        if (r.margin_px >= options.edge_margin_px !== r.found) {
          expect(Math.abs(r.margin_px - options.edge_margin_px)).toBeLessThanOrEqual(1.0);
        }
      }
    });
  }

  it("the silhouettes reach into the marker as far as the Python geometry put them", () => {
    for (const m of [display, drone]) {
      const g = CONFIGS[m.profile]!;
      for (const r of m.hiding.rows) {
        const v = hover(r.distance_m, [actorFromRow(r.actor)]);
        const { position, rot } = cameraExtrinsics(v);
        const K = cameraMatrix(g.width, g.height, g.hfov_deg);
        const hull = convexHull(project(cameraPoints(actorFromRow(r.actor), position, rot), K));
        const marker = signCorners(g, v).pixels;
        const reach =
          r.from === "side"
            ? Math.max(...hull.map((p) => p[0])) - Math.min(...marker.map((p) => p[0]))
            : Math.max(...marker.map((p) => p[1])) - Math.min(...hull.map((p) => p[1]));
        expect(reach).toBeCloseTo(r.reach_px, 6);
      }
    }
  });

  for (const [name, options] of [
    ["display", DETECTOR_DEFAULTS],
    ["drone-like", DRONE_LIKE_DETECTOR_OPTIONS],
  ] as const) {
    it(`the hiding rule against the real detector (${name})`, () => {
      const m = name === "display" ? display : drone;
      const g = CONFIGS[m.profile]!;
      const detector = new SignDetector(g, { ...options, corner_noise_px: 0, dropout: 0 });
      let agree = 0;
      let flight = 0;
      let flightAgree = 0;
      for (const r of m.hiding.rows) {
        const v = hover(r.distance_m, [actorFromRow(r.actor)]);
        const covered = detector.covered(v, signCorners(g, v).pixels);
        // the rule itself: hidden from an overlap, or from hide_margin_px before one (rows exactly on
        // the threshold were placed by bisection and may fall either side)
        if (Math.abs(r.reach_px + options.hide_margin_px!) > 1e-6) {
          expect(covered, `${r.distance_m} ${r.from} ${r.reach_px}`).toBe(r.reach_px > -options.hide_margin_px!);
        }
        const same = !covered === r.found;
        agree += same ? 1 : 0;
        if (r.distance_m >= 2.5) {
          flight += 1;
          flightAgree += same ? 1 : 0;
        }
        if (!same && Math.abs(r.reach_px + options.hide_margin_px!) > 1e-6 && name === "display") {
          // The only disagreement allowed: the rule hides a sign the real detector still reported while
          // partly covered (with corners dragged onto the silhouette), by at most 5 px of overlap at
          // flight distances (10 px, the whole sweep, at 1.5 m).
          expect(covered && r.found, `${r.distance_m} ${r.from} ${r.reach_px}`).toBe(true);
          expect(r.reach_px).toBeLessThanOrEqual(r.distance_m >= 2.5 ? 5.0 : 10.0);
        }
      }
      console.log(
        `${name} hiding rule: ${agree} of ${m.hiding.rows.length} renders agree, ` +
          `${flightAgree} of ${flight} at 2.5 m and 3.5 m`,
      );
      if (name === "display") expect(flightAgree / flight).toBeGreaterThanOrEqual(0.8);
      else expect(agree / m.hiding.rows.length).toBeGreaterThanOrEqual(0.95);
    });
  }

  it("brightness estimates are the measured values", () => {
    expect(estimatedBrightness({ scene: "room", light: 1.0 }, { cam_y: 1.04 })).toBe(display.brightness.hover_median);
    expect(estimatedBrightness({ scene: "room", light: 1.0 }, { cam_y: 0.04 })).toBe(display.brightness.ground_at_start);
    expect(estimatedBrightness({ scene: "plain", light: 0.5 }, { cam_y: 1.04 })).toBe(drone.brightness.hover_median * 0.5);
  });
});

describe("SignDetector behaviour", () => {
  const g = CONFIGS["high"]!;

  it("reports why it found nothing", () => {
    const detector = new SignDetector(g, { corner_noise_px: 0 });
    expect(detector.detect({ ...hover(2.0), marker_hidden: true })).toBeNull();
    expect(detector.lastMiss).toBe("marker_hidden");
    expect(new SignDetector(g, { marker_id: 3 }).detect(hover(2.0))).toBeNull();
    expect(detector.detect(view([0, -2, Math.PI, 1.04]))).toBeNull();
    expect(detector.lastMiss).toBe("behind");
    expect(detector.detect(view([0, -2, 0.7, 1.04]))).toBeNull();
    expect(detector.lastMiss).toBe("outside");
    expect(detector.detect(hover(6.0))).toBeNull();
    expect(detector.lastMiss).toBe("small");
    const person = new Actor({ x_m: 0.0, distance_m: 1.0 });
    expect(detector.detect(hover(2.5, [person]))).toBeNull();
    expect(detector.lastMiss).toBe("covered");
    const aside = new Actor({ x_m: 1.2, distance_m: 1.0 });
    expect(detector.detect(hover(2.5, [aside]))).not.toBeNull();
    expect(detector.lastMiss).toBeNull();
    expect(new SignDetector(g, { hide_margin_px: null }).detect(hover(2.5, [person]))).not.toBeNull();
  });

  it("noise with the configured spread, drawn from the injected generator", () => {
    const detector = new SignDetector(g, { rng: new PythonRandom(1) });
    const truth = signCorners(g, hover(2.0)).pixels;
    const errors: number[] = [];
    const coords: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const obs = detector.detect(hover(2.0))!;
      obs.corners.forEach((c, k) => {
        const du = c[0] - truth[k]![0];
        const dv = c[1] - truth[k]![1];
        errors.push(Math.hypot(du, dv));
        coords.push(du, dv);
      });
    }
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const sd = Math.sqrt(coords.reduce((a, b) => a + b * b, 0) / coords.length);
    expect(Math.abs(sd / DETECTOR_DEFAULTS.corner_noise_px - 1)).toBeLessThan(0.03);
    expect(Math.abs(mean / (DETECTOR_DEFAULTS.corner_noise_px * Math.sqrt(Math.PI / 2)) - 1)).toBeLessThan(0.03);
    // the same seed gives the same detections
    const a = new SignDetector(g, { rng: new PythonRandom(5) }).detect(hover(2.0));
    const b = new SignDetector(g, { rng: new PythonRandom(5) }).detect(hover(2.0));
    expect(fields(a)).toEqual(fields(b));
  });

  it("drops a detection with the configured probability; draws in the documented order", () => {
    const detector = new SignDetector(g, { dropout: 0.25, rng: new PythonRandom(2) });
    let dropped = 0;
    for (let i = 0; i < 4000; i++) {
      if (detector.detect(hover(2.0)) === null) {
        expect(detector.lastMiss).toBe("dropout");
        dropped += 1;
      }
    }
    expect(Math.abs(dropped / 4000 - 0.25)).toBeLessThan(0.03);
    const calls: string[] = [];
    const recording: RandomSource = {
      random: () => (calls.push("random"), 0.9),
      uniform: (a, b) => (calls.push("uniform"), a + (b - a) * 0.5),
      normal: () => (calls.push("normal"), 0.0),
    };
    new SignDetector(g, { dropout: 0.1, rng: recording }).detect(hover(2.0));
    expect(calls).toEqual(["random", ...Array<string>(8).fill("normal")]);
    calls.length = 0;
    new SignDetector(g, { dropout: 0.1, rng: recording }).detect(hover(2.0, [new Actor({ distance_m: 1.0 })]));
    expect(calls).toEqual([]); // nothing is drawn for a sign that is not in view
  });

  it("obstaclesOf stamps the frame's boxes with its time", () => {
    const frame: Frame<null> = { payload: null, timestamp: 1001.5, seq: 3, obstacles: [["person", [0.1, 0.2, 0.3, 0.9]]] };
    const obstacles = obstaclesOf(frame);
    expect(obstacles).toHaveLength(1);
    expect([obstacles[0]!.kind, [...obstacles[0]!.box], obstacles[0]!.ts]).toEqual(["person", [0.1, 0.2, 0.3, 0.9], 1001.5]);
    expect(obstaclesOf({ payload: null, timestamp: 1, seq: 1 })).toEqual([]);
  });
});
