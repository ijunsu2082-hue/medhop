// Draws the simulator's camera view as a plain line drawing: the room, the station sign with its real marker
// pattern, and (when the sign is being tracked) an outline around the marker. Pure canvas 2D, no images.

import { projectPolygon, projectSegment, type CameraPose, type Pixel, type Vec3 } from "./camera";
import { FRONT_WALL, LEFT_WALL, LIGHTS_X, LIGHTS_Z, MARKER_7, RIGHT_WALL, ROOM, SHEET_TOP_Y, SIGN, type WallRect } from "./room";

/** The frame the picture is laid out in; the canvas is scaled to it. Same shape as the simulator's display camera. */
export const FRAME_W = 1280;
export const FRAME_H = 720;

export interface SceneFrame {
  pose: CameraPose;
  /** The tracked marker's corners in frame pixels (top-left, top-right, bottom-right, bottom-left), or null. */
  corners: readonly Pixel[] | null;
  /** Distance from the wall, in metres, of the spot the run lands on; null leaves it out. */
  landingSpot: number | null;
}

export interface SceneTheme {
  bg: string;
  fill: string;
  line: string;
  mid: string;
  ink: string;
  fontFamily: string;
}

type Ctx = CanvasRenderingContext2D;

function path(ctx: Ctx, pts: readonly Pixel[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

function quad(ctx: Ctx, pose: CameraPose, world: Vec3[], fill: string | null, stroke: string | null, width = 1.5): void {
  const pts = projectPolygon(pose, world, FRAME_W, FRAME_H);
  if (pts.length < 3) return;
  path(ctx, pts);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

function segment(ctx: Ctx, pose: CameraPose, a: Vec3, b: Vec3, stroke: string, width = 1.5): void {
  const s = projectSegment(pose, a, b, FRAME_W, FRAME_H);
  if (!s) return;
  ctx.beginPath();
  ctx.moveTo(s[0].x, s[0].y);
  ctx.lineTo(s[1].x, s[1].y);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
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
    { x: r.a0, y: r.y1, z: ROOM.z1 },
    { x: r.a1, y: r.y1, z: ROOM.z1 },
    { x: r.a1, y: r.y0, z: ROOM.z1 },
    { x: r.a0, y: r.y0, z: ROOM.z1 },
  ];
}

/** A rectangle on a side wall (x fixed), from z = a0 to a1. */
function onSide(x: number, r: Span): Vec3[] {
  return [
    { x, y: r.y1, z: r.a0 },
    { x, y: r.y1, z: r.a1 },
    { x, y: r.y0, z: r.a1 },
    { x, y: r.y0, z: r.a0 },
  ];
}

/** A rectangle lying flat at height y. */
function flat(y: number, x0: number, x1: number, z0: number, z1: number): Vec3[] {
  return [
    { x: x0, y, z: z0 },
    { x: x1, y, z: z0 },
    { x: x1, y, z: z1 },
    { x: x0, y, z: z1 },
  ];
}

function wallThing(ctx: Ctx, pose: CameraPose, on: (r: Span) => Vec3[], r: WallRect, t: SceneTheme): void {
  quad(ctx, pose, on(r), t.bg, t.mid, 1.5);
  const w = r.a1 - r.a0;
  if (r.kind === "door") {
    // Two recessed panels and a handle.
    quad(ctx, pose, on({ a0: r.a0 + 0.14, a1: r.a1 - 0.14, y0: 1.15, y1: r.y1 - 0.16 }), null, t.line, 1);
    quad(ctx, pose, on({ a0: r.a0 + 0.14, a1: r.a1 - 0.14, y0: 0.2, y1: 0.95 }), null, t.line, 1);
    quad(ctx, pose, on({ a0: r.a0 + w * 0.82, a1: r.a0 + w * 0.92, y0: 1.0, y1: 1.04 }), t.mid, null);
  } else if (r.kind === "print") {
    quad(ctx, pose, on({ a0: r.a0 + 0.06, a1: r.a1 - 0.06, y0: r.y0 + 0.06, y1: r.y1 - 0.06 }), t.fill, t.line, 1);
  } else {
    // A noticeboard with a few sheets pinned to it.
    for (let i = 0; i < 3; i += 1) {
      const a0 = r.a0 + 0.1 + (i * (w - 0.2)) / 3;
      quad(ctx, pose, on({ a0, a1: a0 + (w - 0.2) / 3 - 0.08, y0: r.y0 + 0.14, y1: r.y1 - 0.14 }), t.fill, t.line, 1);
    }
  }
}

function drawRoom(ctx: Ctx, pose: CameraPose, t: SceneTheme): void {
  const { x0, x1, z0, z1, height: h } = ROOM;

  // Floor (the darkest plane, with board joints), then the ceiling with its light panels.
  quad(ctx, pose, flat(0, x0, x1, z0, z1), t.line, null);
  for (let x = x0 + 0.5; x < x1; x += 0.5) {
    segment(ctx, pose, { x, y: 0, z: z0 }, { x, y: 0, z: z1 }, t.fill, 1.5);
  }
  quad(ctx, pose, flat(h, x0, x1, z0, z1), t.bg, null);
  for (const lx of LIGHTS_X) {
    for (const lz of LIGHTS_Z) {
      quad(ctx, pose, flat(h, lx - 0.3, lx + 0.3, lz - 0.3, lz + 0.3), t.fill, t.line, 1);
    }
  }

  // Walls: back, sides, then the station wall. Seen from inside, none of them hides another.
  const front = (r: Span) => onFront(r);
  const leftWall = (r: Span) => onSide(x0, r);
  const rightWall = (r: Span) => onSide(x1, r);
  const whole = (a0: number, a1: number): Span => ({ a0, a1, y0: 0, y1: h });
  quad(ctx, pose, [{ x: x0, y: h, z: z0 }, { x: x1, y: h, z: z0 }, { x: x1, y: 0, z: z0 }, { x: x0, y: 0, z: z0 }], t.fill, t.mid);
  for (const [on, a0, a1] of [[leftWall, z0, z1], [rightWall, z0, z1], [front, x0, x1]] as const) {
    quad(ctx, pose, on(whole(a0, a1)), t.fill, t.mid);
    // A white skirting board, and a rail at 0.9 m.
    quad(ctx, pose, on({ a0, a1, y0: 0, y1: 0.1 }), t.bg, t.mid, 1);
    quad(ctx, pose, on({ a0, a1, y0: 0.88, y1: 0.92 }), t.bg, t.line, 1);
  }

  for (const r of LEFT_WALL) wallThing(ctx, pose, leftWall, r, t);
  for (const r of RIGHT_WALL) wallThing(ctx, pose, rightWall, r, t);
  for (const r of FRONT_WALL) wallThing(ctx, pose, front, r, t);
}

function drawLandingSpot(ctx: Ctx, pose: CameraPose, distance: number, t: SceneTheme): void {
  const ring: Vec3[] = [];
  for (let i = 0; i < 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    ring.push({ x: 0.15 * Math.cos(a), y: 0, z: -distance + 0.15 * Math.sin(a) });
  }
  const pts = projectPolygon(pose, ring, FRAME_W, FRAME_H);
  if (pts.length < 3) return;
  path(ctx, pts);
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = t.mid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawSign(ctx: Ctx, pose: CameraPose, t: SceneTheme): void {
  const half = SIGN.sheetWidth / 2;
  const sheetBottom = SHEET_TOP_Y - SIGN.sheetHeight;
  quad(ctx, pose, onFront({ a0: -half, a1: half, y0: sheetBottom, y1: SHEET_TOP_Y }), t.bg, t.mid, 1);

  const m = SIGN.markerSize;
  const left = -m / 2;
  const top = SIGN.markerCentreY + m / 2;
  quad(ctx, pose, onFront({ a0: left, a1: left + m, y0: top - m, y1: top }), t.ink, null);
  const cell = m / MARKER_7.length;
  MARKER_7.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== "1") continue;
      const span = { a0: left + c * cell, a1: left + (c + 1) * cell, y0: top - (r + 1) * cell, y1: top - r * cell };
      quad(ctx, pose, onFront(span), t.bg, t.bg, 0.5);
    }
  });

  // The caption under the marker, set in the sheet's own perspective (an affine fit is close enough at this size).
  const baselineY = top - m - 0.03;
  const fit = projectPolygon(
    pose,
    [
      { x: -half, y: baselineY + 0.012, z: ROOM.z1 },
      { x: half, y: baselineY + 0.012, z: ROOM.z1 },
      { x: -half, y: baselineY, z: ROOM.z1 },
    ],
    FRAME_W,
    FRAME_H,
  );
  if (fit.length !== 3) return;
  const [p0, px, py] = fit as [Pixel, Pixel, Pixel];
  if (Math.hypot(px.x - p0.x, px.y - p0.y) < 40) return;
  // Local units are millimetres on the sheet: x across its 210 mm, y down over the 12 mm cap height.
  ctx.save();
  ctx.transform((px.x - p0.x) / 210, (px.y - p0.y) / 210, (py.x - p0.x) / 12, (py.y - p0.y) / 12, p0.x, p0.y);
  ctx.fillStyle = t.ink;
  ctx.font = "600 17px " + t.fontFamily;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(SIGN.caption, 105, 12, 190);
  ctx.restore();
}

function drawTracking(ctx: Ctx, corners: readonly Pixel[], t: SceneTheme): void {
  if (corners.length !== 4) return;
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
  // Drawn just outside the marker, on the white of the sheet, so the black marker itself stays untouched.
  const grown = corners.map((p) => ({ x: cx + (p.x - cx) * 1.14, y: cy + (p.y - cy) * 1.14 }));
  path(ctx, grown);
  ctx.strokeStyle = t.ink;
  ctx.lineWidth = 3;
  ctx.stroke();
}

/** Paint one frame. `scale` is canvas pixels per frame pixel. */
export function drawScene(ctx: Ctx, frame: SceneFrame, scale: number, theme: SceneTheme): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineJoin = "round";
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  drawRoom(ctx, frame.pose, theme);
  if (frame.landingSpot !== null) drawLandingSpot(ctx, frame.pose, frame.landingSpot, theme);
  drawSign(ctx, frame.pose, theme);
  if (frame.corners) drawTracking(ctx, frame.corners, theme);
}
