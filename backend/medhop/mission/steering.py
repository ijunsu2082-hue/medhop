"""Pure steering maths for the station run (no I/O, no clocks, no threads).

Pursuit guidance on the marker centre. Because the video shows what the drone did about half a
second ago, the yaw command is not computed from the stale marker position alone. The yaw commands
that were sent after the picture was taken have not shown up in the video yet, so their expected
effect is subtracted first (a Smith predictor):

    predicted_cx = observed_cx - yaw_rate_fw_per_s * integral of yaw commands over [obs time - latency, now]

`yaw_rate_fw_per_s` is an assumed figure (how fast full yaw stick moves the marker across the frame).
It is deliberately on the high side: over-estimating it only makes the loop slower, while the loop
stays stable for a real yaw rate up to twice the assumed one.

Signs: +yaw turns right, +pitch flies forward, +roll slides right. A marker right of centre
(cx > 0.5) needs +yaw.

Drift assist (experimental, `DriftAssist` below) adds a small roll command that cancels a steady
sideways slide. It uses nothing but what the camera shows. See the class for how and why.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from collections import deque
from typing import Deque, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class MarkerSample:
    ts: float      # when the frame arrived (seconds, monotonic)
    cx: float      # marker centre, fraction of frame width
    width: float   # marker width, fraction of frame width


@dataclass
class SteeringConfig:
    latency_s: float = 0.45          # command-to-video latency to compensate
    yaw_rate_fw_per_s: float = 2.5   # assumed marker speed across the frame at full yaw stick
    yaw_gain: float = 1.0            # stick per frame-width of predicted error
    yaw_max: float = 0.25            # yaw stick cap while approaching
    yaw_deadband: float = 0.015      # frame-widths; no yaw inside this
    forward_window: float = 0.15     # fly forward only when the marker is this close to centre
    forward_max: float = 0.22        # forward stick cap
    forward_near: float = 0.10       # forward stick close to arrival
    taper_start: float = 0.5         # taper begins when width reaches this fraction of the arrive width
    rise_per_s: float = 1.0          # commands rise at most this fast; reductions are immediate
    search_yaw: float = 0.12         # slow fixed yaw while searching
    creep_yaw: float = 0.08          # creep-search yaw toward the side the marker was last seen


YawLog = Sequence[Tuple[float, float]]   # (time the command was issued, yaw stick), oldest first


def pending_yaw(yaw_log: YawLog, start: float, now: float) -> float:
    """Integral of the yaw commands over [start, now]; each command holds until the next one."""
    total = 0.0
    for index, (issued, yaw) in enumerate(yaw_log):
        until = yaw_log[index + 1][0] if index + 1 < len(yaw_log) else now
        lo, hi = max(issued, start), min(until, now)
        if hi > lo:
            total += yaw * (hi - lo)
    return total


def predict_cx(history: Sequence[MarkerSample], yaw_log: YawLog, now: float, cfg: SteeringConfig) -> float:
    """Where the marker centre is expected to be once every command already sent has taken effect."""
    latest = history[-1]
    unseen = pending_yaw(yaw_log, latest.ts - cfg.latency_s, now)
    return latest.cx - cfg.yaw_rate_fw_per_s * unseen


def forward_for_width(width: float, arrive_width: float, cfg: SteeringConfig) -> float:
    """Forward stick as a function of marker size: capped far away, tapering to forward_near."""
    start = arrive_width * cfg.taper_start
    if width <= start:
        return cfg.forward_max
    if width >= arrive_width:
        return cfg.forward_near
    frac = (width - start) / max(1e-9, arrive_width - start)
    return cfg.forward_max + (cfg.forward_near - cfg.forward_max) * frac


def steer(history: Sequence[MarkerSample], yaw_log: YawLog, now: float, arrive_width: float,
          cfg: Optional[SteeringConfig] = None) -> Tuple[float, float]:
    """Raw (yaw, pitch) target for a visible marker.

    `history` holds the marker observations and `yaw_log` the yaw commands already issued, both
    oldest first. Pure: the result depends only on the arguments.
    """
    cfg = cfg or SteeringConfig()
    if not history:
        return 0.0, 0.0
    latest = history[-1]
    predicted = predict_cx(history, yaw_log, now, cfg)
    error = predicted - 0.5
    if abs(error) <= cfg.yaw_deadband:
        yaw = 0.0
    else:
        yaw = max(-cfg.yaw_max, min(cfg.yaw_max, cfg.yaw_gain * error))
    centred = abs(latest.cx - 0.5) <= cfg.forward_window and abs(error) <= cfg.forward_window
    pitch = forward_for_width(latest.width, arrive_width, cfg) if centred else 0.0
    return yaw, pitch


def limit_rise(previous: float, target: float, dt: float, rise_per_s: float) -> float:
    """Magnitude may grow by at most rise_per_s * dt; reductions and stops are immediate."""
    if previous * target < 0.0:
        previous = 0.0  # a sign change passes through zero first
    if abs(target) <= abs(previous):
        return target
    grown = abs(previous) + max(0.0, rise_per_s * dt)
    return (1.0 if target > 0.0 else -1.0) * min(abs(target), grown)


class Steering:
    """Stateful wrapper: remembers the commands it issued (for the latency compensation) and applies
    the rise limit between successive commands. No I/O and no clock: `now` is always passed in."""

    YAW_LOG_S = 3.0

    def __init__(self, cfg: Optional[SteeringConfig] = None) -> None:
        self.cfg = cfg or SteeringConfig()
        self._last: Tuple[float, float] = (0.0, 0.0)
        self._last_at: Optional[float] = None
        self._yaw_log: Deque[Tuple[float, float]] = deque()

    def reset(self) -> None:
        self._last = (0.0, 0.0)
        self._last_at = None
        self._yaw_log.clear()

    def shape(self, yaw: float, pitch: float, now: float) -> Tuple[float, float]:
        """Rate-limit an arbitrary (yaw, pitch) target against the previous output."""
        dt = 0.0 if self._last_at is None else max(0.0, min(0.5, now - self._last_at))
        out = (
            limit_rise(self._last[0], yaw, dt, self.cfg.rise_per_s),
            limit_rise(self._last[1], pitch, dt, self.cfg.rise_per_s),
        )
        self._last = out
        self._last_at = now
        self._yaw_log.append((now, out[0]))
        while len(self._yaw_log) > 1 and now - self._yaw_log[1][0] > self.YAW_LOG_S:
            self._yaw_log.popleft()
        return out

    def update(self, history: Sequence[MarkerSample], now: float, arrive_width: float,
               no_forward: bool = False) -> Tuple[float, float]:
        """`no_forward`: yaw only (the drone is already at the arrive distance and must not creep on
        toward the wall while it lines up)."""
        yaw, pitch = steer(history, tuple(self._yaw_log), now, arrive_width, self.cfg)
        return self.shape(yaw, 0.0 if no_forward else pitch, now)

    def yaw_seen_between(self, earlier_ts: float, later_ts: float) -> float:
        """Integral (stick x seconds) of the yaw commands whose effect appears in the video between
        two frame times: the commands issued one latency before each of them."""
        latency = self.cfg.latency_s
        return pending_yaw(tuple(self._yaw_log), earlier_ts - latency, later_ts - latency)

    def search(self, now: float, direction: float = 1.0, creep: bool = False) -> Tuple[float, float]:
        rate = self.cfg.creep_yaw if creep else self.cfg.search_yaw
        return self.shape(rate if direction >= 0 else -rate, 0.0, now)

    def neutral(self, now: float) -> Tuple[float, float]:
        return self.shape(0.0, 0.0, now)


@dataclass
class DriftAssistConfig:
    roll_max: float = 0.15           # hard bound on the assist roll (SPEC section 6, Revision 2)
    gain: float = 0.11               # roll stick per marker-width of unexplained sideways slide
    uncalibrated_gain: float = 0.5   # gain factor while the yaw effect has not been measured in this run
    rate_max: float = 0.30           # the estimate moves at most this fast (stick per second)
    rise_per_s: float = 1.0          # the roll sent rises at most this fast; reductions are immediate
    # qualifying: the first turn toward the marker must be over
    arm_window_s: float = 0.4        # the yaw seen in the video must have been small for this long ...
    arm_yaw: float = 0.08            # ... "small" (stick) ...
    arm_centre: float = 0.12         # ... with the marker this close to the middle of the picture
    # measuring how much the picture moves per unit of yaw stick (frame-widths per second at full stick)
    calib_min_yaw: float = 0.05      # only frames with at least this much yaw in them are used
    calib_min_sum: float = 6e-4      # enough of them (sum of squared stick x seconds) before it is trusted
    calib_range: float = 4.0         # the measured figure may differ from the assumed one by this factor
    # return to the marker's axis, from the left/right edge heights (only when the marker is large enough)
    axis_gain: float = 2.0           # wanted return speed (marker-widths per second) per unit of off-axis measure
    axis_min_size: float = 0.075     # marker size (fraction of frame width, about 48 px of 640) where it starts
    axis_full_size: float = 0.10     # ... and where it counts fully (about 64 px)
    axis_tau_s: float = 0.4          # smoothing of the off-axis measure
    axis_centre_factor: float = 1.0  # how much of the marker's offset from the picture centre to take off it
    # self-check
    measure_tau_s: float = 0.8       # smoothing of the slide rate used by the self-check
    check_roll: float = 0.06         # the second check judges only once the assist is really pushing
    bound_dwell_s: float = 0.6       # the estimate has sat at the bound for this long ...
    worse_s: float = 0.6             # ... and for this much longer the slide has stayed "not better":
    improve_margin: float = 0.15     # less than this (marker-widths/s) below the fastest it has been in this run
    slide_min: float = 0.50          # and still at least this fast (marker-widths/s), the way the roll should cure
    aspect_floor: float = 0.75       # second check: marker width/height under this (about 41 degrees) ...
    aspect_drop: float = 0.10        # ... having fallen by at least this much since the assist started
    # trim suggestion
    suggest_window_s: float = 3.0    # mean roll over this long before arrival
    suggest_min_s: float = 1.0       # no suggestion from less assist time than this


DISABLED_OFF_AXIS = "off_axis_worsening"


def marker_skew(corners: Sequence[Tuple[float, float]]) -> float:
    """(right edge height - left edge height) / (their sum), from corners TL, TR, BR, BL.

    The nearer edge of a marker seen from the side looks taller, so this is positive when the
    camera is to the right of the marker's axis and negative when it is to the left.
    """
    (tl, tr, br, bl) = corners
    left = math.hypot(bl[0] - tl[0], bl[1] - tl[1])
    right = math.hypot(br[0] - tr[0], br[1] - tr[1])
    total = left + right
    return (right - left) / total if total > 0 else 0.0


class DriftAssist:
    """Roll command that cancels a steady sideways slide, estimated from the camera only.

    Slide measure. Between two frames the marker centre moves because the drone yawed and because
    it slid sideways. The yaw part is known (the commands sent one latency earlier, times how far
    the picture moves per unit of yaw); what is left over is the slide:

        slide = (change of cx + yaw effect) / marker size        [marker-widths, + = drone slid left]

    Dividing by the marker's size turns frame-widths into marker-widths, i.e. into real sideways
    distance in units of the printed marker, at any range and without knowing the field of view.
    A drone that merely starts off to one side and flies straight at the marker shows no slide, so
    being off-axis is not mistaken for drifting. How far the picture moves per unit of yaw is
    measured during the run's own first turn toward the marker (least squares over the frames with
    real yaw in them); until then the steering's assumed figure is used at reduced gain.

    Control. The roll estimate integrates the slide (roll += gain * slide): it settles where the
    marker no longer slides. The estimate is clamped to roll_max, which is also the anti-windup:
    it can never hold more than it is allowed to send.

    Return to the axis. Cancelling the slide leaves the drone wherever the drift had already
    carried it. Close enough to resolve it, the marker's left and right edges differ in height
    (the nearer one is taller); that signed off-axis measure sets a small wanted slide back toward
    the axis, so the roll also undoes the offset instead of only stopping it from growing.

    Not fooled by the initial heading error. The first turn toward the marker is large and its yaw
    effect is only known approximately, so the leftover would be mostly error. The assist stays
    out until the yaw seen in the video has been small for arm_window_s with the marker near the
    middle and the pursuit flying forward, and it has to qualify again whenever that stops. No
    roll is sent while it is not qualified.

    Self-check. If roll pushes this drone the other way (wrong sign), every bit of roll makes the
    slide worse, so the estimate runs away to the bound and the slide keeps growing. Two off-axis
    measures are watched: (1) the slide rate, i.e. how fast the drone is moving off the marker's
    axis: with roll the right way the slide is fastest before the roll takes hold and then comes
    down; if the estimate has sat at the bound for bound_dwell_s and for a further worse_s the
    slide is still as fast as it has ever been in this run, in the direction the roll was meant
    to cure, the assist is making things worse; (2) the marker's width/height ratio, i.e. how far
    off the axis the drone already is, falling below aspect_floor while the assist is pushing.
    Either one switches the assist off for the rest of the run. A drift that is merely stronger
    than roll_max can cancel does not trip (1): full roll the right way still slows the slide.

    Limits (camera only). At long range a slow yaw drift of the drone moves the marker in the
    picture exactly as a sideways slide does; the assist cannot tell them apart and will answer
    either with roll. A drift stronger than roll_max is only reduced, not cancelled. All of this
    was tuned in the simulator: on a real drone the gains, the sign of roll and the edge-height
    measure are unverified until flown.

    No I/O and no clock: the frame time is always passed in.
    """

    def __init__(self, cfg: Optional[DriftAssistConfig] = None, assumed_yaw_rate: float = 2.5) -> None:
        self.cfg = cfg or DriftAssistConfig()
        self._assumed_yaw_rate = float(assumed_yaw_rate)
        self.reset()

    def reset(self) -> None:
        """Start of a run: forget everything, including a self-disable."""
        self._estimate = 0.0
        self._out = 0.0
        self._armed = False
        self._prev: Optional[Tuple[float, float]] = None        # (frame time, cx) of the previous frame
        self._quiet_since: Optional[float] = None               # since when the seen yaw has been small
        self._bound_since: Optional[float] = None               # since when the estimate has sat at the bound
        self._slide_high = 0.0                                  # largest and smallest smoothed slide rate
        self._slide_low = 0.0                                   # seen while the assist was active
        self._calib_xy = 0.0
        self._calib_xx = 0.0
        self._slide_rate: Optional[float] = None                # smoothed, marker-widths per second
        self._axis: Optional[float] = None                      # smoothed off-axis measure
        self._aspect: Optional[float] = None                    # smoothed marker width/height
        self._aspect_ref: Optional[float] = None                # ... when the assist first started
        self._worse_since: Optional[float] = None
        self._sent: Deque[Tuple[float, float]] = deque()        # (time, roll sent) while active
        self._active_s = 0.0
        self._disabled_reason: Optional[str] = None
        self._disabled_by: Optional[str] = None

    # ------------------------------------------------------------------ #
    @property
    def roll(self) -> float:
        """The roll command last returned."""
        return self._out

    @property
    def active(self) -> bool:
        """True while the estimate is being updated from the picture."""
        return self._armed and self._disabled_reason is None

    @property
    def slide_rate(self) -> Optional[float]:
        """Smoothed slide, marker-widths per second; + means the drone is sliding left."""
        return self._slide_rate

    @property
    def yaw_rate(self) -> float:
        """Frame-widths per second at full yaw stick: measured in this run when possible, else assumed."""
        if self._calib_xx < self.cfg.calib_min_sum:
            return self._assumed_yaw_rate
        low, high = self._assumed_yaw_rate / self.cfg.calib_range, self._assumed_yaw_rate * self.cfg.calib_range
        return max(low, min(high, self._calib_xy / self._calib_xx))

    @property
    def calibrated(self) -> bool:
        return self._calib_xx >= self.cfg.calib_min_sum

    @property
    def disabled_reason(self) -> Optional[str]:
        return self._disabled_reason

    @property
    def disabled_by(self) -> Optional[str]:
        """Which of the two off-axis measures tripped the self-check: "slide" or "aspect"."""
        return self._disabled_by

    def pause(self) -> float:
        """Marker lost, no new frame, or the approach is over: send no roll and qualify again later.

        The estimate is kept (the drift has not gone away); only the output is zero meanwhile.
        """
        self._armed = False
        self._prev = None
        self._quiet_since = None
        self._bound_since = None
        self._worse_since = None
        self._out = 0.0
        return 0.0

    def mean_roll_near_end(self) -> Optional[float]:
        """Mean roll sent over the last suggest_window_s of assist time; None when there is no basis."""
        if self._disabled_reason is not None or self._active_s < self.cfg.suggest_min_s or not self._sent:
            return None
        return sum(roll for _t, roll in self._sent) / len(self._sent)

    # ------------------------------------------------------------------ #
    def update(self, ts: float, cx: float, size: float, aspect: float, skew: float, yaw_seen: float,
               flying_forward: bool) -> float:
        """One visible-marker step while approaching. Returns the roll command, within +-roll_max.

        `ts` is the frame time, `size` the marker's size (larger edge measure, fraction of the frame
        width), `aspect` its width/height, `skew` its `marker_skew`, `yaw_seen` the integral of the
        yaw commands whose effect appeared since the previous frame (`Steering.yaw_seen_between`),
        `flying_forward` whether the pursuit is flying forward.
        """
        cfg = self.cfg
        if self._disabled_reason is not None:
            return 0.0
        previous, self._prev = self._prev, (ts, cx)
        if previous is None or not 0.0 < ts - previous[0] <= 0.3:
            self._quiet_since = None     # first frame, or a gap: nothing to compare with yet
            return self._out
        dt = ts - previous[0]
        moved = cx - previous[1]
        size = max(1e-3, size)

        # how far the picture moves per unit of yaw: learn it from frames with real yaw in them
        if abs(yaw_seen) >= cfg.calib_min_yaw * dt:
            self._calib_xy += -moved * yaw_seen
            self._calib_xx += yaw_seen * yaw_seen

        slide = (moved + self.yaw_rate * yaw_seen) / size
        quiet = flying_forward and abs(yaw_seen) <= cfg.arm_yaw * dt and abs(cx - 0.5) <= cfg.arm_centre
        if not flying_forward:
            # A turn toward the marker is in progress: the leftover would be mostly error.
            self._armed = False
            self._quiet_since = None
            self._bound_since = None
            self._worse_since = None
        elif not quiet:
            self._quiet_since = None
        elif self._quiet_since is None:
            self._quiet_since = previous[0]
        if not self._armed and self._quiet_since is not None and ts - self._quiet_since >= cfg.arm_window_s:
            self._armed = True
            if self._aspect_ref is None:
                self._aspect_ref = aspect

        if self._armed:
            blend = 1.0 - math.exp(-dt / max(1e-3, cfg.measure_tau_s))
            rate = slide / dt
            self._slide_rate = rate if self._slide_rate is None else self._slide_rate + (rate - self._slide_rate) * blend
            self._aspect = aspect if self._aspect is None else self._aspect + (aspect - self._aspect) * blend
            # The edge heights tell how far the CAMERA is turned from the wall's normal. Where the
            # drone IS also depends on where the marker sits in the picture, so that is taken off
            # (the factor is 0.5 / tan(hfov / 2)^2: 1.0 for a 70 degree lens, and the offset is small).
            axis = skew / size - cfg.axis_centre_factor * (cx - 0.5)
            axis_blend = 1.0 - math.exp(-dt / max(1e-3, cfg.axis_tau_s))
            self._axis = axis if self._axis is None else self._axis + (axis - self._axis) * axis_blend
            trust = (size - cfg.axis_min_size) / max(1e-6, cfg.axis_full_size - cfg.axis_min_size)
            wanted = cfg.axis_gain * self._axis * max(0.0, min(1.0, trust))   # + = slide left, back to the axis
            gain = cfg.gain * (1.0 if self.calibrated else cfg.uncalibrated_gain)
            step = max(-cfg.rate_max * dt, min(cfg.rate_max * dt, gain * (slide - wanted * dt)))
            self._estimate = max(-cfg.roll_max, min(cfg.roll_max, self._estimate + step))
            self._active_s += dt
            if self._check(ts):
                return 0.0

        self._hold(dt)
        if self._armed:
            self._sent.append((ts, self._out))
            while ts - self._sent[0][0] > cfg.suggest_window_s:
                self._sent.popleft()
        return self._out

    def _hold(self, dt: float) -> float:
        """Send the estimate while qualified (rate-limited on the way up, bounded), else nothing."""
        cfg = self.cfg
        target = self._estimate if self._armed else 0.0
        self._out = max(-cfg.roll_max, min(cfg.roll_max, limit_rise(self._out, target, dt, cfg.rise_per_s)))
        return self._out

    def _check(self, ts: float) -> bool:
        """The self-check. Returns True when it has just switched the assist off."""
        cfg = self.cfg
        rate = self._slide_rate or 0.0
        self._slide_high = max(self._slide_high, rate)
        self._slide_low = min(self._slide_low, rate)
        # Along the roll: positive when the picture still asks for more of what was already added.
        along, fastest = (rate, self._slide_high) if self._estimate >= 0.0 else (-rate, -self._slide_low)
        if abs(self._estimate) < 0.98 * cfg.roll_max:
            self._bound_since = None
            self._worse_since = None
        elif self._bound_since is None:
            self._bound_since = ts
        elif ts - self._bound_since >= cfg.bound_dwell_s:
            worse = along >= cfg.slide_min and along > fastest - cfg.improve_margin
            if not worse:
                self._worse_since = None
            elif self._worse_since is None:
                self._worse_since = ts
            elif ts - self._worse_since >= cfg.worse_s:
                return self._disable("slide")
        pushing = abs(self._estimate) >= cfg.check_roll
        if (pushing and self._aspect is not None and self._aspect_ref is not None
                and self._aspect < cfg.aspect_floor and self._aspect_ref - self._aspect >= cfg.aspect_drop):
            return self._disable("aspect")
        return False

    def _disable(self, by: str) -> bool:
        self._disabled_reason = DISABLED_OFF_AXIS
        self._disabled_by = by
        self._armed = False
        self._estimate = 0.0
        self._out = 0.0
        self._prev = None
        self._quiet_since = None
        self._sent.clear()
        return True
