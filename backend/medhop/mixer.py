"""ControlMixer: the single authority that sends axes to the drone link (SPEC section 5).

Priority each tick:
  1. emergency stop latched -> the motor cut is asserted again, then neutral (no trim) until reset
  2. pilot active (non-zero manual axes in the last 0.4 s) -> pilot axes x max_stick, except on the
     real drone when the newest frame is older than 3.0 s: then neutral (sticks blocked, trim still
     added like any neutral), so the last packets before the library's 4 s socket cut are neutral
  3. fresh mission command (younger than 0.5 s) and live video -> mission yaw and pitch, plus a
     small bounded roll when drift assist is on. Never throttle.
  4. neutral
then, unless the emergency stop is latched, trim (roll, pitch) is added and the result clamped.

Lock rule: the mixer never calls out (link, callbacks) while holding its lock.
"""
from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

from medhop.drone.base import DroneLink, clamp

logger = logging.getLogger("medhop.mixer")

PILOT_ACTIVE_S = 0.4          # pilot counts as active this long after a non-zero axes message
MISSION_FRESH_S = 0.5         # a mission command older than this is ignored
VIDEO_STALE_S = 0.5           # mission axes are forced to neutral when the frame is older than this
PILOT_RAMP_PER_S = 4.0        # pilot axes approach their target at this rate
TRIM_LIMIT = 0.3
MISSION_ROLL_LIMIT = 0.15     # the most roll a mission command may carry (drift assist)
MAX_STICK_MIN = 0.2
MAX_STICK_MAX = 1.0
TOGGLE_GUARD_S = 1.0          # a second toggle this soon after the last one is ignored
# A pilot toggle this soon after a mission (landing) toggle is refused: a second toggle would stop the
# landing or relaunch the drone. Must match the runner's land wait (RunnerConfig.land_wait_s, 4.0 s).
LANDING_GUARD_S = 4.0
# A mission toggle is refused this soon after any pilot input (non-zero axes, toggle, e-stop), even if
# the runner sent a mission_command in between (closes the window inside one runner step).
MISSION_TOGGLE_PILOT_QUIET_S = 0.4
STICKS_BLOCK_AFTER_S = 3.0    # real drone: pilot axes become neutral once the frame is this old
ESTOP_CONFIRM_S = 0.5         # motor cut asserted on an open socket this long counts as confirmed
ESTOP_MAX_STEP_S = 0.1        # at most this much time is credited between two assertions

# Refusal codes for the control socket.
ESTOP_ACTIVE = "estop_active"
TOGGLE_GUARD = "toggle_guard"
LANDING_IN_PROGRESS = "landing_in_progress"
DRONE_LINK_DOWN = "drone_link_down"

Axes = Tuple[float, float, float, float]  # throttle, yaw, pitch, roll
NEUTRAL: Axes = (0.0, 0.0, 0.0, 0.0)


@dataclass(frozen=True)
class MixerSnapshot:
    manual_active: bool
    max_stick: float
    estop_active: bool
    trim_roll: float
    trim_pitch: float
    source: str            # "estop" | "pilot" | "mission" | "neutral"
    sent: Axes
    estop_confirmed: bool = False   # the motor cut went onto an open socket for ESTOP_CONFIRM_S
    sticks_blocked: bool = False    # real drone, video older than STICKS_BLOCK_AFTER_S: pilot axes held neutral


class ToggleResult(tuple):
    """`(ok, message)` as before (so `ok, why = ...` keeps working), plus `code` for the API
    (None when accepted)."""

    def __new__(cls, ok: bool, message: str = "", code: Optional[str] = None) -> "ToggleResult":
        result = super().__new__(cls, (ok, message))
        result.code = code
        return result

    @property
    def ok(self) -> bool:
        return self[0]

    @property
    def message(self) -> str:
        return self[1]


_LINK_DOWN_MESSAGE = ("NOT sent: the drone link is reconnecting, so commands are not reaching the drone. "
                      "Try again in a few seconds.")


def _finite(value: float) -> float:
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("axis values must be finite numbers")
    return value


class ControlMixer:
    def __init__(
        self,
        link: DroneLink,
        rate_hz: float = 20.0,
        clock: Callable[[], float] = time.monotonic,
        trim: Tuple[float, float] = (0.0, 0.0),
        max_stick: float = 0.5,
        on_pilot_input: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._link = link
        self._rate_hz = float(rate_hz)
        self._clock = clock
        self._lock = threading.Lock()
        # Serialises everything written to the link so a neutral sent by the emergency stop can
        # never be followed by an older, non-neutral tick.
        self._send_lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()
        # Called with "axes", "toggle" or "estop" whenever the pilot acts. Never called under the lock.
        self.on_pilot_input = on_pilot_input

        self._estop = False
        self._estop_ok_at: Optional[float] = None   # last assertion that went onto an open socket
        self._estop_open_s = 0.0                     # open-socket time credited since the latch
        self._estop_confirmed = False
        self._max_stick = clamp(max_stick, MAX_STICK_MIN, MAX_STICK_MAX)
        self._trim_roll = clamp(trim[0], -TRIM_LIMIT, TRIM_LIMIT)
        self._trim_pitch = clamp(trim[1], -TRIM_LIMIT, TRIM_LIMIT)

        self._pilot_target: Axes = NEUTRAL
        self._pilot_value: Axes = NEUTRAL
        self._pilot_nonzero_at: Optional[float] = None

        self._mission_cmd: Optional[Tuple[float, float, float]] = None  # yaw, pitch, roll
        self._mission_at: Optional[float] = None

        self._last_tick: Optional[float] = None
        self._last_toggle_at: Optional[float] = None
        self._mission_toggle_at: Optional[float] = None
        # Set by any pilot input (axes, toggle, e-stop), cleared by the runner's next mission_command:
        # a mission toggle is refused while it is set.
        self._pilot_since_mission = False
        self._last_pilot_input_at: Optional[float] = None   # non-zero axes, toggle or e-stop
        self._sent: Axes = NEUTRAL
        self._source = "neutral"
        self._sticks_blocked = False
        self._bad_mission_logged = False

    # ------------------------------------------------------------------ #
    # thread
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._run, name="medhop-mixer", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop ticking. The caller then stops the link, which sends neutral itself."""
        self._stop_evt.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None

    def _run(self) -> None:
        period = 1.0 / self._rate_hz
        next_at = time.monotonic()
        while not self._stop_evt.is_set():
            try:
                self.tick()
            except Exception:
                logger.exception("mixer tick failed")
            next_at += period
            delay = next_at - time.monotonic()
            if delay < -1.0:
                next_at = time.monotonic()
                delay = 0.0
            self._stop_evt.wait(max(0.0, delay))

    # ------------------------------------------------------------------ #
    # the tick
    # ------------------------------------------------------------------ #
    def tick(self, now: Optional[float] = None) -> Axes:
        """Compute this tick's axes and send them to the link. Returns what was sent."""
        now = self._clock() if now is None else now
        with self._send_lock:
            if self.estop_active:
                # Asserted on every tick while latched (it is idempotent): a press made while the link
                # was down is sent as soon as the link is back.
                self._estop_asserted(now, self._link.emergency_stop() is True)
            axes = self._compute(now)
            self._link.set_axes(*axes)
        return axes

    def _estop_asserted(self, now: float, ok: bool) -> None:
        """Credit open-socket time between consecutive successful motor-cut assertions."""
        with self._lock:
            if not self._estop:
                return
            if ok and self._estop_ok_at is not None:
                self._estop_open_s += max(0.0, min(ESTOP_MAX_STEP_S, now - self._estop_ok_at))
            self._estop_ok_at = now if ok else None
            if not self._estop_confirmed and self._estop_open_s >= ESTOP_CONFIRM_S - 1e-9:
                self._estop_confirmed = True
                logger.warning("motor-cut command sent for %.1f s on an open socket", ESTOP_CONFIRM_S)

    def _compute(self, now: float) -> Axes:
        frame = self._link.latest_frame()
        video_live = frame is not None and (now - frame.timestamp) <= VIDEO_STALE_S
        # No frame at all counts as old video too.
        sticks_blocked = self._link.mode == "real" and (
            frame is None or (now - frame.timestamp) > STICKS_BLOCK_AFTER_S
        )
        with self._lock:
            dt = 0.0 if self._last_tick is None else max(0.0, min(0.5, now - self._last_tick))
            self._last_tick = now
            pilot_active = self._pilot_active_locked(now)
            if not pilot_active:
                # Deadman: no non-zero pilot message for 0.4 s means the pilot axes are gone.
                self._pilot_target = NEUTRAL
                self._pilot_value = NEUTRAL

            if self._estop:
                axes, source = NEUTRAL, "estop"
            elif pilot_active and sticks_blocked:
                # Real drone, video about to be cut by the library: neutral (plus trim, below), and
                # the pilot ramp starts again from zero when video returns.
                self._pilot_value = NEUTRAL
                axes, source = NEUTRAL, "neutral"
            elif pilot_active:
                step = PILOT_RAMP_PER_S * dt
                self._pilot_value = tuple(
                    cur + max(-step, min(step, target - cur))
                    for cur, target in zip(self._pilot_value, self._pilot_target)
                )  # type: ignore[assignment]
                axes = tuple(v * self._max_stick for v in self._pilot_value)  # type: ignore[assignment]
                source = "pilot"
            elif (
                self._mission_cmd is not None
                and self._mission_at is not None
                and (now - self._mission_at) < MISSION_FRESH_S
                and video_live
            ):
                yaw, pitch, roll = self._mission_cmd
                axes, source = (0.0, yaw, pitch, roll), "mission"   # throttle is never the mission's
            else:
                axes, source = NEUTRAL, "neutral"

            if not self._estop:
                throttle, yaw, pitch, roll = axes
                axes = (
                    clamp(throttle),
                    clamp(yaw),
                    clamp(pitch + self._trim_pitch),
                    clamp(roll + self._trim_roll),
                )
            if sticks_blocked != self._sticks_blocked:
                if sticks_blocked:
                    logger.warning("video older than %.1f s on the real drone: pilot sticks held neutral",
                                   STICKS_BLOCK_AFTER_S)
                else:
                    logger.info("video is back: pilot sticks enabled")
            self._sticks_blocked = sticks_blocked
            self._sent = axes
            self._source = source
        return axes

    def _pilot_active_locked(self, now: float) -> bool:
        return self._pilot_nonzero_at is not None and (now - self._pilot_nonzero_at) <= PILOT_ACTIVE_S

    # ------------------------------------------------------------------ #
    # pilot inputs
    # ------------------------------------------------------------------ #
    def pilot_axes(self, throttle: float, yaw: float, pitch: float, roll: float,
                   now: Optional[float] = None) -> None:
        now = self._clock() if now is None else now
        target = (clamp(_finite(throttle)), clamp(_finite(yaw)), clamp(_finite(pitch)), clamp(_finite(roll)))
        nonzero = any(abs(v) > 1e-6 for v in target)
        with self._lock:
            self._pilot_target = target
            if nonzero:
                self._pilot_nonzero_at = now
                self._mission_cmd = None   # the mission loses authority at once
                self._mission_at = None
                self._pilot_since_mission = True
                self._last_pilot_input_at = now
        if nonzero:
            self._notify("axes")

    def pilot_disconnect(self) -> None:
        """The pilot's control connection dropped: zero the pilot axes at once."""
        with self._lock:
            self._pilot_target = NEUTRAL
            self._pilot_value = NEUTRAL
            self._pilot_nonzero_at = None

    def pilot_toggle(self, now: Optional[float] = None) -> ToggleResult:
        """Pilot pressed takeoff/land. Aborts a running mission, then sends the one shared toggle.

        Returns ToggleResult (ok, message) with a refusal `code`: estop_active, landing_in_progress,
        toggle_guard or drone_link_down."""
        now = self._clock() if now is None else now
        with self._lock:
            self._mission_cmd = None
            self._mission_at = None
            self._pilot_since_mission = True
            self._last_pilot_input_at = now
        self._notify("toggle")
        control_up = self._link.control_up() is True   # called out before the lock (lock rule)
        with self._lock:
            if self._estop:
                return ToggleResult(False, "emergency stop is active; reset it first", ESTOP_ACTIVE)
            if self._mission_toggle_at is not None and (now - self._mission_toggle_at) < LANDING_GUARD_S:
                return ToggleResult(
                    False,
                    "landing in progress: the station run sent the land command a moment ago; "
                    "a second press would undo it. Wait a few seconds.",
                    LANDING_IN_PROGRESS,
                )
            if self._last_toggle_at is not None and (now - self._last_toggle_at) < TOGGLE_GUARD_S:
                return ToggleResult(False, "takeoff/land was sent a moment ago; ignored", TOGGLE_GUARD)
            if not control_up:
                return ToggleResult(False, _LINK_DOWN_MESSAGE, DRONE_LINK_DOWN)
            self._last_toggle_at = now   # checked and set under one lock: two toggles cannot both pass
        logger.info("pilot takeoff/land toggle")
        if self._link.takeoff_land_toggle() is not True:
            return ToggleResult(False, _LINK_DOWN_MESSAGE, DRONE_LINK_DOWN)
        return ToggleResult(True, "")

    def mission_toggle(self, now: Optional[float] = None) -> bool:
        """The mission runner lands on confirmed arrival. Refused when e-stopped, just toggled, when the
        drone link is down, when any pilot input arrived since the runner's last mission_command, or
        when any pilot input arrived in the last MISSION_TOGGLE_PILOT_QUIET_S.
        True only when the toggle went onto an open socket."""
        now = self._clock() if now is None else now
        control_up = self._link.control_up() is True   # called out before the lock (lock rule)
        with self._lock:
            if self._estop:
                return False
            if self._pilot_since_mission:
                logger.warning("mission toggle refused: pilot input since the last mission command")
                return False
            if (self._last_pilot_input_at is not None
                    and (now - self._last_pilot_input_at) < MISSION_TOGGLE_PILOT_QUIET_S):
                logger.warning("mission toggle refused: pilot input in the last %.1f s", MISSION_TOGGLE_PILOT_QUIET_S)
                return False
            if self._last_toggle_at is not None and (now - self._last_toggle_at) < TOGGLE_GUARD_S:
                return False
            if not control_up:
                logger.warning("mission toggle refused: drone link down")
                return False
            self._last_toggle_at = now
        logger.info("mission takeoff/land toggle (confirmed arrival)")
        if self._link.takeoff_land_toggle() is not True:
            return False
        with self._lock:
            self._mission_toggle_at = now
        return True

    def pilot_estop(self, now: Optional[float] = None) -> bool:
        """Latch the emergency stop and send the motor cut. Returns True when this press went onto an
        open socket (the mixer keeps asserting it on every tick until reset either way)."""
        now = self._clock() if now is None else now
        with self._lock:
            newly = not self._estop
            self._estop = True
            if newly:
                self._estop_ok_at = None
                self._estop_open_s = 0.0
                self._estop_confirmed = False
            self._pilot_target = NEUTRAL
            self._pilot_value = NEUTRAL
            self._pilot_nonzero_at = None
            self._mission_cmd = None
            self._mission_at = None
            self._pilot_since_mission = True
            self._last_pilot_input_at = now
            self._sent = NEUTRAL
            self._source = "estop"
        logger.warning("EMERGENCY STOP")
        with self._send_lock:
            sent = self._link.emergency_stop() is True
            self._estop_asserted(now, sent)
            self._link.set_axes(*NEUTRAL)
        if not sent:
            logger.warning("motor-cut command NOT sent: drone link down; it is re-sent on every tick")
        self._notify("estop")
        return sent

    def estop_reset(self) -> None:
        with self._send_lock:   # never between a tick's motor-cut assertion and its axes
            with self._lock:
                was = self._estop
                self._estop = False
                self._estop_ok_at = None
                self._estop_open_s = 0.0
                self._estop_confirmed = False
        if was:
            logger.warning("emergency stop reset by pilot")

    def calibrate(self) -> Tuple[bool, str]:
        with self._lock:
            if self._estop:
                return False, "emergency stop is active; reset it first"
        self._link.calibrate()
        return True, ""

    def set_max_stick(self, value: float) -> float:
        value = _finite(value)
        if not MAX_STICK_MIN <= value <= MAX_STICK_MAX:
            raise ValueError(f"max_stick must be between {MAX_STICK_MIN} and {MAX_STICK_MAX}")
        with self._lock:
            self._max_stick = value
        return value

    def set_trim(self, roll: float, pitch: float) -> Tuple[float, float]:
        roll = clamp(_finite(roll), -TRIM_LIMIT, TRIM_LIMIT)
        pitch = clamp(_finite(pitch), -TRIM_LIMIT, TRIM_LIMIT)
        with self._lock:
            self._trim_roll, self._trim_pitch = roll, pitch
        return roll, pitch

    def trim(self) -> Tuple[float, float]:
        with self._lock:
            return self._trim_roll, self._trim_pitch

    # ------------------------------------------------------------------ #
    # mission inputs
    # ------------------------------------------------------------------ #
    def mission_command(self, yaw: float, pitch: float, now: Optional[float] = None,
                        roll: float = 0.0) -> None:
        """Yaw and pitch from the mission runner, plus an optional drift-assist roll.

        The roll is clamped to +-MISSION_ROLL_LIMIT here as well, whatever the caller asked for
        (a value that is not a finite number counts as zero).
        There is no throttle argument: a mission can never command it.
        """
        now = self._clock() if now is None else now
        yaw, pitch = float(yaw), float(pitch)
        if not (math.isfinite(yaw) and math.isfinite(pitch)):
            with self._lock:
                self._mission_cmd = None
                self._mission_at = None
                log = not self._bad_mission_logged
                self._bad_mission_logged = True
            if log:
                logger.error("mission command rejected: yaw %r / pitch %r is not a finite number", yaw, pitch)
            return
        roll = float(roll)
        roll = clamp(roll, -MISSION_ROLL_LIMIT, MISSION_ROLL_LIMIT) if math.isfinite(roll) else 0.0
        with self._lock:
            self._mission_cmd = (clamp(yaw), clamp(pitch), roll)
            self._mission_at = now
            self._pilot_since_mission = False

    def clear_mission_command(self) -> None:
        with self._lock:
            self._mission_cmd = None
            self._mission_at = None

    # ------------------------------------------------------------------ #
    # read side
    # ------------------------------------------------------------------ #
    @property
    def estop_active(self) -> bool:
        with self._lock:
            return self._estop

    def snapshot(self, now: Optional[float] = None) -> MixerSnapshot:
        now = self._clock() if now is None else now
        with self._lock:
            return MixerSnapshot(
                manual_active=self._pilot_active_locked(now),
                max_stick=self._max_stick,
                estop_active=self._estop,
                trim_roll=self._trim_roll,
                trim_pitch=self._trim_pitch,
                source=self._source,
                sent=self._sent,
                estop_confirmed=self._estop and self._estop_confirmed,
                sticks_blocked=self._sticks_blocked,
            )

    def _notify(self, kind: str) -> None:
        callback = self.on_pilot_input
        if callback is None:
            return
        try:
            callback(kind)
        except Exception:
            logger.exception("pilot-input callback failed")
