// Ports backend/medhop/mission/runner.py: the station-run state machine, its failsafes, the
// experimental obstacle avoidance in flight and the hover test (SPEC sections 6 and 11). Checked call by
// call against Python by runner.test.ts (fixtures: __fixtures__/runner_*.json, written by
// backend/tools/parity_traces.py from real closed-loop SimHarness runs and scripted ones), and in the
// closed loop with the TypeScript simulator by runner.closedLoop.test.ts.
//
// A manual run never takes off: the pilot does. The runner steers yaw and pitch, through the
// ControlMixer, and sends the shared takeoff/land toggle at most once: after a confirmed arrival. On an
// abort it sends neutral and never the toggle (if the drone has already landed by itself, the toggle
// would launch it).
//
// An automatic run (`start(..., automatic = true)`, the "Fly to station" button or a dose coming due
// with automatic flights on) also takes off: the runner sends the toggle once from the ground, waits
// `takeoff_wait_s` with neutral sticks, then searches as usual and always lands on arrival. If it stops
// early for one of SAFE_LANDING_REASONS it lands where it is, because nobody may be there to land it,
// but only on current evidence that it is in the air (`_airborneNow`: the marker has grown since first
// seen, which only a flying drone can do, it is in view now, and it is not rising in the picture).
// Without that evidence it sends no second toggle and the status says the drone needs a pilot.
//
// Where it lands: a detection counts toward arrival only when the marker is at least the arrive width
// (about 0.45 m from the sign by the program's own measure with the defaults), near the middle of the
// picture and seen from the front, on arrive_consecutive frames in a row, after it has grown since first
// seen. Seeing the sign from far away only starts the approach; a sign too far away to be at least
// MIN_WIDTH of the frame is not detected at all, and any other marker id is ignored.
//
// Drift assist (experimental, off by default, SPEC section 6 Revision 2): while approaching, the run
// may add a small bounded roll that cancels sideways drift (`steering.DriftAssist`). It never touches
// throttle, it sends no roll in any other state, and it switches itself off for the rest of the run
// when its own off-axis check says it is making things worse.
//
// "Marker width" in the arrival, taper and too-close rules means `apparentWidth()`: the marker's size
// corrected for the viewing angle. Seen square-on it equals the reported width. Seen from the side the
// plain width shrinks, which would let a drone that has drifted sideways fly on toward the wall; the
// corrected figure instead reaches the arrive width at the same distance from the wall. The growth rule
// uses `MarkerObs.size` (the larger edge measure), which tracks range.
//
// Obstacle avoidance (experimental, simulator-tested only, never flown near people, not a safety
// system; SPEC section 11): with the mission setting `avoid` at "hold", people and objects in the way
// (avoid.ts) make the run slow down, hold and back off a little, and end it with path_blocked when they
// stay, instead of ending it with person_in_view. It never goes round them. A sign hidden by them is
// "hidden", not lost. "off" is the behaviour without it, unchanged. In every mode a run never starts
// with a person in view, or with an object in the lane (simulator).
//
// How to drive it (Python's vision thread and server, here one caller): `step(obs, now)` for every new
// frame and, with null, a few times a second in between so timers run without video (SimHarness.step
// does both: testing/simHarness.ts); `mixer.tick(now)` at the control rate; the mixer's onPilotInput
// calls `abort("estop" | "pilot_took_over")` and `notePilotInput()`. Nothing here sleeps or reads a
// clock: every method takes `now`, or reads the injected clock when it is omitted.
//
// Differences from Python, all deliberate:
// - No lock and no thread. Writes still go through a queue and `flush()`, called at the same places as
//   in Python (end of step, start, calibrate_arrival and the setters), so the store sees the same calls
//   in the same order and at the same moments; `flush()` just runs them (abort() queues its event
//   without flushing, as in Python: call flush() after it to write at once, as the Python server does).
// - The clock and the wall clock must be injected; the run id comes from an injectable generator
//   (default `pythonRunId`: Python's format, local time, 4 random hex digits).
// - `fitPose` (default vision/pose.ts fitSignPose) is injectable, so the replay test can check each
//   line-up pose fit against Python's with the pose test's rule and then continue on Python's answer.
// - Method names are camelCase; records that reach the status JSON, events and traces keep the Python
//   keys, built in the Python key order. Python tuples are arrays ([ok, blockers]).
// - Log lines go to an optional Logger with Python's level and formatted message.

import { AVOID_MODES, batteryCheckEnabled, type AvoidMode, type Settings } from "../config";
import type { DroneLink } from "../drone/link";
import { SILENT_LOGGER, type Logger } from "../util/log";
import { pyFormatFixed, pyMax, pyMedian, pyMin, pyOr, pyRepr, pyRound, pyTruthy, pyTupleRepr, pyStrRepr, radians, ValueError } from "../util/num";
import { MarkerObs, Obstacle, type Corner, type Observation } from "../vision/marker";
import { NO_PERSON } from "../vision/person";
import { fitSignPose, type SignPose } from "../vision/pose";
import {
  Avoider,
  CLEAR as AVOID_CLEAR,
  estimate,
  floorDistanceM,
  makeAvoidConfig,
  NOT_MOVING_ON,
  type AvoidCommand,
  type AvoidConfig,
  type AvoidState,
  type Box,
  type Seen,
} from "./avoid";
import { pythonRunId, type PersonStatusProvider, type PilotConnected, type RunIdGenerator, type RunnerMixer, type RunnerStore } from "./ports";
import {
  DriftAssist,
  markerSkew,
  steer,
  Steering,
  type DriftAssistConfig,
  type MarkerSample,
  type SteeringConfig,
} from "./steering";

export const IDLE = "idle";
/** automatic runs only: on the ground, a few seconds before the takeoff toggle */
export const COUNTDOWN = "countdown";
/** automatic runs only: the runner sent the takeoff toggle and waits, neutral */
export const TAKING_OFF = "taking_off";
export const SEARCHING = "searching";
export const APPROACHING = "approaching";
/** at the landing distance: sliding onto the sign's centre line before landing */
export const ALIGNING = "aligning";
export const ARRIVED = "arrived";
export const LANDING = "landing";
export const DONE = "done";
export const ABORTED = "aborted";
export const HOVER_TEST = "hover_test";
export const STATES = [
  IDLE,
  COUNTDOWN,
  TAKING_OFF,
  SEARCHING,
  APPROACHING,
  ALIGNING,
  ARRIVED,
  LANDING,
  DONE,
  ABORTED,
  HOVER_TEST,
] as const;
export type RunnerState = (typeof STATES)[number];

/** a station run is in progress */
export const RUN_STATES: readonly RunnerState[] = Object.freeze([COUNTDOWN, TAKING_OFF, SEARCHING, APPROACHING, ALIGNING, ARRIVED, LANDING]);
/** before the landing toggle */
export const ABORTABLE_STATES: readonly RunnerState[] = Object.freeze([COUNTDOWN, TAKING_OFF, SEARCHING, APPROACHING, ALIGNING, ARRIVED]);

export const ABORT_REASONS = [
  "marker_not_found",
  "marker_lost",
  "video_stale",
  "timeout",
  "pilot_took_over",
  "person_in_view",
  "battery_low",
  "estop",
  "off_axis", // not in SPEC section 6: added failsafe, see RunnerConfig.off_axis_aspect
  "pilot_link_lost", // the pilot's control socket dropped: nobody could press stop any more
  "unexpected_descent", // settle descent guard: the drone is sinking by itself (SPEC 10.2)
  "takeoff_refused", // automatic run: the mixer did not send the takeoff toggle
  "not_lined_up", // at the arrive distance but could not get centred and in front of the sign
  "already_at_station", // automatic run: the marker was already at arrive size after takeoff
  "path_blocked", // obstacle avoidance: held too long (SPEC section 11)
  "obstacle_in_view", // automatic run: an object came into the lane during the countdown (simulator)
] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

export const BLOCKERS = [
  "no_video",
  "estop_active",
  "already_running",
  "person_in_view",
  "battery_low",
  "marker_too_close",
  "no_pilot_link", // no pilot control socket is connected (start and hover test)
  "drone_flying", // automatic start only: simulated telemetry says the drone is already up
  "recent_toggle", // automatic start only: a takeoff/land toggle went out a moment ago
  "obstacle_in_view", // an object in the lane (simulator boxes; the real drone never sees objects)
] as const;
export const DRONE_FLYING = "drone_flying";
export const RECENT_TOGGLE = "recent_toggle";
/**
 * An automatic run that stops early lands where it is (the land toggle) for these reasons, because
 * nobody may be there to land it and hovering until the battery runs out ends in a fall. Only on
 * CURRENT evidence that it is in the air (`_airborneNow`): the flight confirmed, the marker in view
 * right now and not rising in the picture (a sinking camera). marker_lost and video_stale are not here:
 * without a picture there is no such evidence, and a drone that landed by itself would be relaunched.
 * Never for estop (motor cut), pilot_took_over (the pilot has it), unexpected_descent (it is already
 * landing: a toggle would relaunch it) or takeoff_refused (it never left the ground). path_blocked may
 * also take its evidence from the obstacle in front (see _obstacleEvidence).
 */
export const SAFE_LANDING_REASONS: ReadonlySet<string> = new Set([
  "timeout",
  "person_in_view",
  "battery_low",
  "off_axis",
  "not_lined_up",
  "pilot_link_lost",
  "path_blocked",
]);
export const NO_PILOT_LINK = "no_pilot_link";
export const NOT_CONFIRMED = "confirm_airborne_required";
export const MARKER_NOT_VISIBLE = "marker_not_visible";

/** RunnerConfig with the Python field names; see RUNNER_CONFIG_DEFAULTS for what each one means. */
export interface RunnerConfig {
  search_timeout_s: number;
  lost_hold_s: number;
  lost_creep_s: number;
  lost_coast_s: number;
  video_stale_s: number;
  run_timeout_s: number;
  settle_s: number;
  land_wait_s: number;
  arrive_consecutive: number;
  growth_ratio: number;
  arrive_marker_fresh_s: number;
  settle_descent_frac: number;
  settle_guard_wait_s: number;
  settle_reference_after_s: number;
  settle_reference_count: number;
  settle_descent_consecutive: number;
  settle_pending_frac: number;
  settle_ref_distance_m: number;
  search_confirm_count: number;
  search_confirm_spread: number;
  frame_gap_hold_s: number;
  off_axis_aspect: number;
  off_axis_consecutive: number;
  video_live_s: number;
  marker_fresh_s: number;
  person_fresh_s: number;
  hover_test_s: number;
  hover_visible_pct: number;
  countdown_s: number;
  takeoff_wait_s: number;
  recent_toggle_s: number;
  arrive_stall_s: number;
  safe_land_marker_fresh_s: number;
  align_enabled: boolean;
  align_tolerance_m: number;
  align_distance_tol_m: number;
  align_centre_tol: number;
  align_still_m_s: number;
  align_hold_s: number;
  align_timeout_s: number;
  align_loose_m: number;
  align_tau_s: number;
  align_roll_kp: number;
  align_roll_kd: number;
  align_roll_ki: number;
  align_roll_max: number;
  align_roll_i_max: number;
  align_pitch_kp: number;
  align_pitch_kd: number;
  align_pitch_max: number;
  align_lost_s: number;
  align_give_up_m: number;
  align_too_close_frac: number;
  align_too_close_floor_m: number;
  arrive_centre_tol: number;
  arrive_min_aspect: number;
  avoid: AvoidMode;
  obstacle_fresh_s: number;
  research_max: number;
  obstacle_evidence_max_m: number;
  takeoff_cy_rise: number;
  path_blocked_evidence_wait_s: number;
}

/** The Python dataclass defaults, with the Python comments. */
export const RUNNER_CONFIG_DEFAULTS: Readonly<RunnerConfig> = Object.freeze({
  /** searching longer than this aborts with marker_not_found */
  search_timeout_s: 12.0,
  /** marker lost: hold neutral this long */
  lost_hold_s: 0.6,
  /** then creep-search this long, then abort with marker_lost */
  lost_creep_s: 2.0,
  // Within lost_hold_s, a marker missing for at most this long is a detection dropout, not a loss: the
  // approach coasts (the last forward stick and assist roll, fading to zero over this window, no yaw)
  // and keeps its arrival counts, so "N detections in a row" means N detections with gaps of at most
  // lost_coast_s. Never forward when the last step held or was near the arrive width. The line-up keeps
  // its timer through such gaps, with no yaw, only a backward pitch (its last one, if backward) and only
  // the clamped drift-cancelling roll. The search's confirming detections may have such gaps too. 0
  // disables all of this.
  lost_coast_s: 0.5,
  /** a frame older than this aborts with video_stale */
  video_stale_s: 1.5,
  run_timeout_s: 45.0,
  // Neutral sticks after arrival before landing. 1.2 s, not SPEC 6's 0.6 s: with about 0.35 s of video
  // delay, a 0.6 s settle left the descent guard blind to a descent that began late in the settle.
  settle_s: 1.2,
  /** time given to the landing before the run is done */
  land_wait_s: 4.0,
  /** detections in a row at or above the arrive width */
  arrive_consecutive: 3,
  /** the marker must have grown this much since first seen */
  growth_ratio: 1.15,
  /** the marker must still be in view when the toggle is sent */
  arrive_marker_fresh_s: 0.3,
  // Settle descent guard (SPEC 10.2). The reference cy is the median of the first settle_reference_count
  // detections taken at least settle_reference_after_s into the settle (after the drone has pitched back
  // from its forward stick). When settle_descent_consecutive detections in a row show the marker more
  // than settle_descent_frac of the frame height ABOVE the reference (cy smaller: the camera is sinking,
  // so the drone is landing by itself), the run aborts with unexpected_descent and does not toggle. The
  // marker moving DOWN the picture does not count. The landing toggle also waits until the guard has its
  // reference, has checked that many detections after it, and has no suspicious detection pending, but
  // no longer than settle_guard_wait_s past settle_s: then the run ends done without the toggle
  // (landing_skipped "settle_guard_undecided") and the pilot lands. The guard only runs when land on
  // arrival is on. 0 disables the guard.
  settle_descent_frac: 0.08,
  settle_guard_wait_s: 1.0,
  settle_reference_after_s: 0.25,
  settle_reference_count: 3,
  settle_descent_consecutive: 3,
  // A smaller rise than settle_descent_frac on the latest detection does not abort, but the toggle waits
  // (within settle_guard_wait_s) until it is gone: a slow sink that started late in the settle has not
  // reached the abort threshold yet when the settle ends.
  settle_pending_frac: 0.03,
  // Both settle fractions are tuned for this distance from the sign. Closer, the same sink moves the sign
  // further up the picture, so the settle guard scales them by clamp(settle_ref_distance_m / landing
  // distance, 1, 2), and the safe-landing evidence check scales settle_descent_frac by the same clamp of
  // the CURRENT distance (from the newest detection).
  settle_ref_distance_m: 0.8,
  // SEARCHING moves to APPROACHING (and a start goes straight to APPROACHING) only after this many
  // detections whose centres agree within search_confirm_spread (cx in frame widths, cy in frame
  // heights), with gaps of at most lost_coast_s between them (consecutive when it is 0); the growth
  // check is seeded from the median size of those detections.
  search_confirm_count: 3,
  search_confirm_spread: 0.1,
  /** no new frame for this long: command neutral */
  frame_gap_hold_s: 0.25,
  // Added failsafe (not in SPEC section 6). The run steers with yaw and pitch only, so sideways drift
  // carries the drone around the marker until it flies at the wall from the side. When the marker looks
  // narrower than this fraction of its height (0.70 is about 45 degrees off the wall's normal) on
  // off_axis_consecutive detections, the run aborts with reason "off_axis". 0 disables.
  off_axis_aspect: 0.7,
  off_axis_consecutive: 3,
  /** start is blocked when the newest frame is older than this */
  video_live_s: 0.5,
  /** a detection older than this is not "currently visible" */
  marker_fresh_s: 0.5,
  /** a person-check result older than this is ignored */
  person_fresh_s: 2.0,
  /** the pass limit is Settings.hover_max_excursion_m */
  hover_test_s: 10.0,
  hover_visible_pct: 80.0,
  // Automatic runs: on the ground this long before the takeoff toggle (the page counts down and beeps;
  // Stop cancels with no flight), then neutral sticks for takeoff_wait_s before searching.
  countdown_s: 5.0,
  takeoff_wait_s: 4.0,
  /** an automatic start is blocked this long after any toggle */
  recent_toggle_s: 10.0,
  // At the arrive distance the run flies no further forward (yaw only). Still not arrived after this
  // long there: abort not_lined_up instead of hovering at the wall.
  arrive_stall_s: 2.5,
  // Safe landing evidence: the marker seen this recently, and its cy not more than settle_descent_frac
  // above the median cy of the detections between 2.0 and 0.5 s ago.
  safe_land_marker_fresh_s: 0.5,
  // Final line-up (ALIGNING). At the arrive distance the run measures where the drone is relative to the
  // sign (vision/pose.ts: metres left/right of the sign's centre line and from the wall), then slides
  // sideways with roll and holds the distance with pitch while yaw keeps the sign centred. It lands once
  // it has been within align_tolerance_m of the centre line, within align_distance_tol_m of the landing
  // distance, the sign within align_centre_tol of the picture's middle and nearly still, for
  // align_hold_s. Not lined up after align_timeout_s: it lands anyway when within align_loose_m (the
  // arrival says it was not lined up exactly), else stops with not_lined_up. The roll that was holding it
  // still is kept on during the settle and the landing (a temporary trim), so the drone comes down where
  // it lined up instead of drifting off. The settle after lining up is the usual settle_s with the
  // descent guard, whose reference is where the sign sat while the drone held still.
  align_enabled: true,
  align_tolerance_m: 0.04,
  align_distance_tol_m: 0.08,
  align_centre_tol: 0.06,
  align_still_m_s: 0.05,
  align_hold_s: 1.0,
  align_timeout_s: 15.0,
  align_loose_m: 0.12,
  /** smoothing of the measured position */
  align_tau_s: 0.25,
  /** roll stick per metre off the centre line */
  align_roll_kp: 0.7,
  /** roll stick per metre/second of sideways speed */
  align_roll_kd: 0.9,
  /** roll stick per metre-second (cancels a steady drift) */
  align_roll_ki: 0.35,
  /** the mixer's mission roll limit */
  align_roll_max: 0.15,
  align_roll_i_max: 0.15,
  // Pitch stick per metre too far from the wall. 0.8, not 0.4: at the 0.45 m landing distance the errors
  // are about half as many metres, and 0.4 let a sideways drift creep the drone onto the wall.
  align_pitch_kp: 0.8,
  align_pitch_kd: 0.5,
  align_pitch_max: 0.08,
  /** marker out of view this long while lining up: marker_lost */
  align_lost_s: 1.0,
  // No separate roll-sign check here: a wrong sign would push the drone off the centre line, and
  // align_give_up_m stops the line-up long before it gets far (the approach's drift assist has its own
  // check). Give up early (not_lined_up) instead of chasing the sign: this far off the centre line, or
  // closer to the wall than align_too_close_frac of the landing distance or than
  // align_too_close_floor_m, whichever is farther from the wall.
  align_give_up_m: 0.9,
  align_too_close_frac: 0.7,
  align_too_close_floor_m: 0.3,
  // A detection only counts toward arrival when the marker is also near the middle of the picture
  // (|cx - 0.5| at most this) and seen from the front (width/height at least arrive_min_aspect, about 37
  // degrees off the wall's normal). Big enough and centred but seen from the side on arrive_consecutive
  // detections: the drone is beside the station, so the run stops with off_axis instead of landing
  // there. 0 for arrive_min_aspect disables both the facing rule and that abort.
  arrive_centre_tol: 0.12,
  arrive_min_aspect: 0.8,
  // Obstacle avoidance (experimental, SPEC section 11): "off" or "hold". A stored mission setting wins;
  // without one, Settings.avoid when it is not "off", else this. A run keeps the mode it started with.
  avoid: "off",
  /** a person-check result older than this is no evidence for avoidance */
  obstacle_fresh_s: 1.0,
  /** back to searching after the way cleared without the sign, per run */
  research_max: 2,
  /** safe landing on path_blocked: a base farther than this is no evidence */
  obstacle_evidence_max_m: 8.0,
  // Safe landing on path_blocked: an automatic run that saw the sign move this much DOWN the picture
  // (fraction of the frame height, median of the countdown on the ground against the median of the last
  // second of the takeoff wait) saw its camera climb: evidence of flight even when an obstacle stepped in
  // before the sign could grow. A 1 m climb moves a sign 4.2 m away about 0.3.
  takeoff_cy_rise: 0.1,
  // path_blocked in an automatic run without current evidence of flight: hold still (neutral sticks) at
  // most this long for it to show, then end the run anyway.
  path_blocked_evidence_wait_s: 2.5,
});

/** RunnerConfig(**overrides) */
export function makeRunnerConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return { ...RUNNER_CONFIG_DEFAULTS, ...overrides };
}

/** Width over height: 1 seen square-on, about the cosine of the viewing angle from the side. */
export function markerAspect(marker: MarkerObs): number {
  return marker.height > 0 ? marker.width / marker.height : 1.0;
}

/** The width a square-on marker would show at the drone's current distance from the wall. */
export function apparentWidth(marker: MarkerObs): number {
  return marker.size / pyMax(0.5, pyMin(1.0, markerAspect(marker)));
}

function roundOrNone(value: number | null | undefined, digits = 2): number | null {
  return value === null || value === undefined ? null : pyRound(value, digits);
}

/** Python's %s of a str, None or bool. */
function pyS(value: string | boolean | null | undefined): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return value;
}

/** Python's repr of the hover result dict (bools and floats only), for the log line. */
function pyDictRepr(d: Record<string, number | boolean>): string {
  const items = Object.entries(d).map(([k, v]) => `${pyStrRepr(k)}: ${typeof v === "boolean" ? pyS(v) : pyRepr(v)}`);
  return `{${items.join(", ")}}`;
}

// ---------------------------------------------------------------------------------------------- //
// records

/** The line-up state (Python's `_align` dict); null where Python's is the empty dict. */
interface AlignState {
  target_m: number;
  x: number | null;
  z: number | null;
  vx: number;
  vz: number;
  ts: number | null;
  integral: number;
  roll: number;
  pitch: number;
  aligned_since: number | null;
  /** (ts, cy) while aligned */
  window: [number, number][];
  lost_since: number | null;
  roll_ok: boolean;
  done: boolean;
  aligned: boolean;
  /** Python adds it on the first _position_commands_locked (a.get("cmd_ts") is None before) */
  cmd_ts: number | null;
}

interface HoverState {
  running: boolean;
  started_at: number;
  elapsed_s: number;
  result: HoverResult | null;
}

export interface HoverResult {
  pass: boolean;
  drift_frame_widths: number;
  drift_m_estimate: number;
  width_change_pct: number;
  visible_pct: number;
  peak_excursion_m: number;
  limit_m: number;
}

export interface HoverSnapshot {
  running: boolean;
  elapsed_s: number;
  result: HoverResult | null;
}

export interface DriftAssistSnapshot {
  enabled: boolean;
  active: boolean;
  roll: number;
  disabled_reason: string | null;
  suggested_trim_roll: number | null;
}

export interface AlignmentSnapshot {
  lateral_m: number | null;
  distance_m: number | null;
  target_distance_m: number;
  tolerance_m: number;
  aligned_for_s: number;
  need_s: number;
}

export interface LastArrival {
  lateral_offset_m: number | null;
  distance_m: number | null;
  aligned: boolean;
}

export interface AvoidSnapshot {
  mode: AvoidMode;
  state: AvoidState | null;
  kind: string | null;
  distance_m: number | null;
  held_s: number;
}

/** What "how the latest run's landing went" can be (status `last_landing`). */
export type LastLanding = "sent" | "skipped_settle_guard_undecided" | "refused_by_mixer" | "off" | "safe_landing";

/** MissionRunner.snapshot(): status `mission`, with the Python keys in the Python order. */
export interface RunnerSnapshot {
  state: RunnerState;
  reason: string | null;
  run_id: string | null;
  dose_id: string | null;
  elapsed_s: number;
  command: { yaw: number; pitch: number };
  arrive_width: number;
  land_on_arrival: boolean;
  last_landing: LastLanding | null;
  drift_assist: DriftAssistSnapshot;
  can_start: boolean;
  blockers: string[];
  automatic: boolean;
  auto_fly: boolean;
  auto_blockers: string[];
  can_start_auto: boolean;
  countdown_remaining_s: number | null;
  distance_m: number | null;
  arrive_distance_m: number | null;
  flight_confirmed: boolean;
  needs_pilot: boolean;
  ready_for_dose: boolean;
  alignment: AlignmentSnapshot | null;
  last_arrival: LastArrival | null;
  avoid: AvoidSnapshot;
}

/** One entry of MissionRunner.obstaclesSnapshot(): status `vision.obstacles`. */
export interface ObstacleSnapshot {
  kind: string;
  box: number[];
  distance_m: number | null;
  lateral_m: number | null;
  in_lane: boolean;
}

/** MissionRunner.settings(): the persisted mission switches. */
export interface MissionSettings {
  land_on_arrival: boolean;
  drift_assist: boolean;
  auto_fly: boolean;
  avoid: AvoidMode;
}

/** The pose fit the line-up uses (vision/pose.ts fitSignPose's signature, with the default iterations). */
export type PoseFit = (corners: readonly Corner[], frameW: number, frameH: number, markerSizeM: number, hfovDeg: number) => SignPose | null;

export interface MissionRunnerOptions {
  /** Monotonic seconds (Python: time.monotonic). Used only when a method is called without `now`. */
  clock: () => number;
  /** Unix seconds (Python: time.time): event and trace times, the run id stamp. */
  wallClock: () => number;
  /** The person check (default: always "disabled", NO_PERSON). */
  personStatus?: PersonStatusProvider | null;
  steeringConfig?: SteeringConfig | null;
  config?: RunnerConfig | null;
  driftAssistConfig?: DriftAssistConfig | null;
  /** Whether a pilot control socket is connected. null (tests without a server): no check. */
  pilotConnected?: PilotConnected | null;
  /** default AvoidConfig(hfov_deg = settings.camera_hfov_deg) */
  avoidConfig?: AvoidConfig | null;
  /** default pythonRunId */
  runId?: RunIdGenerator | null;
  /** default vision/pose.ts fitSignPose */
  fitPose?: PoseFit | null;
  logger?: Logger;
}

type PendingIo = () => void;

export class MissionRunner {
  /** The runner configuration (Python `cfg`). */
  readonly cfg: RunnerConfig;

  private readonly _link: DroneLink;
  private readonly _mixer: RunnerMixer;
  private readonly _store: RunnerStore;
  private readonly _settings: Settings;
  private readonly _clock: () => number;
  private readonly _wallClock: () => number;
  private readonly _personStatus: PersonStatusProvider;
  /** Tells whether a pilot control socket is connected. null (tests without a server) = no check. */
  private readonly _pilotConnected: PilotConnected | null;
  private readonly _newRunId: RunIdGenerator;
  private readonly _fitPose: PoseFit;
  private readonly _logger: Logger;
  private readonly _steering: Steering;
  private readonly _assist: DriftAssist;
  private _pendingIo: PendingIo[] = [];

  private _arriveWidth: number;
  /** persisted; off by default */
  private _landOnArrival: boolean;
  /** the switch (persisted); off by default */
  private _driftAssist: boolean;
  /** fly automatically at dose times; off by default */
  private _autoFly: boolean;
  /** the current (or last) run took off by itself */
  private _automatic = false;
  /** the marker grew since first seen in this run */
  private _flightConfirmed = false;
  /** automatic run: the sign's cy during the countdown */
  private _groundCy: number[] = [];
  /** ... and during the takeoff wait (ts, cy) */
  private _climbCy: [number, number][] = [];
  /** the sign moved down the picture during the takeoff */
  private _takeoffSeen = false;
  /** path_blocked: waiting for evidence of flight */
  private _blockedSince: number | null = null;
  /** the run timeout counts from here */
  private _timeoutFrom = 0.0;
  /** since when the marker has been at arrive size */
  private _atSizeSince: number | null = null;
  /** line-up state, see _stepAligning */
  private _align: AlignState | null = null;
  /** roll kept on through settle and landing */
  private _holdRoll = 0.0;
  private _lastArrival: LastArrival | null = null;
  /** (frame time, cy) of recent detections */
  private _cyLog: [number, number][] = [];
  /** apparent width of the newest of them */
  private _lastApparent: number | null = null;
  // A person marked the drone as on its start spot; scheduled automatic runs need it. In memory only (a
  // restart clears it) and cleared by any run start or pilot input.
  private _readyForDose = false;
  // An automatic run stopped early without landing: the drone may be in the air with nobody flying it.
  // Cleared when the next run starts or the pilot acts.
  private _needsPilot = false;
  /** this run started with the switch on */
  private _assistRun = false;
  private _assistDisabledAt: number | null = null;
  /** frame time of the assist's previous step */
  private _assistTs: number | null = null;
  private _suggestedTrimRoll: number | null = null;
  private _roll = 0.0;

  private _state: RunnerState = IDLE;
  private _reason: string | null = null;
  private _runId: string | null = null;
  private _doseId: string | null = null;
  private _startedAt = 0.0;
  private _startedWall = 0.0;
  private _endedAt: number | null = null;
  private _phaseAt = 0.0;
  private _command: [yaw: number, pitch: number] = [0.0, 0.0];
  private _lastObs: Observation | null = null;
  private _lastFrameTs = 0.0;
  private _searchStarted = 0.0;
  private _firstWidth: number | null = null;
  private _arriveCount = 0;
  private _sizeCount = 0;
  private _offAxisCount = 0;
  private _lostSince: number | null = null;
  /** forward stick to coast on through a dropout */
  private _coastPitch = 0.0;
  private _lastCx = 0.5;
  private _markerSeenAt = 0.0;
  private _arrivedWidth = 0.0;
  /** settle descent guard: reference detections' cy */
  private _settleRef: number[] = [];
  private _settleRefCy: number | null = null;
  /** detections checked against the reference */
  private _settleChecks = 0;
  /** of those, consecutive ones above it */
  private _descentCount = 0;
  /** the latest detection's rise above it */
  private _lastRise = 0.0;
  /** Python deque(maxlen=search_confirm_count) */
  private _candidates: MarkerObs[] = [];
  /** frame time of the newest candidate */
  private _candidateAt: number | null = null;
  private _toggleSent = false;
  // What the latest run did about landing once it arrived: "sent", "skipped_settle_guard_undecided",
  // "refused_by_mixer" or "off"; null before any run and for a run that has not arrived.
  private _lastLanding: LastLanding | null = null;
  private _history: MarkerSample[] = [];
  private _trace: Record<string, unknown>[] = [];

  private _hover: HoverState | null = null;
  private _hoverSamples: [ts: number, cx: number | null, size: number | null][] = [];

  // obstacle avoidance (SPEC section 11)
  private readonly _avoidCfg: AvoidConfig;
  private readonly _avoider: Avoider;
  private _avoidMode: AvoidMode;
  /** the mode the current (or last) run started with */
  private _avoidRun: AvoidMode = "off";
  /** obstacles in the newest frame, with estimates */
  private _seen: Seen[] = [];
  private _seenAt: number | null = null;
  private _seenFresh = false;
  private _avoidClock: number | null = null;
  private _avoidCmd: AvoidCommand | null = null;
  /** back to searching after the way cleared */
  private _researchCount = 0;
  private _researchPending = false;
  private _searchDirection = 1.0;
  private _lastMarkerBox: Box | null = null;
  /** (frame ts, the frame's boxes) */
  private _obstacleLog: [number, Box[]][] = [];

  constructor(link: DroneLink, mixer: RunnerMixer, store: RunnerStore, settings: Settings, options: MissionRunnerOptions) {
    this._link = link;
    this._mixer = mixer;
    this._store = store;
    this._settings = settings;
    this._clock = options.clock;
    this._wallClock = options.wallClock;
    this._personStatus = options.personStatus ?? (() => NO_PERSON);
    this._pilotConnected = options.pilotConnected ?? null;
    this._newRunId = options.runId ?? ((wall) => pythonRunId(wall));
    this._fitPose = options.fitPose ?? ((corners, w, h, size, hfov) => fitSignPose(corners, w, h, size, hfov));
    this._logger = options.logger ?? SILENT_LOGGER;
    this.cfg = options.config ?? makeRunnerConfig();
    this._steering = new Steering(options.steeringConfig ?? null);
    this._assist = new DriftAssist(options.driftAssistConfig ?? null, this._steering.cfg.yaw_rate_fw_per_s);

    const storedWidth = store.loadArriveWidth();
    this._arriveWidth = storedWidth !== null ? storedWidth : settings.arrive_width;
    this._landOnArrival = store.loadLandOnArrival();
    this._driftAssist = store.loadDriftAssist();
    this._autoFly = store.loadAutoFly();

    this._avoidCfg = options.avoidConfig ?? makeAvoidConfig({ hfov_deg: settings.camera_hfov_deg });
    this._avoider = new Avoider(this._avoidCfg);
    const storedAvoid = store.loadAvoid();
    let mode: string;
    if (storedAvoid !== null) {
      mode = storedAvoid;
    } else {
      const fromSettings = (settings as { avoid?: string }).avoid || "off";
      mode = fromSettings !== "off" ? fromSettings : this.cfg.avoid;
    }
    if (!(AVOID_MODES as readonly string[]).includes(mode)) {
      throw new ValueError(`avoid must be one of ${pyTupleRepr(AVOID_MODES)}, got ${pyStrRepr(mode)}`);
    }
    this._avoidMode = mode as AvoidMode;
  }

  // ------------------------------------------------------------------------------------------ //
  // requests

  blockers(now?: number | null): string[] {
    const t = now ?? this._clock();
    return this._blockersLocked(t);
  }

  private _currentMarker(now: number): MarkerObs | null {
    const obs = this._lastObs;
    if (obs === null || obs.marker === null || now - obs.ts > this.cfg.marker_fresh_s) return null;
    return obs.marker;
  }

  /** The optional person check sees someone, or (simulator) a simulated person is in the frame. */
  private _personInView(now: number): boolean {
    const person = this._personStatus();
    if (person.enabled && person.detected && (person.ts === null || now - person.ts <= this.cfg.person_fresh_s)) return true;
    const obs = this._lastObs;
    if (obs !== null && obs.obstacles.length > 0 && now - obs.ts <= this.cfg.person_fresh_s) {
      return obs.obstacles.some((o) => o.kind === "person");
    }
    return false;
  }

  /**
   * An "object" box in the newest frame (no older than person_fresh_s) that is in the lane by its
   * estimate, including one whose base is out of the picture or not clearly below the horizon (very
   * close, or too far to tell). `onGround`: an automatic start, from the ground, where the camera is only
   * ground_camera_height_m up. Only the simulator reports objects; the real drone never does.
   */
  private _objectInLane(now: number, onGround = false): boolean {
    if (this._seenAt === null || now - this._seenAt > this.cfg.person_fresh_s) return false;
    if (!onGround) return this._seen.some((s) => s.kind === "object" && s.in_lane);
    const ground = makeAvoidConfig({ camera_height_m: this._avoidCfg.ground_camera_height_m }, this._avoidCfg);
    return this._seen.some((s) => s.kind === "object" && estimate(s.kind, s.box, s.ts, ground).in_lane);
  }

  /**
   * Only with the check enabled (battery_low_raw >= 0) and on fresh telemetry: a reading older than
   * telemetry_fresh_s is no decision either way.
   */
  private _batteryLow(now: number): boolean {
    if (!batteryCheckEnabled(this._settings)) return false;
    const telemetry = this._link.telemetry();
    if (telemetry === null || now - telemetry.timestamp >= this._settings.telemetry_fresh_s) return false;
    return telemetry.battery_raw <= this._settings.battery_low_raw;
  }

  /**
   * Detections whose centres agree, with gaps of at most lost_coast_s between them (a detector dropout
   * does not start again); a longer gap or a far-off detection starts again. With lost_coast_s 0 any
   * miss starts again.
   */
  private _updateCandidates(marker: MarkerObs | null, ts: number): void {
    if (marker === null) {
      if (this.cfg.lost_coast_s <= 0) this._candidates.length = 0;
      return;
    }
    const spread = this.cfg.search_confirm_spread;
    const gapTooLong = this.cfg.lost_coast_s > 0 && this._candidateAt !== null && ts - this._candidateAt > this.cfg.lost_coast_s;
    if (gapTooLong || this._candidates.some((m) => Math.abs(marker.cx - m.cx) > spread || Math.abs(marker.cy - m.cy) > spread)) {
      this._candidates.length = 0;
    }
    this._candidates.push(marker);
    while (this._candidates.length > this.cfg.search_confirm_count) this._candidates.shift(); // deque maxlen
    this._candidateAt = ts;
  }

  private _markerConfirmed(): boolean {
    return this._candidates.length >= this.cfg.search_confirm_count;
  }

  /** Enter APPROACHING from confirmed detections: the growth check starts from their median size. */
  private _seedApproach(): void {
    this._state = APPROACHING;
    this._firstWidth = pyMedian(this._candidates.map((m) => m.size));
    this._lastCx = this._candidates[this._candidates.length - 1]!.cx;
    this._coastPitch = 0.0;
  }

  private _noPilotLink(): boolean {
    return this._pilotConnected !== null && !this._pilotConnected();
  }

  /**
   * Simulator only: fresh simulated telemetry says the drone is in the air. The real drone's fly-state
   * byte is unverified, so it is never used for a decision.
   */
  private _droneFlying(now: number): boolean {
    if (this._link.mode !== "sim") return false;
    const telemetry = this._link.telemetry();
    if (telemetry === null || now - telemetry.timestamp >= this._settings.telemetry_fresh_s) return false;
    return telemetry.fly_state_raw !== 0;
  }

  private _blockersLocked(now: number, automatic = false): string[] {
    const out: string[] = [];
    if (automatic && this._droneFlying(now)) out.push(DRONE_FLYING); // the takeoff toggle would land it instead
    if (automatic) {
      const since = this._mixer.secondsSinceToggle(now);
      if (since !== null && since < this.cfg.recent_toggle_s) out.push(RECENT_TOGGLE); // it may be climbing or landing
    }
    if (this._noPilotLink()) out.push(NO_PILOT_LINK); // a run may only start while a pilot window is connected
    const frame = this._link.latestFrame();
    if (frame === null || now - frame.timestamp > this.cfg.video_live_s) out.push("no_video");
    if (this._mixer.estopActive) out.push("estop_active");
    if (RUN_STATES.includes(this._state) || this._state === HOVER_TEST) out.push("already_running");
    if (this._personInView(now)) out.push("person_in_view");
    if (this._objectInLane(now, automatic)) out.push("obstacle_in_view");
    if (this._batteryLow(now)) out.push("battery_low");
    const marker = this._currentMarker(now);
    if (marker !== null && apparentWidth(marker) >= this._arriveWidth) out.push("marker_too_close");
    return out;
  }

  /**
   * Begin a station run. Returns [started, blockers].
   *
   * Manual (automatic false): the pilot has taken off and confirms it; the runner never takes off.
   * Automatic: the drone is on the ground; the runner sends the takeoff toggle itself, and
   * confirmAirborne is not used.
   */
  start(confirmAirborne: boolean, doseId: string | null = null, now?: number | null, automatic = false): [started: boolean, blockers: string[]] {
    const t = now ?? this._clock();
    const auto = automatic === true;
    const blockers = this._blockersLocked(t, auto);
    if (!auto && confirmAirborne !== true) blockers.unshift(NOT_CONFIRMED);
    if (blockers.length > 0) return [false, blockers];
    this._runId = this._newRunId(this._wallClock());
    this._doseId = doseId;
    this._reason = null;
    this._startedAt = t;
    this._startedWall = this._wallClock();
    this._endedAt = null;
    this._command = [0.0, 0.0];
    this._roll = 0.0;
    this._assist.reset();
    // Automatic runs always use the drift assist: with nobody to correct a sideways drift it is what
    // keeps the landing in front of the sign (it still switches itself off when its own check says it
    // is making things worse).
    this._assistRun = this._driftAssist || auto;
    this._assistDisabledAt = null;
    this._assistTs = null;
    this._suggestedTrimRoll = null;
    const frame = this._link.latestFrame();
    this._lastFrameTs = frame !== null ? frame.timestamp : t;
    this._searchStarted = t;
    this._firstWidth = null;
    this._arriveCount = 0;
    this._sizeCount = 0;
    this._offAxisCount = 0;
    this._lostSince = null;
    this._coastPitch = 0.0;
    this._lastCx = 0.5;
    this._toggleSent = false;
    this._lastLanding = null;
    this._history = [];
    this._trace = [];
    this._steering.reset();
    this._automatic = auto;
    this._flightConfirmed = false;
    this._timeoutFrom = t;
    this._atSizeSince = null;
    this._cyLog = [];
    this._lastApparent = null;
    this._align = null;
    this._holdRoll = 0.0;
    this._avoidRun = this._avoidMode;
    this._avoider.reset();
    this._avoidClock = t;
    this._avoidCmd = null;
    this._researchCount = 0;
    this._researchPending = false;
    this._searchDirection = 1.0;
    this._obstacleLog = [];
    this._groundCy = [];
    this._climbCy = [];
    this._takeoffSeen = false;
    this._blockedSince = null;
    this._readyForDose = false; // the drone is leaving its start spot
    this._needsPilot = false;
    this._state = auto ? COUNTDOWN : SEARCHING;
    this._phaseAt = t;
    if (!auto && this._currentMarker(t) !== null && this._markerConfirmed()) this._seedApproach();
    this._queueEvent("run_started", {
      arrive_width: pyRound(this._arriveWidth, 4),
      land_on_arrival: this._landsOnArrival(),
      drift_assist: this._assistRun,
      automatic: auto,
      mode: this._link.mode,
      ...(this._avoidRun !== "off" ? { avoid: this._avoidRun } : {}),
    });
    this._logger.log(
      "info",
      `station run ${pyS(this._runId)} started (dose ${pyS(doseId)}, state ${this._state}, ` +
        `${auto ? "automatic" : "manual"}, drift assist ${this._assistRun ? "on" : "off"})`,
    );
    this.flush();
    return [true, []];
  }

  /**
   * End of the countdown: neutral first (this also clears the mixer's "pilot input since the last
   * mission command" flag), then the one takeoff toggle.
   */
  private _takeOff(now: number): void {
    const [yaw, pitch] = this._steering.neutral(now);
    this._send(yaw, pitch, now);
    if (this._mixer.missionToggle(now, false)) {
      this._state = TAKING_OFF;
      this._phaseAt = now;
      this._logger.log("info", `run ${pyS(this._runId)}: takeoff toggle sent`);
    } else {
      this._abort("takeoff_refused", now);
    }
  }

  /**
   * A person says the drone is on its start spot, facing the sign. Scheduled automatic runs only start
   * while this is set.
   */
  markReadyForDose(): [ok: boolean, problems: string[]] {
    if (RUN_STATES.includes(this._state) || this._state === HOVER_TEST) return [false, ["already_running"]];
    this._readyForDose = true;
    this._needsPilot = false;
    this._logger.log("info", "drone marked ready for the next dose");
    return [true, []];
  }

  /**
   * The pilot moved the sticks, toggled or pressed stop: the drone is not known to be on its start spot
   * any more, and somebody is flying it.
   */
  notePilotInput(): void {
    this._readyForDose = false;
    this._needsPilot = false;
  }

  get readyForDose(): boolean {
    return this._readyForDose;
  }

  /** Automatic runs always land on arrival; manual runs follow the switch. */
  private _landsOnArrival(): boolean {
    return this._automatic || this._landOnArrival;
  }

  /**
   * Stop whatever is running. Safe to call at any time. Returns true when something was stopped. The
   * event is queued, not written: call flush() (or let the next step) write it.
   */
  abort(reason = "pilot_took_over", now?: number | null): boolean {
    const t = now ?? this._clock();
    if (ABORTABLE_STATES.includes(this._state)) {
      this._abort(reason, t);
      return true;
    }
    if (this._state === LANDING) {
      // The toggle has been sent and the arrival is logged; the pilot simply has control now.
      this._finishDone(t);
      return true;
    }
    if (this._state === HOVER_TEST) {
      this._cancelHover(reason, t);
      return true;
    }
    return false;
  }

  startHoverTest(now?: number | null): [started: boolean, problems: string[]] {
    const t = now ?? this._clock();
    const problems: string[] = [];
    if (this._noPilotLink()) problems.push(NO_PILOT_LINK);
    if (RUN_STATES.includes(this._state) || this._state === HOVER_TEST) problems.push("already_running");
    if (this._mixer.estopActive) problems.push("estop_active");
    if (this._currentMarker(t) === null) problems.push(MARKER_NOT_VISIBLE);
    if (problems.length > 0) return [false, problems];
    this._state = HOVER_TEST;
    this._reason = null;
    this._runId = null;
    this._doseId = null;
    this._startedAt = t;
    this._endedAt = null;
    this._command = [0.0, 0.0];
    this._hover = { running: true, started_at: t, elapsed_s: 0.0, result: null };
    this._hoverSamples = [];
    this._mixer.clearMissionCommand();
    this._logger.log("info", "hover test started");
    return [true, []];
  }

  /** Store the currently observed marker width as the arrive width. */
  calibrateArrival(now?: number | null): [width: number | null, problems: string[]] {
    const t = now ?? this._clock();
    if (RUN_STATES.includes(this._state) || this._state === HOVER_TEST) return [null, ["already_running"]];
    const marker = this._currentMarker(t);
    if (marker === null) return [null, [MARKER_NOT_VISIBLE]];
    const width = pyMax(0.03, pyMin(0.8, apparentWidth(marker)));
    this._arriveWidth = width;
    this._pendingIo.push(() => this._store.saveArriveWidth(width));
    this._logger.log("info", `arrive width calibrated to ${pyFormatFixed(width, 3)} of the frame width`);
    this.flush();
    return [width, []];
  }

  /** The land-on-arrival switch (persisted, off by default). */
  setLandOnArrival(value: boolean): boolean {
    const v = Boolean(value);
    this._landOnArrival = v;
    this._pendingIo.push(() => this._store.saveLandOnArrival(v));
    this.flush();
    return v;
  }

  /**
   * The drift-assist switch (persisted). Switching it off takes effect at once, also in the middle of a
   * run; switching it on applies from the next run.
   */
  setDriftAssist(value: boolean): boolean {
    const v = Boolean(value);
    this._driftAssist = v;
    this._pendingIo.push(() => this._store.saveDriftAssist(v));
    this.flush();
    return v;
  }

  /**
   * The automatic-flights switch (persisted, off by default): when on, a dose coming due starts an
   * automatic run. Switching it off does not stop a run in progress (Stop does).
   */
  setAutoFly(value: boolean): boolean {
    const v = Boolean(value);
    this._autoFly = v;
    this._pendingIo.push(() => this._store.saveAutoFly(v));
    this.flush();
    return v;
  }

  get autoFly(): boolean {
    return this._autoFly;
  }

  /**
   * The obstacle-avoidance mode (persisted): "off" or "hold". A run keeps the mode it started with; the
   * new one applies from the next run. Throws ValueError for anything else.
   */
  setAvoid(mode: string): AvoidMode {
    if (!(AVOID_MODES as readonly string[]).includes(mode)) {
      throw new ValueError(`avoid must be one of ${pyTupleRepr(AVOID_MODES)}`);
    }
    const m = mode as AvoidMode;
    this._avoidMode = m;
    this._pendingIo.push(() => this._store.saveAvoid(m));
    this.flush();
    return m;
  }

  get avoidMode(): AvoidMode {
    return this._avoidMode;
  }

  settings(): MissionSettings {
    return { land_on_arrival: this._landOnArrival, drift_assist: this._driftAssist, auto_fly: this._autoFly, avoid: this._avoidMode };
  }

  get arriveWidth(): number {
    return this._arriveWidth;
  }

  get state(): RunnerState {
    return this._state;
  }

  get reason(): string | null {
    return this._reason;
  }

  /** The avoidance command of the latest avoiding step (null before one in this run). Not in Python's API. */
  get avoidCommand(): AvoidCommand | null {
    return this._avoidCmd;
  }

  // ------------------------------------------------------------------------------------------ //
  // the step

  step(obs: Observation | null, now?: number | null): void {
    const t = now ?? this._clock();
    if (obs !== null) {
      this._lastObs = obs;
      this._updateCandidates(obs.marker, obs.ts);
      this._updateSeen(obs, t);
    }
    this._stepLocked(obs, t);
    this.flush();
  }

  // ------------------------------------------------------------------------------------------ //
  // obstacle avoidance (SPEC section 11)

  /**
   * This frame's obstacles with their estimates: the simulator's boxes, plus (real drone, or the
   * simulator with the person check on) a fresh person-check result turned into person boxes.
   */
  private _updateSeen(obs: Observation, now: number): void {
    const items: Obstacle[] = [...obs.obstacles];
    const person = this._personStatus();
    const personFresh = person.enabled && person.ts !== null && now - person.ts <= this.cfg.obstacle_fresh_s;
    if (personFresh) {
      for (const box of person.boxes) {
        items.push(new Obstacle({ kind: "person", box: [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])], ts: person.ts! }));
      }
    }
    this._seen = items.map((o) => estimate(o.kind, o.box, o.ts, this._avoidCfg));
    this._seenAt = obs.ts;
    // The simulator's boxes come with every frame; on the real drone only a fresh check is evidence.
    this._seenFresh = this._link.mode === "sim" || personFresh;
    if (obs.marker !== null) {
      const xs = obs.marker.corners.map((c) => c[0]);
      const ys = obs.marker.corners.map((c) => c[1]);
      const w = pyOr(obs.marker.frame_w, 640);
      const h = pyOr(obs.marker.frame_h, 360);
      this._lastMarkerBox = [
        pyMin(xs[0]!, ...xs.slice(1)) / w,
        pyMin(ys[0]!, ...ys.slice(1)) / h,
        pyMax(xs[0]!, ...xs.slice(1)) / w,
        pyMax(ys[0]!, ...ys.slice(1)) / h,
      ];
    }
  }

  private _avoiding(): boolean {
    return this._avoidRun !== "off" && (this._state === SEARCHING || this._state === APPROACHING || this._state === ALIGNING);
  }

  /**
   * Time held does not count against the run timeout (blocked_timeout_s bounds it instead), nor against
   * the search limit, the line-up limit or the stall timer.
   */
  private _shiftTimers(now: number): void {
    const dt = this._avoidClock === null ? 0.0 : pyMax(0.0, now - this._avoidClock);
    this._avoidClock = now;
    if (!NOT_MOVING_ON.includes(this._avoider.state) || dt <= 0.0) return;
    this._timeoutFrom += dt;
    if (this._state === SEARCHING) this._searchStarted += dt;
    else if (this._state === ALIGNING) this._phaseAt += dt;
    if (this._atSizeSince !== null) this._atSizeSince += dt;
  }

  private _avoidUpdate(obs: Observation, now: number): AvoidCommand {
    let sign: [number, number] | null = null;
    if (obs.marker !== null) {
      const rangeM = this._distanceM(obs.marker.size);
      if (pyTruthy(rangeM)) sign = [obs.marker.cx, rangeM!]; // for holding still sideways (avoid.signLateralM)
    }
    const cmd = this._avoider.update(now, this._seen, this._seenFresh, sign);
    this._avoidCmd = cmd;
    if (this._seen.length > 0) {
      // Every box of this frame, for the safe-landing evidence on path_blocked.
      this._obstacleLog.push([obs.ts, this._seen.map((s) => s.box)]);
    }
    while (this._obstacleLog.length > 0 && obs.ts - this._obstacleLog[0]![0] > 3.0) this._obstacleLog.shift();
    return cmd;
  }

  /**
   * A missing marker is hidden, not lost, while avoidance is not clear, or while a current obstacle box
   * overlaps where the sign was last seen.
   */
  private _markerHidden(cmd: AvoidCommand | null): boolean {
    if (cmd === null) return false;
    if (cmd.state !== AVOID_CLEAR) return true;
    const last = this._lastMarkerBox;
    if (last === null || !this._seenFresh) return false;
    for (const seen of this._seen) {
      const [x1, y1, x2, y2] = seen.box;
      if (x1 < last[2] + 0.02 && last[0] - 0.02 < x2 && y1 < last[3] + 0.02 && last[1] - 0.02 < y2) return true;
    }
    return false;
  }

  /**
   * The sign is hidden: no yaw, no forward stick (backward only when avoidance says the obstacle is very
   * close), only the sideways hold, and no marker-lost timer. A real gap: the arrival counts start again.
   */
  private _holdHidden(now: number, cmd: AvoidCommand): void {
    this._lostSince = null;
    this._arriveCount = 0;
    this._sizeCount = 0;
    this._offAxisCount = 0;
    this._coastPitch = 0.0;
    this._assist.pause();
    this._researchPending = true;
    const pitch = cmd.pitch !== null && cmd.pitch < 0.0 ? cmd.pitch : 0.0;
    const [y, p] = this._steering.shape(0.0, pitch, now);
    this._send(y, p, now, pyOr(cmd.roll, 0.0));
  }

  /**
   * The way is clear but the sign is not in view: search again, turning toward the side it was last
   * seen, at most research_max times per run; after that, marker_not_found.
   */
  private _research(now: number): void {
    if (this._researchCount >= this.cfg.research_max) {
      this._abort("marker_not_found", now, { searched_again: this._researchCount });
      return;
    }
    this._researchCount += 1;
    this._researchPending = false;
    this._state = SEARCHING;
    this._searchStarted = now;
    this._searchDirection = this._lastCx >= 0.5 ? 1.0 : -1.0;
    this._candidates.length = 0;
    this._candidateAt = null;
    this._history = [];
    this._lostSince = null;
    this._arriveCount = 0;
    this._sizeCount = 0;
    this._offAxisCount = 0;
    this._atSizeSince = null;
    this._coastPitch = 0.0;
    this._align = null;
    this._assist.pause();
    this._logger.log(
      "info",
      `run ${pyS(this._runId)}: the way is clear but the sign is not in view; searching again ` +
        `(${this._researchCount} of ${this.cfg.research_max})`,
    );
    const [y, p] = this._steering.search(now, this._searchDirection);
    this._send(y, p, now);
  }

  /** Status `vision.obstacles`: what the newest frame showed, with the estimates. */
  obstaclesSnapshot(now?: number | null): ObstacleSnapshot[] {
    const t = now ?? this._clock();
    if (this._seenAt === null || t - this._seenAt > 1.0) return [];
    return this._seen.map((s) => ({
      kind: s.kind,
      box: s.box.map((v) => pyRound(v, 3)),
      distance_m: roundOrNone(s.distance_m),
      lateral_m: roundOrNone(s.lateral_m),
      in_lane: Boolean(s.in_lane),
    }));
  }

  private _stepLocked(obs: Observation | null, now: number): void {
    if (this._state === HOVER_TEST) {
      this._stepHover(obs, now);
      return;
    }
    if (!RUN_STATES.includes(this._state)) return;
    if (obs !== null) {
      this._lastFrameTs = obs.ts;
      if (obs.marker !== null) {
        this._cyLog.push([obs.ts, obs.marker.cy]); // safe-landing evidence
        this._lastApparent = apparentWidth(obs.marker); // its distance scales that evidence
        while (this._cyLog.length > 0 && obs.ts - this._cyLog[0]![0] > 3.0) this._cyLog.shift();
      }
    }

    if (this._state === LANDING) {
      // After a line-up it keeps holding the spot (or at least cancelling the drift) on the way down.
      if (this._align?.done) this._holdPosition(obs === null ? null : obs.marker, obs, now);
      else this._send(0.0, 0.0, now);
      if (now - this._phaseAt >= this.cfg.land_wait_s) this._finishDone(now);
      return;
    }

    const avoiding = this._avoiding();
    if (avoiding) this._shiftTimers(now);
    else this._avoidClock = now;

    // failsafes, checked on every step in every state before the toggle
    if (this._mixer.estopActive) return this._abort("estop", now);
    if (now - this._timeoutFrom > this.cfg.run_timeout_s) return this._abort("timeout", now);
    if (now - this._lastFrameTs > this.cfg.video_stale_s) return this._abort("video_stale", now);
    // With avoidance on, a person in view in the air is avoided instead; on the ground (the countdown) it
    // still stops the run: never take off with a person in view.
    if (this._personInView(now) && (this._avoidRun === "off" || this._state === COUNTDOWN)) {
      return this._abort("person_in_view", now);
    }
    if (this._state === COUNTDOWN && this._objectInLane(now, true)) {
      return this._abort("obstacle_in_view", now); // on the ground: never take off into it
    }
    if (this._batteryLow(now)) return this._abort("battery_low", now);

    if (this._state === COUNTDOWN) {
      // On the ground: nothing is sent until the countdown is over.
      if (obs !== null && obs.marker !== null) this._groundCy.push(obs.marker.cy);
      if (now - this._phaseAt >= this.cfg.countdown_s) this._takeOff(now);
      return;
    }

    if (this._state === TAKING_OFF) {
      // Neutral sticks while the drone climbs to its hover height by itself.
      const [y, p] = this._steering.neutral(now);
      this._send(y, p, now);
      if (obs !== null) {
        this._record(now, obs.marker);
        if (obs.marker !== null) this._climbCy.push([obs.ts, obs.marker.cy]);
      }
      if (now - this._phaseAt >= this.cfg.takeoff_wait_s) {
        this._takeoffSeen = this._takeoffSeenNow();
        const marker = this._currentMarker(now);
        if (marker !== null && apparentWidth(marker) >= this._arriveWidth) {
          // It took off from in front of the sign: the arrival could not be told from the start, and
          // flying on would only take it toward the wall.
          return this._abort("already_at_station", now);
        }
        this._state = SEARCHING;
        this._searchStarted = now;
        this._timeoutFrom = now;
        this._logger.log("info", `run ${pyS(this._runId)}: takeoff wait over, searching`);
      }
      return;
    }

    if (obs === null) {
      if (now - this._lastFrameTs > this.cfg.frame_gap_hold_s) {
        this._assist.pause();
        const [y, p] = this._steering.neutral(now);
        this._send(y, p, now);
      }
      return;
    }

    const marker = obs.marker;
    let cmd: AvoidCommand | null = null;
    if (avoiding) {
      cmd = this._avoidUpdate(obs, now);
      if (cmd.blocked) {
        if (this._automatic && !this._airborneNow(now, "path_blocked")) {
          // No current evidence that it is flying (for example it was turning, so every box slid across
          // the picture): hold still a moment so the obstacle or the sign can show it, then end the run
          // either way. A manual run never lands on an abort: no wait.
          if (this._blockedSince === null) this._blockedSince = now;
          if (now - this._blockedSince < this.cfg.path_blocked_evidence_wait_s) {
            const [y, p] = this._steering.shape(0.0, 0.0, now);
            this._send(y, p, now);
            this._record(now, marker);
            return;
          }
        }
        return this._abort("path_blocked", now, this._pathBlockedDetail(cmd));
      }
    }
    if (this._state === SEARCHING) {
      if (marker === null || !this._markerConfirmed()) {
        if (cmd !== null && NOT_MOVING_ON.includes(cmd.state)) {
          // Something close in the way: stop turning, back off if it is very close.
          const pitch = cmd.pitch !== null && cmd.pitch < 0.0 ? cmd.pitch : 0.0;
          const [y, p] = this._steering.shape(0.0, pitch, now);
          this._send(y, p, now, pyOr(cmd.roll, 0.0));
          this._record(now, marker);
          return;
        }
        // Not seen, or not yet seen on enough consecutive frames at one place: keep searching.
        if (now - this._searchStarted > this.cfg.search_timeout_s) return this._abort("marker_not_found", now);
        const [y, p] = this._steering.search(now, this._searchDirection);
        this._send(y, p, now);
        this._record(now, marker);
        return;
      }
      this._seedApproach();
    }

    if (this._state === APPROACHING) this._stepApproach(marker, obs, now, cmd);
    else if (this._state === ALIGNING) this._stepAligning(marker, obs, now, cmd);
    else if (this._state === ARRIVED) this._stepArrived(marker, obs, now);
    if (RUN_STATES.includes(this._state)) this._record(now, marker);
  }

  private _stepApproach(marker: MarkerObs | null, obs: Observation, now: number, cmd: AvoidCommand | null = null): void {
    const cfg = this.cfg;
    if (marker === null) {
      if (this._markerHidden(cmd)) {
        this._holdHidden(now, cmd!);
        return;
      }
      if (this._lostSince === null) this._lostSince = now;
      const lostFor = now - this._lostSince;
      if (this._researchPending && lostFor > pyMin(cfg.lost_coast_s, cfg.lost_hold_s)) {
        // It was hidden (or the drone went round something) and the way is clear now, but the sign is
        // still not in view: search again instead of the marker-lost rule.
        this._research(now);
        return;
      }
      if (cfg.lost_coast_s > 0 && lostFor <= pyMin(cfg.lost_coast_s, cfg.lost_hold_s)) {
        // A detection dropout, not (yet) a loss: coast on the last forward stick and assist roll, fading
        // to zero over lost_coast_s, with no yaw (where the marker is now is unknown). The arrival counts
        // and the assist's state are kept.
        const fade = 1.0 - lostFor / cfg.lost_coast_s;
        const assistOn = this._assistRun && (this._driftAssist || this._automatic) && this._assist.disabledReason === null;
        const roll = assistOn ? this._assist.roll * fade : 0.0;
        const [yaw, pitch] = this._steering.shape(0.0, this._coastPitch * fade, now);
        this._send(yaw, pitch, now, roll);
        return;
      }
      this._arriveCount = 0;
      this._sizeCount = 0;
      this._offAxisCount = 0;
      this._assist.pause(); // no roll without the marker in view
      if (lostFor <= cfg.lost_hold_s) {
        const [y, p] = this._steering.neutral(now);
        this._send(y, p, now);
      } else if (lostFor <= cfg.lost_hold_s + cfg.lost_creep_s) {
        const direction = this._lastCx >= 0.5 ? 1.0 : -1.0;
        const [y, p] = this._steering.search(now, direction, true);
        this._send(y, p, now);
      } else {
        this._abort("marker_lost", now);
      }
      return;
    }

    if (this._lostSince !== null) {
      if (now - this._lostSince > cfg.lost_coast_s) this._history = []; // a real loss: start again from the reacquired marker
      this._lostSince = null;
    }
    this._researchPending = false;
    if (this._firstWidth === null) this._firstWidth = marker.size;
    this._lastCx = marker.cx;
    this._markerSeenAt = obs.ts;
    const aspect = markerAspect(marker);
    const apparent = apparentWidth(marker);
    this._history.push({ ts: obs.ts, cx: marker.cx, width: apparent });
    while (this._history.length > 0 && obs.ts - this._history[0]!.ts > 2.0) this._history.shift();

    const atSize = apparent >= this._arriveWidth;
    const centred = Math.abs(marker.cx - 0.5) <= cfg.arrive_centre_tol;
    const facing = cfg.arrive_min_aspect <= 0 || aspect >= cfg.arrive_min_aspect;
    this._arriveCount = atSize && centred && facing ? this._arriveCount + 1 : 0;
    this._sizeCount = atSize ? this._sizeCount + 1 : 0;
    const grown = marker.size >= this._firstWidth * cfg.growth_ratio;
    if (grown && !this._flightConfirmed) {
      this._flightConfirmed = true; // only a drone in the air can fly toward the sign
      this._logger.log(
        "info",
        `run ${pyS(this._runId)}: flight confirmed (marker grew ${pyFormatFixed(marker.size / pyMax(1e-9, this._firstWidth), 2)}x)`,
      );
    }
    // Stall timer: at the arrive distance (after growing) but not arriving, for example centred but seen
    // from the side. A little hysteresis so noise at the threshold does not restart it.
    if (atSize && grown) {
      if (this._atSizeSince === null) this._atSizeSince = now;
    } else if (apparent < this._arriveWidth * 0.9) {
      this._atSizeSince = null;
    }
    if (cfg.align_enabled && grown && this._sizeCount >= cfg.arrive_consecutive) {
      this._startAligning(now, apparent);
      return;
    }
    if (!cfg.align_enabled && this._arriveCount >= cfg.arrive_consecutive && grown) {
      this._state = ARRIVED;
      this._phaseAt = now;
      this._arrivedWidth = apparent;
      this._settleRef = [];
      this._settleRefCy = null;
      this._settleChecks = 0;
      this._descentCount = 0;
      this._lastRise = 0.0;
      const [y, p] = this._steering.neutral(now);
      this._send(y, p, now);
      this._logger.log("info", `run ${pyS(this._runId)}: marker at arrive width (${pyFormatFixed(apparent, 3)}), settling`);
      return;
    }

    this._offAxisCount = aspect < cfg.off_axis_aspect ? this._offAxisCount + 1 : 0;
    if (cfg.off_axis_aspect > 0 && this._offAxisCount >= cfg.off_axis_consecutive) {
      this._abort("off_axis", now);
      return;
    }
    if (this._atSizeSince !== null && now - this._atSizeSince > cfg.arrive_stall_s) {
      // Close enough, but not centred in front of the station: do not land there as arrived.
      this._abort("not_lined_up", now, {
        aspect: pyRound(aspect, 3),
        cx: pyRound(marker.cx, 4),
        apparent_width: pyRound(apparent, 4),
      });
      return;
    }
    // At (a little past) the arrive distance: yaw only, so it lines up without creeping on to the wall.
    const hold = grown && apparent >= this._arriveWidth * 1.05;
    const limited = cmd !== null && (cmd.pitch_cap !== null || cmd.pitch !== null);
    let yaw: number;
    let pitch: number;
    if (!limited) {
      [yaw, pitch] = this._steering.update([...this._history], now, this._arriveWidth, hold);
    } else {
      // Something in the way: the same pursuit, with the forward stick capped (slow), or holding: no yaw
      // and no forward stick (a little backward when very close). Steering.update is steer() then
      // shape(); the cap goes in between so the rise limit sees what was really sent.
      let [rawYaw, rawPitch] = steer([...this._history], this._steering.yawLog, now, this._arriveWidth, this._steering.cfg);
      if (cmd!.freeze_yaw) rawYaw = 0.0;
      let target = hold ? 0.0 : rawPitch;
      if (cmd!.pitch_cap !== null) target = pyMin(target, cmd!.pitch_cap);
      if (cmd!.pitch !== null) target = cmd!.pitch;
      [yaw, pitch] = this._steering.shape(rawYaw, target, now);
    }
    let roll: number;
    if (limited && cmd!.roll !== null) {
      this._assist.pause(); // holding: avoidance holds the drone sideways
      roll = cmd!.roll;
    } else {
      roll = this._assistRoll(marker, obs.ts, aspect, pitch, now);
    }
    this._send(yaw, pitch, now, roll);
    // What a dropout right after this step may coast on: never forward blind near the wall, nor while
    // something is in the way.
    this._coastPitch = hold || limited || apparent >= 0.9 * this._arriveWidth ? 0.0 : pitch;
  }

  /**
   * Drift-assist roll for this approach step: 0 unless the switch was on at the start of the run, is
   * still on, and the assist has not switched itself off.
   */
  private _assistRoll(marker: MarkerObs, ts: number, aspect: number, pitch: number, now: number): number {
    if (!(this._assistRun && (this._driftAssist || this._automatic))) return 0.0;
    const wasDisabled = this._assist.disabledReason !== null;
    const previousTs = this._assistTs;
    this._assistTs = ts;
    const yawSeen = previousTs === null ? 0.0 : this._steering.yawSeenBetween(previousTs, ts);
    const roll = this._assist.update(ts, marker.cx, marker.size, aspect, markerSkew(marker.corners), yawSeen, pitch > 0.0);
    if (this._assist.disabledReason !== null && !wasDisabled) {
      this._assistDisabledAt = now - this._startedAt;
      this._logger.log(
        "warning",
        `run ${pyS(this._runId)}: drift assist switched itself off (${pyS(this._assist.disabledReason)}, by the ` +
          `${pyS(this._assist.disabledBy)} measure); the run continues without roll`,
      );
    }
    return roll;
  }

  // ------------------------------------------------------------------------------------------ //
  // final line-up

  private _startAligning(now: number, apparent: number): void {
    this._state = ALIGNING;
    this._phaseAt = now;
    this._arrivedWidth = apparent;
    this._assist.pause();
    this._align = {
      target_m: pyOr(this._distanceM(this._arriveWidth), this._settings.land_distance_m),
      x: null,
      z: null,
      vx: 0.0,
      vz: 0.0,
      ts: null,
      integral: 0.0,
      roll: 0.0,
      pitch: 0.0,
      aligned_since: null,
      window: [],
      lost_since: null,
      // If the approach's drift assist switched itself off (roll seemed to make things worse), the
      // line-up does not use roll either.
      roll_ok: !(this._assistRun && this._assist.disabledReason !== null),
      done: false,
      aligned: false,
      cmd_ts: null,
    };
    this._logger.log("info", `run ${pyS(this._runId)}: at the landing distance, lining up on the sign's centre line`);
  }

  /** Update the smoothed position (metres) from this detection. False when the fit failed. */
  private _measure(marker: MarkerObs, ts: number): boolean {
    const pose = this._fitPose(marker.corners, marker.frame_w, marker.frame_h, this._settings.marker_size_m, this._settings.camera_hfov_deg);
    if (pose === null || pose.rms_px > 3.0 || !(0.1 < pose.distance_m && pose.distance_m < 5.0)) return false;
    const a = this._align!;
    if (a.ts === null) {
      a.x = pose.lateral_m;
      a.z = pose.distance_m;
      a.ts = ts;
      return true;
    }
    const dt = ts - a.ts;
    if (dt <= 0) return true;
    const blend = 1.0 - Math.exp(-dt / pyMax(1e-3, this.cfg.align_tau_s));
    const x = a.x! + (pose.lateral_m - a.x!) * blend;
    const z = a.z! + (pose.distance_m - a.z!) * blend;
    a.vx += ((x - a.x!) / dt - a.vx) * blend;
    a.vz += ((z - a.z!) / dt - a.vz) * blend;
    a.x = x;
    a.z = z;
    a.ts = ts;
    return true;
  }

  private _stepAligning(marker: MarkerObs | null, obs: Observation, now: number, cmd: AvoidCommand | null = null): void {
    const cfg = this.cfg;
    const a = this._align!;
    if (marker === null && this._markerHidden(cmd)) {
      // Hidden, not lost: hold (no yaw, never forward, only the drift-cancelling roll), no timer.
      a.lost_since = null;
      a.aligned_since = null;
      a.window.length = 0;
      const holdRoll = a.roll_ok ? pyMax(-0.1, pyMin(0.1, a.integral)) : 0.0;
      const pitch = cmd!.pitch !== null && cmd!.pitch < 0.0 ? cmd!.pitch : pyMin(0.0, a.pitch);
      this._researchPending = true;
      const [y, p] = this._steering.shape(0.0, pitch, now);
      this._send(y, p, now, holdRoll);
      return;
    }
    if (marker === null || !this._measure(marker, obs.ts)) {
      if (a.lost_since === null) a.lost_since = now;
      if (cfg.lost_coast_s > 0 && now - a.lost_since <= cfg.lost_coast_s) {
        // A detection dropout: keep the timer, no yaw, keep only a backward pitch (never forward blind at
        // the wall) and only the drift-cancelling part of the roll (clamped integral).
        const holdRoll = a.roll_ok ? pyMax(-0.1, pyMin(0.1, a.integral)) : 0.0;
        const [y, p] = this._steering.shape(0.0, pyMin(0.0, a.pitch), now);
        this._send(y, p, now, holdRoll);
        return;
      }
      if (this._researchPending && marker === null) {
        this._research(now);
        return;
      }
      a.aligned_since = null;
      a.window.length = 0;
      const [y, p] = this._steering.neutral(now);
      this._send(y, p, now, marker !== null ? a.roll : 0.0);
      if (now - a.lost_since > cfg.align_lost_s) this._abort("marker_lost", now);
      return;
    }
    a.lost_since = null;
    this._researchPending = false;
    this._markerSeenAt = obs.ts;
    this._history.push({ ts: obs.ts, cx: marker.cx, width: apparentWidth(marker) });
    while (this._history.length > 0 && obs.ts - this._history[0]!.ts > 2.0) this._history.shift();
    let [roll, pitch] = this._positionCommands(obs.ts, now);
    const x = a.x!;
    const z = a.z!;
    const vx = a.vx;
    const vz = a.vz;
    const errZ = z - a.target_m;
    const [yaw] = this._steering.update([...this._history], now, this._arriveWidth, true);
    if (cmd !== null && cmd.pitch_cap !== null) pitch = pyMin(pitch, cmd.pitch_cap); // something in the way: never closer
    if (cmd !== null && cmd.pitch !== null && cmd.pitch < 0.0) pitch = cmd.pitch; // very close: back off
    this._send(yaw, pitch, now, roll);

    const tooClose = z < pyMax(cfg.align_too_close_floor_m, cfg.align_too_close_frac * a.target_m);
    if (Math.abs(x) > cfg.align_give_up_m || tooClose) {
      return this._abort("not_lined_up", now, { lateral_offset_m: pyRound(x, 3), distance_m: pyRound(z, 3) });
    }
    const aligned =
      Math.abs(x) <= cfg.align_tolerance_m &&
      Math.abs(errZ) <= cfg.align_distance_tol_m &&
      Math.abs(marker.cx - 0.5) <= cfg.align_centre_tol &&
      Math.abs(vx) <= cfg.align_still_m_s &&
      Math.abs(vz) <= cfg.align_still_m_s;
    if (aligned) {
      if (a.aligned_since === null) a.aligned_since = now;
      a.window.push([obs.ts, marker.cy]);
    } else {
      a.aligned_since = null;
      a.window.length = 0;
    }
    if (a.aligned_since !== null && now - a.aligned_since >= cfg.align_hold_s) return this._finishAligning(now, true);
    if (now - this._phaseAt >= cfg.align_timeout_s) {
      if (Math.abs(x) <= cfg.align_loose_m) return this._finishAligning(now, false);
      this._abort("not_lined_up", now, { lateral_offset_m: pyRound(x, 3), distance_m: pyRound(z, 3) });
    }
  }

  /**
   * [roll, pitch] that hold the drone on the sign's centre line at the landing distance, from the
   * smoothed position: PID for roll (the integral cancels a steady drift), PD for pitch. +x is right of
   * the centre line and +roll slides right, so roll pushes against x.
   */
  private _positionCommands(ts: number, now: number): [roll: number, pitch: number] {
    void now; // in Python's signature, unused there too
    const cfg = this.cfg;
    const a = this._align!;
    const dt = a.cmd_ts === null ? 0.0 : pyMax(0.0, pyMin(0.3, ts - a.cmd_ts));
    a.cmd_ts = ts;
    // The picture is about one video delay old: steer on where the drone is now, not where it was.
    const lead = this._steering.cfg.latency_s;
    const x = a.x! + a.vx * lead;
    const vx = a.vx;
    const z = a.z! + a.vz * lead;
    let roll: number;
    if (a.roll_ok) {
      a.integral = pyMax(-cfg.align_roll_i_max, pyMin(cfg.align_roll_i_max, a.integral - cfg.align_roll_ki * x * dt));
      roll = -cfg.align_roll_kp * x - cfg.align_roll_kd * vx + a.integral;
      roll = pyMax(-cfg.align_roll_max, pyMin(cfg.align_roll_max, roll));
    } else {
      roll = 0.0;
    }
    a.roll = roll;
    let pitch = cfg.align_pitch_kp * (z - a.target_m) - cfg.align_pitch_kd * a.vz;
    pitch = pyMax(-cfg.align_pitch_max, pyMin(cfg.align_pitch_max, pitch));
    a.pitch = pitch;
    return [roll, pitch];
  }

  /**
   * After lining up (settle and landing): keep holding the spot sideways while the sign is still in view,
   * else keep the drift-cancelling roll. Yaw and pitch stay neutral.
   */
  private _holdPosition(marker: MarkerObs | null, obs: Observation | null, now: number): void {
    if (this._align?.done && marker !== null && obs !== null && this._measure(marker, obs.ts)) {
      const [roll] = this._positionCommands(obs.ts, now);
      if (this._align.roll_ok) this._holdRoll = pyMax(-0.1, pyMin(0.1, this._align.integral));
      // Roll only: pitch tilts the camera, which the descent guard would read as sinking.
      this._send(0.0, 0.0, now, roll);
      return;
    }
    this._send(0.0, 0.0, now, this._holdRoll);
  }

  private _finishAligning(now: number, aligned: boolean): void {
    const a = this._align!;
    a.done = true;
    a.aligned = aligned;
    // Keep the roll that was holding it still (the drift-cancelling part) through settle and landing.
    this._holdRoll = a.roll_ok ? pyMax(-0.1, pyMin(0.1, a.integral)) : 0.0;
    this._state = ARRIVED;
    this._phaseAt = now;
    this._settleRef = [];
    const window = a.window.map(([, cy]) => cy);
    // The descent guard compares against where the sign sat while it was holding still.
    this._settleRefCy = window.length >= 3 ? pyMedian(window) : null;
    this._settleChecks = 0;
    this._descentCount = 0;
    this._lastRise = 0.0;
    const [y, p] = this._steering.neutral(now);
    this._send(y, p, now, this._holdRoll);
    this._logger.log(
      "info",
      `run ${pyS(this._runId)}: lined up (${aligned ? "within tolerance" : "not exactly"}): ` +
        `${pyFormatFixed(a.x!, 3)} m off the centre line, ${pyFormatFixed(a.z!, 2)} m from the wall`,
    );
  }

  private _stepArrived(marker: MarkerObs | null, obs: Observation, now: number): void {
    const cfg = this.cfg;
    if (this._align?.done) {
      this._steering.neutral(now);
      this._holdPosition(marker, obs, now);
    } else {
      const [y, p] = this._steering.neutral(now);
      this._send(y, p, now);
    }
    // The guard protects the landing toggle only: with land on arrival off it neither holds nor aborts.
    const guard = cfg.settle_descent_frac > 0 && this._landsOnArrival();
    const scale = this._settleScale();
    const descentFrac = cfg.settle_descent_frac * scale;
    const pendingFrac = cfg.settle_pending_frac * scale;
    if (marker !== null) {
      this._markerSeenAt = obs.ts;
      if (guard && now - this._phaseAt >= cfg.settle_reference_after_s) {
        if (this._settleRefCy === null) {
          this._settleRef.push(marker.cy);
          if (this._settleRef.length >= cfg.settle_reference_count) this._settleRefCy = pyMedian(this._settleRef);
        } else {
          // Image y grows downward: a sinking camera sees the marker move UP (cy smaller).
          const rise = this._settleRefCy - marker.cy;
          this._lastRise = rise;
          this._settleChecks += 1;
          this._descentCount = rise > descentFrac ? this._descentCount + 1 : 0;
          if (this._descentCount >= cfg.settle_descent_consecutive) {
            // The camera is sinking: the drone is landing by itself. A toggle now could launch it again.
            this._logger.log(
              "warning",
              `run ${pyS(this._runId)}: marker ${pyFormatFixed(rise, 3)} of the frame height above its settle reference ` +
                `on ${this._descentCount} detections in a row; not landing`,
            );
            this._abort("unexpected_descent", now, {
              settle_descent: true,
              settle_reference_cy: pyRound(this._settleRefCy, 4),
              settle_rise: pyRound(rise, 4),
            });
            return;
          }
        }
      }
    }
    const settleS = cfg.settle_s;
    if (now - this._phaseAt < settleS) return;
    if (now - this._markerSeenAt > cfg.arrive_marker_fresh_s) {
      // The marker vanished while settling (the drone may have dropped). Do not toggle.
      this._abort("marker_lost", now);
      return;
    }
    let skipped: string | null = null;
    if (
      guard &&
      (this._settleRefCy === null ||
        this._settleChecks < cfg.settle_descent_consecutive ||
        this._descentCount > 0 ||
        this._lastRise > pendingFrac)
    ) {
      if (now - this._phaseAt < settleS + cfg.settle_guard_wait_s) return; // the descent guard has not finished looking
      // Still undecided: do not toggle on a doubt. The drone did arrive; the pilot lands by hand.
      this._logger.log(
        "warning",
        `run ${pyS(this._runId)}: settle descent guard still undecided ${pyFormatFixed(now - this._phaseAt, 1)} s after arrival; ` +
          "not landing, the pilot lands",
      );
      skipped = "settle_guard_undecided";
      this._lastLanding = "skipped_settle_guard_undecided";
    } else if (!this._landsOnArrival()) {
      this._lastLanding = "off";
    } else {
      // The toggle goes first, so the arrival event says whether it actually went out.
      this._toggleSent = this._mixer.missionToggle(now); // the only toggle a run ever sends
      if (this._toggleSent) {
        this._lastLanding = "sent";
      } else {
        this._logger.log("warning", `run ${pyS(this._runId)}: landing toggle refused by the mixer; the pilot lands`);
        skipped = "refused_by_mixer";
        this._lastLanding = "refused_by_mixer";
      }
    }
    this._suggestedTrimRoll = this._suggestTrimRoll();
    let linedUp: { lateral_offset_m?: number; distance_m?: number; aligned?: boolean } = {};
    if (this._align?.done) {
      linedUp = { lateral_offset_m: pyRound(this._align.x!, 3), distance_m: pyRound(this._align.z!, 3), aligned: Boolean(this._align.aligned) };
    }
    this._lastArrival = {
      lateral_offset_m: linedUp.lateral_offset_m ?? null,
      distance_m: linedUp.distance_m ?? null,
      aligned: linedUp.aligned ?? false,
    };
    this._queueEvent("arrived_at_station", {
      marker_width: pyRound(this._arrivedWidth, 4),
      ...linedUp,
      elapsed_s: pyRound(now - this._startedAt, 2),
      landing: this._toggleSent,
      ...(skipped !== null ? { landing_skipped: skipped } : {}),
      mode: this._link.mode,
      ...this._assistDetail(true),
      ...this._avoidDetail(),
    });
    this._logger.log("info", `run ${pyS(this._runId)}: arrived at station`);
    if (!this._toggleSent) {
      this._finishDone(now);
      return;
    }
    this._state = LANDING;
    this._phaseAt = now;
  }

  // ------------------------------------------------------------------------------------------ //
  // endings

  /** Hand the command to the mixer. Roll is zero unless the drift assist (or a hold) supplied one. */
  private _send(yaw: number, pitch: number, now: number, roll = 0.0): void {
    this._command = [yaw, pitch];
    this._roll = roll;
    this._mixer.missionCommand(yaw, pitch, now, roll);
  }

  /** Current roll trim plus the mean assist roll near the end of the approach, rounded to 0.01. */
  private _suggestTrimRoll(): number | null {
    if (!this._assistRun) return null;
    const mean = this._assist.meanRollNearEnd();
    if (mean === null) return null;
    return pyRound(this._mixer.trim()[0] + mean, 2);
  }

  /** Drift-assist keys for the run's closing event; empty when the run did not use the assist. */
  private _assistDetail(arrived = false): Record<string, unknown> {
    if (!this._assistRun) return {};
    const detail: Record<string, unknown> = {};
    if (arrived) detail["suggested_trim_roll"] = this._suggestedTrimRoll;
    if (this._assist.disabledReason !== null) {
      detail["drift_assist_disabled"] = true;
      detail["drift_assist_disabled_reason"] = this._assist.disabledReason;
    }
    return detail;
  }

  /** Obstacle-avoidance keys for the run's closing event; empty when the run had it off. */
  private _avoidDetail(): Record<string, unknown> {
    if (this._avoidRun === "off") return {};
    return { avoid: { mode: this._avoidRun, holds: this._avoider.holds, held_s: pyRound(this._avoider.noProgressS, 1) } };
  }

  private _pathBlockedDetail(cmd: AvoidCommand): Record<string, unknown> {
    const target = this._avoider.target;
    return {
      blocked_by: cmd.reason, // "timeout" (held blocked_timeout_s in total)
      obstacle_kind: target === null ? null : target.kind,
      obstacle_distance_m: target === null || target.distance_m === null ? null : pyRound(target.distance_m, 2),
      flight_confirmed: this._flightConfirmed, // the sign grew since first seen
      takeoff_climb_seen: this._takeoffSeen, // automatic run: the climb seen at takeoff
    };
  }

  /**
   * `extra` goes into the run_aborted event detail and the run trace (e.g. settle_descent). Automatic runs
   * may land where they are (see SAFE_LANDING_REASONS and _airborneNow).
   */
  private _abort(reason: string, now: number, extra: Record<string, unknown> | null = null): void {
    const flew = this._state !== COUNTDOWN; // an automatic run sends its takeoff toggle at countdown's end
    this._state = ABORTED;
    this._reason = reason;
    this._endedAt = now;
    this._command = [0.0, 0.0];
    this._roll = 0.0;
    this._steering.reset();
    this._assist.pause();
    let safeLanding = false;
    const tookOff = this._automatic && flew;
    if (tookOff && SAFE_LANDING_REASONS.has(reason) && this._airborneNow(now, reason)) {
      // Nobody may be there to land it: land where it is. The mixer still refuses this toggle after any
      // pilot input since the runner's last mission command (see missionToggle).
      safeLanding = this._mixer.missionToggle(now, true);
      if (safeLanding) {
        this._lastLanding = "safe_landing";
        this._logger.log("warning", `run ${pyS(this._runId)}: stopped early (${reason}); landing where it is`);
      }
    }
    this._mixer.clearMissionCommand(); // neutral (plus trim)
    // The drone may be in the air with nobody flying it: say so loudly until someone acts.
    this._needsPilot = tookOff && !safeLanding && reason !== "estop" && reason !== "pilot_took_over";
    this._queueEvent("run_aborted", {
      reason,
      elapsed_s: pyRound(now - this._startedAt, 2),
      mode: this._link.mode,
      ...(this._automatic ? { automatic: true, safe_landing: safeLanding } : {}),
      ...this._assistDetail(),
      ...this._avoidDetail(),
      ...(extra ?? {}),
    });
    this._queueTrace("aborted", reason, now, extra);
    this._logger.log("warning", `run ${pyS(this._runId)} aborted: ${reason}`);
  }

  /**
   * Current evidence that the drone is in the air, needed before a safe-landing toggle (a toggle to a
   * drone that already landed by itself would launch it): the flight was confirmed (the marker grew:
   * only a flying drone moves toward the sign), the marker is in view right now, and it is not rising in
   * the picture (a sinking camera sees it move up) compared with the detections between 2.0 and 0.5 s
   * ago. For path_blocked, where the obstacle often hides the sign, the obstacle in front may give the
   * same evidence instead (_obstacleEvidence).
   */
  private _airborneNow(now: number, reason: string | null = null): boolean {
    if (this._markerEvidence(now)) return true;
    return reason === "path_blocked" && this._obstacleEvidence(now);
  }

  /**
   * path_blocked only: the flight was confirmed (or, for an automatic run, the climb was seen during the
   * takeoff: _takeoffSeenNow), obstacle boxes were seen in the last safe_land_marker_fresh_s, and for
   * every one of them wholly inside the picture sideways: its base is either below the bottom of the
   * picture or at a floor distance a camera at hover height could see (a camera sitting on the floor
   * sees a base just under the horizon, which reads as very far), and none of its edges inside the
   * picture has risen by more than settle_descent_frac of the frame height against the median over 2.0
   * to 0.5 s before (the box nearest it in each earlier frame, within 0.1 of the frame width; a sinking
   * camera sees everything move up). At least one edge must have been checked. Unproven on a real drone.
   */
  private _obstacleEvidence(now: number): boolean {
    if (!(this._flightConfirmed || this._takeoffSeen) || this._obstacleLog.length === 0) return false;
    const [latestTs, boxes] = this._obstacleLog[this._obstacleLog.length - 1]!;
    if (now - latestTs > this.cfg.safe_land_marker_fresh_s) return false;
    const margin = this._avoidCfg.edge_margin;
    const earlier = this._obstacleLog.filter(([ts]) => 0.5 <= latestTs - ts && latestTs - ts <= 2.0).map(([, frame]) => frame);
    let checked = 0;
    for (const [x1, y1, x2, y2] of boxes) {
      if (x1 <= margin || x2 >= 1.0 - margin) continue; // leaving the picture at the side: its centre is not its own
      if (y2 < 1.0 - margin) {
        const base = floorDistanceM(y2, this._avoidCfg);
        if (base === null || base > this.cfg.obstacle_evidence_max_m) return false;
      }
      const cx = 0.5 * (x1 + x2);
      const reference: Box[] = [];
      for (const frame of earlier) {
        // Python: min(frame, key=lambda b: abs(0.5 * (b[0] + b[2]) - cx)), the first of the nearest
        let match = frame[0]!;
        let best = Math.abs(0.5 * (match[0] + match[2]) - cx);
        for (let i = 1; i < frame.length; i++) {
          const k = Math.abs(0.5 * (frame[i]![0] + frame[i]![2]) - cx);
          if (k < best) {
            best = k;
            match = frame[i]!;
          }
        }
        if (Math.abs(0.5 * (match[0] + match[2]) - cx) <= 0.1) reference.push(match);
      }
      if (reference.length < 3) continue;
      for (const [index, latest] of [
        [1, y1],
        [3, y2],
      ] as const) {
        if (!(margin < latest && latest < 1.0 - margin)) continue;
        const values = reference.map((r) => r[index]).filter((v) => margin < v && v < 1.0 - margin);
        if (values.length < 3) continue;
        if (pyMedian(values) - latest > this.cfg.settle_descent_frac) return false;
        checked += 1;
      }
    }
    return checked > 0;
  }

  /**
   * End of an automatic run's takeoff wait: the sign moved down the picture by at least takeoff_cy_rise
   * between the countdown on the ground (median of its last 10 detections) and the last second of the
   * takeoff wait (median), on at least 3 detections each: the camera climbed.
   */
  private _takeoffSeenNow(): boolean {
    const ground = this._groundCy.slice(-10);
    if (ground.length < 3 || this._climbCy.length === 0) return false;
    const latest = this._climbCy[this._climbCy.length - 1]![0];
    const air = this._climbCy.filter(([ts]) => latest - ts <= 1.0).map(([, cy]) => cy);
    if (air.length < 3) return false;
    return pyMedian(air) - pyMedian(ground) >= this.cfg.takeoff_cy_rise;
  }

  private _markerEvidence(now: number): boolean {
    if (!this._flightConfirmed || this._cyLog.length === 0) return false;
    const [latestTs, latestCy] = this._cyLog[this._cyLog.length - 1]!;
    if (now - latestTs > this.cfg.safe_land_marker_fresh_s) return false;
    const reference = this._cyLog.filter(([ts]) => 0.5 <= latestTs - ts && latestTs - ts <= 2.0).map(([, cy]) => cy);
    if (reference.length < 3) return false;
    const rise = pyMedian(reference) - latestCy;
    // Scaled by the current distance (not the landing distance): far from the sign the same sink moves
    // the sign much less in the picture.
    const distance = this._lastApparent === null ? null : this._distanceM(this._lastApparent);
    const scale = pyTruthy(distance) ? pyMax(1.0, pyMin(2.0, this.cfg.settle_ref_distance_m / distance!)) : 1.0;
    return rise <= this.cfg.settle_descent_frac * scale;
  }

  /**
   * Factor on the settle guard's rise thresholds (the drone is at the landing distance then): a closer
   * landing distance sees a bigger rise in the picture for the same sink (rise ~ sink / distance).
   */
  private _settleScale(): number {
    const distance = this._distanceM(this._arriveWidth);
    if (!pyTruthy(distance)) return 1.0;
    return pyMax(1.0, pyMin(2.0, this.cfg.settle_ref_distance_m / distance!));
  }

  private _finishDone(now: number): void {
    this._state = DONE;
    this._reason = null;
    this._endedAt = now;
    this._command = [0.0, 0.0];
    this._roll = 0.0;
    this._steering.reset();
    this._assist.pause();
    this._mixer.clearMissionCommand();
    this._queueTrace("done", null, now);
    this._logger.log("info", `run ${pyS(this._runId)} done`);
  }

  private _queueEvent(eventType: string, detail: Record<string, unknown>): void {
    const runId = this._runId;
    const doseId = this._doseId;
    const ts = this._wallClock();
    this._pendingIo.push(() => this._store.addEvent(eventType, { doseId, runId, detail, ts }));
  }

  private _record(now: number, marker: MarkerObs | null): void {
    const telemetry = this._link.telemetry();
    this._trace.push({
      t: pyRound(now - this._startedAt, 3),
      state: this._state,
      cx: marker === null ? null : pyRound(marker.cx, 4),
      cy: marker === null ? null : pyRound(marker.cy, 4),
      width: marker === null ? null : pyRound(marker.width, 4),
      size: marker === null ? null : pyRound(marker.size, 4),
      apparent_width: marker === null ? null : pyRound(apparentWidth(marker), 4),
      yaw: pyRound(this._command[0], 4),
      pitch: pyRound(this._command[1], 4),
      roll: pyRound(this._roll, 4),
      lateral_m: this._state === ALIGNING ? roundOrNone(this._align?.x, 4) : null,
      distance_m: this._state === ALIGNING ? roundOrNone(this._align?.z, 4) : null,
      // marker-widths per second, + = sliding left
      slide_rate: !this._assist.active || this._assist.slideRate === null ? null : pyRound(this._assist.slideRate, 4),
      fly_state_raw: telemetry === null ? null : telemetry.fly_state_raw,
      battery_raw: telemetry === null ? null : telemetry.battery_raw,
      flags_raw: telemetry === null ? null : telemetry.flags_raw,
      ...(this._avoidRun !== "off" ? { avoid_state: this._avoider.state, obstacles: this._seen.length } : {}),
    });
  }

  private _queueTrace(result: string, reason: string | null, now: number, extra: Record<string, unknown> | null = null): void {
    const runId = this._runId;
    const trace: Record<string, unknown> = {
      run_id: runId,
      dose_id: this._doseId,
      mode: this._link.mode,
      started_ts: this._startedWall,
      ended_ts: this._wallClock(),
      duration_s: pyRound(now - this._startedAt, 3),
      result,
      reason,
      arrive_width: this._arriveWidth,
      land_on_arrival: this._landsOnArrival(),
      automatic: this._automatic,
      toggle_sent: this._toggleSent,
      first_marker_width: this._firstWidth,
      drift_assist: {
        enabled: this._assistRun,
        drift_assist_disabled: this._assist.disabledReason !== null,
        disabled_reason: this._assist.disabledReason,
        disabled_by: this._assist.disabledBy, // "slide" or "aspect": which measure tripped
        disabled_at_s: this._assistDisabledAt === null ? null : pyRound(this._assistDisabledAt, 3),
        suggested_trim_roll: this._suggestedTrimRoll,
      },
      samples: this._trace,
      ...(this._avoidRun !== "off"
        ? {
            avoid: {
              mode: this._avoidRun,
              holds: this._avoider.holds,
              held_s: pyRound(this._avoider.noProgressS, 2),
              blocked_reason: this._avoider.blockedReason,
              searched_again: this._researchCount,
              events: this._avoider.events.map((e) => ({ ...e, t: pyRound(e.t - this._startedAt, 3) })),
            },
          }
        : {}),
      ...(extra ?? {}),
    };
    this._trace = [];
    if (runId !== null) this._pendingIo.push(() => this._store.writeRunTrace(runId, trace));
  }

  /** Do the queued writes (events, traces), in order. A failing write is logged and dropped. */
  flush(): void {
    const jobs = this._pendingIo;
    this._pendingIo = [];
    for (const job of jobs) {
      try {
        job();
      } catch {
        this._logger.log("error", "could not write mission data");
      }
    }
  }

  // ------------------------------------------------------------------------------------------ //
  // hover test

  private _stepHover(obs: Observation | null, now: number): void {
    const hover = this._hover;
    if (hover === null) {
      this._state = IDLE;
      return;
    }
    if (this._mixer.estopActive) {
      this._cancelHover("estop", now);
      return;
    }
    hover.elapsed_s = now - hover.started_at;
    if (obs !== null) {
      const marker = obs.marker;
      this._hoverSamples.push([obs.ts, marker === null ? null : marker.cx, marker === null ? null : marker.size]);
    }
    if (hover.elapsed_s < this.cfg.hover_test_s) return;
    const result = this._hoverResult();
    hover.running = false;
    hover.elapsed_s = this.cfg.hover_test_s;
    hover.result = result;
    this._state = IDLE;
    this._endedAt = now;
    const ts = this._wallClock();
    this._pendingIo.push(() => this._store.addEvent("hover_test", { detail: { ...result }, ts }));
    this._logger.log("info", `hover test finished: ${pyDictRepr({ ...result })}`);
  }

  private _cancelHover(reason: string, now: number): void {
    if (this._hover !== null) {
      this._hover.running = false;
      this._hover.elapsed_s = now - this._hover.started_at;
      this._hover.result = null;
    }
    this._state = IDLE;
    this._endedAt = now;
    const ts = this._wallClock();
    this._pendingIo.push(() => this._store.addEvent("hover_test", { detail: { cancelled: reason }, ts }));
    this._logger.log("info", `hover test cancelled: ${reason}`);
  }

  /**
   * Drift of the drone estimated from how the marker moved in the frame.
   *
   * Sign: positive means the drone appears to have drifted to its right (the marker moved left). A yaw
   * rotation looks the same as a sideways drift, so the metres figure is only an estimate.
   *
   * Pass/fail is judged on the PEAK sideways excursion (SPEC 10.2): the spread of the marker centre over
   * the whole test (max minus min of cx), in metres at the sign's distance using the median marker width
   * as the scale, so a drone that slides out and comes back fails too.
   */
  private _hoverResult(): HoverResult {
    const total = this._hoverSamples.length;
    const seen = this._hoverSamples
      .filter(([, cx, width]) => cx !== null && pyTruthy(width))
      .map(([, cx, width]) => [cx!, width!] as const);
    const visiblePct = total ? (100.0 * seen.length) / total : 0.0;
    const limitM = this._settings.hover_max_excursion_m;
    let driftFw = 0.0;
    let driftM = 0.0;
    let widthChange = 0.0;
    let peakM = 0.0;
    if (seen.length >= 2) {
      const edge = pyMax(1, pyMin(5, Math.floor(seen.length / 2)));
      const head = seen.slice(0, edge);
      const tail = seen.slice(-edge);
      const cxStart = pyMedian(head.map(([cx]) => cx));
      const cxEnd = pyMedian(tail.map(([cx]) => cx));
      const wStart = pyMedian(head.map(([, w]) => w));
      const wEnd = pyMedian(tail.map(([, w]) => w));
      const wMid = pyMedian(seen.map(([, w]) => w));
      driftFw = -(cxEnd - cxStart);
      driftM = (driftFw * this._settings.marker_size_m) / wMid;
      widthChange = 100.0 * (wEnd / wStart - 1.0);
      const cxs = seen.map(([cx]) => cx);
      peakM = ((pyMax(cxs[0]!, ...cxs.slice(1)) - pyMin(cxs[0]!, ...cxs.slice(1))) * this._settings.marker_size_m) / wMid;
    }
    const passed = seen.length >= 2 && peakM <= limitM && visiblePct >= this.cfg.hover_visible_pct;
    return {
      pass: Boolean(passed),
      drift_frame_widths: pyRound(driftFw, 4),
      drift_m_estimate: pyRound(driftM, 3),
      width_change_pct: pyRound(widthChange, 1),
      visible_pct: pyRound(visiblePct, 1),
      peak_excursion_m: pyRound(peakM, 3),
      limit_m: pyRound(limitM, 3),
    };
  }

  // ------------------------------------------------------------------------------------------ //
  // snapshots

  snapshot(now?: number | null): RunnerSnapshot {
    const t = now ?? this._clock();
    const blockers = this._blockersLocked(t);
    const autoBlockers = this._blockersLocked(t, true);
    const marker = this._currentMarker(t);
    let elapsed: number;
    if (RUN_STATES.includes(this._state) || this._state === HOVER_TEST) elapsed = t - this._startedAt;
    else if (this._endedAt !== null && (this._state === DONE || this._state === ABORTED)) elapsed = this._endedAt - this._startedAt;
    else elapsed = 0.0;
    return {
      state: this._state,
      reason: this._reason,
      run_id: this._runId,
      dose_id: this._doseId,
      elapsed_s: pyRound(pyMax(0.0, elapsed), 2),
      command: { yaw: pyRound(this._command[0], 4), pitch: pyRound(this._command[1], 4) },
      arrive_width: pyRound(this._arriveWidth, 4),
      land_on_arrival: this._landOnArrival,
      last_landing: this._lastLanding,
      drift_assist: {
        enabled: this._driftAssist,
        active: this._state === APPROACHING && this._assistRun && (this._driftAssist || this._automatic) && this._assist.active,
        roll: pyRound(this._roll, 4),
        disabled_reason: this._assistRun ? this._assist.disabledReason : null,
        suggested_trim_roll: this._suggestedTrimRoll,
      },
      can_start: blockers.length === 0,
      blockers,
      automatic: this._automatic,
      auto_fly: this._autoFly,
      auto_blockers: autoBlockers,
      can_start_auto: autoBlockers.length === 0,
      countdown_remaining_s: this._state === COUNTDOWN ? pyRound(pyMax(0.0, this.cfg.countdown_s - (t - this._phaseAt)), 1) : null,
      distance_m: marker === null ? null : roundOrNone(this._distanceM(apparentWidth(marker))),
      arrive_distance_m: roundOrNone(this._distanceM(this._arriveWidth)),
      flight_confirmed: this._flightConfirmed,
      needs_pilot: this._needsPilot,
      ready_for_dose: this._readyForDose,
      alignment: this._alignmentSnapshot(t),
      last_arrival: this._lastArrival === null ? null : { ...this._lastArrival },
      avoid: this._avoidSnapshot(),
    };
  }

  /**
   * Status `mission.avoid`: the setting, and what the current (or last) run's avoidance is doing. state,
   * kind and distance_m are null before any run that had it on.
   */
  private _avoidSnapshot(): AvoidSnapshot {
    if (this._avoidRun === "off" || this._runId === null) {
      return { mode: this._avoidMode, state: null, kind: null, distance_m: null, held_s: 0.0 };
    }
    return { mode: this._avoidMode, ...this._avoider.snapshot() };
  }

  private _alignmentSnapshot(now: number): AlignmentSnapshot | null {
    if (this._state !== ALIGNING || this._align === null) return null;
    const a = this._align;
    return {
      lateral_m: roundOrNone(a.x, 3),
      distance_m: roundOrNone(a.z, 3),
      target_distance_m: pyRound(a.target_m, 3),
      tolerance_m: this.cfg.align_tolerance_m,
      aligned_for_s: a.aligned_since === null ? 0.0 : pyRound(now - a.aligned_since, 2),
      need_s: this.cfg.align_hold_s,
    };
  }

  /**
   * Estimated metres from the sign for a marker of this apparent width (fraction of the frame width).
   * Uses the configured camera field of view: right for the simulator, an estimate for the real drone,
   * whose lens is unmeasured.
   */
  private _distanceM(apparent: number): number | null {
    if (apparent <= 0) return null;
    const half = radians(this._settings.camera_hfov_deg) / 2.0;
    return this._settings.marker_size_m / (2.0 * Math.tan(half) * apparent);
  }

  hoverSnapshot(now?: number | null): HoverSnapshot | null {
    const t = now ?? this._clock();
    if (this._hover === null) return null;
    const elapsed = this._hover.running ? t - this._hover.started_at : this._hover.elapsed_s;
    return {
      running: Boolean(this._hover.running),
      elapsed_s: pyRound(pyMax(0.0, elapsed), 2),
      result: this._hover.result === null ? null : { ...this._hover.result },
    };
  }
}
