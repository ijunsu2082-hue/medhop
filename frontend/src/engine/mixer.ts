// Ports backend/medhop/mixer.py: ControlMixer, the single authority that sends axes to the drone
// link (SPEC section 5). Checked step by step against Python by mixer.test.ts (fixture:
// __fixtures__/mixer.json, written by backend/tools/parity_traces.py mixer).
//
// Priority each tick:
//   1. emergency stop latched -> the motor cut is asserted again, then neutral (no trim) until reset
//   2. pilot active (non-zero manual axes in the last 0.4 s) -> pilot axes x max_stick, except on the
//      real drone when the newest frame is older than 3.0 s: then neutral (sticks blocked, trim still
//      added like any neutral), so the last packets before the library's 4 s socket cut are neutral
//   3. fresh mission command (younger than 0.5 s) and live video -> mission yaw and pitch, plus a
//      small bounded roll when drift assist is on. Never throttle.
//   4. neutral
// then, unless the emergency stop is latched, trim (roll, pitch) is added and the result clamped.
//
// Differences from Python: no locks and no thread (JavaScript runs one call at a time; the browser
// loop calls tick() every 1 / rateHz seconds itself, which replaces start()/stop()/_run()); the clock
// must be passed in (there is no time.monotonic default); log lines go to an optional Logger; a
// ToggleResult is an object { ok, message, code } rather than a tuple subclass. The statement order
// inside every method is the Python order, including where the pilot-input callback runs.

import type { ControlErrorCode } from "../api/types";
import type { DroneLink } from "./drone/link";
import { SILENT_LOGGER, type Logger } from "./util/log";
import { clamp, pyFormatFixed, pyMax, pyMin, pyRepr, ValueError } from "./util/num";

/** pilot counts as active this long after a non-zero axes message */
export const PILOT_ACTIVE_S = 0.4;
/** a mission command older than this is ignored */
export const MISSION_FRESH_S = 0.5;
/** mission axes are forced to neutral when the frame is older than this */
export const VIDEO_STALE_S = 0.5;
/** pilot axes approach their target at this rate */
export const PILOT_RAMP_PER_S = 4.0;
export const TRIM_LIMIT = 0.3;
/** the most roll a mission command may carry (drift assist) */
export const MISSION_ROLL_LIMIT = 0.15;
export const MAX_STICK_MIN = 0.2;
export const MAX_STICK_MAX = 1.0;
/** a second toggle this soon after the last one is ignored */
export const TOGGLE_GUARD_S = 1.0;
/**
 * A pilot toggle this soon after a mission (landing) toggle is refused: a second toggle would stop the
 * landing or relaunch the drone. Must match the runner's land wait (RunnerConfig.land_wait_s, 4.0 s).
 */
export const LANDING_GUARD_S = 4.0;
/**
 * A mission toggle is refused this soon after any pilot input (non-zero axes, toggle, e-stop), even if
 * the runner sent a mission_command in between (closes the window inside one runner step).
 */
export const MISSION_TOGGLE_PILOT_QUIET_S = 0.4;
/** real drone: pilot axes become neutral once the frame is this old */
export const STICKS_BLOCK_AFTER_S = 3.0;
/** motor cut asserted on an open socket this long counts as confirmed */
export const ESTOP_CONFIRM_S = 0.5;
/** at most this much time is credited between two assertions */
export const ESTOP_MAX_STEP_S = 0.1;

// Refusal codes for the control socket.
export const ESTOP_ACTIVE = "estop_active";
export const TOGGLE_GUARD = "toggle_guard";
export const LANDING_IN_PROGRESS = "landing_in_progress";
export const DRONE_LINK_DOWN = "drone_link_down";

/** throttle, yaw, pitch, roll */
export type Axes = readonly [throttle: number, yaw: number, pitch: number, roll: number];
export const NEUTRAL: Axes = Object.freeze([0.0, 0.0, 0.0, 0.0] as const);

export type MixerSource = "estop" | "pilot" | "mission" | "neutral";

/** MixerSnapshot, with the Python field names (the status JSON is built from these). */
export interface MixerSnapshot {
  readonly manual_active: boolean;
  readonly max_stick: number;
  readonly estop_active: boolean;
  readonly trim_roll: number;
  readonly trim_pitch: number;
  readonly source: MixerSource;
  readonly sent: Axes;
  /** the motor cut went onto an open socket for ESTOP_CONFIRM_S */
  readonly estop_confirmed: boolean;
  /** real drone, video older than STICKS_BLOCK_AFTER_S: pilot axes held neutral */
  readonly sticks_blocked: boolean;
}

/** Python's ToggleResult `(ok, message)` with `code` for the API (null when accepted). */
export interface ToggleResult {
  readonly ok: boolean;
  readonly message: string;
  readonly code: ControlErrorCode | null;
}

/** What on_pilot_input is called with whenever the pilot acts. */
export type PilotInputKind = "axes" | "toggle" | "estop";

export interface ControlMixerOptions {
  /** Monotonic seconds. Required: the engine never reads a real clock itself. */
  clock: () => number;
  /** Python rate_hz (default 20). Only informs the caller's tick loop; the mixer does not schedule itself. */
  rateHz?: number;
  /** (roll, pitch), each clamped to +-TRIM_LIMIT */
  trim?: readonly [roll: number, pitch: number];
  /** clamped to [MAX_STICK_MIN, MAX_STICK_MAX] (default 0.5) */
  maxStick?: number;
  onPilotInput?: ((kind: PilotInputKind) => void) | null;
  logger?: Logger;
}

const LINK_DOWN_MESSAGE =
  "NOT sent: the drone link is reconnecting, so commands are not reaching the drone. Try again in a few seconds.";

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new ValueError("axis values must be finite numbers");
  return value;
}

function toggleResult(ok: boolean, message = "", code: ControlErrorCode | null = null): ToggleResult {
  return { ok, message, code };
}

export class ControlMixer {
  /** Called with "axes", "toggle" or "estop" whenever the pilot acts. Exceptions are logged and dropped. */
  onPilotInput: ((kind: PilotInputKind) => void) | null;
  readonly rateHz: number;

  private readonly _link: DroneLink;
  private readonly _clock: () => number;
  private readonly _logger: Logger;

  private _estop = false;
  /** last assertion that went onto an open socket */
  private _estopOkAt: number | null = null;
  /** open-socket time credited since the latch */
  private _estopOpenS = 0.0;
  private _estopConfirmed = false;
  private _maxStick: number;
  private _trimRoll: number;
  private _trimPitch: number;

  private _pilotTarget: Axes = NEUTRAL;
  private _pilotValue: Axes = NEUTRAL;
  private _pilotNonzeroAt: number | null = null;

  /** yaw, pitch, roll */
  private _missionCmd: readonly [number, number, number] | null = null;
  private _missionAt: number | null = null;

  private _lastTick: number | null = null;
  private _lastToggleAt: number | null = null;
  private _missionToggleAt: number | null = null;
  /** Set by any pilot input (axes, toggle, e-stop), cleared by the runner's next mission_command. */
  private _pilotSinceMission = false;
  /** non-zero axes, toggle or e-stop */
  private _lastPilotInputAt: number | null = null;
  private _sent: Axes = NEUTRAL;
  private _source: MixerSource = "neutral";
  private _sticksBlocked = false;
  private _badMissionLogged = false;

  constructor(link: DroneLink, options: ControlMixerOptions) {
    this._link = link;
    this.rateHz = options.rateHz ?? 20.0;
    this._clock = options.clock;
    this._logger = options.logger ?? SILENT_LOGGER;
    this.onPilotInput = options.onPilotInput ?? null;
    const trim = options.trim ?? [0.0, 0.0];
    this._maxStick = clamp(options.maxStick ?? 0.5, MAX_STICK_MIN, MAX_STICK_MAX);
    this._trimRoll = clamp(trim[0], -TRIM_LIMIT, TRIM_LIMIT);
    this._trimPitch = clamp(trim[1], -TRIM_LIMIT, TRIM_LIMIT);
  }

  // ------------------------------------------------------------------------------------------ //
  // the tick

  /** Compute this tick's axes and send them to the link. Returns what was sent. */
  tick(now?: number | null): Axes {
    const t = now ?? this._clock();
    if (this.estopActive) {
      // Asserted on every tick while latched (it is idempotent): a press made while the link was down
      // is sent as soon as the link is back.
      this._estopAsserted(t, this._link.emergencyStop() === true);
    }
    const axes = this._compute(t);
    this._link.setAxes(axes[0], axes[1], axes[2], axes[3]);
    return axes;
  }

  /** Credit open-socket time between consecutive successful motor-cut assertions. */
  private _estopAsserted(now: number, ok: boolean): void {
    if (!this._estop) return;
    if (ok && this._estopOkAt !== null) {
      this._estopOpenS += pyMax(0.0, pyMin(ESTOP_MAX_STEP_S, now - this._estopOkAt));
    }
    this._estopOkAt = ok ? now : null;
    if (!this._estopConfirmed && this._estopOpenS >= ESTOP_CONFIRM_S - 1e-9) {
      this._estopConfirmed = true;
      this._logger.log("warning", `motor-cut command sent for ${pyFormatFixed(ESTOP_CONFIRM_S, 1)} s on an open socket`);
    }
  }

  private _compute(now: number): Axes {
    const frame = this._link.latestFrame();
    const videoLive = frame !== null && now - frame.timestamp <= VIDEO_STALE_S;
    // No frame at all counts as old video too.
    const sticksBlocked = this._link.mode === "real" && (frame === null || now - frame.timestamp > STICKS_BLOCK_AFTER_S);
    const dt = this._lastTick === null ? 0.0 : pyMax(0.0, pyMin(0.5, now - this._lastTick));
    this._lastTick = now;
    const pilotActive = this._pilotActive(now);
    if (!pilotActive) {
      // Deadman: no non-zero pilot message for 0.4 s means the pilot axes are gone.
      this._pilotTarget = NEUTRAL;
      this._pilotValue = NEUTRAL;
    }

    let axes: Axes;
    let source: MixerSource;
    if (this._estop) {
      axes = NEUTRAL;
      source = "estop";
    } else if (pilotActive && sticksBlocked) {
      // Real drone, video about to be cut by the library: neutral (plus trim, below), and the pilot
      // ramp starts again from zero when video returns.
      this._pilotValue = NEUTRAL;
      axes = NEUTRAL;
      source = "neutral";
    } else if (pilotActive) {
      const step = PILOT_RAMP_PER_S * dt;
      const cur = this._pilotValue;
      const target = this._pilotTarget;
      const ramp = (i: 0 | 1 | 2 | 3): number => cur[i] + pyMax(-step, pyMin(step, target[i] - cur[i]));
      this._pilotValue = [ramp(0), ramp(1), ramp(2), ramp(3)];
      const v = this._pilotValue;
      const ms = this._maxStick;
      axes = [v[0] * ms, v[1] * ms, v[2] * ms, v[3] * ms];
      source = "pilot";
    } else if (
      this._missionCmd !== null &&
      this._missionAt !== null &&
      now - this._missionAt < MISSION_FRESH_S &&
      videoLive
    ) {
      const [yaw, pitch, roll] = this._missionCmd;
      axes = [0.0, yaw, pitch, roll]; // throttle is never the mission's
      source = "mission";
    } else {
      axes = NEUTRAL;
      source = "neutral";
    }

    if (!this._estop) {
      const [throttle, yaw, pitch, roll] = axes;
      axes = [clamp(throttle), clamp(yaw), clamp(pitch + this._trimPitch), clamp(roll + this._trimRoll)];
    }
    if (sticksBlocked !== this._sticksBlocked) {
      if (sticksBlocked) {
        this._logger.log(
          "warning",
          `video older than ${pyFormatFixed(STICKS_BLOCK_AFTER_S, 1)} s on the real drone: pilot sticks held neutral`,
        );
      } else {
        this._logger.log("info", "video is back: pilot sticks enabled");
      }
    }
    this._sticksBlocked = sticksBlocked;
    this._sent = axes;
    this._source = source;
    return axes;
  }

  private _pilotActive(now: number): boolean {
    return this._pilotNonzeroAt !== null && now - this._pilotNonzeroAt <= PILOT_ACTIVE_S;
  }

  // ------------------------------------------------------------------------------------------ //
  // pilot inputs

  /** Throws ValueError when a value is not a finite number. */
  pilotAxes(throttle: number, yaw: number, pitch: number, roll: number, now?: number | null): void {
    const t = now ?? this._clock();
    const target: Axes = [clamp(finite(throttle)), clamp(finite(yaw)), clamp(finite(pitch)), clamp(finite(roll))];
    const nonzero = target.some((v) => Math.abs(v) > 1e-6);
    this._pilotTarget = target;
    if (nonzero) {
      this._pilotNonzeroAt = t;
      this._missionCmd = null; // the mission loses authority at once
      this._missionAt = null;
      this._pilotSinceMission = true;
      this._lastPilotInputAt = t;
    }
    if (nonzero) this._notify("axes");
  }

  /** The pilot's control connection dropped: zero the pilot axes at once. */
  pilotDisconnect(): void {
    this._pilotTarget = NEUTRAL;
    this._pilotValue = NEUTRAL;
    this._pilotNonzeroAt = null;
  }

  /**
   * Pilot pressed takeoff/land. Aborts a running mission, then sends the one shared toggle.
   *
   * Refusal codes: estop_active, landing_in_progress, toggle_guard or drone_link_down.
   */
  pilotToggle(now?: number | null): ToggleResult {
    const t = now ?? this._clock();
    this._missionCmd = null;
    this._missionAt = null;
    this._pilotSinceMission = true;
    this._lastPilotInputAt = t;
    this._notify("toggle");
    const controlUp = this._link.controlUp() === true;
    if (this._estop) return toggleResult(false, "emergency stop is active; reset it first", ESTOP_ACTIVE);
    if (this._missionToggleAt !== null && t - this._missionToggleAt < LANDING_GUARD_S) {
      return toggleResult(
        false,
        "landing in progress: the station run sent the land command a moment ago; " +
          "a second press would undo it. Wait a few seconds.",
        LANDING_IN_PROGRESS,
      );
    }
    if (this._lastToggleAt !== null && t - this._lastToggleAt < TOGGLE_GUARD_S) {
      return toggleResult(false, "takeoff/land was sent a moment ago; ignored", TOGGLE_GUARD);
    }
    if (!controlUp) return toggleResult(false, LINK_DOWN_MESSAGE, DRONE_LINK_DOWN);
    this._lastToggleAt = t; // checked and set in one step: two toggles cannot both pass
    this._logger.log("info", "pilot takeoff/land toggle");
    if (this._link.takeoffLandToggle() !== true) return toggleResult(false, LINK_DOWN_MESSAGE, DRONE_LINK_DOWN);
    return toggleResult(true, "");
  }

  /**
   * The mission runner's toggle: a landing (confirmed arrival, or an automatic run's safe landing) or,
   * with landing=false, an automatic run's takeoff. Refused when e-stopped, just toggled, when the drone
   * link is down, when any pilot input arrived since the runner's last missionCommand, or when any pilot
   * input arrived in the last MISSION_TOGGLE_PILOT_QUIET_S. Only a landing starts the LANDING_GUARD_S
   * window that refuses a pilot toggle (after a takeoff the pilot must be able to land at once).
   * True only when the toggle went onto an open socket.
   */
  missionToggle(now?: number | null, landing = true): boolean {
    const t = now ?? this._clock();
    const controlUp = this._link.controlUp() === true;
    if (this._estop) return false;
    if (this._pilotSinceMission) {
      this._logger.log("warning", "mission toggle refused: pilot input since the last mission command");
      return false;
    }
    if (this._lastPilotInputAt !== null && t - this._lastPilotInputAt < MISSION_TOGGLE_PILOT_QUIET_S) {
      this._logger.log(
        "warning",
        `mission toggle refused: pilot input in the last ${pyFormatFixed(MISSION_TOGGLE_PILOT_QUIET_S, 1)} s`,
      );
      return false;
    }
    if (this._lastToggleAt !== null && t - this._lastToggleAt < TOGGLE_GUARD_S) return false;
    if (!controlUp) {
      this._logger.log("warning", "mission toggle refused: drone link down");
      return false;
    }
    this._lastToggleAt = t;
    this._logger.log("info", `mission takeoff/land toggle (${landing ? "landing" : "automatic takeoff"})`);
    if (this._link.takeoffLandToggle() !== true) return false;
    if (landing) this._missionToggleAt = t;
    return true;
  }

  /**
   * Latch the emergency stop and send the motor cut. Returns true when this press went onto an open
   * socket (the mixer keeps asserting it on every tick until reset either way).
   */
  pilotEstop(now?: number | null): boolean {
    const t = now ?? this._clock();
    const newly = !this._estop;
    this._estop = true;
    if (newly) {
      this._estopOkAt = null;
      this._estopOpenS = 0.0;
      this._estopConfirmed = false;
    }
    this._pilotTarget = NEUTRAL;
    this._pilotValue = NEUTRAL;
    this._pilotNonzeroAt = null;
    this._missionCmd = null;
    this._missionAt = null;
    this._pilotSinceMission = true;
    this._lastPilotInputAt = t;
    this._sent = NEUTRAL;
    this._source = "estop";
    this._logger.log("warning", "EMERGENCY STOP");
    const sent = this._link.emergencyStop() === true;
    this._estopAsserted(t, sent);
    this._link.setAxes(NEUTRAL[0], NEUTRAL[1], NEUTRAL[2], NEUTRAL[3]);
    if (!sent) this._logger.log("warning", "motor-cut command NOT sent: drone link down; it is re-sent on every tick");
    this._notify("estop");
    return sent;
  }

  estopReset(): void {
    const was = this._estop;
    this._estop = false;
    this._estopOkAt = null;
    this._estopOpenS = 0.0;
    this._estopConfirmed = false;
    if (was) this._logger.log("warning", "emergency stop reset by pilot");
  }

  /** [ok, message], as Python's (bool, str). */
  calibrate(): [ok: boolean, message: string] {
    if (this._estop) return [false, "emergency stop is active; reset it first"];
    this._link.calibrate();
    return [true, ""];
  }

  /** Throws ValueError outside [MAX_STICK_MIN, MAX_STICK_MAX] or for a value that is not a finite number. */
  setMaxStick(value: number): number {
    const v = finite(value);
    if (!(MAX_STICK_MIN <= v && v <= MAX_STICK_MAX)) {
      throw new ValueError(`max_stick must be between ${pyRepr(MAX_STICK_MIN)} and ${pyRepr(MAX_STICK_MAX)}`);
    }
    this._maxStick = v;
    return v;
  }

  /** Each value clamped to +-TRIM_LIMIT; throws ValueError for a value that is not a finite number. */
  setTrim(roll: number, pitch: number): [roll: number, pitch: number] {
    const r = clamp(finite(roll), -TRIM_LIMIT, TRIM_LIMIT);
    const p = clamp(finite(pitch), -TRIM_LIMIT, TRIM_LIMIT);
    this._trimRoll = r;
    this._trimPitch = p;
    return [r, p];
  }

  trim(): [roll: number, pitch: number] {
    return [this._trimRoll, this._trimPitch];
  }

  // ------------------------------------------------------------------------------------------ //
  // mission inputs

  /**
   * Yaw and pitch from the mission runner, plus an optional drift-assist roll.
   *
   * The roll is clamped to +-MISSION_ROLL_LIMIT here as well, whatever the caller asked for (a value
   * that is not a finite number counts as zero). There is no throttle argument: a mission can never
   * command it.
   */
  missionCommand(yaw: number, pitch: number, now?: number | null, roll = 0.0): void {
    const t = now ?? this._clock();
    if (!(Number.isFinite(yaw) && Number.isFinite(pitch))) {
      this._missionCmd = null;
      this._missionAt = null;
      const log = !this._badMissionLogged;
      this._badMissionLogged = true;
      if (log) {
        this._logger.log(
          "error",
          `mission command rejected: yaw ${pyRepr(yaw)} / pitch ${pyRepr(pitch)} is not a finite number`,
        );
      }
      return;
    }
    const r = Number.isFinite(roll) ? clamp(roll, -MISSION_ROLL_LIMIT, MISSION_ROLL_LIMIT) : 0.0;
    this._missionCmd = [clamp(yaw), clamp(pitch), r];
    this._missionAt = t;
    this._pilotSinceMission = false;
  }

  /** Time since the last takeoff/land toggle went out (pilot or mission); null if never. */
  secondsSinceToggle(now?: number | null): number | null {
    const t = now ?? this._clock();
    return this._lastToggleAt === null ? null : t - this._lastToggleAt;
  }

  clearMissionCommand(): void {
    this._missionCmd = null;
    this._missionAt = null;
  }

  // ------------------------------------------------------------------------------------------ //
  // read side

  get estopActive(): boolean {
    return this._estop;
  }

  snapshot(now?: number | null): MixerSnapshot {
    const t = now ?? this._clock();
    return {
      manual_active: this._pilotActive(t),
      max_stick: this._maxStick,
      estop_active: this._estop,
      trim_roll: this._trimRoll,
      trim_pitch: this._trimPitch,
      source: this._source,
      sent: this._sent,
      estop_confirmed: this._estop && this._estopConfirmed,
      sticks_blocked: this._sticksBlocked,
    };
  }

  private _notify(kind: PilotInputKind): void {
    const callback = this.onPilotInput;
    if (callback === null) return;
    try {
      callback(kind);
    } catch {
      this._logger.log("error", "pilot-input callback failed");
    }
  }
}
