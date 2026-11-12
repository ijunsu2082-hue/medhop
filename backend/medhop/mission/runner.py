"""Station-run state machine, failsafes and hover test (SPEC section 6).

A manual run never takes off: the pilot does. The runner steers yaw and pitch, through the
ControlMixer, and sends the shared takeoff/land toggle at most once: after a confirmed arrival. On an
abort it sends neutral and never the toggle (if the drone has already landed by itself, the toggle
would launch it).

An automatic run (`start(..., automatic=True)`, the "Fly to station" button or a dose coming due with
automatic flights on) also takes off: the runner sends the toggle once from the ground, waits
`takeoff_wait_s` with neutral sticks, then searches as usual and always lands on arrival. If it stops
early for one of SAFE_LANDING_REASONS it lands where it is, because nobody may be there to land it,
but only on current evidence that it is in the air (`_airborne_now_locked`: the marker has grown since
first seen, which only a flying drone can do, it is in view now, and it is not rising in the picture).
Without that evidence it sends no second toggle and the status says the drone needs a pilot.

Where it lands: a detection counts toward arrival only when the marker is at least the arrive width
(about 0.8 m from the sign with the defaults), near the middle of the picture and seen from the front,
on arrive_consecutive frames in a row, after it has grown since first seen. Seeing the sign from far
away only starts the approach; a sign too far away to be at least MarkerDetector.MIN_WIDTH of the frame
is not detected at all, and any other marker id is ignored.

Drift assist (experimental, off by default, SPEC section 6 Revision 2): while approaching, the run
may add a small bounded roll that cancels sideways drift (`steering.DriftAssist`). It never touches
throttle, it sends no roll in any other state, and it switches itself off for the rest of the run
when its own off-axis check says it is making things worse.

Threading: `step(observation, now)` is called by the vision thread for every new frame and, with
`None`, a few times a second in between so timers run without video. All other methods only read a
snapshot or set a request. Nothing here sleeps, so tests drive it with an injected clock.

"Marker width" in the arrival, taper and too-close rules means `apparent_width()`: the marker's size
corrected for the viewing angle. Seen square-on it equals the reported width. Seen from the side the
plain width shrinks, which would let a drone that has drifted sideways fly on toward the wall; the
corrected figure instead reaches the arrive width at the same distance from the wall. The growth rule
uses `MarkerObs.size` (the larger edge measure), which tracks range.

Lock rule: the runner may call the mixer while holding its lock; the mixer never calls the runner
while holding its own.
"""
from __future__ import annotations

import logging
import math
import secrets
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from medhop.care.store import CareStore
from medhop.config import Settings
from medhop.drone.base import DroneLink
from medhop.mission.steering import (
    DriftAssist, DriftAssistConfig, MarkerSample, Steering, SteeringConfig, marker_skew,
)
from medhop.mixer import ControlMixer
from medhop.vision.marker import MarkerObs, Observation
from medhop.vision.pose import fit_sign_pose
from medhop.vision.person import PersonStatus

logger = logging.getLogger("medhop.mission")

IDLE = "idle"
COUNTDOWN = "countdown"     # automatic runs only: on the ground, a few seconds before the takeoff toggle
TAKING_OFF = "taking_off"   # automatic runs only: the runner sent the takeoff toggle and waits, neutral
SEARCHING = "searching"
APPROACHING = "approaching"
ALIGNING = "aligning"       # at the landing distance: sliding onto the sign's centre line before landing
ARRIVED = "arrived"
LANDING = "landing"
DONE = "done"
ABORTED = "aborted"
HOVER_TEST = "hover_test"
STATES = (IDLE, COUNTDOWN, TAKING_OFF, SEARCHING, APPROACHING, ALIGNING, ARRIVED, LANDING, DONE, ABORTED,
          HOVER_TEST)

# a station run is in progress
RUN_STATES = (COUNTDOWN, TAKING_OFF, SEARCHING, APPROACHING, ALIGNING, ARRIVED, LANDING)
ABORTABLE_STATES = (COUNTDOWN, TAKING_OFF, SEARCHING, APPROACHING, ALIGNING, ARRIVED)   # before the landing toggle

ABORT_REASONS = (
    "marker_not_found", "marker_lost", "video_stale", "timeout",
    "pilot_took_over", "person_in_view", "battery_low", "estop",
    "off_axis",   # not in SPEC section 6: added failsafe, see RunnerConfig.off_axis_aspect
    "pilot_link_lost",   # the pilot's control socket dropped: nobody could press stop any more
    "unexpected_descent",   # settle descent guard: the drone is sinking by itself (SPEC 10.2)
    "takeoff_refused",      # automatic run: the mixer did not send the takeoff toggle
    "not_lined_up",         # at the arrive distance but could not get centred and in front of the sign
    "already_at_station",   # automatic run: the marker was already at arrive size after takeoff
)
BLOCKERS = (
    "no_video", "estop_active", "already_running", "person_in_view", "battery_low", "marker_too_close",
    "no_pilot_link",     # no pilot control socket is connected (start and hover test)
    "drone_flying",      # automatic start only: simulated telemetry says the drone is already up
    "recent_toggle",     # automatic start only: a takeoff/land toggle went out a moment ago
)
DRONE_FLYING = "drone_flying"
RECENT_TOGGLE = "recent_toggle"
# An automatic run that stops early lands where it is (the land toggle) for these reasons, because
# nobody may be there to land it and hovering until the battery runs out ends in a fall. Only on
# CURRENT evidence that it is in the air (`_airborne_now_locked`): the flight confirmed, the marker in
# view right now and not rising in the picture (a sinking camera). marker_lost and video_stale are not
# here: without a picture there is no such evidence, and a drone that landed by itself would be
# relaunched. Never for estop (motor cut), pilot_took_over (the pilot has it), unexpected_descent (it
# is already landing: a toggle would relaunch it) or takeoff_refused (it never left the ground).
SAFE_LANDING_REASONS = frozenset({
    "timeout", "person_in_view", "battery_low", "off_axis", "not_lined_up", "pilot_link_lost",
})
NO_PILOT_LINK = "no_pilot_link"
NOT_CONFIRMED = "confirm_airborne_required"
MARKER_NOT_VISIBLE = "marker_not_visible"


@dataclass
class RunnerConfig:
    search_timeout_s: float = 12.0     # searching longer than this aborts with marker_not_found
    lost_hold_s: float = 0.6           # marker lost: hold neutral this long
    lost_creep_s: float = 2.0          # then creep-search this long, then abort with marker_lost
    video_stale_s: float = 1.5         # a frame older than this aborts with video_stale
    run_timeout_s: float = 45.0
    # Neutral sticks after arrival before landing. 1.2 s, not SPEC 6's 0.6 s: with about 0.35 s of video
    # delay, a 0.6 s settle left the descent guard blind to a descent that began late in the settle.
    settle_s: float = 1.2
    land_wait_s: float = 4.0           # time given to the landing before the run is done
    arrive_consecutive: int = 3        # detections in a row at or above the arrive width
    growth_ratio: float = 1.15         # the marker must have grown this much since first seen
    arrive_marker_fresh_s: float = 0.3  # the marker must still be in view when the toggle is sent
    # Settle descent guard (SPEC 10.2). The reference cy is the median of the first
    # settle_reference_count detections taken at least settle_reference_after_s into the settle (after
    # the drone has pitched back from its forward stick). When settle_descent_consecutive detections in
    # a row show the marker more than settle_descent_frac of the frame height ABOVE the reference (cy
    # smaller: the camera is sinking, so the drone is landing by itself), the run aborts with
    # unexpected_descent and does not toggle. The marker moving DOWN the picture does not count. The
    # landing toggle also waits until the guard has its reference, has checked that many detections
    # after it, and has no suspicious detection pending, but no longer than settle_guard_wait_s past
    # settle_s: then the run ends done without the toggle (landing_skipped "settle_guard_undecided")
    # and the pilot lands. The guard only runs when land on arrival is on. 0 disables the guard.
    settle_descent_frac: float = 0.08
    settle_guard_wait_s: float = 1.0
    settle_reference_after_s: float = 0.25
    settle_reference_count: int = 3
    settle_descent_consecutive: int = 3
    # A smaller rise than settle_descent_frac on the latest detection does not abort, but the toggle
    # waits (within settle_guard_wait_s) until it is gone: a slow sink that started late in the settle
    # has not reached the abort threshold yet when the settle ends.
    settle_pending_frac: float = 0.03
    # SEARCHING moves to APPROACHING (and a start goes straight to APPROACHING) only after this many
    # consecutive detections whose centres agree within search_confirm_spread (cx in frame widths, cy
    # in frame heights); the growth check is seeded from the median size of those detections.
    search_confirm_count: int = 3
    search_confirm_spread: float = 0.1
    frame_gap_hold_s: float = 0.25     # no new frame for this long: command neutral
    # Added failsafe (not in SPEC section 6). The run steers with yaw and pitch only, so sideways
    # drift carries the drone around the marker until it flies at the wall from the side. When the
    # marker looks narrower than this fraction of its height (0.70 is about 45 degrees off the wall's
    # normal) on off_axis_consecutive detections, the run aborts with reason "off_axis". 0 disables.
    off_axis_aspect: float = 0.70
    off_axis_consecutive: int = 3
    video_live_s: float = 0.5          # start is blocked when the newest frame is older than this
    marker_fresh_s: float = 0.5        # a detection older than this is not "currently visible"
    person_fresh_s: float = 2.0        # a person-check result older than this is ignored
    hover_test_s: float = 10.0         # the pass limit is Settings.hover_max_excursion_m
    hover_visible_pct: float = 80.0
    # Automatic runs: on the ground this long before the takeoff toggle (the page counts down and
    # beeps; Stop cancels with no flight), then neutral sticks for takeoff_wait_s before searching.
    countdown_s: float = 5.0
    takeoff_wait_s: float = 4.0
    recent_toggle_s: float = 10.0      # an automatic start is blocked this long after any toggle
    # At the arrive distance the run flies no further forward (yaw only). Still not arrived after this
    # long there: abort not_lined_up instead of hovering at the wall.
    arrive_stall_s: float = 2.5
    # Safe landing evidence: the marker seen this recently, and its cy not more than settle_descent_frac
    # above the median cy of the detections between 2.0 and 0.5 s ago.
    safe_land_marker_fresh_s: float = 0.5
    # Final line-up (ALIGNING). At the arrive distance the run measures where the drone is relative to
    # the sign (vision/pose.py: metres left/right of the sign's centre line and from the wall), then
    # slides sideways with roll and holds the distance with pitch while yaw keeps the sign centred.
    # It lands once it has been within align_tolerance_m of the centre line, within
    # align_distance_tol_m of the landing distance, the sign within align_centre_tol of the picture's
    # middle and nearly still, for align_hold_s. Not lined up after align_timeout_s: it lands anyway
    # when within align_loose_m (the arrival says it was not lined up exactly), else stops with
    # not_lined_up. The roll that was holding it still is kept on during the settle and the landing
    # (a temporary trim), so the drone comes down where it lined up instead of drifting off. The
    # settle after lining up is the usual settle_s with the descent guard, whose reference is where
    # the sign sat while the drone held still.
    align_enabled: bool = True
    align_tolerance_m: float = 0.04
    align_distance_tol_m: float = 0.08
    align_centre_tol: float = 0.06
    align_still_m_s: float = 0.05
    align_hold_s: float = 1.0
    align_timeout_s: float = 15.0
    align_loose_m: float = 0.12
    align_tau_s: float = 0.25          # smoothing of the measured position
    align_roll_kp: float = 0.7         # roll stick per metre off the centre line
    align_roll_kd: float = 0.9         # roll stick per metre/second of sideways speed
    align_roll_ki: float = 0.35        # roll stick per metre-second (cancels a steady drift)
    align_roll_max: float = 0.15       # the mixer's mission roll limit
    align_roll_i_max: float = 0.15
    align_pitch_kp: float = 0.4        # pitch stick per metre too far from the wall
    align_pitch_kd: float = 0.5
    align_pitch_max: float = 0.08
    align_lost_s: float = 1.0          # marker out of view this long while lining up: marker_lost
    # No separate roll-sign check here: a wrong sign would push the drone off the centre line, and
    # align_give_up_m stops the line-up long before it gets far (the approach's drift assist has its
    # own check). Give up early (not_lined_up) instead of chasing the sign: this far off the centre
    # line, or this much closer to the wall than the landing distance.
    align_give_up_m: float = 0.90
    align_too_close_m: float = 0.25
    # A detection only counts toward arrival when the marker is also near the middle of the picture
    # (|cx - 0.5| at most this) and seen from the front (width/height at least arrive_min_aspect, about
    # 37 degrees off the wall's normal). Big enough and centred but seen from the side on
    # arrive_consecutive detections: the drone is beside the station, so the run stops with off_axis
    # instead of landing there. 0 for arrive_min_aspect disables both the facing rule and that abort.
    arrive_centre_tol: float = 0.12
    arrive_min_aspect: float = 0.80


def marker_aspect(marker: MarkerObs) -> float:
    """Width over height: 1 seen square-on, about the cosine of the viewing angle from the side."""
    return marker.width / marker.height if marker.height > 0 else 1.0


def apparent_width(marker: MarkerObs) -> float:
    """The width a square-on marker would show at the drone's current distance from the wall."""
    return marker.size / max(0.5, min(1.0, marker_aspect(marker)))


def _round_or_none(value: Optional[float], digits: int = 2) -> Optional[float]:
    return None if value is None else round(value, digits)


def _no_person() -> PersonStatus:
    return PersonStatus()


class MissionRunner:
    def __init__(
        self,
        link: DroneLink,
        mixer: ControlMixer,
        store: CareStore,
        settings: Settings,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        person_status: Optional[Callable[[], PersonStatus]] = None,
        steering_config: Optional[SteeringConfig] = None,
        config: Optional[RunnerConfig] = None,
        drift_assist_config: Optional[DriftAssistConfig] = None,
        pilot_connected: Optional[Callable[[], bool]] = None,
    ) -> None:
        self._link = link
        self._mixer = mixer
        self._store = store
        self._settings = settings
        self._clock = clock
        self._wall_clock = wall_clock
        self._person_status = person_status or _no_person
        # Tells whether a pilot control socket is connected. None (tests without a server) = no check.
        self._pilot_connected = pilot_connected
        self.cfg = config or RunnerConfig()
        self._steering = Steering(steering_config)
        self._assist = DriftAssist(drift_assist_config, assumed_yaw_rate=self._steering.cfg.yaw_rate_fw_per_s)
        self._lock = threading.RLock()
        self._pending_io: List[Callable[[], None]] = []

        stored_width = store.load_arrive_width()
        self._arrive_width = stored_width if stored_width is not None else settings.arrive_width
        self._land_on_arrival = store.load_land_on_arrival()   # persisted; off by default
        self._drift_assist = store.load_drift_assist()   # the switch (persisted); off by default
        self._auto_fly = store.load_auto_fly()           # fly automatically at dose times; off by default
        self._automatic = False                          # the current (or last) run took off by itself
        self._flight_confirmed = False                   # the marker grew since first seen in this run
        self._timeout_from = 0.0                         # the run timeout counts from here
        self._at_size_since: Optional[float] = None      # since when the marker has been at arrive size
        self._align: Dict[str, Any] = {}                 # line-up state, see _step_aligning_locked
        self._hold_roll = 0.0                            # roll kept on through settle and landing
        self._last_arrival: Optional[Dict[str, Any]] = None
        self._cy_log: Deque[Tuple[float, float]] = deque()   # (frame time, cy) of recent detections
        # A person marked the drone as on its start spot; scheduled automatic runs need it. In memory
        # only (a restart clears it) and cleared by any run start or pilot input.
        self._ready_for_dose = False
        # An automatic run stopped early without landing: the drone may be in the air with nobody
        # flying it. Cleared when the next run starts or the pilot acts.
        self._needs_pilot = False
        self._assist_run = False                         # this run started with the switch on
        self._assist_disabled_at: Optional[float] = None
        self._assist_ts: Optional[float] = None          # frame time of the assist's previous step
        self._suggested_trim_roll: Optional[float] = None
        self._roll = 0.0

        self._state = IDLE
        self._reason: Optional[str] = None
        self._run_id: Optional[str] = None
        self._dose_id: Optional[str] = None
        self._started_at = 0.0
        self._started_wall = 0.0
        self._ended_at: Optional[float] = None
        self._phase_at = 0.0
        self._command: Tuple[float, float] = (0.0, 0.0)
        self._last_obs: Optional[Observation] = None
        self._last_frame_ts = 0.0
        self._search_started = 0.0
        self._first_width: Optional[float] = None
        self._arrive_count = 0
        self._size_count = 0
        self._off_axis_count = 0
        self._lost_since: Optional[float] = None
        self._last_cx = 0.5
        self._marker_seen_at = 0.0
        self._arrived_width = 0.0
        self._settle_ref: List[float] = []                # settle descent guard: reference detections' cy
        self._settle_ref_cy: Optional[float] = None
        self._settle_checks = 0                          # detections checked against the reference
        self._descent_count = 0                          # of those, consecutive ones above it
        self._last_rise = 0.0                            # the latest detection's rise above it
        self._candidates: Deque[MarkerObs] = deque(maxlen=self.cfg.search_confirm_count)
        self._toggle_sent = False
        # What the latest run did about landing once it arrived: "sent", "skipped_settle_guard_undecided",
        # "refused_by_mixer" or "off"; None before any run and for a run that has not arrived.
        self._last_landing: Optional[str] = None
        self._history: Deque[MarkerSample] = deque()
        self._trace: List[Dict[str, Any]] = []

        self._hover: Optional[Dict[str, Any]] = None     # {"running", "started_at", "elapsed_s", "result"}
        self._hover_samples: List[Tuple[float, Optional[float], Optional[float]]] = []

    # ------------------------------------------------------------------ #
    # requests
    # ------------------------------------------------------------------ #
    def blockers(self, now: Optional[float] = None) -> List[str]:
        now = self._clock() if now is None else now
        with self._lock:
            return self._blockers_locked(now)

    def _current_marker(self, now: float) -> Optional[MarkerObs]:
        obs = self._last_obs
        if obs is None or obs.marker is None or (now - obs.ts) > self.cfg.marker_fresh_s:
            return None
        return obs.marker

    def _person_in_view(self, now: float) -> bool:
        person = self._person_status()
        if not (person.enabled and person.detected):
            return False
        return person.ts is None or (now - person.ts) <= self.cfg.person_fresh_s

    def _battery_low(self, now: float) -> bool:
        """Only with the check enabled (MEDHOP_BATTERY_LOW_RAW >= 0) and on fresh telemetry: a reading
        older than telemetry_fresh_s is no decision either way."""
        if not self._settings.battery_check_enabled:
            return False
        telemetry = self._link.telemetry()
        if telemetry is None or now - telemetry.timestamp >= self._settings.telemetry_fresh_s:
            return False
        return telemetry.battery_raw <= self._settings.battery_low_raw

    def _update_candidates_locked(self, marker: Optional[MarkerObs]) -> None:
        """Consecutive detections whose centres agree; a miss or a far-off detection starts again."""
        if marker is None:
            self._candidates.clear()
            return
        spread = self.cfg.search_confirm_spread
        if any(abs(marker.cx - m.cx) > spread or abs(marker.cy - m.cy) > spread for m in self._candidates):
            self._candidates.clear()
        self._candidates.append(marker)

    def _marker_confirmed_locked(self) -> bool:
        return len(self._candidates) >= self.cfg.search_confirm_count

    def _seed_approach_locked(self) -> None:
        """Enter APPROACHING from confirmed detections: the growth check starts from their median size."""
        self._state = APPROACHING
        self._first_width = statistics.median(m.size for m in self._candidates)
        self._last_cx = self._candidates[-1].cx

    def _no_pilot_link(self) -> bool:
        return self._pilot_connected is not None and not self._pilot_connected()

    def _drone_flying(self, now: float) -> bool:
        """Simulator only: fresh simulated telemetry says the drone is in the air. The real drone's
        fly-state byte is unverified, so it is never used for a decision."""
        if self._link.mode != "sim":
            return False
        telemetry = self._link.telemetry()
        if telemetry is None or now - telemetry.timestamp >= self._settings.telemetry_fresh_s:
            return False
        return telemetry.fly_state_raw != 0

    def _blockers_locked(self, now: float, automatic: bool = False) -> List[str]:
        out: List[str] = []
        if automatic and self._drone_flying(now):
            out.append(DRONE_FLYING)    # the takeoff toggle would land it instead
        if automatic:
            since = self._mixer.seconds_since_toggle(now)
            if since is not None and since < self.cfg.recent_toggle_s:
                out.append(RECENT_TOGGLE)   # it may be climbing or landing: the toggle would undo that
        if self._no_pilot_link():
            out.append(NO_PILOT_LINK)      # a run may only start while a pilot window is connected
        frame = self._link.latest_frame()
        if frame is None or (now - frame.timestamp) > self.cfg.video_live_s:
            out.append("no_video")
        if self._mixer.estop_active:
            out.append("estop_active")
        if self._state in RUN_STATES or self._state == HOVER_TEST:
            out.append("already_running")
        if self._person_in_view(now):
            out.append("person_in_view")
        if self._battery_low(now):
            out.append("battery_low")
        marker = self._current_marker(now)
        if marker is not None and apparent_width(marker) >= self._arrive_width:
            out.append("marker_too_close")
        return out

    def start(self, confirm_airborne: bool, dose_id: Optional[str] = None,
              now: Optional[float] = None, automatic: bool = False) -> Tuple[bool, List[str]]:
        """Begin a station run. Returns (started, blockers).

        Manual (automatic=False): the pilot has taken off and confirms it; the runner never takes off.
        Automatic: the drone is on the ground; the runner sends the takeoff toggle itself, and
        confirm_airborne is not used."""
        now = self._clock() if now is None else now
        automatic = automatic is True
        with self._lock:
            blockers = self._blockers_locked(now, automatic=automatic)
            if not automatic and confirm_airborne is not True:
                blockers.insert(0, NOT_CONFIRMED)
            if blockers:
                return False, blockers
            stamp = datetime.fromtimestamp(self._wall_clock()).strftime("%Y%m%d-%H%M%S")
            self._run_id = f"run-{stamp}-{secrets.token_hex(2)}"
            self._dose_id = dose_id
            self._reason = None
            self._started_at = now
            self._started_wall = self._wall_clock()
            self._ended_at = None
            self._command = (0.0, 0.0)
            self._roll = 0.0
            self._assist.reset()
            # Automatic runs always use the drift assist: with nobody to correct a sideways drift it
            # is what keeps the landing in front of the sign (it still switches itself off when its
            # own check says it is making things worse).
            self._assist_run = self._drift_assist or automatic
            self._assist_disabled_at = None
            self._assist_ts = None
            self._suggested_trim_roll = None
            frame = self._link.latest_frame()
            self._last_frame_ts = frame.timestamp if frame is not None else now
            self._search_started = now
            self._first_width = None
            self._arrive_count = 0
            self._size_count = 0
            self._off_axis_count = 0
            self._lost_since = None
            self._last_cx = 0.5
            self._toggle_sent = False
            self._last_landing = None
            self._history.clear()
            self._trace = []
            self._steering.reset()
            self._automatic = automatic
            self._flight_confirmed = False
            self._timeout_from = now
            self._at_size_since = None
            self._cy_log.clear()
            self._align = {}
            self._hold_roll = 0.0
            self._ready_for_dose = False      # the drone is leaving its start spot
            self._needs_pilot = False
            self._state = COUNTDOWN if automatic else SEARCHING
            self._phase_at = now
            if not automatic and self._current_marker(now) is not None and self._marker_confirmed_locked():
                self._seed_approach_locked()
            self._queue_event("run_started", {
                "arrive_width": round(self._arrive_width, 4),
                "land_on_arrival": self._lands_on_arrival_locked(),
                "drift_assist": self._assist_run,
                "automatic": automatic,
                "mode": self._link.mode,
            })
            logger.info("station run %s started (dose %s, state %s, %s, drift assist %s)", self._run_id, dose_id,
                        self._state, "automatic" if automatic else "manual", "on" if self._assist_run else "off")
        self.flush()
        return True, []

    def _take_off_locked(self, now: float) -> None:
        """End of the countdown: neutral first (this also clears the mixer's "pilot input since the
        last mission command" flag), then the one takeoff toggle."""
        self._send(*self._steering.neutral(now), now)
        if self._mixer.mission_toggle(now, landing=False):
            self._state = TAKING_OFF
            self._phase_at = now
            logger.info("run %s: takeoff toggle sent", self._run_id)
        else:
            self._abort_locked("takeoff_refused", now)

    def mark_ready_for_dose(self) -> Tuple[bool, List[str]]:
        """A person says the drone is on its start spot, facing the sign. Scheduled automatic runs
        only start while this is set."""
        with self._lock:
            if self._state in RUN_STATES or self._state == HOVER_TEST:
                return False, ["already_running"]
            self._ready_for_dose = True
            self._needs_pilot = False
        logger.info("drone marked ready for the next dose")
        return True, []

    def note_pilot_input(self) -> None:
        """The pilot moved the sticks, toggled or pressed stop: the drone is not known to be on its
        start spot any more, and somebody is flying it."""
        with self._lock:
            self._ready_for_dose = False
            self._needs_pilot = False

    @property
    def ready_for_dose(self) -> bool:
        with self._lock:
            return self._ready_for_dose

    def _lands_on_arrival_locked(self) -> bool:
        """Automatic runs always land on arrival; manual runs follow the switch."""
        return self._automatic or self._land_on_arrival

    def abort(self, reason: str = "pilot_took_over", now: Optional[float] = None) -> bool:
        """Stop whatever is running. Safe to call at any time. Returns True when something was stopped."""
        now = self._clock() if now is None else now
        with self._lock:
            if self._state in ABORTABLE_STATES:
                self._abort_locked(reason, now)
                return True
            if self._state == LANDING:
                # The toggle has been sent and the arrival is logged; the pilot simply has control now.
                self._finish_done_locked(now)
                return True
            if self._state == HOVER_TEST:
                self._cancel_hover_locked(reason, now)
                return True
        return False

    def start_hover_test(self, now: Optional[float] = None) -> Tuple[bool, List[str]]:
        now = self._clock() if now is None else now
        with self._lock:
            problems: List[str] = []
            if self._no_pilot_link():
                problems.append(NO_PILOT_LINK)
            if self._state in RUN_STATES or self._state == HOVER_TEST:
                problems.append("already_running")
            if self._mixer.estop_active:
                problems.append("estop_active")
            if self._current_marker(now) is None:
                problems.append(MARKER_NOT_VISIBLE)
            if problems:
                return False, problems
            self._state = HOVER_TEST
            self._reason = None
            self._run_id = None
            self._dose_id = None
            self._started_at = now
            self._ended_at = None
            self._command = (0.0, 0.0)
            self._hover = {"running": True, "started_at": now, "elapsed_s": 0.0, "result": None}
            self._hover_samples = []
            self._mixer.clear_mission_command()
            logger.info("hover test started")
        return True, []

    def calibrate_arrival(self, now: Optional[float] = None) -> Tuple[Optional[float], List[str]]:
        """Store the currently observed marker width as the arrive width."""
        now = self._clock() if now is None else now
        with self._lock:
            if self._state in RUN_STATES or self._state == HOVER_TEST:
                return None, ["already_running"]
            marker = self._current_marker(now)
            if marker is None:
                return None, [MARKER_NOT_VISIBLE]
            width = max(0.03, min(0.8, apparent_width(marker)))
            self._arrive_width = width
            self._pending_io.append(lambda: self._store.save_arrive_width(width))
            logger.info("arrive width calibrated to %.3f of the frame width", width)
        self.flush()
        return width, []

    def set_land_on_arrival(self, value: bool) -> bool:
        """The land-on-arrival switch (persisted, off by default)."""
        with self._lock:
            value = bool(value)
            self._land_on_arrival = value
            self._pending_io.append(lambda: self._store.save_land_on_arrival(value))
        self.flush()
        return value

    def set_drift_assist(self, value: bool) -> bool:
        """The drift-assist switch (persisted). Switching it off takes effect at once, also in the
        middle of a run; switching it on applies from the next run."""
        with self._lock:
            value = bool(value)
            self._drift_assist = value
            self._pending_io.append(lambda: self._store.save_drift_assist(value))
        self.flush()
        return value

    def set_auto_fly(self, value: bool) -> bool:
        """The automatic-flights switch (persisted, off by default): when on, a dose coming due starts
        an automatic run. Switching it off does not stop a run in progress (Stop does)."""
        with self._lock:
            value = bool(value)
            self._auto_fly = value
            self._pending_io.append(lambda: self._store.save_auto_fly(value))
        self.flush()
        return value

    @property
    def auto_fly(self) -> bool:
        with self._lock:
            return self._auto_fly

    def settings(self) -> Dict[str, bool]:
        with self._lock:
            return {"land_on_arrival": self._land_on_arrival, "drift_assist": self._drift_assist,
                    "auto_fly": self._auto_fly}

    @property
    def arrive_width(self) -> float:
        with self._lock:
            return self._arrive_width

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def reason(self) -> Optional[str]:
        with self._lock:
            return self._reason

    # ------------------------------------------------------------------ #
    # the step
    # ------------------------------------------------------------------ #
    def step(self, obs: Optional[Observation], now: Optional[float] = None) -> None:
        now = self._clock() if now is None else now
        with self._lock:
            if obs is not None:
                self._last_obs = obs
                self._update_candidates_locked(obs.marker)
            self._step_locked(obs, now)
        self.flush()

    def _step_locked(self, obs: Optional[Observation], now: float) -> None:
        if self._state == HOVER_TEST:
            self._step_hover_locked(obs, now)
            return
        if self._state not in RUN_STATES:
            return
        if obs is not None:
            self._last_frame_ts = obs.ts
            if obs.marker is not None:
                self._cy_log.append((obs.ts, obs.marker.cy))     # safe-landing evidence
                while self._cy_log and obs.ts - self._cy_log[0][0] > 3.0:
                    self._cy_log.popleft()

        if self._state == LANDING:
            # After a line-up it keeps holding the spot (or at least cancelling the drift) on the way down.
            if self._align.get("done"):
                self._hold_position_locked(None if obs is None else obs.marker, obs, now)
            else:
                self._send(0.0, 0.0, now)
            if now - self._phase_at >= self.cfg.land_wait_s:
                self._finish_done_locked(now)
            return

        # failsafes, checked on every step in every state before the toggle
        if self._mixer.estop_active:
            return self._abort_locked("estop", now)
        if now - self._timeout_from > self.cfg.run_timeout_s:
            return self._abort_locked("timeout", now)
        if now - self._last_frame_ts > self.cfg.video_stale_s:
            return self._abort_locked("video_stale", now)
        if self._person_in_view(now):
            return self._abort_locked("person_in_view", now)
        if self._battery_low(now):
            return self._abort_locked("battery_low", now)

        if self._state == COUNTDOWN:
            # On the ground: nothing is sent until the countdown is over.
            if now - self._phase_at >= self.cfg.countdown_s:
                self._take_off_locked(now)
            return

        if self._state == TAKING_OFF:
            # Neutral sticks while the drone climbs to its hover height by itself.
            self._send(*self._steering.neutral(now), now)
            if obs is not None:
                self._record(now, obs.marker)
            if now - self._phase_at >= self.cfg.takeoff_wait_s:
                marker = self._current_marker(now)
                if marker is not None and apparent_width(marker) >= self._arrive_width:
                    # It took off from in front of the sign: the arrival could not be told from the
                    # start, and flying on would only take it toward the wall.
                    return self._abort_locked("already_at_station", now)
                self._state = SEARCHING
                self._search_started = now
                self._timeout_from = now
                logger.info("run %s: takeoff wait over, searching", self._run_id)
            return

        if obs is None:
            if now - self._last_frame_ts > self.cfg.frame_gap_hold_s:
                self._assist.pause()
                self._send(*self._steering.neutral(now), now)
            return

        marker = obs.marker
        if self._state == SEARCHING:
            if marker is None or not self._marker_confirmed_locked():
                # Not seen, or not yet seen on enough consecutive frames at one place: keep searching.
                if now - self._search_started > self.cfg.search_timeout_s:
                    return self._abort_locked("marker_not_found", now)
                self._send(*self._steering.search(now), now)
                self._record(now, marker)
                return
            self._seed_approach_locked()

        if self._state == APPROACHING:
            self._step_approach_locked(marker, obs, now)
        elif self._state == ALIGNING:
            self._step_aligning_locked(marker, obs, now)
        elif self._state == ARRIVED:
            self._step_arrived_locked(marker, obs, now)
        if self._state in RUN_STATES:
            self._record(now, marker)

    def _step_approach_locked(self, marker: Optional[MarkerObs], obs: Observation, now: float) -> None:
        cfg = self.cfg
        if marker is None:
            self._arrive_count = 0
            self._size_count = 0
            self._off_axis_count = 0
            if self._lost_since is None:
                self._lost_since = now
            lost_for = now - self._lost_since
            self._assist.pause()               # no roll without the marker in view
            if lost_for <= cfg.lost_hold_s:
                self._send(*self._steering.neutral(now), now)
            elif lost_for <= cfg.lost_hold_s + cfg.lost_creep_s:
                direction = 1.0 if self._last_cx >= 0.5 else -1.0
                self._send(*self._steering.search(now, direction=direction, creep=True), now)
            else:
                self._abort_locked("marker_lost", now)
            return

        if self._lost_since is not None:
            self._lost_since = None
            self._history.clear()          # start again from the reacquired marker
        if self._first_width is None:
            self._first_width = marker.size
        self._last_cx = marker.cx
        self._marker_seen_at = obs.ts
        aspect = marker_aspect(marker)
        apparent = apparent_width(marker)
        self._history.append(MarkerSample(ts=obs.ts, cx=marker.cx, width=apparent))
        while self._history and obs.ts - self._history[0].ts > 2.0:
            self._history.popleft()

        at_size = apparent >= self._arrive_width
        centred = abs(marker.cx - 0.5) <= cfg.arrive_centre_tol
        facing = cfg.arrive_min_aspect <= 0 or aspect >= cfg.arrive_min_aspect
        self._arrive_count = self._arrive_count + 1 if (at_size and centred and facing) else 0
        self._size_count = self._size_count + 1 if at_size else 0
        grown = marker.size >= self._first_width * cfg.growth_ratio
        if grown and not self._flight_confirmed:
            self._flight_confirmed = True     # only a drone in the air can fly toward the sign
            logger.info("run %s: flight confirmed (marker grew %.2fx)", self._run_id,
                        marker.size / max(1e-9, self._first_width))
        # Stall timer: at the arrive distance (after growing) but not arriving, for example centred
        # but seen from the side. A little hysteresis so noise at the threshold does not restart it.
        if at_size and grown:
            if self._at_size_since is None:
                self._at_size_since = now
        elif apparent < self._arrive_width * 0.9:
            self._at_size_since = None
        if cfg.align_enabled and grown and self._size_count >= cfg.arrive_consecutive:
            self._start_aligning_locked(now, apparent)
            return
        if not cfg.align_enabled and self._arrive_count >= cfg.arrive_consecutive and grown:
            self._state = ARRIVED
            self._phase_at = now
            self._arrived_width = apparent
            self._settle_ref = []
            self._settle_ref_cy = None
            self._settle_checks = 0
            self._descent_count = 0
            self._last_rise = 0.0
            self._send(*self._steering.neutral(now), now)
            logger.info("run %s: marker at arrive width (%.3f), settling", self._run_id, apparent)
            return

        self._off_axis_count = self._off_axis_count + 1 if aspect < cfg.off_axis_aspect else 0
        if cfg.off_axis_aspect > 0 and self._off_axis_count >= cfg.off_axis_consecutive:
            self._abort_locked("off_axis", now)
            return
        if self._at_size_since is not None and now - self._at_size_since > cfg.arrive_stall_s:
            # Close enough, but not centred in front of the station: do not land there as arrived.
            self._abort_locked("not_lined_up", now, {
                "aspect": round(aspect, 3), "cx": round(marker.cx, 4), "apparent_width": round(apparent, 4),
            })
            return
        # At (a little past) the arrive distance: yaw only, so it lines up without creeping on to the wall.
        hold = grown and apparent >= self._arrive_width * 1.05
        yaw, pitch = self._steering.update(list(self._history), now, self._arrive_width, no_forward=hold)
        self._send(yaw, pitch, now, self._assist_roll_locked(marker, obs.ts, aspect, pitch, now))

    def _assist_roll_locked(self, marker: MarkerObs, ts: float, aspect: float, pitch: float,
                            now: float) -> float:
        """Drift-assist roll for this approach step: 0 unless the switch was on at the start of the
        run, is still on, and the assist has not switched itself off."""
        if not (self._assist_run and (self._drift_assist or self._automatic)):
            return 0.0
        was_disabled = self._assist.disabled_reason is not None
        previous_ts, self._assist_ts = self._assist_ts, ts
        yaw_seen = 0.0 if previous_ts is None else self._steering.yaw_seen_between(previous_ts, ts)
        roll = self._assist.update(ts, marker.cx, marker.size, aspect, marker_skew(marker.corners), yaw_seen,
                                   pitch > 0.0)
        if self._assist.disabled_reason is not None and not was_disabled:
            self._assist_disabled_at = now - self._started_at
            logger.warning("run %s: drift assist switched itself off (%s, by the %s measure); "
                           "the run continues without roll", self._run_id, self._assist.disabled_reason,
                           self._assist.disabled_by)
        return roll

    # ------------------------------------------------------------------ #
    # final line-up
    # ------------------------------------------------------------------ #
    def _start_aligning_locked(self, now: float, apparent: float) -> None:
        self._state = ALIGNING
        self._phase_at = now
        self._arrived_width = apparent
        self._assist.pause()
        self._align = {
            "target_m": self._distance_m(self._arrive_width) or 0.8,
            "x": None, "z": None, "vx": 0.0, "vz": 0.0, "ts": None,
            "integral": 0.0, "roll": 0.0, "pitch": 0.0,
            "aligned_since": None, "window": deque(),      # (ts, cy) while aligned
            "lost_since": None,
            # If the approach's drift assist switched itself off (roll seemed to make things worse),
            # the line-up does not use roll either.
            "roll_ok": not (self._assist_run and self._assist.disabled_reason is not None),
            "done": False, "aligned": False,
        }
        logger.info("run %s: at the landing distance, lining up on the sign's centre line", self._run_id)

    def _measure_locked(self, marker: MarkerObs, ts: float) -> bool:
        """Update the smoothed position (metres) from this detection. False when the fit failed."""
        pose = fit_sign_pose(marker.corners, marker.frame_w, marker.frame_h,
                             self._settings.marker_size_m, self._settings.camera_hfov_deg)
        if pose is None or pose.rms_px > 3.0 or not 0.1 < pose.distance_m < 5.0:
            return False
        a = self._align
        if a["ts"] is None:
            a["x"], a["z"], a["ts"] = pose.lateral_m, pose.distance_m, ts
            return True
        dt = ts - a["ts"]
        if dt <= 0:
            return True
        blend = 1.0 - math.exp(-dt / max(1e-3, self.cfg.align_tau_s))
        x = a["x"] + (pose.lateral_m - a["x"]) * blend
        z = a["z"] + (pose.distance_m - a["z"]) * blend
        a["vx"] += ((x - a["x"]) / dt - a["vx"]) * blend
        a["vz"] += ((z - a["z"]) / dt - a["vz"]) * blend
        a["x"], a["z"], a["ts"] = x, z, ts
        return True

    def _step_aligning_locked(self, marker: Optional[MarkerObs], obs: Observation, now: float) -> None:
        cfg, a = self.cfg, self._align
        if marker is None or not self._measure_locked(marker, obs.ts):
            if a["lost_since"] is None:
                a["lost_since"] = now
            a["aligned_since"] = None
            a["window"].clear()
            self._send(*self._steering.neutral(now), now, a["roll"] if marker is not None else 0.0)
            if now - a["lost_since"] > cfg.align_lost_s:
                self._abort_locked("marker_lost", now)
            return
        a["lost_since"] = None
        self._marker_seen_at = obs.ts
        self._history.append(MarkerSample(ts=obs.ts, cx=marker.cx, width=apparent_width(marker)))
        while self._history and obs.ts - self._history[0].ts > 2.0:
            self._history.popleft()
        roll, pitch = self._position_commands_locked(obs.ts, now)
        x, z, vx, vz = a["x"], a["z"], a["vx"], a["vz"]
        err_z = z - a["target_m"]
        yaw, _ = self._steering.update(list(self._history), now, self._arrive_width, no_forward=True)
        self._send(yaw, pitch, now, roll)

        if abs(x) > cfg.align_give_up_m or err_z < -cfg.align_too_close_m:
            return self._abort_locked("not_lined_up", now, {"lateral_offset_m": round(x, 3),
                                                            "distance_m": round(z, 3)})
        aligned = (abs(x) <= cfg.align_tolerance_m and abs(err_z) <= cfg.align_distance_tol_m
                   and abs(marker.cx - 0.5) <= cfg.align_centre_tol
                   and abs(vx) <= cfg.align_still_m_s and abs(vz) <= cfg.align_still_m_s)
        if aligned:
            if a["aligned_since"] is None:
                a["aligned_since"] = now
            a["window"].append((obs.ts, marker.cy))
        else:
            a["aligned_since"] = None
            a["window"].clear()
        if a["aligned_since"] is not None and now - a["aligned_since"] >= cfg.align_hold_s:
            return self._finish_aligning_locked(now, aligned=True)
        if now - self._phase_at >= cfg.align_timeout_s:
            if abs(x) <= cfg.align_loose_m:
                return self._finish_aligning_locked(now, aligned=False)
            self._abort_locked("not_lined_up", now, {"lateral_offset_m": round(x, 3),
                                                     "distance_m": round(z, 3)})

    def _position_commands_locked(self, ts: float, now: float) -> Tuple[float, float]:
        """(roll, pitch) that hold the drone on the sign's centre line at the landing distance, from
        the smoothed position: PID for roll (the integral cancels a steady drift), PD for pitch.
        +x is right of the centre line and +roll slides right, so roll pushes against x."""
        cfg, a = self.cfg, self._align
        dt = 0.0 if a.get("cmd_ts") is None else max(0.0, min(0.3, ts - a["cmd_ts"]))
        a["cmd_ts"] = ts
        # The picture is about one video delay old: steer on where the drone is now, not where it was.
        lead = self._steering.cfg.latency_s
        x, vx = a["x"] + a["vx"] * lead, a["vx"]
        z = a["z"] + a["vz"] * lead
        if a["roll_ok"]:
            a["integral"] = max(-cfg.align_roll_i_max, min(cfg.align_roll_i_max,
                                                          a["integral"] - cfg.align_roll_ki * x * dt))
            roll = -cfg.align_roll_kp * x - cfg.align_roll_kd * vx + a["integral"]
            roll = max(-cfg.align_roll_max, min(cfg.align_roll_max, roll))
        else:
            roll = 0.0
        a["roll"] = roll
        pitch = cfg.align_pitch_kp * (z - a["target_m"]) - cfg.align_pitch_kd * a["vz"]
        pitch = max(-cfg.align_pitch_max, min(cfg.align_pitch_max, pitch))
        a["pitch"] = pitch
        return roll, pitch

    def _hold_position_locked(self, marker: Optional[MarkerObs], obs: Optional[Observation], now: float) -> None:
        """After lining up (settle and landing): keep holding the spot sideways while the sign is still in
        view, else keep the drift-cancelling roll. Yaw and pitch stay neutral."""
        if (self._align.get("done") and marker is not None and obs is not None
                and self._measure_locked(marker, obs.ts)):
            roll, _pitch = self._position_commands_locked(obs.ts, now)
            if self._align["roll_ok"]:
                self._hold_roll = max(-0.1, min(0.1, self._align["integral"]))
            # Roll only: pitch tilts the camera, which the descent guard would read as sinking.
            self._send(0.0, 0.0, now, roll)
            return
        self._send(0.0, 0.0, now, self._hold_roll)

    def _finish_aligning_locked(self, now: float, aligned: bool) -> None:
        a = self._align
        a["done"], a["aligned"] = True, aligned
        # Keep the roll that was holding it still (the drift-cancelling part) through settle and landing.
        self._hold_roll = max(-0.1, min(0.1, a["integral"])) if a["roll_ok"] else 0.0
        self._state = ARRIVED
        self._phase_at = now
        self._settle_ref = []
        window = [cy for _ts, cy in a["window"]]
        # The descent guard compares against where the sign sat while it was holding still.
        self._settle_ref_cy = statistics.median(window) if len(window) >= 3 else None
        self._settle_checks = 0
        self._descent_count = 0
        self._last_rise = 0.0
        self._send(*self._steering.neutral(now), now, self._hold_roll)
        logger.info("run %s: lined up (%s): %.3f m off the centre line, %.2f m from the wall", self._run_id,
                    "within tolerance" if aligned else "not exactly", a["x"], a["z"])

    def _step_arrived_locked(self, marker: Optional[MarkerObs], obs: Observation, now: float) -> None:
        cfg = self.cfg
        if self._align.get("done"):
            self._steering.neutral(now)
            self._hold_position_locked(marker, obs, now)
        else:
            self._send(*self._steering.neutral(now), now)
        # The guard protects the landing toggle only: with land on arrival off it neither holds nor aborts.
        guard = cfg.settle_descent_frac > 0 and self._lands_on_arrival_locked()
        if marker is not None:
            self._marker_seen_at = obs.ts
            if guard and now - self._phase_at >= cfg.settle_reference_after_s:
                if self._settle_ref_cy is None:
                    self._settle_ref.append(marker.cy)
                    if len(self._settle_ref) >= cfg.settle_reference_count:
                        self._settle_ref_cy = statistics.median(self._settle_ref)
                else:
                    # Image y grows downward: a sinking camera sees the marker move UP (cy smaller).
                    rise = self._settle_ref_cy - marker.cy
                    self._last_rise = rise
                    self._settle_checks += 1
                    self._descent_count = self._descent_count + 1 if rise > cfg.settle_descent_frac else 0
                    if self._descent_count >= cfg.settle_descent_consecutive:
                        # The camera is sinking: the drone is landing by itself. A toggle now could
                        # launch it again.
                        logger.warning("run %s: marker %.3f of the frame height above its settle reference "
                                       "on %d detections in a row; not landing",
                                       self._run_id, rise, self._descent_count)
                        self._abort_locked("unexpected_descent", now, {
                            "settle_descent": True,
                            "settle_reference_cy": round(self._settle_ref_cy, 4),
                            "settle_rise": round(rise, 4),
                        })
                        return
        settle_s = cfg.settle_s
        if now - self._phase_at < settle_s:
            return
        if now - self._marker_seen_at > cfg.arrive_marker_fresh_s:
            # The marker vanished while settling (the drone may have dropped). Do not toggle.
            self._abort_locked("marker_lost", now)
            return
        skipped: Optional[str] = None
        if guard and (self._settle_ref_cy is None or self._settle_checks < cfg.settle_descent_consecutive
                      or self._descent_count > 0 or self._last_rise > cfg.settle_pending_frac):
            if now - self._phase_at < settle_s + cfg.settle_guard_wait_s:
                return     # the descent guard has not finished looking: keep settling (still neutral)
            # Still undecided: do not toggle on a doubt. The drone did arrive; the pilot lands by hand.
            logger.warning("run %s: settle descent guard still undecided %.1f s after arrival; "
                           "not landing, the pilot lands", self._run_id, now - self._phase_at)
            skipped = "settle_guard_undecided"
            self._last_landing = "skipped_settle_guard_undecided"
        elif not self._lands_on_arrival_locked():
            self._last_landing = "off"
        else:
            # The toggle goes first, so the arrival event says whether it actually went out.
            self._toggle_sent = self._mixer.mission_toggle(now)   # the only toggle a run ever sends
            if self._toggle_sent:
                self._last_landing = "sent"
            else:
                logger.warning("run %s: landing toggle refused by the mixer; the pilot lands", self._run_id)
                skipped = "refused_by_mixer"
                self._last_landing = "refused_by_mixer"
        self._suggested_trim_roll = self._suggest_trim_roll_locked()
        lined_up: Dict[str, Any] = {}
        if self._align.get("done"):
            lined_up = {"lateral_offset_m": round(self._align["x"], 3), "distance_m": round(self._align["z"], 3),
                        "aligned": bool(self._align["aligned"])}
        self._last_arrival = {"lateral_offset_m": lined_up.get("lateral_offset_m"),
                              "distance_m": lined_up.get("distance_m"), "aligned": lined_up.get("aligned", False)}
        self._queue_event("arrived_at_station", {
            "marker_width": round(self._arrived_width, 4),
            **lined_up,
            "elapsed_s": round(now - self._started_at, 2),
            "landing": self._toggle_sent,
            **({"landing_skipped": skipped} if skipped is not None else {}),
            "mode": self._link.mode,
            **self._assist_detail_locked(arrived=True),
        })
        logger.info("run %s: arrived at station", self._run_id)
        if not self._toggle_sent:
            self._finish_done_locked(now)
            return
        self._state = LANDING
        self._phase_at = now

    # ------------------------------------------------------------------ #
    # endings
    # ------------------------------------------------------------------ #
    def _send(self, yaw: float, pitch: float, now: float, roll: float = 0.0) -> None:
        """Hand the command to the mixer. Roll is zero unless the drift assist supplied one."""
        self._command = (yaw, pitch)
        self._roll = roll
        self._mixer.mission_command(yaw, pitch, now, roll=roll)

    def _suggest_trim_roll_locked(self) -> Optional[float]:
        """Current roll trim plus the mean assist roll near the end of the approach, rounded to 0.01."""
        if not self._assist_run:
            return None
        mean = self._assist.mean_roll_near_end()
        if mean is None:
            return None
        return round(self._mixer.trim()[0] + mean, 2)

    def _assist_detail_locked(self, arrived: bool = False) -> Dict[str, Any]:
        """Drift-assist keys for the run's closing event; empty when the run did not use the assist."""
        if not self._assist_run:
            return {}
        detail: Dict[str, Any] = {}
        if arrived:
            detail["suggested_trim_roll"] = self._suggested_trim_roll
        if self._assist.disabled_reason is not None:
            detail["drift_assist_disabled"] = True
            detail["drift_assist_disabled_reason"] = self._assist.disabled_reason
        return detail

    def _abort_locked(self, reason: str, now: float, extra: Optional[Dict[str, Any]] = None) -> None:
        """`extra` goes into the run_aborted event detail and the run trace (e.g. settle_descent).

        Automatic runs may land where they are (see SAFE_LANDING_REASONS and _airborne_now_locked)."""
        flew = self._state != COUNTDOWN     # an automatic run sends its takeoff toggle at countdown's end
        self._state = ABORTED
        self._reason = reason
        self._ended_at = now
        self._command = (0.0, 0.0)
        self._roll = 0.0
        self._steering.reset()
        self._assist.pause()
        safe_landing = False
        took_off = self._automatic and flew
        if took_off and reason in SAFE_LANDING_REASONS and self._airborne_now_locked(now):
            # Nobody may be there to land it: land where it is. The mixer still refuses this toggle
            # after any pilot input since the runner's last mission command (see mission_toggle).
            safe_landing = self._mixer.mission_toggle(now, landing=True)
            if safe_landing:
                self._last_landing = "safe_landing"
                logger.warning("run %s: stopped early (%s); landing where it is", self._run_id, reason)
        self._mixer.clear_mission_command()   # neutral (plus trim)
        # The drone may be in the air with nobody flying it: say so loudly until someone acts.
        self._needs_pilot = took_off and not safe_landing and reason not in ("estop", "pilot_took_over")
        self._queue_event("run_aborted", {
            "reason": reason,
            "elapsed_s": round(now - self._started_at, 2),
            "mode": self._link.mode,
            **({"automatic": True, "safe_landing": safe_landing} if self._automatic else {}),
            **self._assist_detail_locked(),
            **(extra or {}),
        })
        self._queue_trace("aborted", reason, now, extra)
        logger.warning("run %s aborted: %s", self._run_id, reason)

    def _airborne_now_locked(self, now: float) -> bool:
        """Current evidence that the drone is in the air, needed before a safe-landing toggle (a toggle
        to a drone that already landed by itself would launch it): the flight was confirmed (the
        marker grew: only a flying drone moves toward the sign), the marker is in view right now, and
        it is not rising in the picture (a sinking camera sees it move up) compared with the
        detections between 2.0 and 0.5 s ago."""
        if not self._flight_confirmed or not self._cy_log:
            return False
        latest_ts, latest_cy = self._cy_log[-1]
        if now - latest_ts > self.cfg.safe_land_marker_fresh_s:
            return False
        reference = [cy for ts, cy in self._cy_log if 0.5 <= latest_ts - ts <= 2.0]
        if len(reference) < 3:
            return False
        rise = statistics.median(reference) - latest_cy
        return rise <= self.cfg.settle_descent_frac

    def _finish_done_locked(self, now: float) -> None:
        self._state = DONE
        self._reason = None
        self._ended_at = now
        self._command = (0.0, 0.0)
        self._roll = 0.0
        self._steering.reset()
        self._assist.pause()
        self._mixer.clear_mission_command()
        self._queue_trace("done", None, now)
        logger.info("run %s done", self._run_id)

    def _queue_event(self, event_type: str, detail: Dict[str, Any]) -> None:
        run_id, dose_id, ts = self._run_id, self._dose_id, self._wall_clock()
        self._pending_io.append(
            lambda: self._store.add_event(event_type, dose_id=dose_id, run_id=run_id, detail=detail, ts=ts)
        )

    def _record(self, now: float, marker: Optional[MarkerObs]) -> None:
        telemetry = self._link.telemetry()
        self._trace.append({
            "t": round(now - self._started_at, 3),
            "state": self._state,
            "cx": None if marker is None else round(marker.cx, 4),
            "cy": None if marker is None else round(marker.cy, 4),
            "width": None if marker is None else round(marker.width, 4),
            "size": None if marker is None else round(marker.size, 4),
            "apparent_width": None if marker is None else round(apparent_width(marker), 4),
            "yaw": round(self._command[0], 4),
            "pitch": round(self._command[1], 4),
            "roll": round(self._roll, 4),
            "lateral_m": _round_or_none(self._align.get("x"), 4) if self._state == ALIGNING else None,
            "distance_m": _round_or_none(self._align.get("z"), 4) if self._state == ALIGNING else None,
            "slide_rate": None if not self._assist.active or self._assist.slide_rate is None
            else round(self._assist.slide_rate, 4),   # marker-widths per second, + = sliding left
            "fly_state_raw": None if telemetry is None else telemetry.fly_state_raw,
            "battery_raw": None if telemetry is None else telemetry.battery_raw,
            "flags_raw": None if telemetry is None else telemetry.flags_raw,
        })

    def _queue_trace(self, result: str, reason: Optional[str], now: float,
                     extra: Optional[Dict[str, Any]] = None) -> None:
        run_id = self._run_id
        trace = {
            "run_id": run_id,
            "dose_id": self._dose_id,
            "mode": self._link.mode,
            "started_ts": self._started_wall,
            "ended_ts": self._wall_clock(),
            "duration_s": round(now - self._started_at, 3),
            "result": result,
            "reason": reason,
            "arrive_width": self._arrive_width,
            "land_on_arrival": self._lands_on_arrival_locked(),
            "automatic": self._automatic,
            "toggle_sent": self._toggle_sent,
            "first_marker_width": self._first_width,
            "drift_assist": {
                "enabled": self._assist_run,
                "drift_assist_disabled": self._assist.disabled_reason is not None,
                "disabled_reason": self._assist.disabled_reason,
                "disabled_by": self._assist.disabled_by,       # "slide" or "aspect": which measure tripped
                "disabled_at_s": None if self._assist_disabled_at is None else round(self._assist_disabled_at, 3),
                "suggested_trim_roll": self._suggested_trim_roll,
            },
            "samples": self._trace,
            **(extra or {}),
        }
        self._trace = []
        if run_id is not None:
            self._pending_io.append(lambda: self._store.write_run_trace(run_id, trace))

    def flush(self) -> None:
        """Do queued file writes (events, traces). Called outside the lock, never from an async handler."""
        with self._lock:
            jobs, self._pending_io = self._pending_io, []
        for job in jobs:
            try:
                job()
            except Exception:
                logger.exception("could not write mission data")

    # ------------------------------------------------------------------ #
    # hover test
    # ------------------------------------------------------------------ #
    def _step_hover_locked(self, obs: Optional[Observation], now: float) -> None:
        hover = self._hover
        if hover is None:
            self._state = IDLE
            return
        if self._mixer.estop_active:
            self._cancel_hover_locked("estop", now)
            return
        hover["elapsed_s"] = now - hover["started_at"]
        if obs is not None:
            marker = obs.marker
            self._hover_samples.append(
                (obs.ts, None if marker is None else marker.cx, None if marker is None else marker.size)
            )
        if hover["elapsed_s"] < self.cfg.hover_test_s:
            return
        result = self._hover_result()
        hover.update(running=False, elapsed_s=self.cfg.hover_test_s, result=result)
        self._state = IDLE
        self._ended_at = now
        ts = self._wall_clock()
        self._pending_io.append(lambda: self._store.add_event("hover_test", detail=dict(result), ts=ts))
        logger.info("hover test finished: %s", result)

    def _cancel_hover_locked(self, reason: str, now: float) -> None:
        if self._hover is not None:
            self._hover.update(running=False, elapsed_s=now - self._hover["started_at"], result=None)
        self._state = IDLE
        self._ended_at = now
        ts = self._wall_clock()
        self._pending_io.append(
            lambda: self._store.add_event("hover_test", detail={"cancelled": reason}, ts=ts)
        )
        logger.info("hover test cancelled: %s", reason)

    def _hover_result(self) -> Dict[str, Any]:
        """Drift of the drone estimated from how the marker moved in the frame.

        Sign: positive means the drone appears to have drifted to its right (the marker moved left).
        A yaw rotation looks the same as a sideways drift, so the metres figure is only an estimate.

        Pass/fail is judged on the PEAK sideways excursion (SPEC 10.2): the spread of the marker centre
        over the whole test (max minus min of cx), in metres at the sign's distance using the median
        marker width as the scale, so a drone that slides out and comes back fails too.
        """
        total = len(self._hover_samples)
        seen = [(cx, width) for _ts, cx, width in self._hover_samples if cx is not None and width]
        visible_pct = 100.0 * len(seen) / total if total else 0.0
        limit_m = self._settings.hover_max_excursion_m
        drift_fw = drift_m = width_change = peak_m = 0.0
        if len(seen) >= 2:
            edge = max(1, min(5, len(seen) // 2))
            cx_start = statistics.median(cx for cx, _w in seen[:edge])
            cx_end = statistics.median(cx for cx, _w in seen[-edge:])
            w_start = statistics.median(w for _cx, w in seen[:edge])
            w_end = statistics.median(w for _cx, w in seen[-edge:])
            w_mid = statistics.median(w for _cx, w in seen)
            drift_fw = -(cx_end - cx_start)
            drift_m = drift_fw * self._settings.marker_size_m / w_mid
            width_change = 100.0 * (w_end / w_start - 1.0)
            cxs = [cx for cx, _w in seen]
            peak_m = (max(cxs) - min(cxs)) * self._settings.marker_size_m / w_mid
        passed = (
            len(seen) >= 2
            and peak_m <= limit_m
            and visible_pct >= self.cfg.hover_visible_pct
        )
        return {
            "pass": bool(passed),
            "drift_frame_widths": round(drift_fw, 4),
            "drift_m_estimate": round(drift_m, 3),
            "width_change_pct": round(width_change, 1),
            "visible_pct": round(visible_pct, 1),
            "peak_excursion_m": round(peak_m, 3),
            "limit_m": round(limit_m, 3),
        }

    # ------------------------------------------------------------------ #
    # snapshots
    # ------------------------------------------------------------------ #
    def snapshot(self, now: Optional[float] = None) -> Dict[str, Any]:
        now = self._clock() if now is None else now
        with self._lock:
            blockers = self._blockers_locked(now)
            auto_blockers = self._blockers_locked(now, automatic=True)
            marker = self._current_marker(now)
            if self._state in RUN_STATES or self._state == HOVER_TEST:
                elapsed = now - self._started_at
            elif self._ended_at is not None and self._state in (DONE, ABORTED):
                elapsed = self._ended_at - self._started_at
            else:
                elapsed = 0.0
            return {
                "state": self._state,
                "reason": self._reason,
                "run_id": self._run_id,
                "dose_id": self._dose_id,
                "elapsed_s": round(max(0.0, elapsed), 2),
                "command": {"yaw": round(self._command[0], 4), "pitch": round(self._command[1], 4)},
                "arrive_width": round(self._arrive_width, 4),
                "land_on_arrival": self._land_on_arrival,
                "last_landing": self._last_landing,
                "drift_assist": {
                    "enabled": self._drift_assist,
                    "active": (self._state == APPROACHING and self._assist_run and (self._drift_assist or self._automatic)
                               and self._assist.active),
                    "roll": round(self._roll, 4),
                    "disabled_reason": self._assist.disabled_reason if self._assist_run else None,
                    "suggested_trim_roll": self._suggested_trim_roll,
                },
                "can_start": not blockers,
                "blockers": blockers,
                "automatic": self._automatic,
                "auto_fly": self._auto_fly,
                "auto_blockers": auto_blockers,
                "can_start_auto": not auto_blockers,
                "countdown_remaining_s": (round(max(0.0, self.cfg.countdown_s - (now - self._phase_at)), 1)
                                          if self._state == COUNTDOWN else None),
                "distance_m": None if marker is None else _round_or_none(self._distance_m(apparent_width(marker))),
                "arrive_distance_m": _round_or_none(self._distance_m(self._arrive_width)),
                "flight_confirmed": self._flight_confirmed,
                "needs_pilot": self._needs_pilot,
                "ready_for_dose": self._ready_for_dose,
                "alignment": self._alignment_snapshot_locked(now),
                "last_arrival": None if self._last_arrival is None else dict(self._last_arrival),
            }

    def _alignment_snapshot_locked(self, now: float) -> Optional[Dict[str, Any]]:
        if self._state != ALIGNING or not self._align:
            return None
        a = self._align
        return {
            "lateral_m": _round_or_none(a["x"], 3),
            "distance_m": _round_or_none(a["z"], 3),
            "target_distance_m": round(a["target_m"], 3),
            "tolerance_m": self.cfg.align_tolerance_m,
            "aligned_for_s": 0.0 if a["aligned_since"] is None else round(now - a["aligned_since"], 2),
            "need_s": self.cfg.align_hold_s,
        }

    def _distance_m(self, apparent: float) -> Optional[float]:
        """Estimated metres from the sign for a marker of this apparent width (fraction of the frame
        width). Uses the configured camera field of view: right for the simulator, an estimate for
        the real drone, whose lens is unmeasured."""
        if apparent <= 0:
            return None
        half = math.radians(self._settings.camera_hfov_deg) / 2.0
        return self._settings.marker_size_m / (2.0 * math.tan(half) * apparent)

    def hover_snapshot(self, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
        now = self._clock() if now is None else now
        with self._lock:
            if self._hover is None:
                return None
            elapsed = now - self._hover["started_at"] if self._hover["running"] else self._hover["elapsed_s"]
            return {
                "running": bool(self._hover["running"]),
                "elapsed_s": round(max(0.0, elapsed), 2),
                "result": None if self._hover["result"] is None else dict(self._hover["result"]),
            }
