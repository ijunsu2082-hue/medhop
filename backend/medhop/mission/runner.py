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
(about 0.45 m from the sign by the program's own measure with the defaults), near the middle of the picture and seen from the front,
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

Obstacle avoidance (experimental, simulator-tested only, never flown near people, not a safety
system; SPEC section 11): with the mission setting `avoid` at "hold", people and objects in the way
(`mission/avoid.py`) make the run slow down, hold and back off a little, and end it with path_blocked
when they stay, instead of ending it with person_in_view. It never goes round them. A sign hidden by
them is "hidden", not lost. "off" is the behaviour without it, unchanged. In every mode a run never
starts with a person in view, or with an object in the lane (simulator).

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
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from medhop.care.store import CareStore
from medhop.config import Settings
from medhop.drone.base import DroneLink
from medhop.mission.avoid import (
    AVOID_MODES, CLEAR as AVOID_CLEAR, NOT_MOVING_ON, AvoidCommand, AvoidConfig, Avoider, Seen, estimate,
    floor_distance_m,
)
from medhop.mission.steering import (
    DriftAssist, DriftAssistConfig, MarkerSample, Steering, SteeringConfig, marker_skew, steer,
)
from medhop.mixer import ControlMixer
from medhop.vision.marker import MarkerObs, Observation, Obstacle
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
    "path_blocked",         # obstacle avoidance: held too long (SPEC section 11)
    "obstacle_in_view",     # automatic run: an object came into the lane during the countdown (simulator)
)
BLOCKERS = (
    "no_video", "estop_active", "already_running", "person_in_view", "battery_low", "marker_too_close",
    "no_pilot_link",     # no pilot control socket is connected (start and hover test)
    "drone_flying",      # automatic start only: simulated telemetry says the drone is already up
    "recent_toggle",     # automatic start only: a takeoff/land toggle went out a moment ago
    "obstacle_in_view",  # an object in the lane (simulator boxes; the real drone never sees objects)
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
# path_blocked may also take its evidence from the obstacle in front (see _obstacle_evidence_locked).
SAFE_LANDING_REASONS = frozenset({
    "timeout", "person_in_view", "battery_low", "off_axis", "not_lined_up", "pilot_link_lost",
    "path_blocked",
})
NO_PILOT_LINK = "no_pilot_link"
NOT_CONFIRMED = "confirm_airborne_required"
MARKER_NOT_VISIBLE = "marker_not_visible"


@dataclass
class RunnerConfig:
    search_timeout_s: float = 12.0     # searching longer than this aborts with marker_not_found
    lost_hold_s: float = 0.6           # marker lost: hold neutral this long
    lost_creep_s: float = 2.0          # then creep-search this long, then abort with marker_lost
    # Within lost_hold_s, a marker missing for at most this long is a detection dropout, not a loss:
    # the approach coasts (the last forward stick and assist roll, fading to zero over this window, no
    # yaw) and keeps its arrival counts, so "N detections in a row" means N detections with gaps of at
    # most lost_coast_s. Never forward when the last step held or was near the arrive width. The line-up
    # keeps its timer through such gaps, with no yaw, only a backward pitch (its last one, if backward)
    # and only the clamped drift-cancelling roll. The search's confirming detections may have such gaps
    # too. 0 disables all of this.
    lost_coast_s: float = 0.5
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
    # Both settle fractions are tuned for this distance from the sign. Closer, the same sink moves the
    # sign further up the picture, so the settle guard scales them by
    # clamp(settle_ref_distance_m / landing distance, 1, 2), and the safe-landing evidence check scales
    # settle_descent_frac by the same clamp of the CURRENT distance (from the newest detection).
    settle_ref_distance_m: float = 0.8
    # SEARCHING moves to APPROACHING (and a start goes straight to APPROACHING) only after this many
    # detections whose centres agree within search_confirm_spread (cx in frame widths, cy in frame
    # heights), with gaps of at most lost_coast_s between them (consecutive when it is 0); the growth
    # check is seeded from the median size of those detections.
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
    # Pitch stick per metre too far from the wall. 0.8, not 0.4: at the 0.45 m landing distance the
    # errors are about half as many metres, and 0.4 let a sideways drift creep the drone onto the wall.
    align_pitch_kp: float = 0.8
    align_pitch_kd: float = 0.5
    align_pitch_max: float = 0.08
    align_lost_s: float = 1.0          # marker out of view this long while lining up: marker_lost
    # No separate roll-sign check here: a wrong sign would push the drone off the centre line, and
    # align_give_up_m stops the line-up long before it gets far (the approach's drift assist has its
    # own check). Give up early (not_lined_up) instead of chasing the sign: this far off the centre
    # line, or closer to the wall than align_too_close_frac of the landing distance or than
    # align_too_close_floor_m, whichever is farther from the wall.
    align_give_up_m: float = 0.90
    align_too_close_frac: float = 0.70
    align_too_close_floor_m: float = 0.30
    # A detection only counts toward arrival when the marker is also near the middle of the picture
    # (|cx - 0.5| at most this) and seen from the front (width/height at least arrive_min_aspect, about
    # 37 degrees off the wall's normal). Big enough and centred but seen from the side on
    # arrive_consecutive detections: the drone is beside the station, so the run stops with off_axis
    # instead of landing there. 0 for arrive_min_aspect disables both the facing rule and that abort.
    arrive_centre_tol: float = 0.12
    arrive_min_aspect: float = 0.80
    # Obstacle avoidance (experimental, SPEC section 11): "off" or "hold". A stored mission
    # setting wins; without one, Settings.avoid when it is not "off", else this. A run keeps the mode
    # it started with.
    avoid: str = "off"
    obstacle_fresh_s: float = 1.0      # a person-check result older than this is no evidence for avoidance
    research_max: int = 2              # back to searching after the way cleared without the sign, per run
    obstacle_evidence_max_m: float = 8.0   # safe landing on path_blocked: a base farther than this is no evidence
    # Safe landing on path_blocked: an automatic run that saw the sign move this much DOWN the picture
    # (fraction of the frame height, median of the countdown on the ground against the median of the
    # last second of the takeoff wait) saw its camera climb: evidence of flight even when an obstacle
    # stepped in before the sign could grow. A 1 m climb moves a sign 4.2 m away about 0.3.
    takeoff_cy_rise: float = 0.10
    # path_blocked in an automatic run without current evidence of flight: hold still (neutral sticks)
    # at most this long for it to show, then end the run anyway.
    path_blocked_evidence_wait_s: float = 2.5


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
        avoid_config: Optional[AvoidConfig] = None,
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
        self._ground_cy: List[float] = []                # automatic run: the sign's cy during the countdown
        self._climb_cy: Deque[Tuple[float, float]] = deque()   # ... and during the takeoff wait (ts, cy)
        self._takeoff_seen = False                       # the sign moved down the picture during the takeoff
        self._blocked_since: Optional[float] = None      # path_blocked: waiting for evidence of flight
        self._timeout_from = 0.0                         # the run timeout counts from here
        self._at_size_since: Optional[float] = None      # since when the marker has been at arrive size
        self._align: Dict[str, Any] = {}                 # line-up state, see _step_aligning_locked
        self._hold_roll = 0.0                            # roll kept on through settle and landing
        self._last_arrival: Optional[Dict[str, Any]] = None
        self._cy_log: Deque[Tuple[float, float]] = deque()   # (frame time, cy) of recent detections
        self._last_apparent: Optional[float] = None      # apparent width of the newest of them
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
        self._coast_pitch = 0.0                          # forward stick to coast on through a dropout
        self._last_cx = 0.5
        self._marker_seen_at = 0.0
        self._arrived_width = 0.0
        self._settle_ref: List[float] = []                # settle descent guard: reference detections' cy
        self._settle_ref_cy: Optional[float] = None
        self._settle_checks = 0                          # detections checked against the reference
        self._descent_count = 0                          # of those, consecutive ones above it
        self._last_rise = 0.0                            # the latest detection's rise above it
        self._candidates: Deque[MarkerObs] = deque(maxlen=self.cfg.search_confirm_count)
        self._candidate_at: Optional[float] = None       # frame time of the newest candidate
        self._toggle_sent = False
        # What the latest run did about landing once it arrived: "sent", "skipped_settle_guard_undecided",
        # "refused_by_mixer" or "off"; None before any run and for a run that has not arrived.
        self._last_landing: Optional[str] = None
        self._history: Deque[MarkerSample] = deque()
        self._trace: List[Dict[str, Any]] = []

        self._hover: Optional[Dict[str, Any]] = None     # {"running", "started_at", "elapsed_s", "result"}
        self._hover_samples: List[Tuple[float, Optional[float], Optional[float]]] = []

        # obstacle avoidance (SPEC section 11)
        self._avoid_cfg = avoid_config or AvoidConfig(hfov_deg=settings.camera_hfov_deg)
        self._avoider = Avoider(self._avoid_cfg)
        stored_avoid = store.load_avoid()
        if stored_avoid is not None:
            self._avoid_mode = stored_avoid
        else:
            from_settings = getattr(settings, "avoid", "off") or "off"
            self._avoid_mode = from_settings if from_settings != "off" else self.cfg.avoid
        if self._avoid_mode not in AVOID_MODES:
            raise ValueError(f"avoid must be one of {AVOID_MODES}, got {self._avoid_mode!r}")
        self._avoid_run = "off"                          # the mode the current (or last) run started with
        self._seen: List[Seen] = []                      # obstacles in the newest frame, with estimates
        self._seen_at: Optional[float] = None
        self._seen_fresh = False
        self._avoid_clock: Optional[float] = None
        self._avoid_cmd: Optional[AvoidCommand] = None
        self._research_count = 0                         # back to searching after the way cleared
        self._research_pending = False
        self._search_direction = 1.0
        self._last_marker_box: Optional[Tuple[float, float, float, float]] = None
        self._obstacle_log: Deque[Tuple[float, tuple]] = deque()   # (frame ts, the frame's boxes)

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
        """The optional person check sees someone, or (simulator) a simulated person is in the frame."""
        person = self._person_status()
        if person.enabled and person.detected and (person.ts is None or (now - person.ts) <= self.cfg.person_fresh_s):
            return True
        obs = self._last_obs
        if obs is not None and obs.obstacles and (now - obs.ts) <= self.cfg.person_fresh_s:
            return any(o.kind == "person" for o in obs.obstacles)
        return False

    def _object_in_lane(self, now: float, on_ground: bool = False) -> bool:
        """An "object" box in the newest frame (no older than person_fresh_s) that is in the lane by its
        estimate, including one whose base is out of the picture or not clearly below the horizon (very
        close, or too far to tell). `on_ground`: an automatic start, from the ground, where the camera is
        only ground_camera_height_m up. Only the simulator reports objects; the real drone never does."""
        if self._seen_at is None or now - self._seen_at > self.cfg.person_fresh_s:
            return False
        if not on_ground:
            return any(s.kind == "object" and s.in_lane for s in self._seen)
        ground = replace(self._avoid_cfg, camera_height_m=self._avoid_cfg.ground_camera_height_m)
        return any(s.kind == "object" and estimate(s.kind, s.box, s.ts, ground).in_lane for s in self._seen)

    def _battery_low(self, now: float) -> bool:
        """Only with the check enabled (MEDHOP_BATTERY_LOW_RAW >= 0) and on fresh telemetry: a reading
        older than telemetry_fresh_s is no decision either way."""
        if not self._settings.battery_check_enabled:
            return False
        telemetry = self._link.telemetry()
        if telemetry is None or now - telemetry.timestamp >= self._settings.telemetry_fresh_s:
            return False
        return telemetry.battery_raw <= self._settings.battery_low_raw

    def _update_candidates_locked(self, marker: Optional[MarkerObs], ts: float) -> None:
        """Detections whose centres agree, with gaps of at most lost_coast_s between them (a detector
        dropout does not start again); a longer gap or a far-off detection starts again. With
        lost_coast_s 0 any miss starts again."""
        if marker is None:
            if self.cfg.lost_coast_s <= 0:
                self._candidates.clear()
            return
        spread = self.cfg.search_confirm_spread
        gap_too_long = (self.cfg.lost_coast_s > 0 and self._candidate_at is not None
                        and ts - self._candidate_at > self.cfg.lost_coast_s)
        if gap_too_long or any(
                abs(marker.cx - m.cx) > spread or abs(marker.cy - m.cy) > spread for m in self._candidates):
            self._candidates.clear()
        self._candidates.append(marker)
        self._candidate_at = ts

    def _marker_confirmed_locked(self) -> bool:
        return len(self._candidates) >= self.cfg.search_confirm_count

    def _seed_approach_locked(self) -> None:
        """Enter APPROACHING from confirmed detections: the growth check starts from their median size."""
        self._state = APPROACHING
        self._first_width = statistics.median(m.size for m in self._candidates)
        self._last_cx = self._candidates[-1].cx
        self._coast_pitch = 0.0

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

    def _drone_on_ground(self, now: float) -> bool:
        """Simulator only: fresh simulated telemetry says the drone is on the ground (the same evidence
        as _drone_flying). Without that evidence (the real drone, or stale telemetry) it is False."""
        if self._link.mode != "sim":
            return False
        telemetry = self._link.telemetry()
        if telemetry is None or now - telemetry.timestamp >= self._settings.telemetry_fresh_s:
            return False
        return telemetry.fly_state_raw == 0

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
        if self._object_in_lane(now, on_ground=automatic):
            out.append("obstacle_in_view")
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
            self._coast_pitch = 0.0
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
            self._last_apparent = None
            self._align = {}
            self._hold_roll = 0.0
            self._avoid_run = self._avoid_mode
            self._avoider.reset()
            self._avoid_clock = now
            self._avoid_cmd = None
            self._research_count = 0
            self._research_pending = False
            self._search_direction = 1.0
            self._obstacle_log.clear()
            self._ground_cy = []
            self._climb_cy.clear()
            self._takeoff_seen = False
            self._blocked_since = None
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
                **({"avoid": self._avoid_run} if self._avoid_run != "off" else {}),
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

    def set_avoid(self, mode: str) -> str:
        """The obstacle-avoidance mode (persisted): "off" or "hold". A run keeps the mode it
        started with; the new one applies from the next run."""
        if mode not in AVOID_MODES:
            raise ValueError(f"avoid must be one of {AVOID_MODES}")
        with self._lock:
            self._avoid_mode = mode
            self._pending_io.append(lambda: self._store.save_avoid(mode))
        self.flush()
        return mode

    @property
    def avoid_mode(self) -> str:
        with self._lock:
            return self._avoid_mode

    def settings(self) -> Dict[str, Any]:
        with self._lock:
            return {"land_on_arrival": self._land_on_arrival, "drift_assist": self._drift_assist,
                    "auto_fly": self._auto_fly, "avoid": self._avoid_mode}

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
                self._update_candidates_locked(obs.marker, obs.ts)
                self._update_seen_locked(obs, now)
            self._step_locked(obs, now)
        self.flush()

    # ------------------------------------------------------------------ #
    # obstacle avoidance (SPEC section 11)
    # ------------------------------------------------------------------ #
    def _update_seen_locked(self, obs: Observation, now: float) -> None:
        """This frame's obstacles with their estimates: the simulator's boxes, plus (real drone, or the
        simulator with the person check on) a fresh person-check result turned into person boxes."""
        items = list(obs.obstacles)
        person = self._person_status()
        person_fresh = (person.enabled and person.ts is not None
                        and now - person.ts <= self.cfg.obstacle_fresh_s)
        if person_fresh:
            items.extend(Obstacle("person", tuple(float(v) for v in box), person.ts) for box in person.boxes)
        self._seen = [estimate(o.kind, o.box, o.ts, self._avoid_cfg) for o in items]
        self._seen_at = obs.ts
        # The simulator's boxes come with every frame; on the real drone only a fresh check is evidence.
        self._seen_fresh = self._link.mode == "sim" or person_fresh
        if obs.marker is not None:
            xs = [c[0] for c in obs.marker.corners]
            ys = [c[1] for c in obs.marker.corners]
            w, h = float(obs.marker.frame_w or 640), float(obs.marker.frame_h or 360)
            self._last_marker_box = (min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h)

    def _avoiding_locked(self) -> bool:
        return self._avoid_run != "off" and self._state in (SEARCHING, APPROACHING, ALIGNING)

    def _shift_timers_locked(self, now: float) -> None:
        """Time held does not count against the run timeout (blocked_timeout_s
        bounds it instead), nor against the search limit, the line-up limit or the stall timer."""
        dt = 0.0 if self._avoid_clock is None else max(0.0, now - self._avoid_clock)
        self._avoid_clock = now
        if self._avoider.state not in NOT_MOVING_ON or dt <= 0.0:
            return
        self._timeout_from += dt
        if self._state == SEARCHING:
            self._search_started += dt
        elif self._state == ALIGNING:
            self._phase_at += dt
        if self._at_size_since is not None:
            self._at_size_since += dt

    def _avoid_update_locked(self, obs: Observation, now: float) -> AvoidCommand:
        sign = None
        if obs.marker is not None:
            range_m = self._distance_m(obs.marker.size)
            if range_m:
                sign = (obs.marker.cx, range_m)        # for holding still sideways (avoid.sign_lateral_m)
        cmd = self._avoider.update(now, self._seen, self._seen_fresh, sign=sign)
        self._avoid_cmd = cmd
        if self._seen:
            # Every box of this frame, for the safe-landing evidence on path_blocked.
            self._obstacle_log.append((obs.ts, tuple(s.box for s in self._seen)))
        while self._obstacle_log and obs.ts - self._obstacle_log[0][0] > 3.0:
            self._obstacle_log.popleft()
        return cmd

    def _marker_hidden_locked(self, cmd: Optional[AvoidCommand]) -> bool:
        """A missing marker is hidden, not lost, while avoidance is not clear, or while a current
        obstacle box overlaps where the sign was last seen."""
        if cmd is None:
            return False
        if cmd.state != AVOID_CLEAR:
            return True
        last = self._last_marker_box
        if last is None or not self._seen_fresh:
            return False
        for seen in self._seen:
            x1, y1, x2, y2 = seen.box
            if x1 < last[2] + 0.02 and last[0] - 0.02 < x2 and y1 < last[3] + 0.02 and last[1] - 0.02 < y2:
                return True
        return False

    def _hold_hidden_locked(self, now: float, cmd: AvoidCommand) -> None:
        """The sign is hidden: no yaw, no forward stick (backward only when avoidance says the
        obstacle is very close), only the sideways hold, and no marker-lost timer. A real gap: the
        arrival counts start again."""
        self._lost_since = None
        self._arrive_count = 0
        self._size_count = 0
        self._off_axis_count = 0
        self._coast_pitch = 0.0
        self._assist.pause()
        self._research_pending = True
        pitch = cmd.pitch if cmd.pitch is not None and cmd.pitch < 0.0 else 0.0
        self._send(*self._steering.shape(0.0, pitch, now), now, cmd.roll or 0.0)

    def _research_locked(self, now: float) -> None:
        """The way is clear but the sign is not in view: search again, turning toward the side it was
        last seen, at most research_max times per run; after that, marker_not_found."""
        if self._research_count >= self.cfg.research_max:
            self._abort_locked("marker_not_found", now, {"searched_again": self._research_count})
            return
        self._research_count += 1
        self._research_pending = False
        self._state = SEARCHING
        self._search_started = now
        self._search_direction = 1.0 if self._last_cx >= 0.5 else -1.0
        self._candidates.clear()
        self._candidate_at = None
        self._history.clear()
        self._lost_since = None
        self._arrive_count = 0
        self._size_count = 0
        self._off_axis_count = 0
        self._at_size_since = None
        self._coast_pitch = 0.0
        self._align = {}
        self._assist.pause()
        logger.info("run %s: the way is clear but the sign is not in view; searching again (%d of %d)",
                    self._run_id, self._research_count, self.cfg.research_max)
        self._send(*self._steering.search(now, direction=self._search_direction), now)

    def obstacles_snapshot(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """Status `vision.obstacles`: what the newest frame showed, with the estimates. In the simulator,
        with the drone on the ground, the estimates use the ground camera height (as the start blocker
        does); the run's own decisions keep the hover-height estimates in self._seen."""
        now = self._clock() if now is None else now
        with self._lock:
            if self._seen_at is None or now - self._seen_at > 1.0:
                return []
            seen = self._seen
            if self._drone_on_ground(now):
                ground = replace(self._avoid_cfg, camera_height_m=self._avoid_cfg.ground_camera_height_m)
                seen = [estimate(s.kind, s.box, s.ts, ground) for s in self._seen]
            return [{
                "kind": s.kind,
                "box": [round(v, 3) for v in s.box],
                "distance_m": _round_or_none(s.distance_m),
                "lateral_m": _round_or_none(s.lateral_m),
                "in_lane": bool(s.in_lane),
            } for s in seen]

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
                self._last_apparent = apparent_width(obs.marker)  # its distance scales that evidence
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

        avoiding = self._avoiding_locked()
        if avoiding:
            self._shift_timers_locked(now)
        else:
            self._avoid_clock = now

        # failsafes, checked on every step in every state before the toggle
        if self._mixer.estop_active:
            return self._abort_locked("estop", now)
        if now - self._timeout_from > self.cfg.run_timeout_s:
            return self._abort_locked("timeout", now)
        if now - self._last_frame_ts > self.cfg.video_stale_s:
            return self._abort_locked("video_stale", now)
        # With avoidance on, a person in view in the air is avoided instead; on the ground (the
        # countdown) it still stops the run: never take off with a person in view.
        if self._person_in_view(now) and (self._avoid_run == "off" or self._state == COUNTDOWN):
            return self._abort_locked("person_in_view", now)
        if self._state == COUNTDOWN and self._object_in_lane(now, on_ground=True):
            return self._abort_locked("obstacle_in_view", now)    # on the ground: never take off into it
        if self._battery_low(now):
            return self._abort_locked("battery_low", now)

        if self._state == COUNTDOWN:
            # On the ground: nothing is sent until the countdown is over.
            if obs is not None and obs.marker is not None:
                self._ground_cy.append(obs.marker.cy)
            if now - self._phase_at >= self.cfg.countdown_s:
                self._take_off_locked(now)
            return

        if self._state == TAKING_OFF:
            # Neutral sticks while the drone climbs to its hover height by itself.
            self._send(*self._steering.neutral(now), now)
            if obs is not None:
                self._record(now, obs.marker)
                if obs.marker is not None:
                    self._climb_cy.append((obs.ts, obs.marker.cy))
            if now - self._phase_at >= self.cfg.takeoff_wait_s:
                self._takeoff_seen = self._takeoff_seen_locked()
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
        cmd: Optional[AvoidCommand] = None
        if avoiding:
            cmd = self._avoid_update_locked(obs, now)
            if cmd.blocked:
                if self._automatic and not self._airborne_now_locked(now, "path_blocked"):
                    # No current evidence that it is flying (for example it was turning, so every box
                    # slid across the picture): hold still a moment so the obstacle or the sign can show
                    # it, then end the run either way. A manual run never lands on an abort: no wait.
                    if self._blocked_since is None:
                        self._blocked_since = now
                    if now - self._blocked_since < self.cfg.path_blocked_evidence_wait_s:
                        self._send(*self._steering.shape(0.0, 0.0, now), now)
                        self._record(now, marker)
                        return
                return self._abort_locked("path_blocked", now, self._path_blocked_detail_locked(cmd))
        if self._state == SEARCHING:
            if marker is None or not self._marker_confirmed_locked():
                if cmd is not None and cmd.state in NOT_MOVING_ON:
                    # Something close in the way: stop turning, back off if it is very close.
                    pitch = cmd.pitch if cmd.pitch is not None and cmd.pitch < 0.0 else 0.0
                    self._send(*self._steering.shape(0.0, pitch, now), now, cmd.roll or 0.0)
                    self._record(now, marker)
                    return
                # Not seen, or not yet seen on enough consecutive frames at one place: keep searching.
                if now - self._search_started > self.cfg.search_timeout_s:
                    return self._abort_locked("marker_not_found", now)
                self._send(*self._steering.search(now, direction=self._search_direction), now)
                self._record(now, marker)
                return
            self._seed_approach_locked()

        if self._state == APPROACHING:
            self._step_approach_locked(marker, obs, now, cmd)
        elif self._state == ALIGNING:
            self._step_aligning_locked(marker, obs, now, cmd)
        elif self._state == ARRIVED:
            self._step_arrived_locked(marker, obs, now)
        if self._state in RUN_STATES:
            self._record(now, marker)

    def _step_approach_locked(self, marker: Optional[MarkerObs], obs: Observation, now: float,
                              cmd: Optional[AvoidCommand] = None) -> None:
        cfg = self.cfg
        if marker is None:
            if self._marker_hidden_locked(cmd):
                self._hold_hidden_locked(now, cmd)
                return
            if self._lost_since is None:
                self._lost_since = now
            lost_for = now - self._lost_since
            if self._research_pending and lost_for > min(cfg.lost_coast_s, cfg.lost_hold_s):
                # It was hidden (or the drone went round something) and the way is clear now, but the
                # sign is still not in view: search again instead of the marker-lost rule.
                self._research_locked(now)
                return
            if cfg.lost_coast_s > 0 and lost_for <= min(cfg.lost_coast_s, cfg.lost_hold_s):
                # A detection dropout, not (yet) a loss: coast on the last forward stick and assist roll,
                # fading to zero over lost_coast_s, with no yaw (where the marker is now is unknown). The
                # arrival counts and the assist's state are kept.
                fade = 1.0 - lost_for / cfg.lost_coast_s
                assist_on = (self._assist_run and (self._drift_assist or self._automatic)
                             and self._assist.disabled_reason is None)
                roll = self._assist.roll * fade if assist_on else 0.0
                yaw, pitch = self._steering.shape(0.0, self._coast_pitch * fade, now)
                self._send(yaw, pitch, now, roll)
                return
            self._arrive_count = 0
            self._size_count = 0
            self._off_axis_count = 0
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
            if now - self._lost_since > cfg.lost_coast_s:
                self._history.clear()      # a real loss: start again from the reacquired marker
            self._lost_since = None
        self._research_pending = False
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
        limited = cmd is not None and (cmd.pitch_cap is not None or cmd.pitch is not None)
        if not limited:
            yaw, pitch = self._steering.update(list(self._history), now, self._arrive_width, no_forward=hold)
        else:
            # Something in the way: the same pursuit, with the forward stick capped (slow), or holding:
            # no yaw and no forward stick (a little backward when very close). Steering.update is
            # steer() then shape(); the cap goes in between so the rise limit sees what was really sent.
            raw_yaw, raw_pitch = steer(list(self._history), tuple(self._steering._yaw_log), now,
                                       self._arrive_width, self._steering.cfg)
            if cmd.freeze_yaw:
                raw_yaw = 0.0
            target = 0.0 if hold else raw_pitch
            if cmd.pitch_cap is not None:
                target = min(target, cmd.pitch_cap)
            if cmd.pitch is not None:
                target = cmd.pitch
            yaw, pitch = self._steering.shape(raw_yaw, target, now)
        if limited and cmd.roll is not None:
            self._assist.pause()                    # holding: avoidance holds the drone sideways
            roll = cmd.roll
        else:
            roll = self._assist_roll_locked(marker, obs.ts, aspect, pitch, now)
        self._send(yaw, pitch, now, roll)
        # What a dropout right after this step may coast on: never forward blind near the wall, nor
        # while something is in the way.
        self._coast_pitch = 0.0 if (hold or limited or apparent >= 0.9 * self._arrive_width) else pitch

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
            "target_m": self._distance_m(self._arrive_width) or self._settings.land_distance_m,
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

    def _step_aligning_locked(self, marker: Optional[MarkerObs], obs: Observation, now: float,
                              cmd: Optional[AvoidCommand] = None) -> None:
        cfg, a = self.cfg, self._align
        if marker is None and self._marker_hidden_locked(cmd):
            # Hidden, not lost: hold (no yaw, never forward, only the drift-cancelling roll), no timer.
            a["lost_since"] = None
            a["aligned_since"] = None
            a["window"].clear()
            hold_roll = max(-0.1, min(0.1, a["integral"])) if a["roll_ok"] else 0.0
            pitch = cmd.pitch if cmd.pitch is not None and cmd.pitch < 0.0 else min(0.0, a["pitch"])
            self._research_pending = True
            self._send(*self._steering.shape(0.0, pitch, now), now, hold_roll)
            return
        if marker is None or not self._measure_locked(marker, obs.ts):
            if a["lost_since"] is None:
                a["lost_since"] = now
            if cfg.lost_coast_s > 0 and now - a["lost_since"] <= cfg.lost_coast_s:
                # A detection dropout: keep the timer, no yaw, keep only a backward pitch (never forward
                # blind at the wall) and only the drift-cancelling part of the roll (clamped integral).
                hold_roll = max(-0.1, min(0.1, a["integral"])) if a["roll_ok"] else 0.0
                self._send(*self._steering.shape(0.0, min(0.0, a["pitch"]), now), now, hold_roll)
                return
            if self._research_pending and marker is None:
                self._research_locked(now)
                return
            a["aligned_since"] = None
            a["window"].clear()
            self._send(*self._steering.neutral(now), now, a["roll"] if marker is not None else 0.0)
            if now - a["lost_since"] > cfg.align_lost_s:
                self._abort_locked("marker_lost", now)
            return
        a["lost_since"] = None
        self._research_pending = False
        self._marker_seen_at = obs.ts
        self._history.append(MarkerSample(ts=obs.ts, cx=marker.cx, width=apparent_width(marker)))
        while self._history and obs.ts - self._history[0].ts > 2.0:
            self._history.popleft()
        roll, pitch = self._position_commands_locked(obs.ts, now)
        x, z, vx, vz = a["x"], a["z"], a["vx"], a["vz"]
        err_z = z - a["target_m"]
        yaw, _ = self._steering.update(list(self._history), now, self._arrive_width, no_forward=True)
        if cmd is not None and cmd.pitch_cap is not None:
            pitch = min(pitch, cmd.pitch_cap)       # something in the way: never closer
        if cmd is not None and cmd.pitch is not None and cmd.pitch < 0.0:
            pitch = cmd.pitch                       # very close: back off
        self._send(yaw, pitch, now, roll)

        too_close = z < max(cfg.align_too_close_floor_m, cfg.align_too_close_frac * a["target_m"])
        if abs(x) > cfg.align_give_up_m or too_close:
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
        scale = self._settle_scale_locked()
        descent_frac, pending_frac = cfg.settle_descent_frac * scale, cfg.settle_pending_frac * scale
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
                    self._descent_count = self._descent_count + 1 if rise > descent_frac else 0
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
                      or self._descent_count > 0 or self._last_rise > pending_frac):
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
            **self._avoid_detail_locked(),
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

    def _avoid_detail_locked(self) -> Dict[str, Any]:
        """Obstacle-avoidance keys for the run's closing event; empty when the run had it off."""
        if self._avoid_run == "off":
            return {}
        return {"avoid": {"mode": self._avoid_run, "holds": self._avoider.holds,
                          "held_s": round(self._avoider.no_progress_s, 1)}}

    def _path_blocked_detail_locked(self, cmd: AvoidCommand) -> Dict[str, Any]:
        target = self._avoider.target
        return {
            "blocked_by": cmd.reason,           # "timeout" (held blocked_timeout_s in total)
            "obstacle_kind": None if target is None else target.kind,
            "obstacle_distance_m": None if target is None or target.distance_m is None else round(target.distance_m, 2),
            "flight_confirmed": self._flight_confirmed,      # the sign grew since first seen
            "takeoff_climb_seen": self._takeoff_seen,        # automatic run: the climb seen at takeoff
        }

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
        if took_off and reason in SAFE_LANDING_REASONS and self._airborne_now_locked(now, reason):
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
            **self._avoid_detail_locked(),
            **(extra or {}),
        })
        self._queue_trace("aborted", reason, now, extra)
        logger.warning("run %s aborted: %s", self._run_id, reason)

    def _airborne_now_locked(self, now: float, reason: Optional[str] = None) -> bool:
        """Current evidence that the drone is in the air, needed before a safe-landing toggle (a toggle
        to a drone that already landed by itself would launch it): the flight was confirmed (the
        marker grew: only a flying drone moves toward the sign), the marker is in view right now, and
        it is not rising in the picture (a sinking camera sees it move up) compared with the
        detections between 2.0 and 0.5 s ago. For path_blocked, where the obstacle often hides the
        sign, the obstacle in front may give the same evidence instead (_obstacle_evidence_locked)."""
        if self._marker_evidence_locked(now):
            return True
        return reason == "path_blocked" and self._obstacle_evidence_locked(now)

    def _obstacle_evidence_locked(self, now: float) -> bool:
        """path_blocked only: the flight was confirmed (or, for an automatic run, the climb was seen
        during the takeoff: _takeoff_seen_locked), obstacle boxes were seen in the last
        safe_land_marker_fresh_s, and for every one of them wholly inside the picture sideways: its
        base is either below the bottom of the picture or at a floor distance a camera at hover height
        could see (a camera sitting on the floor sees a base just under the horizon, which reads as very
        far), and none of its edges inside the picture has risen by more than settle_descent_frac of the
        frame height against the median over 2.0 to 0.5 s before (the box nearest it in each earlier
        frame, within 0.1 of the frame width; a sinking camera sees everything move up). At least one
        edge must have been checked. Unproven on a real drone."""
        if not (self._flight_confirmed or self._takeoff_seen) or not self._obstacle_log:
            return False
        latest_ts, boxes = self._obstacle_log[-1]
        if now - latest_ts > self.cfg.safe_land_marker_fresh_s:
            return False
        margin = self._avoid_cfg.edge_margin
        earlier = [frame for ts, frame in self._obstacle_log if 0.5 <= latest_ts - ts <= 2.0]
        checked = 0
        for x1, y1, x2, y2 in boxes:
            if x1 <= margin or x2 >= 1.0 - margin:
                continue                      # leaving the picture at the side: its centre is not its own
            if y2 < 1.0 - margin:
                base = floor_distance_m(y2, self._avoid_cfg)
                if base is None or base > self.cfg.obstacle_evidence_max_m:
                    return False
            cx = 0.5 * (x1 + x2)
            reference = []
            for frame in earlier:
                match = min(frame, key=lambda b: abs(0.5 * (b[0] + b[2]) - cx))
                if abs(0.5 * (match[0] + match[2]) - cx) <= 0.1:
                    reference.append(match)
            if len(reference) < 3:
                continue
            for index, latest in ((1, y1), (3, y2)):
                if not margin < latest < 1.0 - margin:
                    continue
                values = [r[index] for r in reference if margin < r[index] < 1.0 - margin]
                if len(values) < 3:
                    continue
                if statistics.median(values) - latest > self.cfg.settle_descent_frac:
                    return False
                checked += 1
        return checked > 0

    def _takeoff_seen_locked(self) -> bool:
        """End of an automatic run's takeoff wait: the sign moved down the picture by at least
        takeoff_cy_rise between the countdown on the ground (median of its last 10 detections) and the
        last second of the takeoff wait (median), on at least 3 detections each: the camera climbed."""
        ground = self._ground_cy[-10:]
        if len(ground) < 3 or not self._climb_cy:
            return False
        latest = self._climb_cy[-1][0]
        air = [cy for ts, cy in self._climb_cy if latest - ts <= 1.0]
        if len(air) < 3:
            return False
        return statistics.median(air) - statistics.median(ground) >= self.cfg.takeoff_cy_rise

    def _marker_evidence_locked(self, now: float) -> bool:
        if not self._flight_confirmed or not self._cy_log:
            return False
        latest_ts, latest_cy = self._cy_log[-1]
        if now - latest_ts > self.cfg.safe_land_marker_fresh_s:
            return False
        reference = [cy for ts, cy in self._cy_log if 0.5 <= latest_ts - ts <= 2.0]
        if len(reference) < 3:
            return False
        rise = statistics.median(reference) - latest_cy
        # Scaled by the current distance (not the landing distance): far from the sign the same sink
        # moves the sign much less in the picture.
        distance = None if self._last_apparent is None else self._distance_m(self._last_apparent)
        scale = max(1.0, min(2.0, self.cfg.settle_ref_distance_m / distance)) if distance else 1.0
        return rise <= self.cfg.settle_descent_frac * scale

    def _settle_scale_locked(self) -> float:
        """Factor on the settle guard's rise thresholds (the drone is at the landing distance then): a
        closer landing distance sees a bigger rise in the picture for the same sink (rise ~ sink /
        distance)."""
        distance = self._distance_m(self._arrive_width)
        if not distance:
            return 1.0
        return max(1.0, min(2.0, self.cfg.settle_ref_distance_m / distance))

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
            **({"avoid_state": self._avoider.state, "obstacles": len(self._seen)}
               if self._avoid_run != "off" else {}),
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
            **({"avoid": {
                "mode": self._avoid_run,
                "holds": self._avoider.holds,
                "held_s": round(self._avoider.no_progress_s, 2),
                "blocked_reason": self._avoider.blocked_reason,
                "searched_again": self._research_count,
                "events": [{**e, "t": round(e["t"] - self._started_at, 3)} for e in self._avoider.events],
            }} if self._avoid_run != "off" else {}),
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
                "avoid": self._avoid_snapshot_locked(),
            }

    def _avoid_snapshot_locked(self) -> Dict[str, Any]:
        """Status `mission.avoid`: the setting, and what the current (or last) run's avoidance is doing.
        state, kind and distance_m are null before any run that had it on."""
        if self._avoid_run == "off" or self._run_id is None:
            return {"mode": self._avoid_mode, "state": None, "kind": None, "distance_m": None, "held_s": 0.0}
        return {"mode": self._avoid_mode, **self._avoider.snapshot()}

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
