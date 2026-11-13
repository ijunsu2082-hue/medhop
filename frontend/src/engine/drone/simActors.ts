// Ports backend/medhop/drone/sim_actors.py: simulated people and objects in the corridor (experimental
// obstacle avoidance, SPEC section 11), their motion, the scenario table and the bounding boxes each
// frame carries. Checked against Python by simActors.test.ts (fixture: __fixtures__/sim_actors.json,
// backend/tools/parity_traces.py sim_actors) and, through the simulator, by sim.test.ts.
//
// An actor is an upright box standing on the floor: a footprint `width_m` along the wall by `depth_m`
// toward the room, `height_m` tall, centred `x_m` along the wall and `distance_m` from it (the frame of
// sim.py: the wall is z = 0 and the drone flies at z < 0, so an actor's centre is at z = -distance_m).
// It may move at a constant velocity between two times measured from the takeoff (see `Actor.at`).
//
// The boxes are simulator truth: a perfect detector that never misses anything and never sees anything
// that is not there. Real detection (the optional person check) is nothing like that.
//
// Differences from Python: Actor takes one init object with the Python field names (like the
// dataclass's keyword arguments) and `replace` stands in for dataclasses.replace; the scenario table is
// SCENARIO_TABLE (the tuple the Python dict is built from) plus SCENARIOS keyed by name, and
// `scenarioByName` throws KeyError where `SCENARIOS[name]` raises it. draw_actors (drawing) is not
// ported; `actorSilhouette` and `actorDrawOrder` give a renderer what it computes: the convex outline
// of the projected box (in floating point; Python rounds to 1/16 pixel for cv2.fillConvexPoly) and the
// farthest-first order.

import { cameraToPixel, NEAR_M, toCamera, type Camera, type Mat3, type Pixel, type Vec3 } from "../camera/projection";
import { KeyError, pyHypot, pyMax, pyMin, pyRound, pyStrRepr, pyTupleRepr, ValueError } from "../util/num";

export { NEAR_M } from "../camera/projection";

export const ACTOR_KINDS = ["person", "object"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Silhouette colours of the Python renderer (BGR): dark, plain, no texture. */
export const PERSON_BGR = [54, 50, 48] as const;
export const OBJECT_BGR = [74, 82, 88] as const;

/** x1, y1, x2, y2 as fractions of the frame */
export type Box = readonly [x1: number, y1: number, x2: number, y2: number];

/** The dataclass fields, in their Python order (also the order of a fixture row). */
export const ACTOR_FIELDS = [
  "kind",
  "x_m",
  "distance_m",
  "width_m",
  "depth_m",
  "height_m",
  "vx_m_s",
  "vd_m_s",
  "move_from_s",
  "move_until_s",
] as const;

export interface ActorInit {
  /** "person" or "object" */
  kind?: string;
  /** footprint centre along the wall (+ = right, facing the wall) */
  x_m?: number;
  /** footprint centre's distance from the wall */
  distance_m?: number;
  /** along the wall */
  width_m?: number;
  /** toward the room */
  depth_m?: number;
  height_m?: number;
  /** velocity along the wall while moving */
  vx_m_s?: number;
  /** velocity away from the wall while moving */
  vd_m_s?: number;
  /** moves between these times after the takeoff */
  move_from_s?: number;
  move_until_s?: number;
}

/** Actor.as_status(): the actor for the status JSON, lengths rounded to millimetres. */
export interface ActorStatus {
  readonly kind: ActorKind;
  readonly x_m: number;
  readonly distance_m: number;
  readonly width_m: number;
  readonly depth_m: number;
  readonly height_m: number;
}

/** A frozen dataclass in Python: never changed in place; `at` and `replace` return new actors. */
export class Actor {
  readonly kind: ActorKind;
  readonly x_m: number;
  readonly distance_m: number;
  readonly width_m: number;
  readonly depth_m: number;
  readonly height_m: number;
  readonly vx_m_s: number;
  readonly vd_m_s: number;
  readonly move_from_s: number;
  readonly move_until_s: number;

  /** Throws ValueError for an unknown kind or a size that is not positive (Python's __post_init__). */
  constructor(init: ActorInit = {}) {
    const kind = init.kind ?? "person";
    if (!(ACTOR_KINDS as readonly string[]).includes(kind)) {
      throw new ValueError(`actor kind must be one of ${pyTupleRepr(ACTOR_KINDS)}, got ${pyStrRepr(kind)}`);
    }
    this.kind = kind as ActorKind;
    this.x_m = init.x_m ?? 0.0;
    this.distance_m = init.distance_m ?? 1.5;
    this.width_m = init.width_m ?? 0.45;
    this.depth_m = init.depth_m ?? 0.3;
    this.height_m = init.height_m ?? 1.7;
    this.vx_m_s = init.vx_m_s ?? 0.0;
    this.vd_m_s = init.vd_m_s ?? 0.0;
    this.move_from_s = init.move_from_s ?? 0.0;
    this.move_until_s = init.move_until_s ?? 0.0;
    if (pyMin(this.width_m, this.depth_m, this.height_m) <= 0) {
      throw new ValueError("actor width, depth and height must be positive");
    }
  }

  /** dataclasses.replace(actor, ...) */
  replace(changes: ActorInit): Actor {
    return new Actor({ ...this.init(), ...changes });
  }

  /** The fields as an init object. */
  init(): Required<ActorInit> {
    return {
      kind: this.kind,
      x_m: this.x_m,
      distance_m: this.distance_m,
      width_m: this.width_m,
      depth_m: this.depth_m,
      height_m: this.height_m,
      vx_m_s: this.vx_m_s,
      vd_m_s: this.vd_m_s,
      move_from_s: this.move_from_s,
      move_until_s: this.move_until_s,
    };
  }

  /**
   * Where the actor is `sinceTakeoffS` after the takeoff (null: not taken off yet, so it is still at its
   * start). It moves only between move_from_s and move_until_s. Returns this actor when it has not moved.
   */
  at(sinceTakeoffS: number | null): Actor {
    if (sinceTakeoffS === null || this.move_until_s <= this.move_from_s) return this;
    const moved = pyMax(0.0, pyMin(sinceTakeoffS, this.move_until_s) - this.move_from_s);
    if (moved <= 0.0) return this;
    return this.replace({ x_m: this.x_m + this.vx_m_s * moved, distance_m: this.distance_m + this.vd_m_s * moved });
  }

  asStatus(): ActorStatus {
    return {
      kind: this.kind,
      x_m: pyRound(this.x_m, 3),
      distance_m: pyRound(this.distance_m, 3),
      width_m: pyRound(this.width_m, 3),
      depth_m: pyRound(this.depth_m, 3),
      height_m: pyRound(this.height_m, 3),
    };
  }
}

export interface Scenario {
  readonly name: string;
  readonly actors: readonly Actor[];
  /** null: keep the simulator's own start distance */
  readonly start_distance_m: number | null;
  readonly description: string;
}

function scenario(name: string, actors: readonly ActorInit[], startDistanceM: number | null, description: string): Scenario {
  return Object.freeze({
    name,
    actors: Object.freeze(actors.map((a) => new Actor(a))),
    start_distance_m: startDistanceM,
    description,
  });
}

// The one table, mirroring SCENARIOS in sim_actors.py (keep it in step: simActors.test.ts compares it
// with the fixture field by field).
//
// Times are seconds after the takeoff toggle takes effect. An automatic run sends that toggle at the
// end of its 5 s countdown, waits 4 s, and is usually approaching the sign about 4.5 s after the
// toggle; the people below step in a few seconds later, after the sign has grown in the picture (the
// runner's evidence that the drone is flying), from outside the camera's view. The cart stands in the
// lane from the beginning, so a run is refused before takeoff (start blocker obstacle_in_view).
export const SCENARIO_TABLE: readonly Scenario[] = Object.freeze([
  scenario("empty", [], null, "nothing in the corridor"),
  scenario(
    "crossing",
    [{ kind: "person", x_m: -3.6, distance_m: 1.6, vx_m_s: 1.2, move_from_s: 7.0, move_until_s: 13.0 }],
    4.2,
    "a person walks across the corridor about 1.6 m from the wall",
  ),
  scenario(
    "standing",
    [{ kind: "person", x_m: -3.0, distance_m: 1.4, vx_m_s: 1.0, move_from_s: 6.0, move_until_s: 9.0 }],
    4.2,
    "a person steps into the lane about 1.4 m from the wall and stays",
  ),
  scenario(
    "cart",
    [{ kind: "object", x_m: 0.15, distance_m: 1.5, width_m: 0.6, depth_m: 0.4, height_m: 0.9 }],
    4.2,
    "a cart stands in the lane about 1.5 m from the wall: a run is refused before takeoff",
  ),
  scenario(
    "blocked",
    [
      { kind: "person", x_m: -3.5, distance_m: 1.75, vx_m_s: 1.0, move_from_s: 6.5, move_until_s: 9.0 },
      { kind: "person", x_m: 3.5, distance_m: 1.75, vx_m_s: -1.0, move_from_s: 6.5, move_until_s: 9.0 },
      { kind: "person", x_m: -4.0, distance_m: 1.45, vx_m_s: 1.0, move_from_s: 6.5, move_until_s: 10.5 },
    ],
    4.2,
    "three people stand across the corridor: the lane and both sides are blocked",
  ),
]);

/** SCENARIOS: the table keyed by name. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = Object.freeze(
  Object.fromEntries(SCENARIO_TABLE.map((s) => [s.name, s])),
);
export const SCENARIO_NAMES: readonly string[] = Object.freeze(SCENARIO_TABLE.map((s) => s.name));

/** SCENARIOS[name]; throws KeyError for an unknown name (Python's message is the repr of the key). */
export function scenarioByName(name: string): Scenario {
  const found = Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? SCENARIOS[name] : undefined;
  if (found === undefined) throw new KeyError(pyStrRepr(name));
  return found;
}

/** The 8 corners of the actor's box in world coordinates (x, y, z), z = -distance, in Python's order. */
export function corners(actor: Actor): Vec3[] {
  const hw = actor.width_m / 2.0;
  const hd = actor.depth_m / 2.0;
  const xs = [actor.x_m - hw, actor.x_m + hw];
  const zs = [-(actor.distance_m + hd), -(actor.distance_m - hd)];
  const out: Vec3[] = [];
  for (const x of xs) for (const y of [0.0, actor.height_m]) for (const z of zs) out.push([x, y, z]);
  return out;
}

/** Corner index pairs that differ in exactly one coordinate: the 12 edges of the box (Python's _EDGES). */
export const EDGES: readonly (readonly [number, number])[] = (() => {
  const edges: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const x = i ^ j;
      if (x === 1 || x === 2 || x === 4) edges.push([i, j]);
    }
  }
  return edges;
})();

/**
 * The actor's box in camera coordinates (right, down, forward), clipped to forward >= near: the corners
 * in front of the camera plus the points where edges cross the near plane (the vertices of the clipped
 * box, whose projection bounds the box's image exactly).
 */
export function cameraPoints(actor: Actor, position: Vec3, rot: Mat3, near: number = NEAR_M): Vec3[] {
  const pts = corners(actor).map((p) => toCamera(position, rot, p));
  const keep: Vec3[] = pts.filter((p) => p[2] >= near);
  for (const [i, j] of EDGES) {
    const a = pts[i]!;
    const b = pts[j]!;
    if ((a[2] - near) * (b[2] - near) < 0.0) {
      const t = (near - a[2]) / (b[2] - a[2]);
      keep.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return keep;
}

/** Pixel coordinates (u, v) of camera-frame points (all in front of the camera). */
export function project(pointsCam: readonly Vec3[], K: Mat3): Pixel[] {
  return pointsCam.map((p) => cameraToPixel(K, p));
}

/**
 * Bounding box (x1, y1, x2, y2 as fractions of the frame) of the actor as the camera sees it, clipped
 * to the frame. null when it is wholly outside the picture or behind the camera.
 */
export function actorBox(actor: Actor, position: Vec3, rot: Mat3, K: Mat3, width: number, height: number): Box | null {
  const uv = project(cameraPoints(actor, position, rot), K);
  if (uv.length === 0) return null;
  let x1 = uv[0]![0];
  let y1 = uv[0]![1];
  let x2 = x1;
  let y2 = y1;
  for (const [u, v] of uv) {
    // numpy's min/max: a NaN wins; the boxes never hold one in practice
    if (u < x1 || Number.isNaN(u)) x1 = u;
    if (u > x2 || Number.isNaN(u)) x2 = u;
    if (v < y1 || Number.isNaN(v)) y1 = v;
    if (v > y2 || Number.isNaN(v)) y2 = v;
  }
  x1 = pyMax(0.0, x1);
  x2 = pyMin(width, x2);
  y1 = pyMax(0.0, y1);
  y2 = pyMin(height, y2);
  if (x2 - x1 < 0.5 || y2 - y1 < 0.5) return null;
  return [x1 / width, y1 / height, x2 / width, y2 / height];
}

/** The boxes a frame carries: (kind, box rounded to 5 decimals) for each actor in view, in actor order. */
export function actorBoxes(
  actors: readonly Actor[],
  position: Vec3,
  rot: Mat3,
  K: Mat3,
  width: number,
  height: number,
): [kind: ActorKind, box: Box][] {
  const out: [ActorKind, Box][] = [];
  for (const actor of actors) {
    const box = actorBox(actor, position, rot, K, width, height);
    if (box !== null) {
      out.push([actor.kind, [pyRound(box[0], 5), pyRound(box[1], 5), pyRound(box[2], 5), pyRound(box[3], 5)]]);
    }
  }
  return out;
}

/**
 * Horizontal distance (metres) from a point (x along the wall, distance from the wall) to the actor's
 * footprint; 0 inside it. Simulator truth, for tests and the status.
 */
export function footprintDistance(actor: Actor, xM: number, distanceM: number): number {
  const dx = pyMax(Math.abs(xM - actor.x_m) - actor.width_m / 2.0, 0.0);
  const dz = pyMax(Math.abs(distanceM - actor.distance_m) - actor.depth_m / 2.0, 0.0);
  return pyHypot(dx, dz);
}

// ---------------------------------------------------------------------------------------------- //
// for a renderer and the synthetic detector (draw_actors computes these before it fills)

/** 2-D convex hull (Andrew's monotone chain), counter-clockwise in pixel coordinates, no repeated point. */
export function convexHull(points: readonly Pixel[]): Pixel[] {
  const pts = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length <= 2) return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
  const cross = (o: Pixel, a: Pixel, b: Pixel): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pixel[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pixel[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * The actor's silhouette in the picture: the convex outline of its near-clipped, projected box, as
 * draw_actors fills it. Fewer than 3 points (or none) when too little of it is in front of the camera;
 * draw_actors then draws nothing.
 */
export function actorSilhouette(actor: Actor, camera: Camera): Pixel[] {
  const pts = cameraPoints(actor, camera.position, camera.rot);
  if (pts.length < 3) return [];
  return convexHull(project(pts, camera.K));
}

/** Indices of `actors` in draw_actors' order: farthest first (horizontal distance of the footprint centre). */
export function actorDrawOrder(actors: readonly Actor[], position: Vec3): number[] {
  const depth = actors.map((a) => pyHypot(a.x_m - position[0], 0.0, -a.distance_m - position[2]));
  return actors.map((_, i) => i).sort((i, j) => depth[j]! - depth[i]!);
}
