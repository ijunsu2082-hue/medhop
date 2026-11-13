// Ports the pinhole camera of backend/medhop/drone/sim.py (SimLink._camera and the camera matrix K that
// _build_plain_scene and _build_room_scene build) and backend/medhop/drone/sim_actors.py `project`.
// sim_scene.py's RoomRenderer renders with the same geometry (its supersampled K is shifted so that the
// output picture has exactly this K), so this one model covers both camera profiles. Checked against
// Python by projection.test.ts (fixture: __fixtures__/projection.json, backend/tools/parity_traces.py
// projection).
//
// World frame (sim.py): the station wall is the plane z = 0, x runs along the wall (positive to the
// right when facing it), y is up from the floor. The drone flies at z < 0. Heading 0 faces the wall;
// positive heading is a turn to the right. The camera is level (no pitch, no roll).
//
// Camera frame: x right, y down, z forward (depth). A world point P is at rot @ (P - position).
//
// Pixels follow OpenCV: integer coordinates are pixel CENTRES, so (0, 0) is the centre of the top-left
// pixel and the principal point (width / 2, height / 2) is half a pixel right of and below the middle
// of the picture. A canvas whose (0, 0) is the top-left corner of the top-left pixel draws a projected
// point at (u + 0.5, v + 0.5). The marker detector reports corners in the same pixel-centre convention.
//
// No dependency on the simulator class: a canvas renderer can import this module on its own.
//
// Differences from Python: the polygon near-plane clip has no Python original (the Python renderer clips
// with warpPerspective and column masks); it is Sutherland-Hodgman with the crossing points computed as
// sim_actors.camera_points computes them, checked against a reference in the tool. Matrix products are
// written out term by term in numpy's order; numpy may use fused multiply-adds inside BLAS, so results
// agree with Python to rounding (about 1e-15 relative), not bit for bit.

import { radians } from "../util/num";

export type Vec3 = readonly [x: number, y: number, z: number];
/** A pixel position (u, v), pixel-centre convention. */
export type Pixel = readonly [u: number, v: number];
export type Mat3 = readonly [Vec3, Vec3, Vec3];

/** sim_actors.NEAR_M: points closer to the camera than this are clipped away. */
export const NEAR_M = 0.05;

/** The camera's place, with the snapshot keys of sim.py (`_snapshot()`): x, z, heading (radians), cam_y. */
export interface CameraPose {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly cam_y: number;
}

/** Frame size and lens. SimConfig carries these fields (width, height, hfov_deg). */
export interface Lens {
  readonly width: number;
  readonly height: number;
  readonly hfov_deg: number;
}

/** A posed camera: everything needed to project, computed once per frame. */
export interface Camera {
  readonly width: number;
  readonly height: number;
  readonly focal: number;
  readonly K: Mat3;
  /** world position of the camera: (x, cam_y, z) */
  readonly position: Vec3;
  /** rows: camera right, image down, camera forward, in world coordinates */
  readonly rot: Mat3;
}

/** SimLink._focal: (width / 2) / tan(radians(hfov_deg) / 2), in pixels. */
export function focalLength(width: number, hfovDeg: number): number {
  return width / 2.0 / Math.tan(radians(hfovDeg) / 2.0);
}

/** SimLink._K: [[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]]. */
export function cameraMatrix(width: number, height: number, hfovDeg: number): Mat3 {
  const f = focalLength(width, hfovDeg);
  return [
    [f, 0.0, width / 2.0],
    [0.0, f, height / 2.0],
    [0.0, 0.0, 1.0],
  ];
}

/** SimLink._camera(snap): the camera's world position and rotation. */
export function cameraExtrinsics(pose: CameraPose): { position: Vec3; rot: Mat3 } {
  const sinH = Math.sin(pose.heading);
  const cosH = Math.cos(pose.heading);
  return {
    position: [pose.x, pose.cam_y, pose.z],
    rot: [
      [cosH, 0.0, -sinH], // camera right
      [0.0, -1.0, 0.0], // image down
      [sinH, 0.0, cosH], // camera forward
    ],
  };
}

/** A camera at `pose` with `lens`. */
export function makeCamera(pose: CameraPose, lens: Lens): Camera {
  const { position, rot } = cameraExtrinsics(pose);
  return {
    width: lens.width,
    height: lens.height,
    focal: focalLength(lens.width, lens.hfov_deg),
    K: cameraMatrix(lens.width, lens.height, lens.hfov_deg),
    position,
    rot,
  };
}

/** rot @ (p - position), as numpy's `(p - cam) @ rot.T`. */
export function toCamera(position: Vec3, rot: Mat3, p: Vec3): Vec3 {
  const d0 = p[0] - position[0];
  const d1 = p[1] - position[1];
  const d2 = p[2] - position[2];
  const row = (r: Vec3): number => d0 * r[0] + d1 * r[1] + d2 * r[2];
  return [row(rot[0]), row(rot[1]), row(rot[2])];
}

/** A world point in the camera frame (x right, y down, z forward). */
export function worldToCamera(camera: Camera, p: Vec3): Vec3 {
  return toCamera(camera.position, camera.rot, p);
}

/**
 * sim_actors.project for one camera-frame point: K @ p, divided by its third component. Meaningful
 * only in front of the camera (p[2] > 0); behind it the result is mirrored, and at p[2] = 0 infinite.
 */
export function cameraToPixel(K: Mat3, p: Vec3): Pixel {
  const w = p[0] * K[2][0] + p[1] * K[2][1] + p[2] * K[2][2];
  return [(p[0] * K[0][0] + p[1] * K[0][1] + p[2] * K[0][2]) / w, (p[0] * K[1][0] + p[1] * K[1][1] + p[2] * K[1][2]) / w];
}

/** sim_actors.project: pixel coordinates of camera-frame points (all assumed in front of the camera). */
export function projectCameraPoints(K: Mat3, points: readonly Vec3[]): Pixel[] {
  return points.map((p) => cameraToPixel(K, p));
}

export interface ProjectedPoint {
  readonly u: number;
  readonly v: number;
  /** distance in front of the camera plane, metres (negative behind the camera) */
  readonly depth: number;
  /** depth > 0. When false, u and v are not a place in the picture. */
  readonly in_front: boolean;
}

/** Project one world point to pixels. */
export function projectPoint(camera: Camera, p: Vec3): ProjectedPoint {
  const c = worldToCamera(camera, p);
  const [u, v] = cameraToPixel(camera.K, c);
  return { u, v, depth: c[2], in_front: c[2] > 0 };
}

/**
 * Clip a polygon (camera-frame vertices, in order) to the half-space depth >= near: Sutherland-Hodgman,
 * a crossing at a + t (b - a) with t = (near - a.z) / (b.z - a.z), as sim_actors.camera_points. Returns
 * the clipped polygon's vertices in order (empty when wholly behind the near plane).
 */
export function clipPolygonNear(points: readonly Vec3[], near: number = NEAR_M): Vec3[] {
  const out: Vec3[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const aIn = a[2] >= near;
    const bIn = b[2] >= near;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return out;
}

/** Project a world polygon to pixels after clipping it at the near plane (empty when wholly behind it). */
export function projectPolygon(camera: Camera, polygon: readonly Vec3[], near: number = NEAR_M): Pixel[] {
  const clipped = clipPolygonNear(
    polygon.map((p) => worldToCamera(camera, p)),
    near,
  );
  return projectCameraPoints(camera.K, clipped);
}
