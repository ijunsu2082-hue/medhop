"""Simulated people and objects in the corridor (experimental obstacle avoidance, SPEC section 11).

An actor is an upright box standing on the floor: a footprint `width_m` along the wall by `depth_m`
toward the room, `height_m` tall, centred `x_m` along the wall and `distance_m` from it (the frame of
sim.py: the station wall is z = 0 and the drone flies at z < 0, so an actor's centre is at
z = -distance_m). It may move at a constant velocity between two times measured from the takeoff
(see `Actor.at`).

Each camera frame the simulator captures carries every actor's bounding box as that camera sees it
(`actor_box`: the box's corners through the same pinhole camera the renderer uses, clipped to the
picture; nothing when it is wholly outside or behind the camera). Both render paths draw each actor
as a plain dark silhouette in front of the wall (`draw_actors`), so an actor standing between the
camera and the sign really hides the marker from the detector.

The boxes are simulator truth: a perfect detector that never misses anything and never sees
anything that is not there. Real detection (the optional person check) is nothing like that.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

ACTOR_KINDS = ("person", "object")
NEAR_M = 0.05                       # points closer to the camera than this are clipped away
PERSON_BGR = (54, 50, 48)           # silhouettes: dark, plain, no texture (nothing to decode as a marker)
OBJECT_BGR = (74, 82, 88)

Box = Tuple[float, float, float, float]


@dataclass(frozen=True)
class Actor:
    kind: str = "person"            # "person" or "object"
    x_m: float = 0.0                # footprint centre along the wall (+ = right, facing the wall)
    distance_m: float = 1.5         # footprint centre's distance from the wall
    width_m: float = 0.45           # along the wall
    depth_m: float = 0.30           # toward the room
    height_m: float = 1.70
    vx_m_s: float = 0.0             # velocity along the wall while moving
    vd_m_s: float = 0.0             # velocity away from the wall while moving
    move_from_s: float = 0.0        # moves between these times after the takeoff
    move_until_s: float = 0.0

    def __post_init__(self) -> None:
        if self.kind not in ACTOR_KINDS:
            raise ValueError(f"actor kind must be one of {ACTOR_KINDS}, got {self.kind!r}")
        if min(self.width_m, self.depth_m, self.height_m) <= 0:
            raise ValueError("actor width, depth and height must be positive")

    def at(self, since_takeoff_s: Optional[float]) -> "Actor":
        """Where the actor is `since_takeoff_s` after the takeoff (None: not taken off yet, so it is
        still at its start). It moves only between move_from_s and move_until_s."""
        if since_takeoff_s is None or self.move_until_s <= self.move_from_s:
            return self
        moved = max(0.0, min(since_takeoff_s, self.move_until_s) - self.move_from_s)
        if moved <= 0.0:
            return self
        return replace(self, x_m=self.x_m + self.vx_m_s * moved, distance_m=self.distance_m + self.vd_m_s * moved)

    def as_status(self) -> Dict[str, object]:
        return {"kind": self.kind, "x_m": round(self.x_m, 3), "distance_m": round(self.distance_m, 3),
                "width_m": round(self.width_m, 3), "depth_m": round(self.depth_m, 3),
                "height_m": round(self.height_m, 3)}


@dataclass(frozen=True)
class Scenario:
    name: str
    actors: Tuple[Actor, ...]
    start_distance_m: Optional[float]   # None: keep the simulator's own start distance
    description: str


# Times are seconds after the takeoff toggle takes effect. An automatic run sends that toggle at the
# end of its 5 s countdown, waits 4 s, and is usually approaching the sign about 4.5 s after the
# toggle; the people below step in a few seconds later, after the sign has grown in the picture (the
# runner's evidence that the drone is flying), from outside the camera's view.
SCENARIOS: Dict[str, Scenario] = {s.name: s for s in (
    Scenario("empty", (), None, "nothing in the corridor"),
    Scenario("crossing", (
        Actor("person", x_m=-3.6, distance_m=1.6, vx_m_s=1.2, move_from_s=7.0, move_until_s=13.0),
    ), 4.2, "a person walks across the corridor about 1.6 m from the wall"),
    Scenario("standing", (
        Actor("person", x_m=-3.0, distance_m=1.4, vx_m_s=1.0, move_from_s=6.0, move_until_s=9.0),
    ), 4.2, "a person steps into the lane about 1.4 m from the wall and stays"),
    Scenario("cart", (
        Actor("object", x_m=0.15, distance_m=1.5, width_m=0.60, depth_m=0.40, height_m=0.90),
    ), 4.2, "a cart in the lane about 1.5 m from the wall, slightly off centre"),
    Scenario("blocked", (
        Actor("person", x_m=-3.5, distance_m=1.75, vx_m_s=1.0, move_from_s=6.5, move_until_s=9.0),
        Actor("person", x_m=3.5, distance_m=1.75, vx_m_s=-1.0, move_from_s=6.5, move_until_s=9.0),
        Actor("person", x_m=-4.0, distance_m=1.45, vx_m_s=1.0, move_from_s=6.5, move_until_s=10.5),
    ), 4.2, "three people stand across the corridor: the lane and both sides are blocked"),
)}
SCENARIO_NAMES = tuple(SCENARIOS)


def corners(actor: Actor) -> np.ndarray:
    """The 8 corners of the actor's box in world coordinates (x, y, z), z = -distance."""
    hw, hd = actor.width_m / 2.0, actor.depth_m / 2.0
    xs = (actor.x_m - hw, actor.x_m + hw)
    zs = (-(actor.distance_m + hd), -(actor.distance_m - hd))
    return np.array([[x, y, z] for x in xs for y in (0.0, actor.height_m) for z in zs], dtype=np.float64)


# corner indices that differ in exactly one coordinate (the 12 edges of the box)
_EDGES = tuple((i, j) for i in range(8) for j in range(i + 1, 8) if bin(i ^ j).count("1") == 1)


def camera_points(actor: Actor, cam: np.ndarray, rot: np.ndarray, near: float = NEAR_M) -> np.ndarray:
    """The actor's box in camera coordinates (right, down, forward), clipped to forward >= near.

    Returns the corners in front of the camera plus the points where edges cross the near plane: the
    vertices of the clipped box, whose projection bounds the box's image exactly."""
    pts = (corners(actor) - cam) @ rot.T
    keep = [p for p in pts if p[2] >= near]
    for i, j in _EDGES:
        a, b = pts[i], pts[j]
        if (a[2] - near) * (b[2] - near) < 0.0:
            t = (near - a[2]) / (b[2] - a[2])
            keep.append(a + t * (b - a))
    return np.array(keep, dtype=np.float64).reshape(-1, 3)


def project(points_cam: np.ndarray, K: np.ndarray) -> np.ndarray:
    """Pixel coordinates (u, v) of camera-frame points (all in front of the camera)."""
    if points_cam.size == 0:
        return np.zeros((0, 2))
    uvw = points_cam @ K.T
    return uvw[:, :2] / uvw[:, 2:3]


def actor_box(actor: Actor, cam: np.ndarray, rot: np.ndarray, K: np.ndarray, width: int,
              height: int) -> Optional[Box]:
    """Bounding box (x1, y1, x2, y2 as fractions of the frame) of the actor as the camera sees it,
    clipped to the frame. None when it is wholly outside the picture or behind the camera."""
    uv = project(camera_points(actor, cam, rot), K)
    if uv.shape[0] == 0:
        return None
    x1, y1 = float(uv[:, 0].min()), float(uv[:, 1].min())
    x2, y2 = float(uv[:, 0].max()), float(uv[:, 1].max())
    x1, x2 = max(0.0, x1), min(float(width), x2)
    y1, y2 = max(0.0, y1), min(float(height), y2)
    if x2 - x1 < 0.5 or y2 - y1 < 0.5:
        return None
    return (x1 / width, y1 / height, x2 / width, y2 / height)


def actor_boxes(actors: Sequence[Actor], cam: np.ndarray, rot: np.ndarray, K: np.ndarray, width: int,
                height: int) -> Tuple[Tuple[str, Box], ...]:
    out: List[Tuple[str, Box]] = []
    for actor in actors:
        box = actor_box(actor, cam, rot, K, width, height)
        if box is not None:
            out.append((actor.kind, tuple(round(v, 5) for v in box)))
    return tuple(out)


def draw_actors(canvas: np.ndarray, actors: Sequence[Actor], cam: np.ndarray, rot: np.ndarray,
                K: np.ndarray) -> None:
    """Fill each actor's silhouette (the convex outline of its projected box) into the canvas,
    farthest first, so nearer actors cover farther ones and every actor covers the wall and sign."""
    if not actors:
        return
    shapes = []
    for actor in actors:
        pts = camera_points(actor, cam, rot)
        if pts.shape[0] < 3:
            continue
        uv = project(pts, K)
        # far outside the canvas: keep the fixed-point coordinates in range
        uv = np.clip(uv, -4.0 * canvas.shape[1], 5.0 * canvas.shape[1])
        depth = float(np.linalg.norm(np.array([actor.x_m, 0.0, -actor.distance_m]) - cam * np.array([1, 0, 1])))
        shapes.append((depth, actor.kind, uv))
    for _depth, kind, uv in sorted(shapes, key=lambda item: -item[0]):
        hull = cv2.convexHull(np.round(uv * 16.0).astype(np.int32))
        cv2.fillConvexPoly(canvas, hull, PERSON_BGR if kind == "person" else OBJECT_BGR, cv2.LINE_AA, 4)


def footprint_distance(actor: Actor, x_m: float, distance_m: float) -> float:
    """Horizontal distance (metres) from a point (x along the wall, distance from the wall) to the
    actor's footprint; 0 inside it. Simulator truth, for tests and the status."""
    dx = max(abs(x_m - actor.x_m) - actor.width_m / 2.0, 0.0)
    dz = max(abs(distance_m - actor.distance_m) - actor.depth_m / 2.0, 0.0)
    return math.hypot(dx, dz)
