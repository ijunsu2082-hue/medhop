// A synthetic station-sign detector for the browser simulator. It stands in for MarkerDetector of
// backend/medhop/vision/marker.py (OpenCV ArUco on the rendered JPEG, which a browser does not have):
// the sign's four corners are projected from the frame's pose snapshot through the simulator's camera
// (camera/projection.ts), and the MarkerObs is built from them with MarkerDetector.detect's own
// arithmetic (markerObsFromCorners: same corner order TL, TR, BR, BL, the same normalisation by the
// frame width, the same MIN_WIDTH filter, frame_w and frame_h set). Also ports obstacles_of from
// backend/medhop/vision/worker.py. Checked by detector.test.ts against __fixtures__/detector_calibration.json.
//
// No detection when: the simulator's hide-marker hook is set (snapshot.marker_hidden); the sign carries
// another id than the one looked for; a corner is behind the camera; a corner is closer than
// edge_margin_px to the frame's edge pixels (or outside the frame); an actor's silhouette overlaps the
// marker square or comes within hide_margin_px of it; the detection is dropped (probability `dropout`);
// the (noisy) width is below MIN_WIDTH. Otherwise seeded Gaussian noise of corner_noise_px is added to
// each corner coordinate. Draw order on the injected RandomSource, per detection that passes the
// geometric checks: one random() for the dropout (only when dropout > 0), then eight normals (only when
// corner_noise_px > 0) in the order TL.u, TL.v, TR.u, TR.v, BR.u, BR.v, BL.u, BL.v.
//
// Calibration (backend/tools/parity_traces.py detector_calibration, which renders frames with the
// Python simulator and runs the real OpenCV detector on them; grid: 14 distances 0.5..7 m, sideways
// offsets -0.4..0.4 m, headings -20..20 degrees from facing the sign, camera at 1.04 m; 350 poses per
// profile, seed 11; the numbers are in the fixture):
//
//   display profile, 1280x720 (SimConfig.high_quality; the defaults below):
//     found 285 of 285 poses where the whole marker is in the frame and at least MIN_WIDTH wide
//     (0.5..5.5 m; from about 5.1 m on the marker is narrower than MIN_WIDTH = 32 px): miss rate 0.0
//     at every distance (with 285 trials, a true rate above about 1 % would likely have shown).
//     Corner error against the ideal geometry: mean 0.47 px, median 0.43, p95 0.83, max 1.06; per
//     coordinate RMS 0.36 px, of which a mean offset of -0.18..-0.49 px in u and -0.16..-0.42 px in v
//     (by distance), and a spread of 0.17 px once that offset is removed. The offset is the Python
//     renderer's: it maps the sign texture's texel centres, so the marker is drawn half a texel up and
//     left of the ideal one, on a texture level that changes with distance. Against the marker as it
//     is actually drawn the error is mean 0.21 px, p95 0.29, max 0.37: the projection here is the
//     renderer's to well under a pixel, and what is left is the detector's own corner refinement.
//     Edge: found while every true corner was at least 0.5 px (left edge) or 1.0 px (top edge) inside
//     the edge pixels, lost at 0.0 and 0.5 px. Hiding: a person (from the side) or an object (from
//     below) 0.8 m from the wall in front of the sign; "reach" = how far its silhouette reaches into the
//     marker square. At 2.5 m the sign was still found up to +2.0 px (side) and +4.5 px (below), at
//     3.5 m up to -0.5 px (side, with single finds to +2.5) and +3.0 px (below); lost beyond +5.5 px in
//     every case. At 1.5 m it was still "found" with 10 px of overlap, but with its corners dragged by
//     up to 13 px onto the silhouette's edge. Chosen rule: any overlap hides the sign (hide_margin_px 0):
//     within a few pixels of the measured boundary at flight distances, and never a detection with
//     wrong corners.
//
//   drone-like profile, 640x360 (SimConfig(): blur, sensor noise, JPEG q50; DRONE_LIKE_DETECTOR_OPTIONS):
//     found 257 of 285 in view: miss rate 0.0 to 3.0 m, 0.04 at 3.5 m, 0.12 at 4.0 m, 0.0 at 4.5 m,
//     0.56 at 5.0 m (16.5 px marker), 1.0 at 5.5 m; 4 of 250 (1.6 %) up to 4.5 m. Beyond 4.5 m the
//     misses are mostly the blur: the detected width is 3..8 % below the true one, so a marker just over
//     MIN_WIDTH (16 px) measures under it. That is not modelled here. Corner error: mean 0.94 px, median
//     0.84, p95 1.76, max 3.41; RMS 0.75 px per coordinate, 0.47 px once the offset is removed; against
//     the drawn marker mean 0.55 px. Edge: found from 1.5..2.0 px inside, lost at 1.0..1.5 px. Hiding:
//     lost once the silhouette came within 1.5..2.0 px from the side, 0.0..0.5 px from below.
//
// Defaults chosen from the display numbers: corner_noise_px 0.17 (the spread without the renderer's
// offset; the browser renderer draws the sign where this module projects it), dropout 0.0 (none seen),
// edge_margin_px 1.0, hide_margin_px 0.0.

import {
  cameraExtrinsics,
  cameraMatrix,
  cameraToPixel,
  focalLength,
  toCamera,
  type CameraPose,
  type Mat3,
  type Pixel,
  type Vec3,
} from "../camera/projection";
import type { Frame } from "../drone/link";
import { cameraPoints, convexHull, project, type Actor } from "../drone/simActors";
import { PythonRandom, type RandomSource } from "../util/rng";
import { DEFAULT_MARKER_ID, MarkerObs, MIN_WIDTH, Obstacle, type Corner } from "./marker";

/** What the detector needs to know about the camera and the sign; a SimConfig has all of it. */
export interface SignGeometry {
  readonly width: number;
  readonly height: number;
  readonly hfov_deg: number;
  /** the id printed on the sign */
  readonly marker_id: number;
  readonly marker_size_m: number;
  /** height of the marker centre on the wall */
  readonly marker_height_m: number;
}

/** A frame's pose snapshot as the detector reads it (drone/sim.ts SimSnapshot has these fields). */
export interface SignView extends CameraPose {
  readonly marker_hidden?: boolean;
  readonly actors?: readonly Actor[];
}

export interface SignDetectorOptions {
  /** The id to look for (MarkerDetector(marker_id), default 7). A sign printed with another id is never found. */
  marker_id?: number;
  /** Sigma of the Gaussian noise added to each corner coordinate, pixels of this frame. */
  corner_noise_px?: number;
  /** Probability that a detection that would otherwise be made is dropped. */
  dropout?: number;
  /** A true corner closer than this to the frame's edge pixels (or outside the frame) means no detection. */
  edge_margin_px?: number;
  /** An actor's silhouette overlapping the marker square or closer than this hides it. null: actors never hide it. */
  hide_margin_px?: number | null;
  /** Draws the dropout and the noise (default PythonRandom(0)). */
  rng?: RandomSource;
}

type ResolvedOptions = Required<Omit<SignDetectorOptions, "rng" | "hide_margin_px">> & { hide_margin_px: number | null };

/** The display profile (1280x720) calibration; see the header. */
export const DETECTOR_DEFAULTS: Readonly<ResolvedOptions> = Object.freeze({
  marker_id: DEFAULT_MARKER_ID,
  corner_noise_px: 0.17,
  dropout: 0.0,
  edge_margin_px: 1.0,
  hide_margin_px: 0.0,
});

/** The drone-like profile (640x360) calibration; see the header. */
export const DRONE_LIKE_DETECTOR_OPTIONS: Readonly<ResolvedOptions> = Object.freeze({
  marker_id: DEFAULT_MARKER_ID,
  corner_noise_px: 0.47,
  dropout: 0.016,
  edge_margin_px: 2.0,
  hide_margin_px: 1.5,
});

/** Why the last detect() found nothing (null: it found the sign). */
export type MissReason = "marker_hidden" | "other_id" | "behind" | "outside" | "covered" | "dropout" | "small";

/** The marker's corners on the wall (TL, TR, BR, BL as printed), world coordinates. */
export function markerWorldCorners(geometry: SignGeometry): Vec3[] {
  const half = geometry.marker_size_m / 2.0;
  const top = geometry.marker_height_m + half;
  const bottom = geometry.marker_height_m - half;
  return [
    [-half, top, 0.0],
    [half, top, 0.0],
    [half, bottom, 0.0],
    [-half, bottom, 0.0],
  ];
}

/** The true corners: camera-frame points (their z is the depth) and pixels, TL, TR, BR, BL. */
export function signCorners(geometry: SignGeometry, pose: CameraPose, K?: Mat3): { camera: Vec3[]; pixels: Corner[] } {
  const k = K ?? cameraMatrix(geometry.width, geometry.height, geometry.hfov_deg);
  const { position, rot } = cameraExtrinsics(pose);
  const camera = markerWorldCorners(geometry).map((p) => toCamera(position, rot, p));
  return { camera, pixels: camera.map((p) => cameraToPixel(k, p)) };
}

/** Smallest distance (pixels) from a corner to the frame's edge pixels; negative when one is outside. */
export function borderMargin(corners: readonly Pixel[], width: number, height: number): number {
  let margin = Infinity;
  for (const [u, v] of corners) margin = Math.min(margin, u, v, width - 1 - u, height - 1 - v);
  return margin;
}

function norm2(a: Corner, b: Corner): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy); // np.linalg.norm of a 2-vector: sqrt(dot)
}

/**
 * MarkerDetector.detect's arithmetic on one quad of corners (TL, TR, BR, BL, pixels): the MarkerObs it
 * builds, or null when the width is below MIN_WIDTH (the detector skips such a detection).
 */
export function markerObsFromCorners(
  corners: readonly Corner[],
  frameW: number,
  frameH: number,
  markerId: number,
  ts = 0.0,
): MarkerObs | null {
  const [p0, p1, p2, p3] = corners as readonly [Corner, Corner, Corner, Corner];
  const top = norm2(p1, p0);
  const bottom = norm2(p2, p3);
  const left = norm2(p3, p0);
  const right = norm2(p2, p1);
  const obs = new MarkerObs({
    id: markerId,
    cx: (p0[0] + p1[0] + p2[0] + p3[0]) / 4 / frameW,
    cy: (p0[1] + p1[1] + p2[1] + p3[1]) / 4 / frameH,
    width: (0.5 * (top + bottom)) / frameW,
    corners: corners.map((c) => [c[0], c[1]] as Corner),
    ts,
    height: (0.5 * (left + right)) / frameW,
    frame_w: Math.trunc(frameW),
    frame_h: Math.trunc(frameH),
  });
  if (obs.width < MIN_WIDTH) return null;
  return obs;
}

// ---------------------------------------------------------------------------------------------- //
// convex polygon distance (pixels), for the hiding rule

function edgesOf(poly: readonly Pixel[]): [Pixel, Pixel][] {
  if (poly.length === 1) return [[poly[0]!, poly[0]!]];
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]!] as [Pixel, Pixel]);
}

function pointSegmentDistance(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Separating-axis test for two convex polygons (any vertex order; one or two points allowed). */
function convexOverlap(a: readonly Pixel[], b: readonly Pixel[]): boolean {
  for (const poly of [a, b]) {
    if (poly.length < 2) continue;
    for (const [p, q] of edgesOf(poly)) {
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      if (nx === 0 && ny === 0) continue;
      let aMin = Infinity;
      let aMax = -Infinity;
      for (const r of a) {
        const s = r[0] * nx + r[1] * ny;
        aMin = Math.min(aMin, s);
        aMax = Math.max(aMax, s);
      }
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const r of b) {
        const s = r[0] * nx + r[1] * ny;
        bMin = Math.min(bMin, s);
        bMax = Math.max(bMax, s);
      }
      if (aMax < bMin || bMax < aMin) return false;
    }
  }
  if (a.length === 1 && b.length === 1) return a[0]![0] === b[0]![0] && a[0]![1] === b[0]![1];
  return true;
}

/** Distance between two convex polygons in pixels: 0 when they touch or overlap. */
export function convexPolygonDistance(a: readonly Pixel[], b: readonly Pixel[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  if (convexOverlap(a, b)) return 0;
  let best = Infinity;
  for (const p of a) for (const [q, r] of edgesOf(b)) best = Math.min(best, pointSegmentDistance(p, q, r));
  for (const p of b) for (const [q, r] of edgesOf(a)) best = Math.min(best, pointSegmentDistance(p, q, r));
  return best;
}

// ---------------------------------------------------------------------------------------------- //

export class SignDetector {
  readonly geometry: SignGeometry;
  readonly options: Readonly<ResolvedOptions>;
  /** Why the last detect() returned null; null after a detection. */
  lastMiss: MissReason | null = null;

  private readonly _rng: RandomSource;
  private readonly _K: Mat3;

  constructor(geometry: SignGeometry, options: SignDetectorOptions = {}) {
    this.geometry = geometry;
    const { rng, ...rest } = options;
    // a key given as undefined keeps its default
    const given = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    this.options = Object.freeze({ ...DETECTOR_DEFAULTS, ...given });
    this._rng = rng ?? new PythonRandom(0);
    this._K = cameraMatrix(geometry.width, geometry.height, geometry.hfov_deg);
  }

  /** The focal length of the camera this detector projects through, pixels. */
  get focal(): number {
    return focalLength(this.geometry.width, this.geometry.hfov_deg);
  }

  /** The sign in this view, or null (see lastMiss). `ts` is the frame's arrival time, as in Python. */
  detect(view: SignView, ts = 0.0): MarkerObs | null {
    const miss = (reason: MissReason): null => {
      this.lastMiss = reason;
      return null;
    };
    const g = this.geometry;
    const o = this.options;
    if (view.marker_hidden === true) return miss("marker_hidden");
    if (o.marker_id !== g.marker_id) return miss("other_id");
    const { camera, pixels } = signCorners(g, view, this._K);
    if (camera.some((p) => !(p[2] > 0))) return miss("behind");
    if (!(borderMargin(pixels, g.width, g.height) >= o.edge_margin_px)) return miss("outside");
    if (o.hide_margin_px !== null && this.covered(view, pixels)) return miss("covered");
    if (o.dropout > 0 && this._rng.random() < o.dropout) return miss("dropout");
    let corners: Corner[] = pixels;
    if (o.corner_noise_px > 0) {
      const s = o.corner_noise_px;
      corners = pixels.map(([u, v]) => {
        const nu = u + this._rng.normal(0.0, s);
        const nv = v + this._rng.normal(0.0, s);
        return [nu, nv] as Corner;
      });
    }
    const obs = markerObsFromCorners(corners, g.width, g.height, o.marker_id, ts);
    if (obs === null) return miss("small");
    this.lastMiss = null;
    return obs;
  }

  /** True when an actor's silhouette overlaps the marker square or is within hide_margin_px of it. */
  covered(view: SignView, markerPixels: readonly Pixel[]): boolean {
    const margin = this.options.hide_margin_px;
    if (margin === null || !view.actors || view.actors.length === 0) return false;
    const { position, rot } = cameraExtrinsics(view);
    for (const actor of view.actors) {
      const pts = cameraPoints(actor, position, rot);
      if (pts.length < 3) continue; // draw_actors draws nothing then
      const silhouette = convexHull(project(pts, this._K));
      if (convexPolygonDistance(silhouette, markerPixels) <= margin) return true;
    }
    return false;
  }
}

/**
 * obstacles_of (vision/worker.py): the simulator's actor boxes carried by a frame, as Obstacles stamped
 * with the frame's time. Empty for a frame without them (always on the real drone).
 */
export function obstaclesOf(frame: Frame<unknown>): Obstacle[] {
  return (frame.obstacles ?? []).map(
    ([kind, box]) => new Obstacle({ kind: String(kind), box: [box[0], box[1], box[2], box[3]], ts: frame.timestamp }),
  );
}

/**
 * Mean grey level of the simulator's picture, for Observation.brightness, which the browser cannot
 * measure: what detector_calibration measured on the Python renderer (median over the hover poses of
 * the grid; on the ground at the start distance), times the config's light gain. A rough stand-in: the
 * real value varies with the view by tens of grey levels.
 */
export const MEASURED_BRIGHTNESS = Object.freeze({
  room: Object.freeze({ hover: 195.26, ground: 174.95 }),
  plain: Object.freeze({ hover: 186.92, ground: 158.39 }),
});

export function estimatedBrightness(
  config: { readonly scene: string; readonly light: number },
  view: { readonly cam_y: number },
): number {
  const scene = config.scene === "room" ? MEASURED_BRIGHTNESS.room : MEASURED_BRIGHTNESS.plain;
  return (view.cam_y > 0.19 ? scene.hover : scene.ground) * config.light;
}
