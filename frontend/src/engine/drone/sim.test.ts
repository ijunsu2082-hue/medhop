// Replays __fixtures__/sim_physics.json (backend/tools/parity_traces.py sim_physics) through sim.ts.
//
// Every scenario drives the Python SimLink (stepped, or realtime with an injected clock) with the
// simulator's noise at zero, the picture patched out, on a fake clock from 1000 s; the same ops are
// applied here. After every op: the pose, what the op returned, every new capture (time and snapshot),
// the newest released frame when it is new (seq, release time, which capture it shows, its actor
// boxes) and the telemetry when it changed must match, within 1e-9 relative (the physics goes through
// exp, sin and cos, whose last bit may differ between the C library and V8). Integers and strings exactly.
import { describe, expect, it } from "vitest";
import { FakeClock } from "../testing/harness";
import { assertNoMismatches, compareValues, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import { actorFromRow, actorRow, configFromFixture, snapList, snapRow } from "../testing/simFixtures";
import { MemoryLogger } from "../util/log";
import { KeyError, ValueError } from "../util/num";
import { PythonRandom } from "../util/rng";
import {
  AIRBORNE,
  GROUND,
  highQualitySimConfig,
  makeSimConfig,
  PHYSICS_STEP_S,
  SimLink,
  type SimPose,
  type SimSnapshot,
} from "./sim";
import { Actor, SCENARIOS } from "./simActors";

interface Step {
  dt?: number;
  op?: string;
  [key: string]: unknown;
  pose: unknown[];
  out?: unknown;
  captures?: unknown[][] | { count: number; last: number };
  frame?: [number, number, number, [string, number[]][]];
  tel?: [number, number, number, number];
}

interface Scenario {
  name: string;
  profile: string;
  config: Record<string, unknown>;
  realtime: boolean;
  snapshots: boolean;
  steps: Step[];
  end: Record<string, unknown>;
}

interface PhysicsFixture {
  pose_keys: string[];
  quiet: Record<string, number>;
  physics_step_s: number;
  scenarios: Scenario[];
}

const fx = loadFixture<PhysicsFixture>("sim_physics");

function poseRow(pose: SimPose): unknown[] {
  const record = pose as unknown as Record<string, unknown>;
  return fx.pose_keys.map((key) => record[key]);
}

function poseDict(pose: SimPose): Record<string, unknown> {
  return { ...pose };
}

function applyOp(step: Step, sim: SimLink, clock: FakeClock): unknown {
  if (step.dt !== undefined) {
    sim.advanceTo(clock.advance(step.dt));
    return undefined;
  }
  switch (step.op) {
    case "axes": {
      const [t, y, p, r] = step["v"] as [number, number, number, number];
      sim.setAxes(t, y, p, r);
      return undefined;
    }
    case "toggle":
      return sim.takeoffLandToggle();
    case "estop":
      return sim.emergencyStop();
    case "calibrate":
      sim.calibrate();
      return undefined;
    case "stop":
      sim.stop();
      return undefined;
    case "start":
      sim.start();
      return undefined;
    case "set_pose":
      sim.setPose(step["kw"] as Parameters<SimLink["setPose"]>[0]);
      return undefined;
    case "force_auto_land":
      sim.forceAutoLand((step["drop_battery"] as boolean | undefined) ?? false, (step["descent_m_s"] as number | undefined) ?? null);
      return undefined;
    case "freeze_video":
      sim.freezeVideo(step["frozen"] as boolean);
      return undefined;
    case "drop_marker":
      sim.dropMarker(step["hidden"] as boolean);
      return undefined;
    case "set_drift":
      sim.setDrift(step["v"] as number);
      return undefined;
    case "set_battery_raw":
      sim.setBatteryRaw(step["v"] as number);
      return undefined;
    case "set_scenario":
      try {
        sim.setScenario(step["name"] as string);
      } catch (error) {
        if (error instanceof KeyError) return { error: "KeyError" };
        throw error;
      }
      return undefined;
    case "set_actors":
      sim.setActors((step["actors"] as unknown[][]).map(actorFromRow), (step["origin_now"] as boolean | undefined) ?? true);
      return undefined;
    case "pose":
      return poseDict(sim.pose());
    case "clearance":
      return sim.clearanceM();
    case "actors_now":
      return sim.actorsNow().map(actorRow);
    case "status":
      return sim.actorsNow().map((a) => ({ ...a.asStatus() }));
    case "scenario":
      return sim.scenario;
    case "test_snapshot": {
      const [d, x, h] = step["args"] as [number, number, number];
      return snapRow(sim.testSnapshot(d, x, h));
    }
    default:
      throw new Error(`unknown op ${String(step.op)}`);
  }
}

function runScenario(scenario: Scenario, stats: ParityStats): void {
  const clock = new FakeClock(1000.0);
  const captures: SimSnapshot[] = [];
  const sim = new SimLink(configFromFixture(scenario.profile, scenario.config), {
    clock: clock.now,
    realtime: scenario.realtime,
    onCapture: (snap) => captures.push(snap),
  });
  let nCaptures = 0;
  let lastSeq: number | null = null;
  let lastTel: unknown[] | null = null;
  scenario.steps.forEach((step, i) => {
    const label = `${scenario.name}[${i}] ${step.op ?? `advance ${step.dt}`}`;
    const out = applyOp(step, sim, clock);
    const actual: Record<string, unknown> = { pose: poseRow(sim.pose()) };
    const expected: Record<string, unknown> = { pose: step.pose };
    if (step.out !== undefined || out !== undefined) {
      actual["out"] = out ?? null;
      expected["out"] = step.out ?? null;
    }
    if (captures.length > nCaptures) {
      const fresh = captures.slice(nCaptures);
      actual["captures"] = scenario.snapshots
        ? fresh.map((s) => [s.t, ...snapList(s)])
        : { count: fresh.length, last: fresh[fresh.length - 1]!.t };
      nCaptures = captures.length;
    }
    if (step.captures !== undefined) expected["captures"] = step.captures;
    const frame = sim.latestFrame();
    if (frame !== null && frame.seq !== lastSeq) {
      lastSeq = frame.seq;
      actual["frame"] = [
        frame.seq,
        frame.timestamp,
        captures.indexOf(frame.payload),
        (frame.obstacles ?? []).map(([kind, box]) => [kind, [...box]]),
      ];
    }
    if (step.frame !== undefined) expected["frame"] = step.frame;
    const tel = sim.telemetry();
    if (tel !== null) {
      const row = [tel.fly_state_raw, tel.battery_raw, tel.flags_raw, tel.timestamp];
      if (lastTel === null || row.some((v, k) => v !== lastTel![k])) {
        lastTel = row;
        actual["tel"] = row;
      }
    }
    if (step.tel !== undefined) expected["tel"] = step.tel;
    assertNoMismatches(compareValues(actual, expected, PARITY, label, stats), label);
  });
  const end = {
    toggle_count: sim.toggleCount,
    estop_count: sim.estopCount,
    calibrate_count: sim.calibrateCount,
    last_axes_sent: [...sim.lastAxesSent],
    scenario: sim.scenario,
    start_distance_m: sim.cfg.start_distance_m,
    lateral_drift: sim.cfg.lateral_drift,
  };
  assertNoMismatches(compareValues(end, scenario.end, PARITY, `${scenario.name} end`, stats), `${scenario.name} end`);
}

describe("SimLink against sim.py (stepped, noise at zero)", () => {
  it("the fixture covers what it claims", () => {
    expect(fx.physics_step_s).toBe(PHYSICS_STEP_S);
    expect(fx.quiet).toEqual({ noise_velocity: 0.0, noise_yaw_deg: 0.0, sensor_noise: 0.0 });
    const steps = fx.scenarios.flatMap((s) => s.steps);
    const phases = new Set(steps.map((s) => s.pose[4]));
    expect(phases).toEqual(new Set(["ground", "taking_off", "airborne", "landing"]));
    const ops = new Set(steps.map((s) => s.op).filter((op) => op !== undefined));
    for (const op of ["toggle", "estop", "set_pose", "force_auto_land", "freeze_video", "drop_marker", "set_scenario", "set_actors"]) {
      expect(ops.has(op), op).toBe(true);
    }
    expect(steps.some((s) => (s.frame?.[3].length ?? 0) > 0)).toBe(true); // frames with actor boxes
    expect(fx.scenarios.some((s) => s.realtime)).toBe(true);
    expect(fx.scenarios.map((s) => s.profile)).toEqual(expect.arrayContaining(["drone", "high"]));
  });

  for (const scenario of fx.scenarios) {
    it(`${scenario.name}: ${scenario.steps.length} steps`, () => {
      const stats = new ParityStats();
      runScenario(scenario, stats);
      console.log(stats.summary(scenario.name));
    });
  }
});

describe("SimLink behaviour", () => {
  it("config defaults and the display profile", () => {
    const c = makeSimConfig();
    expect([c.width, c.height, c.fps, c.hfov_deg, c.jpeg_quality, c.sensor_noise, c.blur_sigma]).toEqual([640, 360, 15, 70, 50, 6, 0.8]);
    expect([c.scene, c.supersample, c.vignette, c.start_distance_m]).toEqual(["plain", 1, 0, 2.5]);
    const h = highQualitySimConfig({ start_distance_m: 3.2, marker_id: 9 });
    expect([h.width, h.height, h.fps, h.jpeg_quality, h.scene, h.supersample, h.blur_sigma]).toEqual([1280, 720, 15, 92, "room", 2, 0]);
    expect([h.start_distance_m, h.marker_id]).toEqual([3.2, 9]);
    expect(makeSimConfig().width).toBe(640);
  });

  it("refuses an unknown scene and an unknown scenario", () => {
    const clock = new FakeClock();
    expect(() => new SimLink(makeSimConfig({ scene: "garden" }), { clock: clock.now })).toThrow(ValueError);
    expect(() => new SimLink(makeSimConfig({ scene: "garden" }), { clock: clock.now })).toThrow(
      "SimConfig.scene must be 'plain' or 'room', got 'garden'",
    );
    const sim = new SimLink(makeSimConfig(), { clock: clock.now });
    expect(() => sim.setScenario("nope")).toThrow(KeyError);
  });

  it("copies the config: set_drift and setScenario do not change the caller's object", () => {
    const clock = new FakeClock();
    const config = makeSimConfig();
    const sim = new SimLink(config, { clock: clock.now });
    sim.setDrift(0.3);
    sim.setScenario("crossing");
    expect([config.lateral_drift, config.start_distance_m]).toEqual([0.08, 2.5]);
    expect([sim.cfg.lateral_drift, sim.cfg.start_distance_m]).toEqual([0.3, 4.2]);
  });

  it("a frame's payload is the snapshot captured video_delay_s before it is released", () => {
    const clock = new FakeClock();
    const sim = new SimLink(makeSimConfig({ start_airborne: true, actors: [new Actor({ x_m: 0.3, distance_m: 1.5 })] }), {
      clock: clock.now,
    });
    for (let i = 0; i < 60; i++) sim.advanceTo(clock.advance(1 / 60));
    const frame = sim.latestFrame()!;
    expect(frame.timestamp - frame.payload.t).toBeCloseTo(0.35, 12);
    expect(frame.payload.actors).toHaveLength(1);
    expect(frame.obstacles).toHaveLength(1);
    expect(frame.obstacles![0]![0]).toBe("person");
  });

  it("logs the scenario like Python", () => {
    const clock = new FakeClock();
    const logger = new MemoryLogger();
    const sim = new SimLink(makeSimConfig(), { clock: clock.now, logger });
    sim.setScenario("blocked");
    expect(logger.entries).toEqual([["info", "simulator scenario: blocked (3 actors)"]]);
    expect(SCENARIOS["blocked"]!.actors).toHaveLength(3);
  });

  it("with noise on, the drone wanders but stays deterministic for a seed", () => {
    const run = (seed: number): SimPose => {
      const clock = new FakeClock();
      const sim = new SimLink(makeSimConfig({ start_airborne: true, lateral_drift: 0 }), {
        clock: clock.now,
        rng: new PythonRandom(seed),
      });
      for (let i = 0; i < 600; i++) sim.advanceTo(clock.advance(1 / 60));
      return sim.pose();
    };
    const a = run(1);
    expect(run(1)).toEqual(a);
    expect(run(2)).not.toEqual(a);
    expect(Math.abs(a.x_m)).toBeGreaterThan(0); // the noise moved it
    expect(Math.abs(a.x_m)).toBeLessThan(0.5);
    expect(a.phase).toBe(AIRBORNE);
  });

  it("an e-stop sent on the ground keeps it there; the start pose is restored on takeoff when asked", () => {
    const clock = new FakeClock();
    const sim = new SimLink(makeSimConfig({ reset_pose_on_takeoff: true, start_distance_m: 3.0 }), { clock: clock.now });
    sim.advanceTo(clock.t);
    sim.setPose({ distance_m: 1.0, x_m: 1.0 });
    sim.takeoffLandToggle();
    for (let i = 0; i < 12; i++) sim.advanceTo(clock.advance(1 / 60));
    expect(sim.pose().distance_m).toBe(3.0);
    expect(sim.pose().x_m).toBe(0.0);
    sim.emergencyStop();
    for (let i = 0; i < 12; i++) sim.advanceTo(clock.advance(1 / 60));
    expect(sim.pose().phase).toBe(GROUND);
  });
});
