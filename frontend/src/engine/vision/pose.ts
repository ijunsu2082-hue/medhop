// Ports backend/medhop/vision/pose.py: where the camera is relative to the station sign, from the
// sign's four corners in one frame. Checked against Python by pose.test.ts (fixture:
// __fixtures__/pose.json, written by backend/tools/parity_traces.py pose).
//
// Classical geometry (a pinhole camera model fitted by least squares). Used by the final line-up
// before landing: how far the drone is left or right of the sign's centre line, and how far from the
// wall, in metres.
//
// Frame of reference (as seen by someone standing in front of the sign, facing it):
//     X  to the right along the wall, Y up, Z out of the wall toward the room. Origin: centre of the
//     printed marker. The camera sits at (X, Y, Z) with Z > 0.
//     `lateral_m` = X: positive means the drone is to the RIGHT of the sign's centre line.
//     `distance_m` = Z: metres from the wall.
//
// Why not a general PnP solver: a square seen nearly head-on has two almost equally good 3D poses (the
// "flip" ambiguity), and they disagree exactly on the sign of the sideways offset we need. A small
// drone flies level and the sign hangs upright, so the camera is modelled with yaw, pitch and a little
// roll only. That model has one answer: the nearer vertical edge of the marker looks taller.
//
// Scale: the metres depend on the camera's field of view (Settings.camera_hfov_deg, unmeasured on the
// real drone), but zero offset does not: "centred on the sign" is right whatever the lens.
//
// Porting notes. numpy's np.linalg.solve (LAPACK) is replaced by solveLinear below, a 6x6 Gaussian
// elimination with partial pivoting. Iteration counts, the damping schedule, the finite-difference step
// and every threshold are the Python ones. The vector products are plain left-to-right sums here while
// numpy hands them to OpenBLAS (other summation order, fused multiply-adds), and LAPACK factorises
// differently, so results agree with Python to rounding, not bit for bit (see pose.test.ts).

import { degrees, pyMax, radians, ValueError } from "../util/num";
import type { Corner } from "./marker";

export interface SignPose {
  /** + = the drone is right of the sign's centre line (facing the sign) */
  readonly lateral_m: number;
  /** metres from the wall */
  readonly distance_m: number;
  /** camera height above the marker centre */
  readonly height_m: number;
  /** + = the camera is turned to its right */
  readonly yaw_deg: number;
  /** fit residual; large means the detection does not fit the model */
  readonly rms_px: number;
}

/** A world point (X, Y, Z) in metres. */
export type WorldPoint = readonly [x: number, y: number, z: number];

/** Camera pose parameters: x, y, z (metres), yaw, pitch, roll (radians). + pitch = nose down. */
export type PoseParams = readonly number[];

/**
 * Python `_project`: pixel coordinates of the world points for camera pose `params`, all u values first,
 * then all v values (numpy's concatenate([u, v])).
 */
export function project(params: PoseParams, world: readonly WorldPoint[], focal: number, cx0: number, cy0: number): number[] {
  const x = params[0]!;
  const y = params[1]!;
  const z = params[2]!;
  const yaw = params[3]!;
  const pitch = params[4]!;
  const roll = params[5]!;
  const sy = Math.sin(yaw);
  const cyaw = Math.cos(yaw);
  let forward = [sy, 0.0, -cyaw]; // optical axis, toward the wall at yaw 0
  let right = [cyaw, 0.0, sy];
  let down = [0.0, -1.0, 0.0];
  const sp = Math.sin(pitch); // + pitch = nose down
  const cp = Math.cos(pitch);
  [forward, down] = [
    forward.map((f, i) => cp * f + sp * down[i]!),
    down.map((d, i) => cp * d - sp * forward[i]!),
  ];
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  [right, down] = [
    right.map((r, i) => cr * r + sr * down[i]!),
    down.map((d, i) => cr * d - sr * right[i]!),
  ];
  const n = world.length;
  const out = new Array<number>(2 * n);
  for (let i = 0; i < n; i++) {
    const w = world[i]!;
    const r0 = w[0] - x;
    const r1 = w[1] - y;
    const r2 = w[2] - z;
    let depth = r0 * forward[0]! + r1 * forward[1]! + r2 * forward[2]!;
    if (Math.abs(depth) < 1e-6) depth = 1e-6;
    const alongRight = r0 * right[0]! + r1 * right[1]! + r2 * right[2]!;
    const alongDown = r0 * down[0]! + r1 * down[1]! + r2 * down[2]!;
    out[i] = cx0 + (focal * alongRight) / depth;
    out[n + i] = cy0 + (focal * alongDown) / depth;
  }
  return out;
}

/**
 * Solve a x = b by Gaussian elimination with partial pivoting (the largest remaining |pivot| in the
 * column, the first one on a tie). Returns null when a pivot is exactly zero, where numpy raises
 * LinAlgError("Singular matrix"); like LAPACK, a NaN pivot does not count as singular.
 */
export function solveLinear(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length;
  const m = a.map((row) => row.slice());
  const rhs = b.slice();
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let best = Math.abs(m[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const candidate = Math.abs(m[row]![col]!);
      if (candidate > best) {
        best = candidate;
        pivotRow = row;
      }
    }
    if (pivotRow !== col) {
      [m[col], m[pivotRow]] = [m[pivotRow]!, m[col]!];
      [rhs[col], rhs[pivotRow]] = [rhs[pivotRow]!, rhs[col]!];
    }
    const pivotLine = m[col]!;
    const pivot = pivotLine[col]!;
    if (pivot === 0) return null;
    for (let row = col + 1; row < n; row++) {
      const line = m[row]!;
      const factor = line[col]! / pivot;
      line[col] = 0.0;
      for (let k = col + 1; k < n; k++) line[k] = line[k]! - factor * pivotLine[k]!;
      rhs[row] = rhs[row]! - factor * rhs[col]!;
    }
  }
  const solution = new Array<number>(n);
  for (let row = n - 1; row >= 0; row--) {
    const line = m[row]!;
    let s = rhs[row]!;
    for (let k = row + 1; k < n; k++) s -= line[k]! * solution[k]!;
    solution[row] = s / line[row]!;
  }
  return solution;
}

function residualOf(params: PoseParams, world: readonly WorldPoint[], focal: number, cx0: number, cy0: number, observed: readonly number[]): number[] {
  const projected = project(params, world, focal, cx0, cy0);
  return projected.map((p, i) => p - observed[i]!);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0.0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** float(np.max(np.abs(v))): NaN if any element is NaN. */
function maxAbs(v: readonly number[]): number {
  let best = -Infinity;
  for (const x of v) {
    const a = Math.abs(x);
    if (Number.isNaN(a)) return Number.NaN;
    if (a > best) best = a;
  }
  return best;
}

/** Fit the camera pose to the detected corners (order TL, TR, BR, BL). null when it fails. */
export function fitSignPose(
  cornersPx: readonly Corner[],
  frameW: number,
  frameH: number,
  markerSizeM: number,
  hfovDeg: number,
  iterations = 12,
): SignPose | null {
  if (cornersPx.length !== 4 || cornersPx.some((c) => c.length !== 2)) {
    throw new ValueError(`cannot reshape array of size ${cornersPx.reduce((s, c) => s + c.length, 0)} into shape (4,2)`);
  }
  const xs = cornersPx.map((c) => c[0]);
  const ys = cornersPx.map((c) => c[1]);
  if (![...xs, ...ys].every((v) => Number.isFinite(v)) || frameW <= 0 || frameH <= 0) return null;
  const focal = frameW / 2.0 / Math.tan(radians(hfovDeg) / 2.0);
  const cx0 = frameW / 2.0;
  const cy0 = frameH / 2.0;
  const half = markerSizeM / 2.0;
  const world: WorldPoint[] = [
    [-half, half, 0.0],
    [half, half, 0.0],
    [half, -half, 0.0],
    [-half, -half, 0.0],
  ];
  const observed = [...xs, ...ys];

  const edges = [0, 1, 2, 3].map((i) => {
    const j = (i + 1) % 4;
    const dx = xs[j]! - xs[i]!;
    const dy = ys[j]! - ys[i]!;
    return Math.sqrt(dx * dx + dy * dy); // np.linalg.norm of the edge vector
  });
  const sizePx = pyMax(edges[0]!, edges[1]!, edges[2]!, edges[3]!);
  if (sizePx < 4.0) return null;
  const centreX = (xs[0]! + xs[1]! + xs[2]! + xs[3]!) / 4;
  const centreY = (ys[0]! + ys[1]! + ys[2]! + ys[3]!) / 4;
  const z0 = (markerSizeM * focal) / sizePx;
  let params: number[] = [0.0, (z0 * (centreY - cy0)) / focal, z0, -Math.atan2(centreX - cx0, focal), 0.0, 0.0];

  let damping = 1e-3;
  let residual = residualOf(params, world, focal, cx0, cy0, observed);
  let cost = dot(residual, residual);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const jac: number[][] = Array.from({ length: 8 }, () => new Array<number>(6).fill(0));
    for (let k = 0; k < 6; k++) {
      const step = 1e-6 * pyMax(1.0, Math.abs(params[k]!));
      const moved = params.slice();
      moved[k] = moved[k]! + step;
      const projected = project(moved, world, focal, cx0, cy0);
      for (let r = 0; r < 8; r++) jac[r]![k] = (projected[r]! - observed[r]! - residual[r]!) / step;
    }
    const normal: number[][] = [];
    const gradient: number[] = [];
    for (let i = 0; i < 6; i++) {
      const row: number[] = [];
      for (let j = 0; j < 6; j++) {
        let s = 0.0;
        for (let r = 0; r < 8; r++) s += jac[r]![i]! * jac[r]![j]!;
        row.push(s);
      }
      normal.push(row);
      let g = 0.0;
      for (let r = 0; r < 8; r++) g += jac[r]![i]! * residual[r]!;
      gradient.push(g);
    }
    let improved = false;
    let delta: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      // normal + damping * np.diag(np.diag(normal) + 1e-9)
      const damped = normal.map((row, i) => row.map((v, j) => v + damping * (i === j ? normal[i]![i]! + 1e-9 : 0.0)));
      const solved = solveLinear(damped, gradient.map((g) => -g));
      if (solved === null) return null;
      delta = solved;
      const trial = params.map((p, i) => p + delta[i]!);
      trial[2] = pyMax(0.05, trial[2]!);
      const trialRes = residualOf(trial, world, focal, cx0, cy0, observed);
      const trialCost = dot(trialRes, trialRes);
      if (trialCost < cost) {
        params = trial;
        residual = trialRes;
        cost = trialCost;
        damping = pyMax(1e-7, damping / 3.0);
        improved = true;
        break;
      }
      damping *= 10.0;
    }
    if (!improved || maxAbs(delta) < 1e-7) break;
  }

  if (!params.every((v) => Number.isFinite(v))) return null;
  return {
    lateral_m: params[0]!,
    distance_m: params[2]!,
    height_m: params[1]!,
    yaw_deg: degrees(params[3]!),
    rms_px: Math.sqrt(cost / 8.0),
  };
}
