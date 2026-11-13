// Replays __fixtures__/sim_harness.json (backend/tools/parity_traces.py sim_harness) through
// simHarness.ts.
//
// Python side: the real SimHarness.step of backend/tests/harness.py (simulator noise at zero, the
// picture a tiny grey JPEG), with two stand-ins: for MarkerDetector, the frame's true corners through
// MarkerDetector's own arithmetic (no detection when hidden, behind the camera or outside the frame:
// the synthetic detector here with no noise, no dropout, no edge margin and no hiding); for the runner,
// a script that takes off once and steers at the marker through the mixer. The runner hook here runs
// the same script. Every runner call (time, the observation with marker and obstacles, the pose after
// it), every mixer tick and the dropout draws (random.Random, reproduced by PythonRandom) must match.
import { describe, expect, it } from "vitest";
import { clamp } from "../util/num";
import type { Observation } from "../vision/marker";
import { assertNoMismatches, compareValues, loadFixture, PARITY, ParityStats } from "./fixtures";
import { SimHarness, WALL_EPOCH } from "./simHarness";
import { configFromFixture } from "./simFixtures";
import { Actor } from "../drone/simActors";
import { makeSimConfig } from "../drone/sim";

interface HarnessCase {
  name: string;
  profile: string;
  config: Record<string, unknown>;
  marker_dropout: number;
  dropout_seed: number;
  seconds: number;
  takeoff_after: number | null;
  runner_calls: unknown[][];
  sent: [number, number[]][];
  observations: number;
  end_clock: number;
}

interface HarnessFixture {
  physics_dt: number;
  control_dt: number;
  cases: HarnessCase[];
}

const fx = loadFixture<HarnessFixture>("sim_harness");
const POSE_KEYS = ["x_m", "distance_m", "heading_deg", "altitude_m", "phase", "airborne"] as const;

function obsRow(obs: Observation): Record<string, unknown> {
  const m = obs.marker;
  return {
    ts: obs.ts,
    seq: obs.seq,
    brightness: obs.brightness,
    marker: m === null ? null : [m.cx, m.cy, m.width, m.height, m.ts],
    obstacles: obs.obstacles.map((o) => [o.kind, [...o.box], o.ts]),
  };
}

function brightnessOf(case_: HarnessCase): number {
  const row = case_.runner_calls.find((call) => call[1] !== null);
  return (row![1] as { brightness: number }).brightness;
}

describe("SimHarness against tests/harness.py", () => {
  it("constants", () => {
    expect(SimHarness.PHYSICS_DT).toBe(fx.physics_dt);
    expect(SimHarness.CONTROL_DT).toBe(fx.control_dt);
  });

  for (const case_ of fx.cases) {
    it(`${case_.name}: ${case_.runner_calls.length} runner calls, ${case_.sent.length} mixer ticks`, () => {
      const h = new SimHarness({
        simConfig: configFromFixture(case_.profile, case_.config),
        detector: { corner_noise_px: 0, dropout: 0, edge_margin_px: 0, hide_margin_px: null },
        markerDropout: case_.marker_dropout,
        dropoutSeed: case_.dropout_seed,
        brightness: () => brightnessOf(case_),
      });
      let takeoffAt = case_.takeoff_after === null ? null : h.clock.t + case_.takeoff_after;
      const calls: unknown[][] = [];
      h.onObservation = (obs, now) => {
        let toggled: boolean | null = null;
        if (takeoffAt !== null && now >= takeoffAt) {
          takeoffAt = null;
          toggled = h.mixer.missionToggle(now, false);
        }
        if (obs !== null && obs.marker !== null) {
          const m = obs.marker;
          h.mixer.missionCommand(clamp(1.2 * (m.cx - 0.5)), clamp(2.0 * (0.14 - m.size)), now);
        }
        const pose = h.sim.pose();
        const row: unknown[] = [now, obs === null ? null : obsRow(obs), POSE_KEYS.map((k) => pose[k])];
        if (toggled !== null) row.push(toggled);
        calls.push(row);
      };
      h.run(case_.seconds);
      const stats = new ParityStats();
      const got = {
        runner_calls: calls,
        sent: h.sent.map(([t, axes]) => [t, [...axes]]),
        observations: h.observations.length,
        end_clock: h.clock.t,
      };
      const want = {
        runner_calls: case_.runner_calls,
        sent: case_.sent,
        observations: case_.observations,
        end_clock: case_.end_clock,
      };
      assertNoMismatches(compareValues(got, want, PARITY, case_.name, stats), case_.name);
      console.log(stats.summary(case_.name));
      // the trace is worth something: markers, misses, null steps, obstacles and a flight toward the sign
      const observed = calls.filter((c) => c[1] !== null).map((c) => c[1] as { marker: unknown; obstacles: unknown[] });
      expect(observed.some((o) => o.marker !== null)).toBe(true);
      expect(calls.some((c) => c[1] === null)).toBe(true);
      if (case_.marker_dropout > 0) expect(observed.some((o) => o.marker === null)).toBe(true);
      if (case_.name.includes("ground")) expect(observed.some((o) => o.obstacles.length > 0)).toBe(true);
      const last = calls[calls.length - 1]![2] as unknown[];
      expect(last[4]).toBe("airborne");
    });
  }
});

describe("SimHarness shell", () => {
  it("calls the runner hook once per new frame and with null every 0.05 s between frames", () => {
    const h = new SimHarness();
    const calls: [Observation | null, number][] = [];
    h.onObservation = (obs, now) => calls.push([obs, now]);
    h.warmUp(2.0);
    const seqs = calls.filter(([obs]) => obs !== null).map(([obs]) => obs!.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // every frame, in order, once
    expect(seqs.length).toBeGreaterThanOrEqual(24); // 15 fps after the 0.35 s video delay
    for (let i = 1; i < calls.length; i++) {
      const gap = calls[i]![1] - calls[i - 1]![1];
      expect(gap).toBeLessThan(0.05 + SimHarness.PHYSICS_DT + 1e-9);
    }
    expect(h.sent.length).toBe(41); // 20 Hz for 2 s, counting both ends (as Python's step does)
    expect(h.wall()).toBe(WALL_EPOCH + h.clock.t);
    expect(h.lastSent()).toEqual([0, 0, 0, 0]);
  });

  it("a toy runner flies the default drone-like profile to the sign through the synthetic detector", () => {
    const h = new SimHarness({ simConfig: makeSimConfig({ seed: 3, start_airborne: true, start_heading_deg: 15 }) });
    let width = 0;
    h.onObservation = (obs, now) => {
      if (obs?.marker) {
        width = obs.marker.width;
        h.mixer.missionCommand(clamp(1.5 * (obs.marker.cx - 0.5)), clamp(3.0 * (0.2 - obs.marker.size)), now);
      }
    };
    h.warmUp(1.0);
    const arrived = h.run(30.0, () => width > 0.19);
    expect(arrived).toBe(true);
    // a 0.19 frame-width marker is 0.68 m away by the pinhole model; the video is 0.45 s behind
    expect(h.sim.pose().distance_m).toBeLessThan(0.8);
    expect(Math.abs(h.sim.pose().x_m)).toBeLessThan(0.25);
  });

  it("observations carry the actors' boxes; a person in front hides the sign", () => {
    const person = new Actor({ x_m: 0.0, distance_m: 1.2 });
    const h = new SimHarness({ simConfig: makeSimConfig({ seed: 0, start_airborne: true, actors: [person] }) });
    h.warmUp(1.0);
    const obs = h.observations[h.observations.length - 1]!;
    expect(obs.obstacles.map((o) => o.kind)).toEqual(["person"]);
    expect(obs.obstacles[0]!.ts).toBe(obs.ts);
    expect(obs.marker).toBeNull();
    expect(h.detector.lastMiss).toBe("covered");
  });
});
