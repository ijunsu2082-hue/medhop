"""Obstacle avoidance for the station run: pure maths and a small state machine (no I/O, no clock).

EXPERIMENTAL and simulator-tested only. It has never been flown near people. It is not a safety
system: on the real drone it only knows about people, only when the optional person check is
enabled, and that check can miss people. A human pilot stays responsible for keeping the corridor
empty (SPEC sections 1 and 11).

It only ever slows down, holds, backs off a little or gives up. Going round an obstacle was tried and
removed (SPEC 11.7): with this camera it failed on 19 of 20 simulator runs and once passed 0.49 m
from a person.

What is seen. Each obstacle is a box in the picture (fractions of the frame). Its distance comes from
the box alone, never from simulator truth:
  - floor plane: the camera is level at `camera_height_m`, so a box whose bottom edge is inside the
    picture and below the horizon stands on the floor at camera_height * focal / (drop of that edge
    below the horizon);
  - a person whose box top is inside the picture too: also an assumed 1.7 m height; the smaller wins;
  - a box cut off at the bottom of the picture (its base is closer than the floor at the bottom row,
    about 2.54 m with the 70 degree, 16:9 camera at 1 m) counts as very close (distance None), and as
    in the lane wherever it is in the picture, because its sideways position cannot be told.
Sideways position and half-width follow from the box's centre and width at that distance. "In the
lane" means its nearer edge is within `lane_half_m` of the drone's line of flight (the camera axis).

What the drone does (`Avoider.update`, once per frame):
  clear     nothing in the lane closer than slow_distance_m;
  slow      something in the lane closer than slow_distance_m: forward stick at most slow_pitch;
  hold      closer than hold_distance_m (or very close): no forward stick and no yaw, and closer than
            back_distance_m (or very close) a small backward stick; roll keeps the drone where it was
            sideways, measured on the sign while it is in view (its bearing and distance: a fixed
            landmark), else on the obstacle's box while its distance can be told. Back to moving only
            after the lane has been clear for clear_confirm_s on current evidence;
  blocked   held for blocked_timeout_s in total: the run ends path_blocked.

Signs follow steering.py: +roll slides right, +pitch flies forward, lateral + is right of the line of
flight.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from medhop.config import AVOID_MODES  # noqa: F401  ("off", "hold")
from medhop.mission.steering import limit_rise

CLEAR, SLOW, HOLD, BLOCKED = "clear", "slow", "hold", "blocked"
AVOID_STATES = (CLEAR, SLOW, HOLD, BLOCKED)
NOT_MOVING_ON = (HOLD, BLOCKED)   # time in these does not count against the run timeout

Box = Tuple[float, float, float, float]


@dataclass
class AvoidConfig:
    # the design figures (SPEC section 11)
    lane_half_m: float = 0.55
    slow_distance_m: float = 3.0
    hold_distance_m: float = 1.8
    back_distance_m: float = 0.9
    slow_pitch: float = 0.10
    back_pitch: float = -0.08
    clear_confirm_s: float = 1.0
    blocked_timeout_s: float = 25.0
    # camera geometry (level camera at the hover height; 16:9 like the drone's 640x360 stream)
    camera_height_m: float = 1.0
    # On the ground before an automatic takeoff the camera is only a few centimetres up (4 cm in the
    # simulator): the start blocker judges "in the lane" with this height then.
    ground_camera_height_m: float = 0.04
    hfov_deg: float = 70.0
    frame_aspect: float = 16.0 / 9.0
    person_height_m: float = 1.7
    edge_margin: float = 0.004       # a box edge this close to the frame border counts as cut off
    horizon_margin: float = 0.01     # the bottom edge must be at least this far below the horizon
    # holding still sideways (on the sign, else on the obstacle's box)
    lat_kp: float = 0.3              # roll per metre the drone has moved sideways ...
    lat_ki: float = 0.1              # ... and per metre-second (learns the roll that cancels a drift)
    roll_max: float = 0.15           # the mixer's mission roll limit
    roll_rise_per_s: float = 1.0
    match_fw: float = 0.15           # a box this close (frame widths) to the last one is the same thing


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
def focal_fw(cfg: AvoidConfig) -> float:
    """Focal length in frame widths."""
    return 0.5 / math.tan(math.radians(cfg.hfov_deg) / 2.0)


def focal_fh(cfg: AvoidConfig) -> float:
    """Focal length in frame heights."""
    return focal_fw(cfg) * cfg.frame_aspect


def blind_distance_m(cfg: AvoidConfig) -> float:
    """Distance at which the floor leaves the bottom of the picture: closer than this an object's
    base is out of view (about 2.54 m at 1.0 m with the 70 degree 16:9 camera)."""
    return cfg.camera_height_m * focal_fh(cfg) / 0.5


def floor_distance_m(y2: float, cfg: AvoidConfig) -> Optional[float]:
    """Distance (along the camera axis) of a point on the floor seen at image row y2 (fraction of the
    frame height). None when y2 is not clearly below the horizon."""
    drop = y2 - 0.5
    if drop <= cfg.horizon_margin:
        return None
    return cfg.camera_height_m * focal_fh(cfg) / drop


@dataclass(frozen=True)
class Seen:
    """One obstacle with what its box tells about where it is."""

    kind: str
    box: Box
    ts: float
    distance_m: Optional[float]      # None: its base is out of the picture, so it counts as very close
    lateral_m: Optional[float]       # centre, + = right of the line of flight (None when very close)
    half_width_m: Optional[float]
    near_m: Optional[float]          # its nearer edge's distance from the line of flight (0: across it)
    in_lane: bool

    @property
    def very_close(self) -> bool:
        return self.distance_m is None

    @property
    def lo_m(self) -> Optional[float]:
        return None if self.lateral_m is None else self.lateral_m - self.half_width_m

    @property
    def hi_m(self) -> Optional[float]:
        return None if self.lateral_m is None else self.lateral_m + self.half_width_m

    @property
    def cx(self) -> float:
        return 0.5 * (self.box[0] + self.box[2])


def estimate(kind: str, box: Box, ts: float, cfg: AvoidConfig) -> Seen:
    x1, y1, x2, y2 = (float(v) for v in box)
    distance: Optional[float] = None
    if y2 < 1.0 - cfg.edge_margin:
        distance = floor_distance_m(y2, cfg)
        if distance is not None and kind == "person" and y1 > cfg.edge_margin and y2 - y1 > 1e-6:
            distance = min(distance, cfg.person_height_m * focal_fh(cfg) / (y2 - y1))
    if distance is None:
        return Seen(kind, (x1, y1, x2, y2), ts, None, None, None, None, True)
    f = focal_fw(cfg)
    lo, hi = (x1 - 0.5) * distance / f, (x2 - 0.5) * distance / f
    near = 0.0 if lo <= 0.0 <= hi else min(abs(lo), abs(hi))
    return Seen(kind, (x1, y1, x2, y2), ts, distance, 0.5 * (lo + hi), 0.5 * (hi - lo), near,
                near <= cfg.lane_half_m)


def nearest(items: Sequence[Seen]) -> Optional[Seen]:
    """The closest of these; anything very close comes first."""
    if not items:
        return None
    return min(items, key=lambda s: -1.0 if s.distance_m is None else s.distance_m)


def sign_lateral_m(cx: float, range_m: float, cfg: AvoidConfig) -> float:
    """The camera's sideways position (metres, + = right) relative to the line through the sign along
    the camera's current heading, from the sign's centre in the picture (fraction of the frame width)
    and its distance. With the heading held still this is a fixed frame: it changes only when the
    drone moves sideways (or the heading drifts)."""
    bearing = math.atan2(cx - 0.5, focal_fw(cfg))
    return -range_m * math.sin(bearing)


@dataclass(frozen=True)
class AvoidCommand:
    state: str
    pitch_cap: Optional[float] = None   # forward stick at most this (None: no limit)
    pitch: Optional[float] = None       # send this pitch instead (backing off)
    roll: Optional[float] = None        # send this roll instead (holding still sideways)
    freeze_yaw: bool = False            # send no yaw (holding)
    blocked: bool = False               # end the run: path_blocked
    reason: Optional[str] = None        # why blocked: "timeout"


# --------------------------------------------------------------------------- #
# the state machine
# --------------------------------------------------------------------------- #
class Avoider:
    """Driven once per frame by the runner (`update`). No I/O and no clock: `now` is passed in."""

    def __init__(self, cfg: Optional[AvoidConfig] = None) -> None:
        self.cfg = cfg or AvoidConfig()
        self.reset()

    def reset(self) -> None:
        """Start of a run."""
        self.state = CLEAR
        self.target: Optional[Seen] = None      # what it is reacting to
        self.no_progress_s = 0.0                # time held
        self.holds = 0
        self.blocked_reason: Optional[str] = None
        self.events: List[Dict[str, Any]] = []   # state changes, for the run trace
        self._last_now: Optional[float] = None
        self._clear_since: Optional[float] = None
        self._roll = 0.0
        self._sign: Optional[Tuple[float, float]] = None
        # holding still sideways: the sign-based position to keep, the obstacle box's lateral position
        # to keep (and the box it belongs to), and the integral (the roll that cancels a steady drift)
        self._lat: Dict[str, Any] = {"sign_ref": None, "ref": None, "of": None, "i": 0.0}

    # ------------------------------------------------------------------ #
    def update(self, now: float, seen: Sequence[Seen], fresh: bool = True,
               sign: Optional[Tuple[float, float]] = None) -> AvoidCommand:
        """One step. `seen`: this frame's obstacles. `fresh`: whether `seen` is current evidence (on the
        real drone the person check can fall behind). `sign`: (centre as a fraction of the frame width,
        distance in metres) of the station sign when it is in this frame, for holding still sideways."""
        cfg = self.cfg
        dt = 0.0 if self._last_now is None else max(0.0, min(0.5, now - self._last_now))
        self._last_now = now
        self._sign = sign
        if self.state == BLOCKED:
            return self._blocked_command()
        if self.state == HOLD:
            self.no_progress_s += dt
            if self.no_progress_s >= cfg.blocked_timeout_s:
                return self._block(now, "timeout")
            return self._hold(now, dt, seen if fresh else None)
        return self._moving(now, seen if fresh else None)

    # ------------------------------------------------------------------ #
    def _set(self, state: str, now: float, target: Optional[Seen], **extra: Any) -> None:
        self.target = target
        if state != self.state:
            self.state = state
            self.events.append({
                "t": round(now, 3), "state": state,
                "kind": None if target is None else target.kind,
                "distance_m": None if target is None or target.distance_m is None else round(target.distance_m, 2),
                **extra,
            })
            if len(self.events) > 200:
                del self.events[:50]

    def _block(self, now: float, reason: str) -> AvoidCommand:
        self.blocked_reason = reason
        self._set(BLOCKED, now, self.target, reason=reason)
        return self._blocked_command()

    def _blocked_command(self) -> AvoidCommand:
        return AvoidCommand(BLOCKED, pitch_cap=0.0, pitch=0.0, roll=0.0, blocked=True, reason=self.blocked_reason)

    def _hold_command(self, target: Optional[Seen], roll: float) -> AvoidCommand:
        cfg = self.cfg
        back = target is not None and (target.distance_m is None or target.distance_m < cfg.back_distance_m)
        return AvoidCommand(HOLD, pitch_cap=0.0, pitch=cfg.back_pitch if back else None, roll=roll,
                            freeze_yaw=True)

    def _same(self, previous: Seen, current: Seen) -> bool:
        return previous.kind == current.kind and abs(previous.cx - current.cx) <= self.cfg.match_fw

    def _hold_roll(self, dt: float, target: Optional[Seen]) -> float:
        """Roll that keeps the drone where it was sideways (PI; the integral learns the roll that cancels
        a steady drift and starts at zero). Measured on the sign while it is in view (with yaw held still
        its bearing and distance give the drone's sideways position), else on `target`'s box while its
        distance can be told; without either, the integral alone is sent. Rises at most
        roll_rise_per_s; reductions are immediate."""
        cfg, lat = self.cfg, self._lat
        raw = lat["i"]
        err: Optional[float] = None                            # metres the drone has moved left (+)
        if self._sign is not None:
            here = sign_lateral_m(self._sign[0], self._sign[1], cfg)
            if lat["sign_ref"] is None:
                lat["sign_ref"] = here                         # start from where it is now
            err = lat["sign_ref"] - here
        elif target is not None and target.lateral_m is not None:
            if lat["ref"] is None or lat["of"] is None or not self._same(lat["of"], target):
                lat["ref"] = target.lateral_m
            lat["of"] = target
            err = target.lateral_m - lat["ref"]                # it moved right: the drone moved left
        if err is not None:
            lat["i"] = max(-cfg.roll_max, min(cfg.roll_max, lat["i"] + cfg.lat_ki * err * dt))
            raw = cfg.lat_kp * err + lat["i"]
        raw = max(-cfg.roll_max, min(cfg.roll_max, raw))
        self._roll = max(-cfg.roll_max, min(cfg.roll_max, limit_rise(self._roll, raw, dt, cfg.roll_rise_per_s)))
        return self._roll

    # ------------------------------------------------------------------ #
    def _moving(self, now: float, seen: Optional[Sequence[Seen]]) -> AvoidCommand:
        cfg = self.cfg
        if seen is None:      # no current evidence: keep what the last evidence said
            return AvoidCommand(SLOW, pitch_cap=cfg.slow_pitch) if self.state == SLOW else AvoidCommand(CLEAR)
        target = nearest([s for s in seen if s.in_lane])
        distance = None if target is None else (0.0 if target.distance_m is None else target.distance_m)
        if distance is not None and distance < cfg.hold_distance_m:
            self.holds += 1
            self._clear_since = None
            self._roll = 0.0
            self._lat = {"sign_ref": None, "ref": None, "of": None, "i": 0.0}
            self._set(HOLD, now, target)
            return self._hold_command(target, self._hold_roll(0.0, target))
        if distance is not None and distance < cfg.slow_distance_m:
            self._set(SLOW, now, target)
            return AvoidCommand(SLOW, pitch_cap=cfg.slow_pitch)
        self._set(CLEAR, now, None)
        return AvoidCommand(CLEAR)

    def _hold(self, now: float, dt: float, seen: Optional[Sequence[Seen]]) -> AvoidCommand:
        cfg = self.cfg
        if seen is None:
            self._clear_since = None              # "clear" needs current evidence
            return self._hold_command(self.target, self._hold_roll(dt, None))
        lane = [s for s in seen if s.in_lane]
        target = nearest(lane)
        if any(s.distance_m is None or s.distance_m < cfg.slow_distance_m for s in lane):
            self._clear_since = None
            self.target = target
        else:
            if self._clear_since is None:
                self._clear_since = now
            if now - self._clear_since >= cfg.clear_confirm_s:
                self._roll = 0.0
                self._set(CLEAR, now, None)
                return self._moving(now, seen)
        return self._hold_command(target, self._hold_roll(dt, target))

    # ------------------------------------------------------------------ #
    def snapshot(self) -> Dict[str, Any]:
        target = self.target
        return {
            "state": self.state,
            "kind": None if target is None else target.kind,
            "distance_m": None if target is None or target.distance_m is None else round(target.distance_m, 2),
            "held_s": round(self.no_progress_s, 1),
        }
