// The simulator camera as a pinhole model, the same one backend/medhop/drone/sim.py renders with: a level camera
// with a 70 degree horizontal field of view. World axes: x to the right along the station wall, y up from the
// floor, z toward the station wall, which is the plane z = 0 (the room is at z < 0).

export interface CameraPose {
  /** metres along the wall; 0 is the sign's centre line */
  x: number;
  /** metres; negative, the wall is at 0 */
  z: number;
  /** radians; 0 faces the wall square-on, positive turns to the right */
  heading: number;
  /** camera height above the floor, metres */
  camY: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A point in camera space: x right, y down, z forward (depth). */
export interface CamPoint {
  x: number;
  y: number;
  z: number;
}

export interface Pixel {
  x: number;
  y: number;
}

export const HFOV_DEG = 70;
/** Nothing closer than this to the camera plane is drawn. */
export const NEAR_M = 0.05;

export function focalPx(frameWidth: number): number {
  return frameWidth / 2 / Math.tan((HFOV_DEG * Math.PI) / 180 / 2);
}

export function toCamera(pose: CameraPose, p: Vec3): CamPoint {
  const sin = Math.sin(pose.heading);
  const cos = Math.cos(pose.heading);
  const dx = p.x - pose.x;
  const dy = p.y - pose.camY;
  const dz = p.z - pose.z;
  return { x: dx * cos - dz * sin, y: -dy, z: dx * sin + dz * cos };
}

export function toPixel(c: CamPoint, frameWidth: number, frameHeight: number): Pixel {
  const f = focalPx(frameWidth);
  return { x: frameWidth / 2 + (f * c.x) / c.z, y: frameHeight / 2 + (f * c.y) / c.z };
}

/** Cut a polygon (camera space) against the near plane, so nothing behind the camera is ever projected. */
export function clipNear(points: CamPoint[]): CamPoint[] {
  const out: CamPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const aIn = a.z >= NEAR_M;
    const bIn = b.z >= NEAR_M;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_M - a.z) / (b.z - a.z);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR_M });
    }
  }
  return out;
}

/** World polygon to frame pixels, clipped at the near plane. Fewer than three points means it is not visible. */
export function projectPolygon(pose: CameraPose, world: Vec3[], frameWidth: number, frameHeight: number): Pixel[] {
  const clipped = clipNear(world.map((p) => toCamera(pose, p)));
  if (clipped.length < 3) return [];
  return clipped.map((c) => toPixel(c, frameWidth, frameHeight));
}

/** World line segment to frame pixels, clipped at the near plane; null when it is wholly behind the camera. */
export function projectSegment(
  pose: CameraPose,
  a: Vec3,
  b: Vec3,
  frameWidth: number,
  frameHeight: number,
): [Pixel, Pixel] | null {
  let ca = toCamera(pose, a);
  let cb = toCamera(pose, b);
  if (ca.z < NEAR_M && cb.z < NEAR_M) return null;
  if (ca.z < NEAR_M || cb.z < NEAR_M) {
    const t = (NEAR_M - ca.z) / (cb.z - ca.z);
    const cut = { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: NEAR_M };
    if (ca.z < NEAR_M) ca = cut;
    else cb = cut;
  }
  return [toPixel(ca, frameWidth, frameHeight), toPixel(cb, frameWidth, frameHeight)];
}
