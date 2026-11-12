"""Where the camera is relative to the station sign, from the sign's four corners in one frame.

Classical geometry (a pinhole camera model fitted by least squares), not AI. Used by the final
line-up before landing: how far the drone is left or right of the sign's centre line, and how far
from the wall, in metres.

Frame of reference (as seen by someone standing in front of the sign, facing it):
    X  to the right along the wall, Y up, Z out of the wall toward the room. Origin: centre of the
    printed marker. The camera sits at (X, Y, Z) with Z > 0.
    `lateral_m` = X: positive means the drone is to the RIGHT of the sign's centre line.
    `distance_m` = Z: metres from the wall.

Why not cv2.solvePnP: a square seen nearly head-on has two almost equally good 3D poses (the
"flip" ambiguity), and they disagree exactly on the sign of the sideways offset we need. A small
drone flies level and the sign hangs upright, so the camera is modelled with yaw, pitch and a little
roll only. That model has one answer: the nearer vertical edge of the marker looks taller.

Scale: the metres depend on the camera's field of view (Settings.camera_hfov_deg, unmeasured on the
real drone), but zero offset does not: "centred on the sign" is right whatever the lens.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

import numpy as np


@dataclass(frozen=True)
class SignPose:
    lateral_m: float     # + = the drone is right of the sign's centre line (facing the sign)
    distance_m: float    # metres from the wall
    height_m: float      # camera height above the marker centre
    yaw_deg: float       # + = the camera is turned to its right
    rms_px: float        # fit residual; large means the detection does not fit the model


def _project(params: np.ndarray, world: np.ndarray, focal: float, cx0: float, cy0: float) -> np.ndarray:
    x, y, z, yaw, pitch, roll = params
    sy, cy_ = math.sin(yaw), math.cos(yaw)
    forward = np.array([sy, 0.0, -cy_])           # optical axis, toward the wall at yaw 0
    right = np.array([cy_, 0.0, sy])
    down = np.array([0.0, -1.0, 0.0])
    sp, cp = math.sin(pitch), math.cos(pitch)     # + pitch = nose down
    forward, down = cp * forward + sp * down, cp * down - sp * forward
    sr, cr = math.sin(roll), math.cos(roll)
    right, down = cr * right + sr * down, cr * down - sr * right
    rel = world - np.array([x, y, z])
    depth = rel @ forward
    depth = np.where(np.abs(depth) < 1e-6, 1e-6, depth)
    u = cx0 + focal * (rel @ right) / depth
    v = cy0 + focal * (rel @ down) / depth
    return np.concatenate([u, v])


def fit_sign_pose(corners_px: Sequence[Tuple[float, float]], frame_w: int, frame_h: int,
                  marker_size_m: float, hfov_deg: float, iterations: int = 12) -> Optional[SignPose]:
    """Fit the camera pose to the detected corners (order TL, TR, BR, BL). None when it fails."""
    pts = np.asarray(corners_px, dtype=np.float64).reshape(4, 2)
    if not np.all(np.isfinite(pts)) or frame_w <= 0 or frame_h <= 0:
        return None
    focal = (frame_w / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
    cx0, cy0 = frame_w / 2.0, frame_h / 2.0
    half = marker_size_m / 2.0
    world = np.array([[-half, half, 0.0], [half, half, 0.0], [half, -half, 0.0], [-half, -half, 0.0]])
    observed = np.concatenate([pts[:, 0], pts[:, 1]])

    edges = [np.linalg.norm(pts[(i + 1) % 4] - pts[i]) for i in range(4)]
    size_px = max(edges)
    if size_px < 4.0:
        return None
    centre = pts.mean(axis=0)
    z0 = marker_size_m * focal / size_px
    params = np.array([0.0, z0 * (centre[1] - cy0) / focal, z0,
                       -math.atan2(centre[0] - cx0, focal), 0.0, 0.0])

    damping = 1e-3
    residual = _project(params, world, focal, cx0, cy0) - observed
    cost = float(residual @ residual)
    for _ in range(iterations):
        jac = np.empty((8, 6))
        for k in range(6):
            step = 1e-6 * max(1.0, abs(params[k]))
            moved = params.copy()
            moved[k] += step
            jac[:, k] = (_project(moved, world, focal, cx0, cy0) - observed - residual) / step
        normal = jac.T @ jac
        gradient = jac.T @ residual
        improved = False
        for _attempt in range(6):
            try:
                delta = np.linalg.solve(normal + damping * np.diag(np.diag(normal) + 1e-9), -gradient)
            except np.linalg.LinAlgError:
                return None
            trial = params + delta
            trial[2] = max(0.05, trial[2])
            trial_res = _project(trial, world, focal, cx0, cy0) - observed
            trial_cost = float(trial_res @ trial_res)
            if trial_cost < cost:
                params, residual, cost = trial, trial_res, trial_cost
                damping = max(1e-7, damping / 3.0)
                improved = True
                break
            damping *= 10.0
        if not improved or float(np.max(np.abs(delta))) < 1e-7:
            break

    if not np.all(np.isfinite(params)):
        return None
    x, y, z, yaw, _pitch, _roll = params
    return SignPose(lateral_m=float(x), distance_m=float(z), height_m=float(y),
                    yaw_deg=math.degrees(float(yaw)), rms_px=math.sqrt(cost / 8.0))
