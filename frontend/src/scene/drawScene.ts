// Draws the simulator's camera view as a plain line drawing: the room, the station sign with its real marker
// pattern, the simulated people and objects, and what the flight logic made of the picture: an outline round
// the tracked sign, and a box with a short label round each obstacle. Pure canvas 2D, no images.
//
// The geometry is the engine's. engine/camera/projection.ts projects (the simulator's own pinhole model, the
// one the sign detector projects through), and engine/drone/simActors.ts gives each actor's silhouette and
// the farthest-first order the Python renderer fills them in, so the drawing shows what the flight logic is
// told. buildScene() turns a frame into a list of plain shapes and is pure (drawScene.test.ts checks it);
// drawScene() only paints that list.
//
// Coordinates: the picture is laid out in a 1280x720 frame, the simulator's display camera
// (SimConfig.high_quality), and the canvas is scaled to it. The engine's pixels are pixel centres (OpenCV),
// so a projected point (u, v) is drawn at (u + 0.5, v + 0.5) on a canvas whose origin is the top-left
// corner of the top-left pixel. The marker corners in a frame are pixels of this same 1280x720 frame (the
// display-profile detector reports them so); obstacle boxes are fractions of the frame.
//
// Overlay lines and labels (the flight logic's marks, not the room) are sized in CSS pixels of the
// displayed picture through `uiScale`, so a label stays legible on a phone and is not huge on a desk.

import {
  cameraToPixel,
  makeCamera,
  NEAR_M,
  projectPolygon,
  worldToCamera,
  type Camera,
  type Lens,
  type Pixel,
  type Vec3,
} from "../engine/camera/projection";
import { highQualitySimConfig, type SimSnapshot } from "../engine/drone/sim";
import { actorDrawOrder, actorSilhouette, type Actor } from "../engine/drone/simActors";
import type { MarkerObs, ObstacleBox } from "../engine/vision/marker";
import { FRONT_WALL, LEFT_WALL, LIGHTS_X, LIGHTS_Z, MARKER_7, RIGHT_WALL, ROOM, SHEET_TOP_Y, SIGN, type WallRect } from "./room";

const DISPLAY = highQualitySimConfig();

/** The frame the picture is laid out in; the canvas is scaled to it. The simulator's display camera. */
export const FRAME_W = DISPLAY.width;
export const FRAME_H = DISPLAY.height;
export const LENS: Lens = { width: FRAME_W, height: FRAME_H, hfov_deg: DISPLAY.hfov_deg };

export type ObstacleKind = "person" | "object";

/** One entry of the status's `vision.obstacles`: a box the flight logic was given, and what it made of it. */
export interface SceneObstacle {
  readonly kind: ObstacleKind;
  /** x1, y1, x2, y2 as fractions of the frame */
  readonly box: ObstacleBox;
  /** metres ahead, as the flight logic estimated it; null: very close (its base is out of the picture) */
  readonly distance_m: number | null;
  /** inside the lane the drone needs */
  readonly in_lane: boolean;
}

export interface SceneFrame {
  /** What the simulator's camera saw: the pose snapshot the frame was captured from. */
  readonly view: SimSnapshot;
  /** The tracked sign's corners as the flight logic saw them (TL, TR, BR, BL, pixels of the frame), or null. */
  readonly marker: MarkerObs["corners"] | null;
  /** The obstacles the flight logic was given in this frame. */
  readonly obstacles: readonly SceneObstacle[];
  /** Distance from the wall, in metres, of the spot the run lands on; null leaves it out. */
  readonly landingSpot: number | null;
}

export interface SceneTheme {
  bg: string;
  fill: string;
  line: string;
  mid: string;
  ink: string;
  fontFamily: string;
}

/** A page colour token, by name; the painter looks it up in the theme. */
export type Tone = "bg" | "fill" | "line" | "mid" | "ink";

/** A point on the canvas, in frame pixels with the origin at the frame's top-left corner. */
export type Pt = readonly [x: number, y: number];

/** What a shape is part of: lets tests (and nothing else) find things in the list. */
export type Part = "room" | "landing" | "sign" | "marker" | "actor" | "tracking" | "obstacle" | "label";

export interface PathShape {
  readonly type: "path";
  readonly part: Part;
  readonly points: readonly Pt[];
  readonly closed: boolean;
  readonly fill: Tone | null;
  readonly stroke: Tone | null;
  readonly width: number;
  readonly dash: readonly number[] | null;
  /** For actor shapes: the index of the actor in view.actors. For obstacle and label shapes: in obstacles. */
  readonly index?: number;
}

export interface TextShape {
  readonly type: "text";
  readonly part: Part;
  readonly text: string;
  /** the start of the baseline (align "left") or its middle (align "center") */
  readonly x: number;
  readonly y: number;
  /** frame pixels (before `transform`) */
  readonly size: number;
  readonly weight: 400 | 600;
  readonly tone: Tone;
  readonly align: "left" | "center";
  readonly maxWidth: number | null;
  /** a canvas transform (a, b, c, d, e, f) applied before the text is set, or null */
  readonly transform: readonly [number, number, number, number, number, number] | null;
  readonly index?: number;
}

export type Shape = PathShape | TextShape;

/** An axis-aligned rectangle, frame pixels. */
export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Sizes of the flight logic's marks, CSS pixels of the displayed picture. */
export const OVERLAY = Object.freeze({
  labelPx: 12,
  labelWeight: 600 as const,
  labelPadX: 4,
  labelPadY: 1,
  /** an obstacle box outside the lane, and one in it */
  boxThinPx: 1.25,
  boxHeavyPx: 2.75,
  /** the box is drawn this far outside the flight logic's box, so it never sits on the figure's outline */
  boxOutsetPx: 3,
  trackingPx: 2,
  /** at least this much white between the marker and the outline round it */
  trackingGapPx: 2.5,
  /** labels keep this far from the sign and its outline */
  clearPx: 4,
});

/** Frame pixels per CSS pixel when the caller does not say: a picture about 800 CSS pixels wide. */
export const DEFAULT_UI_SCALE = FRAME_W / 800;

export interface LayoutOptions {
  /** Frame pixels per CSS pixel of the displayed picture. */
  readonly uiScale?: number;
  /** Width in frame pixels of `text` set at `size` frame pixels in `weight`; the default is an estimate. */
  readonly measure?: (text: string, size: number, weight: number) => number;
}

/** A rough width of the page typeface's text, for when no canvas is at hand to measure it. */
export function estimateTextWidth(text: string, size: number): number {
  return text.length * size * 0.56;
}

/** The label above an obstacle's box: "person 2.6 m", "object, very close". */
export function obstacleLabel(o: Pick<SceneObstacle, "kind" | "distance_m">): string {
  const what = o.kind === "person" ? "person" : "object";
  return o.distance_m === null ? `${what}, very close` : `${what} ${o.distance_m.toFixed(1)} m`;
}

// ---------------------------------------------------------------------------------------------- //
// projection helpers

const toCanvas = (p: Pixel): Pt => [p[0] + 0.5, p[1] + 0.5];

/** A world polygon on the canvas, clipped at the near plane; fewer than three points when it is not in front. */
function project(camera: Camera, world: readonly Vec3[]): Pt[] {
  const pts = projectPolygon(camera, world);
  return pts.length < 3 ? [] : pts.map(toCanvas);
}

/** A world line segment on the canvas, clipped at the near plane; null when it is wholly behind the camera. */
function projectSegment(camera: Camera, a: Vec3, b: Vec3): Pt[] | null {
  let ca = worldToCamera(camera, a);
  let cb = worldToCamera(camera, b);
  if (ca[2] < NEAR_M && cb[2] < NEAR_M) return null;
  if (ca[2] < NEAR_M || cb[2] < NEAR_M) {
    const t = (NEAR_M - ca[2]) / (cb[2] - ca[2]);
    const cut: Vec3 = [ca[0] + t * (cb[0] - ca[0]), ca[1] + t * (cb[1] - ca[1]), NEAR_M];
    if (ca[2] < NEAR_M) ca = cut;
    else cb = cut;
  }
  return [toCanvas(cameraToPixel(camera.K, ca)), toCanvas(cameraToPixel(camera.K, cb))];
}

function boundsOf(points: readonly Pt[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

const grow = (r: Rect, by: number): Rect => ({ x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by });
const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const rectPoints = (r: Rect): Pt[] => [
  [r.x0, r.y0],
  [r.x1, r.y0],
  [r.x1, r.y1],
  [r.x0, r.y1],
];

// ---------------------------------------------------------------------------------------------- //
// shape builders

interface Style {
  fill?: Tone | null;
  stroke?: Tone | null;
  width?: number;
  dash?: readonly number[] | null;
  index?: number;
}

function poly(out: Shape[], part: Part, points: readonly Pt[], style: Style, closed = true): void {
  if (points.length < 2) return;
  out.push({
    type: "path",
    part,
    points,
    closed,
    fill: style.fill ?? null,
    stroke: style.stroke ?? null,
    width: style.width ?? 1.5,
    dash: style.dash ?? null,
    ...(style.index === undefined ? {} : { index: style.index }),
  });
}

function quad(out: Shape[], part: Part, camera: Camera, world: readonly Vec3[], style: Style): void {
  const pts = project(camera, world);
  if (pts.length >= 3) poly(out, part, pts, style);
}

function segment(out: Shape[], camera: Camera, a: Vec3, b: Vec3, stroke: Tone, width = 1.5): void {
  const s = projectSegment(camera, a, b);
  if (s) poly(out, "room", s, { stroke, width }, false);
}

interface Span {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

/** A rectangle on the station wall (z = 0), from x = a0 to a1. */
function onFront(r: Span): Vec3[] {
  return [
    [r.a0, r.y1, ROOM.z1],
    [r.a1, r.y1, ROOM.z1],
    [r.a1, r.y0, ROOM.z1],
    [r.a0, r.y0, ROOM.z1],
  ];
}

/** A rectangle on a side wall (x fixed), from z = a0 to a1. */
function onSide(x: number, r: Span): Vec3[] {
  return [
    [x, r.y1, r.a0],
    [x, r.y1, r.a1],
    [x, r.y0, r.a1],
    [x, r.y0, r.a0],
  ];
}

/** A rectangle lying flat at height y. */
function flat(y: number, x0: number, x1: number, z0: number, z1: number): Vec3[] {
  return [
    [x0, y, z0],
    [x1, y, z0],
    [x1, y, z1],
    [x0, y, z1],
  ];
}

function wallThing(out: Shape[], camera: Camera, on: (r: Span) => Vec3[], r: WallRect): void {
  quad(out, "room", camera, on(r), { fill: "bg", stroke: "mid" });
  const w = r.a1 - r.a0;
  if (r.kind === "door") {
    // Two recessed panels and a handle.
    quad(out, "room", camera, on({ a0: r.a0 + 0.14, a1: r.a1 - 0.14, y0: 1.15, y1: r.y1 - 0.16 }), { stroke: "line", width: 1 });
    quad(out, "room", camera, on({ a0: r.a0 + 0.14, a1: r.a1 - 0.14, y0: 0.2, y1: 0.95 }), { stroke: "line", width: 1 });
    quad(out, "room", camera, on({ a0: r.a0 + w * 0.82, a1: r.a0 + w * 0.92, y0: 1.0, y1: 1.04 }), { fill: "mid" });
  } else if (r.kind === "print") {
    quad(out, "room", camera, on({ a0: r.a0 + 0.06, a1: r.a1 - 0.06, y0: r.y0 + 0.06, y1: r.y1 - 0.06 }), {
      fill: "fill",
      stroke: "line",
      width: 1,
    });
  } else {
    // A noticeboard with a few sheets pinned to it.
    for (let i = 0; i < 3; i += 1) {
      const a0 = r.a0 + 0.1 + (i * (w - 0.2)) / 3;
      quad(out, "room", camera, on({ a0, a1: a0 + (w - 0.2) / 3 - 0.08, y0: r.y0 + 0.14, y1: r.y1 - 0.14 }), {
        fill: "fill",
        stroke: "line",
        width: 1,
      });
    }
  }
}

function roomShapes(out: Shape[], camera: Camera): void {
  const { x0, x1, z0, z1, height: h } = ROOM;

  // Floor (the darkest plane, with board joints), then the ceiling with its light panels.
  quad(out, "room", camera, flat(0, x0, x1, z0, z1), { fill: "line" });
  for (let x = x0 + 0.5; x < x1; x += 0.5) segment(out, camera, [x, 0, z0], [x, 0, z1], "fill");
  quad(out, "room", camera, flat(h, x0, x1, z0, z1), { fill: "bg" });
  for (const lx of LIGHTS_X) {
    for (const lz of LIGHTS_Z) {
      quad(out, "room", camera, flat(h, lx - 0.3, lx + 0.3, lz - 0.3, lz + 0.3), { fill: "fill", stroke: "line", width: 1 });
    }
  }

  // Walls: back, sides, then the station wall. Seen from inside, none of them hides another.
  const front = (r: Span) => onFront(r);
  const leftWall = (r: Span) => onSide(x0, r);
  const rightWall = (r: Span) => onSide(x1, r);
  const whole = (a0: number, a1: number): Span => ({ a0, a1, y0: 0, y1: h });
  const back: Vec3[] = [
    [x0, h, z0],
    [x1, h, z0],
    [x1, 0, z0],
    [x0, 0, z0],
  ];
  quad(out, "room", camera, back, { fill: "fill", stroke: "mid" });
  for (const [on, a0, a1] of [
    [leftWall, z0, z1],
    [rightWall, z0, z1],
    [front, x0, x1],
  ] as const) {
    quad(out, "room", camera, on(whole(a0, a1)), { fill: "fill", stroke: "mid" });
    // A white skirting board, and a rail at 0.9 m.
    quad(out, "room", camera, on({ a0, a1, y0: 0, y1: 0.1 }), { fill: "bg", stroke: "mid", width: 1 });
    quad(out, "room", camera, on({ a0, a1, y0: 0.88, y1: 0.92 }), { fill: "bg", stroke: "line", width: 1 });
  }

  for (const r of LEFT_WALL) wallThing(out, camera, leftWall, r);
  for (const r of RIGHT_WALL) wallThing(out, camera, rightWall, r);
  for (const r of FRONT_WALL) wallThing(out, camera, front, r);
}

function landingShapes(out: Shape[], camera: Camera, distance: number): void {
  const ring: Vec3[] = [];
  for (let i = 0; i < 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    ring.push([0.15 * Math.cos(a), 0, -distance + 0.15 * Math.sin(a)]);
  }
  quad(out, "landing", camera, ring, { stroke: "mid", width: 1.5, dash: [6, 5] });
}

/** The marker square on the wall: TL, TR, BR, BL as printed (the order of the detector's corners). */
export function markerWorldSquare(): Vec3[] {
  const m = SIGN.markerSize;
  const left = -m / 2;
  const top = SIGN.markerCentreY + m / 2;
  return onFront({ a0: left, a1: left + m, y0: top - m, y1: top });
}

/** The sheet the sign is printed on, on the wall. */
function sheetWorld(): Vec3[] {
  const half = SIGN.sheetWidth / 2;
  return onFront({ a0: -half, a1: half, y0: SHEET_TOP_Y - SIGN.sheetHeight, y1: SHEET_TOP_Y });
}

function signShapes(out: Shape[], camera: Camera): void {
  quad(out, "sign", camera, sheetWorld(), { fill: "bg", stroke: "mid", width: 1 });

  const m = SIGN.markerSize;
  const left = -m / 2;
  const top = SIGN.markerCentreY + m / 2;
  quad(out, "marker", camera, markerWorldSquare(), { fill: "ink" });
  const cell = m / MARKER_7.length;
  MARKER_7.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== "1") continue;
      const span = { a0: left + c * cell, a1: left + (c + 1) * cell, y0: top - (r + 1) * cell, y1: top - r * cell };
      quad(out, "sign", camera, onFront(span), { fill: "bg", stroke: "bg", width: 0.5 });
    }
  });

  // The caption under the marker, set in the sheet's own perspective (an affine fit is close enough at this size).
  const half = SIGN.sheetWidth / 2;
  const baselineY = top - m - 0.03;
  const fit = projectPolygon(camera, [
    [-half, baselineY + 0.012, ROOM.z1],
    [half, baselineY + 0.012, ROOM.z1],
    [-half, baselineY, ROOM.z1],
  ]);
  if (fit.length !== 3) return;
  const [p0, px, py] = fit.map(toCanvas) as [Pt, Pt, Pt];
  if (Math.hypot(px[0] - p0[0], px[1] - p0[1]) < 40) return;
  // Local units are millimetres on the sheet: x across its 210 mm, y down over the 12 mm cap height.
  out.push({
    type: "text",
    part: "sign",
    text: SIGN.caption,
    x: 105,
    y: 12,
    size: 17,
    weight: 600,
    tone: "ink",
    align: "center",
    maxWidth: 190,
    transform: [(px[0] - p0[0]) / 210, (px[1] - p0[1]) / 210, (py[0] - p0[0]) / 12, (py[1] - p0[1]) / 12, p0[0], p0[1]],
  });
}

function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = from + ((to - from) * i) / steps;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * A plain standing figure filling `r` (canvas pixels): a round head over a body with rounded shoulders that
 * fill the width, narrowing a little to the feet, and a line where the legs part. No face, no detail.
 */
export function personFigure(r: Rect): { head: Pt[]; body: Pt[]; legs: Pt[] } {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const cx = (r.x0 + r.x1) / 2;
  const head = Math.min(0.13 * h, 0.4 * w);
  const shoulderTop = r.y0 + head * 1.12;
  const round = Math.min(0.32 * w, 0.1 * h);
  const hip = r.y0 + 0.56 * h;
  const foot = 0.07 * w;
  const body: Pt[] = [
    ...arc(r.x0 + round, shoulderTop + round, round, Math.PI, Math.PI * 1.5, 10),
    ...arc(r.x1 - round, shoulderTop + round, round, Math.PI * 1.5, Math.PI * 2, 10),
    [r.x1, hip],
    [r.x1 - foot, r.y1],
    [r.x0 + foot, r.y1],
    [r.x0, hip],
  ];
  return {
    head: arc(cx, r.y0 + head / 2, head / 2, 0, Math.PI * 2, 36).slice(0, -1),
    body,
    legs: [
      [cx, r.y1],
      [cx, r.y0 + 0.54 * h],
    ],
  };
}

/** The faces of an object's box that face the camera at `eye`, as world quads (the box of simActors.corners). */
function visibleFaces(actor: Actor, eye: Vec3): Vec3[][] {
  const x0 = actor.x_m - actor.width_m / 2;
  const x1 = actor.x_m + actor.width_m / 2;
  const z0 = -(actor.distance_m + actor.depth_m / 2);
  const z1 = -(actor.distance_m - actor.depth_m / 2);
  const h = actor.height_m;
  const faces: Vec3[][] = [];
  const side = (x: number, za: number, zb: number): Vec3[] => [
    [x, h, za],
    [x, h, zb],
    [x, 0, zb],
    [x, 0, za],
  ];
  const across = (z: number, xa: number, xb: number): Vec3[] => [
    [xa, h, z],
    [xb, h, z],
    [xb, 0, z],
    [xa, 0, z],
  ];
  if (eye[2] < z0) faces.push(across(z0, x0, x1));
  if (eye[2] > z1) faces.push(across(z1, x1, x0));
  if (eye[0] < x0) faces.push(side(x0, z1, z0));
  if (eye[0] > x1) faces.push(side(x1, z0, z1));
  if (eye[1] > h) faces.push(flat(h, x0, x1, z0, z1));
  return faces;
}

function actorShapes(out: Shape[], camera: Camera, actors: readonly Actor[]): void {
  for (const i of actorDrawOrder(actors, camera.position)) {
    const actor = actors[i]!;
    const hull = actorSilhouette(actor, camera).map(toCanvas);
    if (hull.length < 3) continue; // too little of it in front of the camera: the simulator draws nothing either
    if (actor.kind === "person") {
      const figure = personFigure(boundsOf(hull));
      poly(out, "actor", figure.body, { fill: "mid", stroke: "ink", width: 2, index: i });
      poly(out, "actor", figure.head, { fill: "mid", stroke: "ink", width: 2, index: i });
      poly(out, "actor", figure.legs, { stroke: "ink", width: 2, index: i }, false);
    } else {
      poly(out, "actor", hull, { fill: "mid", index: i });
      for (const face of visibleFaces(actor, camera.position)) {
        const pts = project(camera, face);
        if (pts.length >= 3) poly(out, "actor", pts, { stroke: "ink", width: 1.5, index: i });
      }
      poly(out, "actor", hull, { stroke: "ink", width: 2, index: i });
    }
  }
}

/**
 * The outline round the tracked marker: the corners pushed out from the centre, by 7 % of the marker's size
 * (on the white of the sheet) or by `minOutset` frame pixels if that is more, so the marker itself stays
 * untouched and a little white shows between the two even when the picture is small.
 */
export function trackingRing(corners: MarkerObs["corners"], minOutset = 0): Pt[] {
  const pts = corners.map(toCanvas);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const edges = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const side = edges.reduce((s, e) => s + e, 0) / Math.max(1, edges.length);
  const k = side > 0 ? Math.max(1.14, 1 + (2 * minOutset) / side) : 1.14;
  return pts.map((p): Pt => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);
}

/** Where a label plate of size w x h goes beside `box` (the drawn box, outer edge): the first place that fits. */
export function placeLabel(box: Rect, w: number, h: number, avoid: readonly Rect[]): Rect {
  const clampX = (x: number) => Math.min(Math.max(x, 0), FRAME_W - w);
  const clampY = (y: number) => Math.min(Math.max(y, 0), FRAME_H - h);
  const at = (x0: number, y0: number): Rect => ({ x0, y0, x1: x0 + w, y1: y0 + h });
  const candidates = [
    at(clampX(box.x0), box.y0 - h), // above, from its left edge
    at(clampX(box.x1 - w), box.y0 - h), // above, to its right edge
    at(box.x0 - w, clampY(box.y0)), // to its left, level with its top
    at(box.x1, clampY(box.y0)), // to its right
    at(clampX(box.x0), box.y1), // below
  ];
  const fits = (r: Rect) =>
    r.x0 >= 0 && r.y0 >= 0 && r.x1 <= FRAME_W && r.y1 <= FRAME_H && !avoid.some((a) => overlaps(a, r));
  return candidates.find(fits) ?? at(clampX(box.x0), clampY(box.y0)); // inside its top-left corner
}

function obstacleShapes(
  out: Shape[],
  obstacles: readonly SceneObstacle[],
  ui: number,
  measure: (text: string, size: number, weight: number) => number,
  keepClear: Rect[],
): void {
  const boxes = obstacles.map((o, i) => {
    const [x1, y1, x2, y2] = o.box;
    const width = (o.in_lane ? OVERLAY.boxHeavyPx : OVERLAY.boxThinPx) * ui;
    const flightBox: Rect = { x0: x1 * FRAME_W + 0.5, y0: y1 * FRAME_H + 0.5, x1: x2 * FRAME_W + 0.5, y1: y2 * FRAME_H + 0.5 };
    const drawn = grow(flightBox, OVERLAY.boxOutsetPx * ui + width / 2);
    poly(out, "obstacle", rectPoints(drawn), { stroke: "ink", width, index: i });
    return { drawn: grow(drawn, width / 2), label: obstacleLabel(o) };
  });

  const size = OVERLAY.labelPx * ui;
  const padX = OVERLAY.labelPadX * ui;
  const padY = OVERLAY.labelPadY * ui;
  const lineBox = 1.4 * size;
  const placed = [...keepClear];
  boxes.forEach(({ drawn, label }, i) => {
    const w = measure(label, size, OVERLAY.labelWeight) + 2 * padX;
    const h = lineBox + 2 * padY;
    const plate = placeLabel(drawn, w, h, placed);
    placed.push(plate);
    poly(out, "label", rectPoints(plate), { fill: "bg", index: i });
    out.push({
      type: "text",
      part: "label",
      text: label,
      x: plate.x0 + padX,
      y: plate.y0 + padY + lineBox / 2 + 0.36 * size,
      size,
      weight: OVERLAY.labelWeight,
      tone: "ink",
      align: "left",
      maxWidth: null,
      transform: null,
      index: i,
    });
  });
}

/** Everything one frame shows, back to front, as plain shapes on the 1280x720 frame. */
export function buildScene(frame: SceneFrame, options: LayoutOptions = {}): Shape[] {
  const ui = options.uiScale ?? DEFAULT_UI_SCALE;
  const measure = options.measure ?? estimateTextWidth;
  const camera = makeCamera(frame.view, LENS);
  const out: Shape[] = [];
  const keepClear: Rect[] = [];

  roomShapes(out, camera);
  if (frame.landingSpot !== null) landingShapes(out, camera, frame.landingSpot);
  if (!frame.view.marker_hidden) {
    signShapes(out, camera);
    const sheet = project(camera, sheetWorld());
    if (sheet.length >= 3) keepClear.push(grow(boundsOf(sheet), OVERLAY.clearPx * ui));
  }
  // After the room and the sign, farthest first: a person in front of the sign hides it, as in the simulator.
  actorShapes(out, camera, frame.view.actors);
  if (frame.marker && frame.marker.length === 4) {
    const width = OVERLAY.trackingPx * ui;
    const ring = trackingRing(frame.marker, OVERLAY.trackingGapPx * ui + width / 2);
    poly(out, "tracking", ring, { stroke: "ink", width });
    keepClear.push(grow(boundsOf(ring), OVERLAY.clearPx * ui));
  }
  obstacleShapes(out, frame.obstacles, ui, measure, keepClear);
  return out;
}

// ---------------------------------------------------------------------------------------------- //
// painting

type Ctx = CanvasRenderingContext2D;

const fontOf = (weight: number, size: number, family: string) => `${weight} ${size}px ${family}`;

function paintShape(ctx: Ctx, s: Shape, theme: SceneTheme): void {
  if (s.type === "path") {
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (s.closed) ctx.closePath();
    if (s.fill && s.closed) {
      ctx.fillStyle = theme[s.fill];
      ctx.fill();
    }
    if (s.stroke) {
      ctx.setLineDash(s.dash ? [...s.dash] : []);
      ctx.strokeStyle = theme[s.stroke];
      ctx.lineWidth = s.width;
      ctx.stroke();
      if (s.dash) ctx.setLineDash([]);
    }
    return;
  }
  ctx.save();
  if (s.transform) ctx.transform(...s.transform);
  ctx.fillStyle = theme[s.tone];
  ctx.font = fontOf(s.weight, s.size, theme.fontFamily);
  ctx.textAlign = s.align;
  ctx.textBaseline = "alphabetic";
  if (s.maxWidth === null) ctx.fillText(s.text, s.x, s.y);
  else ctx.fillText(s.text, s.x, s.y, s.maxWidth);
  ctx.restore();
}

/**
 * Paint one frame. `scale` is canvas pixels per frame pixel; `uiScale` is frame pixels per CSS pixel of the
 * displayed picture (the flight logic's marks keep their on-screen size).
 */
export function drawScene(ctx: Ctx, frame: SceneFrame, scale: number, theme: SceneTheme, uiScale = DEFAULT_UI_SCALE): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineJoin = "round";
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  const measure = (text: string, size: number, weight: number) => {
    ctx.font = fontOf(weight, size, theme.fontFamily);
    return ctx.measureText(text).width;
  };
  for (const shape of buildScene(frame, { uiScale, measure })) paintShape(ctx, shape, theme);
}
