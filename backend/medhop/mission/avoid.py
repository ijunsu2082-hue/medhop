"""Obstacle avoidance for the station run: pure maths and a small state machine (no I/O, no clock).

EXPERIMENTAL and simulator-tested only. It has never been flown near people. It is not a safety
system: on the real drone it only knows about people, only when the optional person check is
enabled, and that check can miss people. A human pilot stays responsible for keeping the corridor
empty (SPEC sections 1 and 11).

What is seen. Each obstacle is a box in the picture (`Obstacle`, fractions of the frame). Its
distance comes from the box alone, never from simulator truth:
  - floor plane: the camera is level at `camera_height_m`, so a box whose bottom edge is inside the
    picture and below the horizon stands on the floor at camera_height * focal / (pixel drop of that
    edge below the horizon);
  - a person whose box top is inside the picture too: also an assumed 1.7 m height; the smaller wins;
  - a box cut off at the bottom of the picture (its base is closer than the floor at the bottom row,
    about 2.6 m with the 70 degree, 16:9 camera at 1 m) counts as very close (distance None), and as
    in the lane wherever it is in the picture, because its sideways position cannot be told.
Sideways position and half-width follow from the box's centre and width at that distance. "In the
lane" means its nearer edge is within `lane_half_m` of the drone's line of flight (the camera axis).

What the drone does (`Avoider.update`, once per frame):
  clear     nothing in the lane;
  slow      something in the lane closer than slow_distance_m: forward stick at most slow_pitch;
  hold      closer than hold_distance_m (or very close): no forward stick, and closer than
            back_distance_m a small backward stick. Back to moving only after the lane has been clear
            for clear_confirm_s;
  sidestep  (mode "pass", while approaching only) a blocker that stayed hold_patience_s: roll toward
            the side that needs the shorter move and where nothing else is in the way, yaw frozen,
            until the blocker's box shows pass_clear_m of sideways gap;
  passing   forward slowly, yaw frozen, until the camera is beside the blocker's front face and the
            blocker has been out of the picture for pass_gone_s; then it hands back (`handed_back`)
            and the normal approach and line-up bring the drone back onto the sign's centre line;
  blocked   no progress for blocked_timeout_s in total, or no way round: the run ends path_blocked.

Where the drone is during a pass (the sidestep limit and how far it has flown) comes from the sign
when it is in view: its bearing in the picture and its distance (from its size) give the drone's
position relative to the line of sight to the sign along the frozen heading. That is close to the
sign's centre line only when the approach was on it. Out of view, the distance flown is dead-reckoned
from the forward stick and `assumed_speed_m_s` (the simulator's figure; unmeasured on a real drone).

Signs follow steering.py: +roll slides right, +pitch flies forward, lateral + is right of the line of
flight.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from medhop.config import AVOID_MODES  # noqa: F401  ("off", "hold", "pass")
from medhop.mission.steering import limit_rise

CLEAR, SLOW, HOLD, SIDESTEP, PASSING, BLOCKED = "clear", "slow", "hold", "sidestep", "passing", "blocked"
AVOID_STATES = (CLEAR, SLOW, HOLD, SIDESTEP, PASSING, BLOCKED)
NOT_MOVING_ON = (HOLD, SIDESTEP, PASSING)    # time in these does not count against the run timeout

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
    hold_patience_s: float = 4.0
    pass_clear_m: float = 0.9
    max_sidestep_m: float = 1.2
    blocked_timeout_s: float = 25.0
    # camera geometry (level camera at the hover height; 16:9 like the drone's 640x360 stream)
    camera_height_m: float = 1.0
    hfov_deg: float = 70.0
    frame_aspect: float = 16.0 / 9.0
    person_height_m: float = 1.7
    edge_margin: float = 0.004       # a box edge this close to the frame border counts as cut off
    horizon_margin: float = 0.01     # the bottom edge must be at least this far below the horizon
    # sidestep and passing
    sidestep_roll: float = 0.12      # feed-forward roll while side-stepping ...
    sidestep_speed_m_s: float = 0.12  # ... for this sideways speed, held by the loop below when measurable
    lat_kp: float = 0.3              # hold and sidestep: roll per metre the blocker's box is off its track
    lat_ki: float = 0.1              # ... and per metre-second (learns the roll that cancels the drift)
    pass_pitch: float = 0.15
    assumed_speed_m_s: float = 1.0   # metres per second at full stick: the simulator's figure, unmeasured
    pass_beside_m: float = 0.15      # hand back once the camera is this far past the blocker's front face
    pass_gone_s: float = 1.0         # ... and the blocker has been out of the picture this long
    pass_timeout_s: float = 45.0     # a pass still not finished after this: path_blocked
    pass_stop_gap_m: float = 0.65    # passing stops when a measurable blocker's gap shrinks below this
    pass_gap_kp: float = 0.4         # passing: roll per metre of gap error, while the blocker is measurable
    pass_gap_ki: float = 0.1         # ... and per metre-second (this part also cancels a steady drift)
    roll_max: float = 0.15           # the mixer's mission roll limit
    roll_rise_per_s: float = 1.0
    match_fw: float = 0.15           # a box this close (frame widths) to the last one is the same thing
    no_way_round_frames: int = 3     # consecutive "no way round" plans before giving up
    lost_s: float = 0.5              # sidestep: the blocker out of view this long -> back to hold


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


@dataclass(frozen=True)
class SignFix:
    """The sign in one frame: its centre (fraction of the frame width) and its distance in metres."""

    ts: float
    cx: float
    range_m: float


def sign_position(fix: SignFix, cfg: AvoidConfig) -> Tuple[float, float]:
    """(lateral, along) of the camera, metres, relative to the line through the sign along the camera's
    current heading: + lateral = right of that line. With the heading frozen this is a fixed frame."""
    bearing = math.atan2(fix.cx - 0.5, focal_fw(cfg))
    return -fix.range_m * math.sin(bearing), fix.range_m * math.cos(bearing)


@dataclass(frozen=True)
class AvoidCommand:
    state: str
    pitch_cap: Optional[float] = None   # forward stick at most this (None: no limit)
    pitch: Optional[float] = None       # send this pitch instead (back off, sidestep, passing)
    roll: Optional[float] = None        # send this roll instead
    freeze_yaw: bool = False            # send no yaw
    blocked: bool = False               # end the run: path_blocked
    handed_back: bool = False           # a pass has just finished
    reason: Optional[str] = None        # why blocked: "timeout", "no_way_round" or "pass_timeout"


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
        self.side = 0                           # +1 right, -1 left while side-stepping or passing
        self.no_progress_s = 0.0                # time held, side-stepping or stopped in a pass
        self.holds = 0
        self.passes = 0
        self.blocked_reason: Optional[str] = None
        self.events: List[Dict[str, Any]] = []   # state changes, for the run trace
        self._last_now: Optional[float] = None
        self._hold_since: Optional[float] = None
        self._clear_since: Optional[float] = None
        self._infeasible = 0
        self._roll = 0.0
        self._move: Dict[str, Any] = {}         # sidestep / passing bookkeeping
        self._stalled = False
        self._drift_hint = 0.0
        # sideways tracking of the blocker's box: reference lateral, its time, the speed it should move
        # at (+ = the drone moves right), the feed-forward roll and the integral
        self._lat: Dict[str, Any] = {"ref": None, "t0": None, "speed": 0.0, "ff": 0.0, "i": 0.0, "of": None}

    # ------------------------------------------------------------------ #
    def update(self, now: float, seen: Sequence[Seen], fresh: bool = True, sign: Optional[SignFix] = None,
               allow_pass: bool = False, drift_roll: float = 0.0) -> AvoidCommand:
        """One step. `seen`: this frame's obstacles. `fresh`: whether `seen` is current evidence (on the
        real drone the person check can fall behind). `sign`: the sign if it is in view. `allow_pass`:
        mode "pass" and the run is approaching. `drift_roll`: the roll that cancels the drone's sideways
        drift, if known (the drift assist's estimate)."""
        cfg = self.cfg
        dt = 0.0 if self._last_now is None else max(0.0, min(0.5, now - self._last_now))
        self._last_now = now
        self._drift_hint = drift_roll
        if self.state == BLOCKED:
            return self._blocked_command()
        if self.state in (HOLD, SIDESTEP) or (self.state == PASSING and self._stalled):
            self.no_progress_s += dt
            if self.no_progress_s >= cfg.blocked_timeout_s:
                return self._block(now, "timeout")
        if self.state in (CLEAR, SLOW):
            return self._moving(now, seen if fresh else None)
        if self.state == HOLD:
            return self._hold(now, dt, seen if fresh else None, allow_pass, sign, drift_roll)
        if self.state == SIDESTEP:
            return self._sidestep(now, dt, seen if fresh else None, sign, drift_roll)
        return self._passing(now, dt, seen if fresh else None, sign)

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
        return AvoidCommand(BLOCKED, pitch_cap=0.0, pitch=0.0, roll=0.0, freeze_yaw=True, blocked=True,
                            reason=self.blocked_reason)

    def _ramp_roll(self, target: float, dt: float) -> float:
        cfg = self.cfg
        target = max(-cfg.roll_max, min(cfg.roll_max, target))
        self._roll = max(-cfg.roll_max, min(cfg.roll_max, limit_rise(self._roll, target, dt, cfg.roll_rise_per_s)))
        return self._roll

    def _hold_command(self, target: Optional[Seen], roll: Optional[float] = None) -> AvoidCommand:
        cfg = self.cfg
        back = target is not None and (target.distance_m is None or target.distance_m < cfg.back_distance_m)
        return AvoidCommand(HOLD, pitch_cap=0.0, pitch=cfg.back_pitch if back else None,
                            roll=self._roll if roll is None else roll)

    def _track_reset(self, target: Optional[Seen], now: float, speed: float = 0.0, ff: float = 0.0) -> None:
        """Start tracking `target`'s box sideways from where it is now (keeps the integral)."""
        lat = self._lat
        lat["ref"] = None if target is None else target.lateral_m
        lat["t0"] = now
        lat["speed"] = speed
        lat["ff"] = ff
        lat["of"] = target

    def _track(self, now: float, dt: float, target: Optional[Seen]) -> float:
        """Roll that keeps the drone where it was relative to `target` (hold), or moves it sideways at
        the set speed (sidestep), measured on the target's box while its distance can be told. The
        integral learns the roll that cancels a steady drift; without a measurement the feed-forward
        and the integral are sent as they are."""
        cfg, lat = self.cfg, self._lat
        if target is not None and target.lateral_m is not None:
            if lat["of"] is None or lat["ref"] is None or self._match(lat["of"], [target]) is None:
                self._track_reset(target, now, lat["speed"], lat["ff"])
            lat["of"] = target
            reference = lat["ref"] - lat["speed"] * (now - lat["t0"])   # it moves left when the drone moves right
            err = target.lateral_m - reference                         # > 0: the drone is too far left
            lat["i"] = max(-cfg.roll_max, min(cfg.roll_max, lat["i"] + cfg.lat_ki * err * dt))
            return self._ramp_roll(lat["ff"] + cfg.lat_kp * err + lat["i"], dt)
        return self._ramp_roll(lat["ff"] + lat["i"], dt)

    # ------------------------------------------------------------------ #
    def _moving(self, now: float, seen: Optional[Sequence[Seen]]) -> AvoidCommand:
        cfg = self.cfg
        if seen is None:      # no current evidence: keep what the last evidence said
            return AvoidCommand(SLOW, pitch_cap=cfg.slow_pitch) if self.state == SLOW else AvoidCommand(CLEAR)
        target = nearest([s for s in seen if s.in_lane])
        distance = None if target is None else (0.0 if target.distance_m is None else target.distance_m)
        if distance is not None and distance < cfg.hold_distance_m:
            self.holds += 1
            self._hold_since = now
            self._clear_since = None
            self._infeasible = 0
            self._lat["i"] = max(-cfg.roll_max, min(cfg.roll_max, self._drift_hint))
            self._track_reset(target, now)
            self._set(HOLD, now, target)
            return self._hold_command(target, self._track(now, 0.0, target))
        if distance is not None and distance < cfg.slow_distance_m:
            self._set(SLOW, now, target)
            return AvoidCommand(SLOW, pitch_cap=cfg.slow_pitch)
        self._set(CLEAR, now, None)
        return AvoidCommand(CLEAR)

    def _hold(self, now: float, dt: float, seen: Optional[Sequence[Seen]], allow_pass: bool,
              sign: Optional[SignFix], drift_roll: float) -> AvoidCommand:
        cfg = self.cfg
        if seen is None:
            self._clear_since = None              # "clear" needs current evidence
            return self._hold_command(self.target, self._track(now, dt, None))
        lane = [s for s in seen if s.in_lane]
        target = nearest(lane)
        if any(s.distance_m is None or s.distance_m < cfg.slow_distance_m for s in lane):
            self._clear_since = None
            self.target = target
        else:
            if self._clear_since is None:
                self._clear_since = now
            if now - self._clear_since >= cfg.clear_confirm_s:
                self._set(CLEAR, now, None)
                return self._moving(now, seen)
        if allow_pass and target is not None and now - self._hold_since >= cfg.hold_patience_s:
            plan = self._plan(target, seen, sign, drift_roll)
            if plan is None:
                self._infeasible += 1
                if self._infeasible >= cfg.no_way_round_frames:
                    return self._block(now, "no_way_round")
            elif plan != "wait":
                self._infeasible = 0
                return self._start_sidestep(now, target, plan, sign, drift_roll)
        return self._hold_command(target, self._track(now, dt, target))

    def _plan(self, blocker: Seen, seen: Sequence[Seen], sign: Optional[SignFix], drift_roll: float):
        """("side", move) for the sidestep: the side needing the shorter move that stays within
        max_sidestep_m and has nothing else in the way. "wait" while the blocker's base is out of the
        picture (the hold backs off until it can be measured); None when there is no way round."""
        cfg = self.cfg
        if blocker.distance_m is None:
            return "wait"
        x_now = sign_position(sign, cfg)[0] if sign is not None else 0.0
        others = [s for s in seen if s is not blocker]
        options = []
        for side in (1, -1):
            move = (blocker.hi_m + cfg.pass_clear_m) if side > 0 else (cfg.pass_clear_m - blocker.lo_m)
            move = max(0.0, move)
            if abs(x_now + side * move) > cfg.max_sidestep_m:
                continue
            # what the drone sweeps (its own lane on the way out) and the line it passes on
            if side > 0:
                region = (-cfg.lane_half_m, move + cfg.pass_clear_m)
            else:
                region = (-(move + cfg.pass_clear_m), cfg.lane_half_m)
            in_way = False
            for other in others:
                if other.lateral_m is None:
                    in_way = True        # very close, position unknown: assume it is in the way
                    break
                if other.lo_m < region[1] and other.hi_m > region[0]:
                    in_way = True
                    break
            if not in_way:
                options.append((move, side))
        if not options:
            return None
        options.sort()
        if len(options) == 2 and abs(options[0][0] - options[1][0]) < 0.1:
            # As good as each other: pass on the side the drift will bring back toward the sign's
            # centre line afterwards (a drone drifting right has a negative cancelling roll: pass left).
            learned = self._lat["i"] if abs(self._lat["i"]) > 1e-3 else drift_roll
            side = 1 if learned > 0 else -1
            return next(o for o in options if o[1] == side)[::-1]
        return options[0][::-1]

    # ------------------------------------------------------------------ #
    def _match(self, previous: Seen, seen: Sequence[Seen]) -> Optional[Seen]:
        best, best_d = None, self.cfg.match_fw
        for s in seen:
            if s.kind != previous.kind:
                continue
            d = abs(s.cx - previous.cx)
            if d <= best_d:
                best, best_d = s, d
        return best

    def _start_sidestep(self, now: float, blocker: Seen, plan: Tuple[int, float], sign: Optional[SignFix],
                        drift_roll: float) -> AvoidCommand:
        cfg = self.cfg
        side, move = plan
        self.side = side
        self._move = {
            "since": now, "blocker": blocker, "move": move, "lost_since": None,
            "time_limit": cfg.max_sidestep_m / max(1e-3, cfg.sidestep_speed_m_s),
        }
        self._track_reset(blocker, now, side * cfg.sidestep_speed_m_s, side * cfg.sidestep_roll)
        self._set(SIDESTEP, now, blocker, side="right" if side > 0 else "left", move_m=round(move, 2))
        return AvoidCommand(SIDESTEP, pitch_cap=0.0, pitch=0.0, roll=self._roll, freeze_yaw=True)

    def _sidestep(self, now: float, dt: float, seen: Optional[Sequence[Seen]], sign: Optional[SignFix],
                  drift_roll: float) -> AvoidCommand:
        cfg, m = self.cfg, self._move
        blocker = None if seen is None else self._match(m["blocker"], seen)
        if blocker is None:
            if m["lost_since"] is None:
                m["lost_since"] = now
            if now - m["lost_since"] > cfg.lost_s:
                # It left the picture (walked away?) or there is no current evidence: hold again.
                self._hold_since = now
                self._clear_since = None
                self._track_reset(None, now)
                self._set(HOLD, now, self.target)
                return self._hold_command(None, self._track(now, dt, None))
            return AvoidCommand(SIDESTEP, pitch_cap=0.0, pitch=0.0, roll=self._ramp_roll(self._lat["i"], dt),
                                freeze_yaw=True)
        m["lost_since"] = None
        m["blocker"] = blocker
        others = [s for s in seen if s is not blocker and s.in_lane]
        if others:
            # Something else came into the way: hold, and plan again from there.
            self._hold_since = now - cfg.hold_patience_s + 1.0
            self._clear_since = None
            self._track_reset(nearest(others), now)
            self._set(HOLD, now, nearest(others))
            return self._hold_command(nearest(others), self._track(now, dt, nearest(others)))
        if blocker.distance_m is not None:
            self._blocker_depth(blocker)          # calibrates the top-edge distance for the pass
            gap = -blocker.hi_m if self.side > 0 else blocker.lo_m
            if gap >= cfg.pass_clear_m:
                return self._start_passing(now, blocker, sign)
        x_now = sign_position(sign, cfg)[0] if sign is not None else None
        if (x_now is not None and abs(x_now) > cfg.max_sidestep_m) or now - m["since"] > m["time_limit"]:
            return self._block(now, "no_way_round")
        pitch = cfg.back_pitch if blocker.distance_m is None or blocker.distance_m < cfg.back_distance_m else 0.0
        roll = self._track(now, dt, blocker)
        return AvoidCommand(SIDESTEP, pitch_cap=0.0, pitch=pitch, roll=roll, freeze_yaw=True)

    def _blocker_depth(self, blocker: Seen) -> Optional[float]:
        """The blocker's distance along the camera axis: the floor estimate while its base is in the
        picture; after that, from its top edge, scaled by the floor estimate taken while both were in
        view (distance is inversely proportional to the edge's offset from the horizon, whatever the
        real height). None when neither is available."""
        cfg, m = self.cfg, self._move
        y1 = blocker.box[1]
        top_ok = y1 > cfg.edge_margin and abs(y1 - 0.5) >= 0.02
        if blocker.distance_m is not None:
            if top_ok:
                m["k_top"] = (blocker.distance_m * abs(y1 - 0.5), y1 < 0.5)
            return blocker.distance_m
        k_top = m.get("k_top")
        if top_ok and k_top is not None and (y1 < 0.5) == k_top[1]:
            return k_top[0] / abs(y1 - 0.5)
        return None

    def _gap_m(self, blocker: Seen, depth: float) -> float:
        """Sideways gap between the line of flight and the blocker's nearer edge (it is on the side
        opposite `self.side`); negative when the line of flight crosses it."""
        f = focal_fw(self.cfg)
        if self.side > 0:
            return (0.5 - blocker.box[2]) * depth / f
        return (blocker.box[0] - 0.5) * depth / f

    def _start_passing(self, now: float, blocker: Seen, sign: Optional[SignFix]) -> AvoidCommand:
        cfg, m = self.cfg, self._move
        cancel = self._lat["i"]                    # what the hold and the sidestep learned about the drift
        position = sign_position(sign, cfg) if sign is not None else None
        depth = blocker.distance_m
        self._move = {
            "since": now, "blocker": blocker, "d0": depth, "k_top": m.get("k_top"),
            "gap_target": max(cfg.pass_clear_m, self._gap_m(blocker, depth)),
            "integral": cancel, "travel": 0.0, "last_depth": depth,
            "last_z": None if position is None else position[1],
            "gone_since": None, "pitch": 0.0,
        }
        self.passes += 1
        self._stalled = False
        self._set(PASSING, now, blocker, side="right" if self.side > 0 else "left", drift_roll=round(cancel, 3))
        return AvoidCommand(PASSING, pitch_cap=0.0, pitch=0.0, roll=self._roll, freeze_yaw=True)

    def _passing(self, now: float, dt: float, seen: Optional[Sequence[Seen]], sign: Optional[SignFix]) -> AvoidCommand:
        """Forward slowly with yaw frozen. While the blocker is in the picture and its distance can be
        told, a PI loop on its sideways gap holds the passing line (the integral learns the roll that
        cancels the drift, which is then kept once it is out of view). Distance flown: from the
        blocker's distance while measurable, else from the sign's distance, else dead-reckoned."""
        cfg, m = self.cfg, self._move
        blocker = None if seen is None else self._match(m["blocker"], seen)
        depth = None if blocker is None else self._blocker_depth(blocker)
        position = sign_position(sign, cfg) if sign is not None else None
        if depth is not None and m["last_depth"] is not None:
            m["travel"] += m["last_depth"] - depth
        elif position is not None and m["last_z"] is not None:
            m["travel"] += m["last_z"] - position[1]
        else:
            m["travel"] += m["pitch"] * cfg.assumed_speed_m_s * dt
        m["last_depth"] = depth
        m["last_z"] = None if position is None else position[1]
        travel = m["travel"]

        stop, back = seen is None, False
        gap = None
        if seen is not None:
            if blocker is None:
                if m["gone_since"] is None:
                    m["gone_since"] = now
            else:
                m["blocker"] = blocker
                m["gone_since"] = None
                if depth is not None:
                    gap = self._gap_m(blocker, depth)
                    stop = stop or gap < cfg.pass_stop_gap_m
                else:
                    # Neither its base nor its top can be measured: only its bearing can be checked. It
                    # must stay out of the band the lane covers at the farthest a cut-off base can be.
                    near_u = blocker.box[2] if self.side > 0 else blocker.box[0]
                    band = focal_fw(cfg) * cfg.lane_half_m / blind_distance_m(cfg)
                    stop = stop or abs(near_u - 0.5) < band
            others = [s for s in seen if s is not blocker and s.in_lane]
            if others:
                stop = True
                closest = nearest(others)
                back = closest.distance_m is None or closest.distance_m < cfg.back_distance_m

        if (not stop and travel >= m["d0"] + cfg.pass_beside_m and m["gone_since"] is not None
                and now - m["gone_since"] >= cfg.pass_gone_s):
            self._stalled = False
            self.side = 0
            self._roll = 0.0
            self._set(CLEAR, now, None, handed_back=True, travel_m=round(travel, 2))
            return AvoidCommand(CLEAR, handed_back=True)
        if now - m["since"] > cfg.pass_timeout_s:
            return self._block(now, "pass_timeout")

        self._stalled = stop
        proportional = 0.0
        if gap is not None:
            err = m["gap_target"] - gap               # > 0: too close to it, move away (toward `side`)
            m["integral"] = max(-cfg.roll_max, min(cfg.roll_max,
                                                   m["integral"] + self.side * cfg.pass_gap_ki * err * dt))
            proportional = self.side * cfg.pass_gap_kp * err
        roll = self._ramp_roll(m["integral"] + proportional, dt)
        pitch = cfg.back_pitch if back else (0.0 if stop else cfg.pass_pitch)
        m["pitch"] = pitch
        return AvoidCommand(PASSING, pitch_cap=max(0.0, pitch), pitch=pitch, roll=roll, freeze_yaw=True)

    # ------------------------------------------------------------------ #
    def snapshot(self) -> Dict[str, Any]:
        target = self.target
        return {
            "state": self.state,
            "kind": None if target is None else target.kind,
            "distance_m": None if target is None or target.distance_m is None else round(target.distance_m, 2),
            "side": None if self.state not in (SIDESTEP, PASSING) else ("right" if self.side > 0 else "left"),
            "held_s": round(self.no_progress_s, 1),
        }
