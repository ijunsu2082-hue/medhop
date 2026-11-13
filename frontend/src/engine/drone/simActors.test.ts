// Replays __fixtures__/sim_actors.json (backend/tools/parity_traces.py sim_actors) through simActors.ts
// and, for the boxes frames carry, through sim.ts: the scenario table field by field, actor motion,
// as_status, the constructor's errors, footprint distances, box corners, the near-plane clip
// (camera_points), the projected points and boxes at random camera poses for both frame sizes, and the
// boxes the simulator's own frames carry while the actors of every scenario move. Motion, status and
// footprints are plain arithmetic and bit-identical; the projections go through sin and cos (1e-9).
import { describe, expect, it } from "vitest";
import { cameraExtrinsics, cameraMatrix, makeCamera } from "../camera/projection";
import { FakeClock } from "../testing/harness";
import { assertNoMismatches, BIT_EXACT, compareValues, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import { actorFromRow, actorRow, configFromFixture, snapList } from "../testing/simFixtures";
import { KeyError, ValueError } from "../util/num";
import { SimLink } from "./sim";
import {
  Actor,
  ACTOR_FIELDS,
  ACTOR_KINDS,
  actorBox,
  actorBoxes,
  actorDrawOrder,
  actorSilhouette,
  cameraPoints,
  corners,
  footprintDistance,
  NEAR_M,
  project,
  SCENARIO_NAMES,
  SCENARIO_TABLE,
  scenarioByName,
  SCENARIOS,
  type ActorInit,
} from "./simActors";

interface SnapRow {
  x: number;
  z: number;
  heading: number;
  cam_y: number;
  marker_hidden: boolean;
  actors: unknown[][];
}

interface ActorsFixture {
  actor_fields: string[];
  kinds: string[];
  near_m: number;
  scenario_names: string[];
  scenarios: { name: string; start_distance_m: number | null; description: string; actors: unknown[][] }[];
  motion: { scenario: string; index: number; actor?: unknown[]; at: [number | null, number, number][] }[];
  status: { actor: unknown[]; out: Record<string, unknown> }[];
  errors: { init: ActorInit; error: string | null }[];
  footprint: { actor: unknown[]; x_m: number; distance_m: number; out: number }[];
  corners: { actor: unknown[]; out: number[][] }[];
  boxes: {
    snap: SnapRow;
    width: number;
    height: number;
    actors: { camera_points: number[][]; uv: number[][]; box: number[] | null }[];
    boxes: [string, number[]][];
  }[];
  frames: {
    profile: string;
    scenario: string;
    rows: { set_pose: [number, number, number]; seq: number | null; snap?: unknown[]; obstacles?: [string, number[]][] }[];
  }[];
}

const fx = loadFixture<ActorsFixture>("sim_actors");

describe("sim_actors.py data", () => {
  it("the scenario table is Python's, field by field", () => {
    expect([...ACTOR_FIELDS]).toEqual(fx.actor_fields);
    expect([...ACTOR_KINDS]).toEqual(fx.kinds);
    expect(NEAR_M).toBe(fx.near_m);
    expect([...SCENARIO_NAMES]).toEqual(fx.scenario_names);
    const ours = SCENARIO_TABLE.map((s) => ({
      name: s.name,
      start_distance_m: s.start_distance_m,
      description: s.description,
      actors: s.actors.map(actorRow),
    }));
    assertNoMismatches(compareValues(ours, fx.scenarios, BIT_EXACT), "scenario table");
    for (const s of SCENARIO_TABLE) expect(scenarioByName(s.name)).toBe(SCENARIOS[s.name]);
    expect(() => scenarioByName("toString")).toThrow(KeyError);
  });

  it("motion over time (Actor.at), bit-identical", () => {
    const stats = new ParityStats();
    for (const case_ of fx.motion) {
      const actor = case_.actor ? actorFromRow(case_.actor) : SCENARIOS[case_.scenario]!.actors[case_.index]!;
      const got = case_.at.map(([t]) => {
        const moved = actor.at(t);
        return [t, moved.x_m, moved.distance_m];
      });
      assertNoMismatches(compareValues(got, case_.at, BIT_EXACT, `${case_.scenario}[${case_.index}]`, stats), "motion");
    }
    expect(stats.bitExact).toBe(stats.floats);
  });

  it("as_status, the constructor's checks and footprint distances", () => {
    for (const s of fx.status) {
      assertNoMismatches(compareValues({ ...actorFromRow(s.actor).asStatus() }, s.out, BIT_EXACT), "status");
    }
    for (const e of fx.errors) {
      if (e.error === null) {
        expect(() => new Actor(e.init)).not.toThrow();
      } else {
        expect(() => new Actor(e.init)).toThrow(ValueError);
        expect(() => new Actor(e.init)).toThrow(e.error);
      }
    }
    for (const f of fx.footprint) {
      expect(footprintDistance(actorFromRow(f.actor), f.x_m, f.distance_m)).toBe(f.out);
    }
    for (const c of fx.corners) {
      assertNoMismatches(compareValues(corners(actorFromRow(c.actor)), c.out, BIT_EXACT), "corners");
    }
  });
});

describe("boxes through the simulator's camera", () => {
  it(`camera_points, project, actor_box and actor_boxes: ${fx.boxes.length} random poses`, () => {
    const stats = new ParityStats();
    let crossings = 0;
    fx.boxes.forEach((case_, i) => {
      const { position, rot } = cameraExtrinsics(case_.snap);
      const K = cameraMatrix(case_.width, case_.height, 70.0);
      const actors = case_.snap.actors.map(actorFromRow);
      const got = {
        actors: actors.map((a) => {
          const pts = cameraPoints(a, position, rot);
          if (pts.length !== 8 || pts.some((p) => p[2] < NEAR_M)) crossings += 1;
          return { camera_points: pts, uv: project(pts, K), box: actorBox(a, position, rot, K, case_.width, case_.height) };
        }),
        boxes: actorBoxes(actors, position, rot, K, case_.width, case_.height),
      };
      const want = { actors: case_.actors, boxes: case_.boxes };
      assertNoMismatches(compareValues(got, want, PARITY, `boxes[${i}]`, stats), `boxes[${i}]`);
    });
    expect(crossings).toBeGreaterThan(5); // boxes that cross the near plane are covered
    console.log(stats.summary("boxes"));
  });

  for (const group of fx.frames) {
    it(`frames carry the boxes: ${group.profile} ${group.scenario}`, () => {
      const stats = new ParityStats();
      const clock = new FakeClock();
      const config = configFromFixture(group.profile, {
        noise_velocity: 0.0,
        noise_yaw_deg: 0.0,
        sensor_noise: 0.0,
        start_airborne: true,
        start_distance_m: 3.5,
      });
      const sim = new SimLink(config, { clock: clock.now });
      sim.setScenario(group.scenario);
      group.rows.forEach((row, k) => {
        const [d, x, h] = row.set_pose;
        sim.setPose({ distance_m: d, x_m: x, heading_deg: h });
        sim.advanceTo(clock.advance(0.5));
        const frame = sim.latestFrame();
        const got: Record<string, unknown> = { set_pose: row.set_pose, seq: frame?.seq ?? null };
        if (frame !== null) {
          got["snap"] = snapList(frame.payload);
          got["obstacles"] = (frame.obstacles ?? []).map(([kind, box]) => [kind, [...box]]);
        }
        assertNoMismatches(compareValues(got, row, PARITY, `${group.scenario}[${k}]`, stats), `${group.scenario}[${k}]`);
      });
    });
  }

  it("the fixture's frames see every scenario's actors at some point", () => {
    for (const name of SCENARIO_NAMES.filter((n) => SCENARIOS[n]!.actors.length > 0)) {
      const rows = fx.frames.filter((g) => g.scenario === name).flatMap((g) => g.rows);
      expect(rows.some((r) => (r.obstacles ?? []).length > 0), name).toBe(true);
    }
  });
});

describe("renderer helpers", () => {
  it("the silhouette is the hull of the box's projection, with the same extent", () => {
    const camera = makeCamera({ x: 0.2, z: -3.0, heading: 0.1, cam_y: 1.04 }, { width: 1280, height: 720, hfov_deg: 70 });
    const actor = new Actor({ kind: "object", x_m: 0.15, distance_m: 1.5, width_m: 0.6, depth_m: 0.4, height_m: 0.9 });
    const hull = actorSilhouette(actor, camera);
    expect(hull.length).toBeGreaterThanOrEqual(4);
    const uv = project(cameraPoints(actor, camera.position, camera.rot), camera.K);
    const extent = (pts: readonly (readonly [number, number])[]): number[] => [
      Math.min(...pts.map((p) => p[0])),
      Math.min(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[1])),
    ];
    expect(extent(hull)).toEqual(extent(uv));
    // actorBox is that extent clipped to the frame, as fractions
    const box = actorBox(actor, camera.position, camera.rot, camera.K, 1280, 720)!;
    const [x1, y1, x2, y2] = extent(uv) as [number, number, number, number];
    expect(box).toEqual([Math.max(0, x1) / 1280, Math.max(0, y1) / 720, Math.min(1280, x2) / 1280, Math.min(720, y2) / 720]);
    // behind the camera: nothing to draw
    expect(actorSilhouette(new Actor({ distance_m: 5.0 }), camera)).toEqual([]);
  });

  it("draw order is farthest first", () => {
    const actors = [new Actor({ distance_m: 1.0 }), new Actor({ distance_m: 2.0 }), new Actor({ x_m: 3.0, distance_m: 1.0 })];
    expect(actorDrawOrder(actors, [0.0, 1.0, -3.0])).toEqual([2, 0, 1]);
  });

  it("an actor is immutable: at() and replace() return new ones", () => {
    const a = SCENARIOS["crossing"]!.actors[0]!;
    const later = a.at(10.0);
    expect(later).not.toBe(a);
    expect(a.x_m).toBe(-3.6);
    expect(later.x_m).toBeCloseTo(-3.6 + 1.2 * 3.0, 12);
    expect(a.at(null)).toBe(a);
    expect(() => a.replace({ height_m: 0 })).toThrow("actor width, depth and height must be positive");
  });
});
