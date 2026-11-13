// Ports backend/medhop/mission/avoid.py: obstacle avoidance for the station run, pure maths and a small
// state machine (no I/O, no clock). Checked step by step against Python by avoid.test.ts (fixture:
// __fixtures__/avoid.json, written by backend/tools/parity_traces.py avoid).
//
// EXPERIMENTAL and simulator-tested only. It has never been flown near people. It is not a safety
// system: on the real drone it only knows about people, only when the optional person check is
// enabled, and that check can miss people. A human pilot stays responsible for keeping the corridor
// empty (SPEC sections 1 and 11).
//
// It only ever slows down, holds, backs off a little or gives up. Going round an obstacle was tried and
// removed (SPEC 11.7): with this camera it failed on 19 of 20 simulator runs and once passed 0.49 m
// from a person.
//
// What is seen. Each obstacle is a box in the picture (fractions of the frame). Its distance comes from
// the box alone, never from simulator truth:
//   - floor plane: the camera is level at `camera_height_m`, so a box whose bottom edge is inside the
//     picture and below the horizon stands on the floor at camera_height * focal / (drop of that edge
//     below the horizon);
//   - a person whose box top is inside the picture too: also an assumed 1.7 m height; the smaller wins;
//   - a box cut off at the bottom of the picture (its base is closer than the floor at the bottom row,
//     about 2.54 m with the 70 degree, 16:9 camera at 1 m) counts as very close (distance null), and as
//     in the lane wherever it is in the picture, because its sideways position cannot be told.
// Sideways position and half-width follow from the box's centre and width at that distance. "In the
// lane" means its nearer edge is within `lane_half_m` of the drone's line of flight (the camera axis).
//
// What the drone does (`Avoider.update`, once per frame):
//   clear     nothing in the lane closer than slow_distance_m;
//   slow      something in the lane closer than slow_distance_m: forward stick at most slow_pitch;
//   hold      closer than hold_distance_m (or very close): no forward stick and no yaw, and closer than
//             back_distance_m (or very close) a small backward stick; roll keeps the drone where it was
//             sideways, measured on the sign while it is in view (its bearing and distance: a fixed
//             landmark), else on the obstacle's box while its distance can be told. Back to moving only
//             after the lane has been clear for clear_confirm_s on current evidence;
//   blocked   held for blocked_timeout_s in total: the run ends path_blocked.
//
// Signs follow steering.ts: +roll slides right, +pitch flies forward, lateral + is right of the line of
// flight.
//
// Porting notes: Python's None is null; min()/max() are pyMin()/pyMax() in the Python argument order;
// round() is pyRound(). The dataclasses AvoidConfig and AvoidCommand are plain records with the Python
// field names (AvoidCommand reaches the run trace through the runner); Seen is a class like MarkerObs
// (one init object with the Python field names) whose properties are camelCase (very_close ->
// veryClose, lo_m -> loM, hi_m -> hiM). Avoider's public attributes are camelCase (no_progress_s ->
// noProgressS, blocked_reason -> blockedReason); the event records it keeps keep the Python keys.

import { AVOID_MODES } from "../config";
import { pyMax, pyMin, pyRound, radians } from "../util/num";
import { limitRise } from "./steering";

export { AVOID_MODES };

export const CLEAR = "clear";
export const SLOW = "slow";
export const HOLD = "hold";
export const BLOCKED = "blocked";
export const AVOID_STATES = [CLEAR, SLOW, HOLD, BLOCKED] as const;
export type AvoidState = (typeof AVOID_STATES)[number];
/** Time in these does not count against the run timeout. */
export const NOT_MOVING_ON: readonly AvoidState[] = Object.freeze([HOLD, BLOCKED]);

/** (x1, y1, x2, y2) as fractions of the frame. */
export type Box = readonly [x1: number, y1: number, x2: number, y2: number];

export interface AvoidConfig {
  // the design figures (SPEC section 11)
  lane_half_m: number;
  slow_distance_m: number;
  hold_distance_m: number;
  back_distance_m: number;
  slow_pitch: number;
  back_pitch: number;
  clear_confirm_s: number;
  blocked_timeout_s: number;
  /** camera geometry (level camera at the hover height; 16:9 like the drone's 640x360 stream) */
  camera_height_m: number;
  /**
   * On the ground before an automatic takeoff the camera is only a few centimetres up (4 cm in the
   * simulator): the start blocker judges "in the lane" with this height then.
   */
  ground_camera_height_m: number;
  hfov_deg: number;
  frame_aspect: number;
  person_height_m: number;
  /** a box edge this close to the frame border counts as cut off */
  edge_margin: number;
  /** the bottom edge must be at least this far below the horizon */
  horizon_margin: number;
  // holding still sideways (on the sign, else on the obstacle's box)
  /** roll per metre the drone has moved sideways ... */
  lat_kp: number;
  /** ... and per metre-second (learns the roll that cancels a drift) */
  lat_ki: number;
  /** the mixer's mission roll limit */
  roll_max: number;
  roll_rise_per_s: number;
  /** a box this close (frame widths) to the last one is the same thing */
  match_fw: number;
}

export const AVOID_CONFIG_DEFAULTS: Readonly<AvoidConfig> = Object.freeze({
  lane_half_m: 0.55,
  slow_distance_m: 3.0,
  hold_distance_m: 1.8,
  back_distance_m: 0.9,
  slow_pitch: 0.1,
  back_pitch: -0.08,
  clear_confirm_s: 1.0,
  blocked_timeout_s: 25.0,
  camera_height_m: 1.0,
  ground_camera_height_m: 0.04,
  hfov_deg: 70.0,
  frame_aspect: 16.0 / 9.0,
  person_height_m: 1.7,
  edge_margin: 0.004,
  horizon_margin: 0.01,
  lat_kp: 0.3,
  lat_ki: 0.1,
  roll_max: 0.15,
  roll_rise_per_s: 1.0,
  match_fw: 0.15,
});

/** AvoidConfig(**overrides); also dataclasses.replace(cfg, **overrides) when given a base. */
export function makeAvoidConfig(overrides: Partial<AvoidConfig> = {}, base: Readonly<AvoidConfig> = AVOID_CONFIG_DEFAULTS): AvoidConfig {
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------------------------- //
// geometry

/** Focal length in frame widths. */
export function focalFw(cfg: AvoidConfig): number {
  return 0.5 / Math.tan(radians(cfg.hfov_deg) / 2.0);
}

/** Focal length in frame heights. */
export function focalFh(cfg: AvoidConfig): number {
  return focalFw(cfg) * cfg.frame_aspect;
}

/**
 * Distance at which the floor leaves the bottom of the picture: closer than this an object's base is
 * out of view (about 2.54 m at 1.0 m with the 70 degree 16:9 camera).
 */
export function blindDistanceM(cfg: AvoidConfig): number {
  return (cfg.camera_height_m * focalFh(cfg)) / 0.5;
}

/**
 * Distance (along the camera axis) of a point on the floor seen at image row y2 (fraction of the frame
 * height). null when y2 is not clearly below the horizon.
 */
export function floorDistanceM(y2: number, cfg: AvoidConfig): number | null {
  const drop = y2 - 0.5;
  if (drop <= cfg.horizon_margin) return null;
  return (cfg.camera_height_m * focalFh(cfg)) / drop;
}

export interface SeenInit {
  kind: string;
  box: Box;
  ts: number;
  /** null: its base is out of the picture, so it counts as very close */
  distance_m: number | null;
  /** centre, + = right of the line of flight (null when very close) */
  lateral_m: number | null;
  half_width_m: number | null;
  /** its nearer edge's distance from the line of flight (0: across it) */
  near_m: number | null;
  in_lane: boolean;
}

/** One obstacle with what its box tells about where it is (Python's frozen dataclass Seen). */
export class Seen {
  readonly kind: string;
  readonly box: Box;
  readonly ts: number;
  readonly distance_m: number | null;
  readonly lateral_m: number | null;
  readonly half_width_m: number | null;
  readonly near_m: number | null;
  readonly in_lane: boolean;

  constructor(init: SeenInit) {
    this.kind = init.kind;
    this.box = init.box;
    this.ts = init.ts;
    this.distance_m = init.distance_m;
    this.lateral_m = init.lateral_m;
    this.half_width_m = init.half_width_m;
    this.near_m = init.near_m;
    this.in_lane = init.in_lane;
  }

  /** Python `very_close` */
  get veryClose(): boolean {
    return this.distance_m === null;
  }

  /** Python `lo_m` */
  get loM(): number | null {
    return this.lateral_m === null ? null : this.lateral_m - this.half_width_m!;
  }

  /** Python `hi_m` */
  get hiM(): number | null {
    return this.lateral_m === null ? null : this.lateral_m + this.half_width_m!;
  }

  get cx(): number {
    return 0.5 * (this.box[0] + this.box[2]);
  }
}

export function estimate(kind: string, box: Box, ts: number, cfg: AvoidConfig): Seen {
  const [x1, y1, x2, y2] = [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])] as const;
  const frozenBox: Box = [x1, y1, x2, y2];
  let distance: number | null = null;
  if (y2 < 1.0 - cfg.edge_margin) {
    distance = floorDistanceM(y2, cfg);
    if (distance !== null && kind === "person" && y1 > cfg.edge_margin && y2 - y1 > 1e-6) {
      distance = pyMin(distance, (cfg.person_height_m * focalFh(cfg)) / (y2 - y1));
    }
  }
  if (distance === null) {
    return new Seen({
      kind,
      box: frozenBox,
      ts,
      distance_m: null,
      lateral_m: null,
      half_width_m: null,
      near_m: null,
      in_lane: true,
    });
  }
  const f = focalFw(cfg);
  const lo = ((x1 - 0.5) * distance) / f;
  const hi = ((x2 - 0.5) * distance) / f;
  const near = lo <= 0.0 && 0.0 <= hi ? 0.0 : pyMin(Math.abs(lo), Math.abs(hi));
  return new Seen({
    kind,
    box: frozenBox,
    ts,
    distance_m: distance,
    lateral_m: 0.5 * (lo + hi),
    half_width_m: 0.5 * (hi - lo),
    near_m: near,
    in_lane: near <= cfg.lane_half_m,
  });
}

/** Python min(items, key=...): the first item whose key no later item undercuts. */
function minBy<T>(items: readonly T[], key: (item: T) => number): T {
  let best = items[0]!;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item);
    if (k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** The closest of these; anything very close comes first. */
export function nearest(items: readonly Seen[]): Seen | null {
  if (items.length === 0) return null;
  return minBy(items, (s) => (s.distance_m === null ? -1.0 : s.distance_m));
}

/**
 * The camera's sideways position (metres, + = right) relative to the line through the sign along the
 * camera's current heading, from the sign's centre in the picture (fraction of the frame width) and its
 * distance. With the heading held still this is a fixed frame: it changes only when the drone moves
 * sideways (or the heading drifts).
 */
export function signLateralM(cx: number, rangeM: number, cfg: AvoidConfig): number {
  const bearing = Math.atan2(cx - 0.5, focalFw(cfg));
  return -rangeM * Math.sin(bearing);
}

/** Python's frozen dataclass AvoidCommand, with its field names. */
export interface AvoidCommand {
  readonly state: AvoidState;
  /** forward stick at most this (null: no limit) */
  readonly pitch_cap: number | null;
  /** send this pitch instead (backing off) */
  readonly pitch: number | null;
  /** send this roll instead (holding still sideways) */
  readonly roll: number | null;
  /** send no yaw (holding) */
  readonly freeze_yaw: boolean;
  /** end the run: path_blocked */
  readonly blocked: boolean;
  /** why blocked: "timeout" */
  readonly reason: string | null;
}

/** AvoidCommand(state, **fields) with the dataclass defaults. */
export function avoidCommand(state: AvoidState, fields: Partial<Omit<AvoidCommand, "state">> = {}): AvoidCommand {
  return Object.freeze({
    state,
    pitch_cap: fields.pitch_cap ?? null,
    pitch: fields.pitch ?? null,
    roll: fields.roll ?? null,
    freeze_yaw: fields.freeze_yaw ?? false,
    blocked: fields.blocked ?? false,
    reason: fields.reason ?? null,
  });
}

/** A state change, for the run trace (Python dict keys and order). */
export interface AvoidEvent {
  t: number;
  state: AvoidState;
  kind: string | null;
  distance_m: number | null;
  reason?: string;
}

/** Avoider.snapshot(): status `mission.avoid` without the mode. */
export interface AvoiderSnapshot {
  state: AvoidState;
  kind: string | null;
  distance_m: number | null;
  held_s: number;
}

interface LateralHold {
  sign_ref: number | null;
  ref: number | null;
  of: Seen | null;
  i: number;
}

function freshLateral(): LateralHold {
  return { sign_ref: null, ref: null, of: null, i: 0.0 };
}

// ---------------------------------------------------------------------------------------------- //
// the state machine

/** Driven once per frame by the runner (`update`). No I/O and no clock: `now` is passed in. */
export class Avoider {
  readonly cfg: AvoidConfig;
  state!: AvoidState;
  /** what it is reacting to */
  target!: Seen | null;
  /** time held */
  noProgressS!: number;
  holds!: number;
  blockedReason!: string | null;
  /** state changes, for the run trace */
  events!: AvoidEvent[];
  private _lastNow!: number | null;
  private _clearSince!: number | null;
  private _roll!: number;
  private _sign!: readonly [cx: number, rangeM: number] | null;
  /**
   * holding still sideways: the sign-based position to keep, the obstacle box's lateral position to
   * keep (and the box it belongs to), and the integral (the roll that cancels a steady drift)
   */
  private _lat!: LateralHold;

  constructor(cfg?: AvoidConfig | null) {
    this.cfg = cfg ?? makeAvoidConfig();
    this.reset();
  }

  /** Start of a run. */
  reset(): void {
    this.state = CLEAR;
    this.target = null;
    this.noProgressS = 0.0;
    this.holds = 0;
    this.blockedReason = null;
    this.events = [];
    this._lastNow = null;
    this._clearSince = null;
    this._roll = 0.0;
    this._sign = null;
    this._lat = freshLateral();
  }

  // ------------------------------------------------------------------------------------------ //
  /**
   * One step. `seen`: this frame's obstacles. `fresh`: whether `seen` is current evidence (on the real
   * drone the person check can fall behind). `sign`: (centre as a fraction of the frame width, distance
   * in metres) of the station sign when it is in this frame, for holding still sideways.
   */
  update(now: number, seen: readonly Seen[], fresh = true, sign: readonly [number, number] | null = null): AvoidCommand {
    const cfg = this.cfg;
    const dt = this._lastNow === null ? 0.0 : pyMax(0.0, pyMin(0.5, now - this._lastNow));
    this._lastNow = now;
    this._sign = sign;
    if (this.state === BLOCKED) return this._blockedCommand();
    if (this.state === HOLD) {
      this.noProgressS += dt;
      if (this.noProgressS >= cfg.blocked_timeout_s) return this._block(now, "timeout");
      return this._hold(now, dt, fresh ? seen : null);
    }
    return this._moving(now, fresh ? seen : null);
  }

  // ------------------------------------------------------------------------------------------ //
  private _set(state: AvoidState, now: number, target: Seen | null, extra: { reason?: string } = {}): void {
    this.target = target;
    if (state !== this.state) {
      this.state = state;
      this.events.push({
        t: pyRound(now, 3),
        state,
        kind: target === null ? null : target.kind,
        distance_m: target === null || target.distance_m === null ? null : pyRound(target.distance_m, 2),
        ...extra,
      });
      if (this.events.length > 200) this.events.splice(0, 50);
    }
  }

  private _block(now: number, reason: string): AvoidCommand {
    this.blockedReason = reason;
    this._set(BLOCKED, now, this.target, { reason });
    return this._blockedCommand();
  }

  private _blockedCommand(): AvoidCommand {
    return avoidCommand(BLOCKED, { pitch_cap: 0.0, pitch: 0.0, roll: 0.0, blocked: true, reason: this.blockedReason });
  }

  private _holdCommand(target: Seen | null, roll: number): AvoidCommand {
    const cfg = this.cfg;
    const back = target !== null && (target.distance_m === null || target.distance_m < cfg.back_distance_m);
    return avoidCommand(HOLD, { pitch_cap: 0.0, pitch: back ? cfg.back_pitch : null, roll, freeze_yaw: true });
  }

  private _same(previous: Seen, current: Seen): boolean {
    return previous.kind === current.kind && Math.abs(previous.cx - current.cx) <= this.cfg.match_fw;
  }

  /**
   * Roll that keeps the drone where it was sideways (PI; the integral learns the roll that cancels a
   * steady drift and starts at zero). Measured on the sign while it is in view (with yaw held still its
   * bearing and distance give the drone's sideways position), else on `target`'s box while its distance
   * can be told; without either, the integral alone is sent. Rises at most roll_rise_per_s; reductions
   * are immediate.
   */
  private _holdRoll(dt: number, target: Seen | null): number {
    const cfg = this.cfg;
    const lat = this._lat;
    let raw = lat.i;
    let err: number | null = null; // metres the drone has moved left (+)
    if (this._sign !== null) {
      const here = signLateralM(this._sign[0], this._sign[1], cfg);
      if (lat.sign_ref === null) lat.sign_ref = here; // start from where it is now
      err = lat.sign_ref - here;
    } else if (target !== null && target.lateral_m !== null) {
      if (lat.ref === null || lat.of === null || !this._same(lat.of, target)) lat.ref = target.lateral_m;
      lat.of = target;
      err = target.lateral_m - lat.ref; // it moved right: the drone moved left
    }
    if (err !== null) {
      lat.i = pyMax(-cfg.roll_max, pyMin(cfg.roll_max, lat.i + cfg.lat_ki * err * dt));
      raw = cfg.lat_kp * err + lat.i;
    }
    raw = pyMax(-cfg.roll_max, pyMin(cfg.roll_max, raw));
    this._roll = pyMax(-cfg.roll_max, pyMin(cfg.roll_max, limitRise(this._roll, raw, dt, cfg.roll_rise_per_s)));
    return this._roll;
  }

  // ------------------------------------------------------------------------------------------ //
  private _moving(now: number, seen: readonly Seen[] | null): AvoidCommand {
    const cfg = this.cfg;
    if (seen === null) {
      // no current evidence: keep what the last evidence said
      return this.state === SLOW ? avoidCommand(SLOW, { pitch_cap: cfg.slow_pitch }) : avoidCommand(CLEAR);
    }
    const target = nearest(seen.filter((s) => s.in_lane));
    const distance = target === null ? null : target.distance_m === null ? 0.0 : target.distance_m;
    if (distance !== null && distance < cfg.hold_distance_m) {
      this.holds += 1;
      this._clearSince = null;
      this._roll = 0.0;
      this._lat = freshLateral();
      this._set(HOLD, now, target);
      return this._holdCommand(target, this._holdRoll(0.0, target));
    }
    if (distance !== null && distance < cfg.slow_distance_m) {
      this._set(SLOW, now, target);
      return avoidCommand(SLOW, { pitch_cap: cfg.slow_pitch });
    }
    this._set(CLEAR, now, null);
    return avoidCommand(CLEAR);
  }

  private _hold(now: number, dt: number, seen: readonly Seen[] | null): AvoidCommand {
    const cfg = this.cfg;
    if (seen === null) {
      this._clearSince = null; // "clear" needs current evidence
      const target = this.target;
      return this._holdCommand(target, this._holdRoll(dt, null));
    }
    const lane = seen.filter((s) => s.in_lane);
    const target = nearest(lane);
    if (lane.some((s) => s.distance_m === null || s.distance_m < cfg.slow_distance_m)) {
      this._clearSince = null;
      this.target = target;
    } else {
      if (this._clearSince === null) this._clearSince = now;
      if (now - this._clearSince >= cfg.clear_confirm_s) {
        this._roll = 0.0;
        this._set(CLEAR, now, null);
        return this._moving(now, seen);
      }
    }
    return this._holdCommand(target, this._holdRoll(dt, target));
  }

  // ------------------------------------------------------------------------------------------ //
  snapshot(): AvoiderSnapshot {
    const target = this.target;
    return {
      state: this.state,
      kind: target === null ? null : target.kind,
      distance_m: target === null || target.distance_m === null ? null : pyRound(target.distance_m, 2),
      held_s: pyRound(this.noProgressS, 1),
    };
  }
}
