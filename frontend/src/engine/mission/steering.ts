// Ports backend/medhop/mission/steering.py: pure steering maths for the station run (no I/O, no
// clocks, no threads). Checked step by step against Python by steering.test.ts
// (fixture: __fixtures__/steering.json, written by backend/tools/parity_traces.py steering).
//
// Pursuit guidance on the marker centre. Because the video shows what the drone did about half a
// second ago, the yaw command is not computed from the stale marker position alone. The yaw commands
// that were sent after the picture was taken have not shown up in the video yet, so their expected
// effect is subtracted first (a Smith predictor):
//
//     predicted_cx = observed_cx - yaw_rate_fw_per_s * integral of yaw commands over [obs time - latency, now]
//
// `yaw_rate_fw_per_s` is an assumed figure (how fast full yaw stick moves the marker across the frame).
// It is deliberately on the high side: over-estimating it only makes the loop slower, while the loop
// stays stable for a real yaw rate up to twice the assumed one.
//
// Signs: +yaw turns right, +pitch flies forward, +roll slides right. A marker right of centre
// (cx > 0.5) needs +yaw.
//
// Drift assist (experimental, `DriftAssist` below) adds a small roll command that cancels a steady
// sideways slide. It uses nothing but what the camera shows. See the class for how and why.
//
// Porting notes: every Python min()/max() is pyMin()/pyMax() in the same argument order (NaN
// behaves as in Python), `x or 0.0` is pyOr(), sum() is pySum() (compensated, as in Python 3.12) and
// math.hypot is pyHypot(). Python deques are arrays here.

import { pyHypot, pyMax, pyMin, pyOr, pySum, ValueError } from "../util/num";
import type { Corner } from "../vision/marker";

export interface MarkerSample {
  /** when the frame arrived (seconds, monotonic) */
  readonly ts: number;
  /** marker centre, fraction of frame width */
  readonly cx: number;
  /** marker width, fraction of frame width */
  readonly width: number;
}

export interface SteeringConfig {
  /** command-to-video latency to compensate */
  latency_s: number;
  /** assumed marker speed across the frame at full yaw stick */
  yaw_rate_fw_per_s: number;
  /** stick per frame-width of predicted error */
  yaw_gain: number;
  /** yaw stick cap while approaching */
  yaw_max: number;
  /** frame-widths; no yaw inside this */
  yaw_deadband: number;
  /** fly forward only when the marker is this close to centre */
  forward_window: number;
  /** forward stick cap */
  forward_max: number;
  /** forward stick close to arrival */
  forward_near: number;
  /** taper begins when width reaches this fraction of the arrive width */
  taper_start: number;
  /** commands rise at most this fast; reductions are immediate */
  rise_per_s: number;
  /** slow fixed yaw while searching */
  search_yaw: number;
  /** creep-search yaw toward the side the marker was last seen */
  creep_yaw: number;
}

export const STEERING_CONFIG_DEFAULTS: Readonly<SteeringConfig> = Object.freeze({
  latency_s: 0.45,
  yaw_rate_fw_per_s: 2.5,
  yaw_gain: 1.0,
  yaw_max: 0.25,
  yaw_deadband: 0.015,
  forward_window: 0.15,
  forward_max: 0.22,
  forward_near: 0.07,
  taper_start: 0.5,
  rise_per_s: 1.0,
  search_yaw: 0.12,
  creep_yaw: 0.08,
});

/** SteeringConfig(**overrides) */
export function makeSteeringConfig(overrides: Partial<SteeringConfig> = {}): SteeringConfig {
  return { ...STEERING_CONFIG_DEFAULTS, ...overrides };
}

/** (time the command was issued, yaw stick) */
export type YawEntry = readonly [issued: number, yaw: number];
/** Yaw commands, oldest first. */
export type YawLog = readonly YawEntry[];

/** Integral of the yaw commands over [start, now]; each command holds until the next one. */
export function pendingYaw(yawLog: YawLog, start: number, now: number): number {
  let total = 0.0;
  for (let index = 0; index < yawLog.length; index++) {
    const [issued, yaw] = yawLog[index]!;
    const until = index + 1 < yawLog.length ? yawLog[index + 1]![0] : now;
    const lo = pyMax(issued, start);
    const hi = pyMin(until, now);
    if (hi > lo) total += yaw * (hi - lo);
  }
  return total;
}

/** Where the marker centre is expected to be once every command already sent has taken effect. */
export function predictCx(history: readonly MarkerSample[], yawLog: YawLog, now: number, cfg: SteeringConfig): number {
  const latest = history[history.length - 1];
  if (latest === undefined) throw new RangeError("predictCx needs at least one sample"); // Python: IndexError
  const unseen = pendingYaw(yawLog, latest.ts - cfg.latency_s, now);
  return latest.cx - cfg.yaw_rate_fw_per_s * unseen;
}

/** Forward stick as a function of marker size: capped far away, tapering to forward_near. */
export function forwardForWidth(width: number, arriveWidth: number, cfg: SteeringConfig): number {
  const start = arriveWidth * cfg.taper_start;
  if (width <= start) return cfg.forward_max;
  if (width >= arriveWidth) return cfg.forward_near;
  const frac = (width - start) / pyMax(1e-9, arriveWidth - start);
  return cfg.forward_max + (cfg.forward_near - cfg.forward_max) * frac;
}

/**
 * Raw (yaw, pitch) target for a visible marker.
 *
 * `history` holds the marker observations and `yawLog` the yaw commands already issued, both oldest
 * first. Pure: the result depends only on the arguments.
 */
export function steer(
  history: readonly MarkerSample[],
  yawLog: YawLog,
  now: number,
  arriveWidth: number,
  cfg?: SteeringConfig | null,
): [yaw: number, pitch: number] {
  const c = cfg ?? makeSteeringConfig();
  const latest = history[history.length - 1];
  if (latest === undefined) return [0.0, 0.0];
  const predicted = predictCx(history, yawLog, now, c);
  const error = predicted - 0.5;
  let yaw: number;
  if (Math.abs(error) <= c.yaw_deadband) yaw = 0.0;
  else yaw = pyMax(-c.yaw_max, pyMin(c.yaw_max, c.yaw_gain * error));
  const centred = Math.abs(latest.cx - 0.5) <= c.forward_window && Math.abs(error) <= c.forward_window;
  const pitch = centred ? forwardForWidth(latest.width, arriveWidth, c) : 0.0;
  return [yaw, pitch];
}

/** Magnitude may grow by at most risePerS * dt; reductions and stops are immediate. */
export function limitRise(previous: number, target: number, dt: number, risePerS: number): number {
  let prev = previous;
  if (prev * target < 0.0) prev = 0.0; // a sign change passes through zero first
  if (Math.abs(target) <= Math.abs(prev)) return target;
  const grown = Math.abs(prev) + pyMax(0.0, risePerS * dt);
  return (target > 0.0 ? 1.0 : -1.0) * pyMin(Math.abs(target), grown);
}

/**
 * Stateful wrapper: remembers the commands it issued (for the latency compensation) and applies the
 * rise limit between successive commands. No I/O and no clock: `now` is always passed in.
 */
export class Steering {
  static readonly YAW_LOG_S = 3.0;

  readonly cfg: SteeringConfig;
  private _last: readonly [number, number] = [0.0, 0.0];
  private _lastAt: number | null = null;
  private readonly _yawLog: [number, number][] = [];

  constructor(cfg?: SteeringConfig | null) {
    this.cfg = cfg ?? makeSteeringConfig();
  }

  reset(): void {
    this._last = [0.0, 0.0];
    this._lastAt = null;
    this._yawLog.length = 0;
  }

  /**
   * A copy of the yaw commands issued, oldest first (Python: `tuple(steering._yaw_log)`, which the
   * runner reads to call `steer()` itself when avoidance caps the forward stick between steer and shape).
   */
  get yawLog(): YawLog {
    return this._yawLog.slice();
  }

  /** Rate-limit an arbitrary (yaw, pitch) target against the previous output. */
  shape(yaw: number, pitch: number, now: number): [yaw: number, pitch: number] {
    const dt = this._lastAt === null ? 0.0 : pyMax(0.0, pyMin(0.5, now - this._lastAt));
    const out: [number, number] = [
      limitRise(this._last[0], yaw, dt, this.cfg.rise_per_s),
      limitRise(this._last[1], pitch, dt, this.cfg.rise_per_s),
    ];
    this._last = [out[0], out[1]];
    this._lastAt = now;
    this._yawLog.push([now, out[0]]);
    while (this._yawLog.length > 1 && now - this._yawLog[1]![0] > Steering.YAW_LOG_S) this._yawLog.shift();
    return out;
  }

  /**
   * `noForward`: yaw only (the drone is already at the arrive distance and must not creep on toward the
   * wall while it lines up).
   */
  update(history: readonly MarkerSample[], now: number, arriveWidth: number, noForward = false): [yaw: number, pitch: number] {
    const [yaw, pitch] = steer(history, this._yawLog.slice(), now, arriveWidth, this.cfg);
    return this.shape(yaw, noForward ? 0.0 : pitch, now);
  }

  /**
   * Integral (stick x seconds) of the yaw commands whose effect appears in the video between two frame
   * times: the commands issued one latency before each of them.
   */
  yawSeenBetween(earlierTs: number, laterTs: number): number {
    const latency = this.cfg.latency_s;
    return pendingYaw(this._yawLog.slice(), earlierTs - latency, laterTs - latency);
  }

  search(now: number, direction = 1.0, creep = false): [yaw: number, pitch: number] {
    const rate = creep ? this.cfg.creep_yaw : this.cfg.search_yaw;
    return this.shape(direction >= 0 ? rate : -rate, 0.0, now);
  }

  neutral(now: number): [yaw: number, pitch: number] {
    return this.shape(0.0, 0.0, now);
  }
}

export interface DriftAssistConfig {
  /** hard bound on the assist roll (SPEC section 6, Revision 2) */
  roll_max: number;
  /** roll stick per marker-width of unexplained sideways slide */
  gain: number;
  /** gain factor while the yaw effect has not been measured in this run */
  uncalibrated_gain: number;
  /** the estimate moves at most this fast (stick per second) */
  rate_max: number;
  /** the roll sent rises at most this fast; reductions are immediate */
  rise_per_s: number;
  // qualifying: the first turn toward the marker must be over
  /** the yaw seen in the video must have been small for this long ... */
  arm_window_s: number;
  /** ... "small" (stick) ... */
  arm_yaw: number;
  /** ... with the marker this close to the middle of the picture */
  arm_centre: number;
  // measuring how much the picture moves per unit of yaw stick (frame-widths per second at full stick)
  /** only frames with at least this much yaw in them are used */
  calib_min_yaw: number;
  /** enough of them (sum of squared stick x seconds) before it is trusted */
  calib_min_sum: number;
  /** the measured figure may differ from the assumed one by this factor */
  calib_range: number;
  // return to the marker's axis, from the left/right edge heights (only when the marker is large enough)
  /** wanted return speed (marker-widths per second) per unit of off-axis measure */
  axis_gain: number;
  /** marker size (fraction of frame width, about 48 px of 640) where it starts */
  axis_min_size: number;
  /** ... and where it counts fully (about 64 px) */
  axis_full_size: number;
  /** smoothing of the off-axis measure */
  axis_tau_s: number;
  /** how much of the marker's offset from the picture centre to take off it */
  axis_centre_factor: number;
  // self-check
  /** smoothing of the slide rate used by the self-check */
  measure_tau_s: number;
  /** the second check judges only once the assist is really pushing */
  check_roll: number;
  /** the estimate has sat at the bound for this long ... */
  bound_dwell_s: number;
  /** ... and for this much longer the slide has stayed "not better": */
  worse_s: number;
  /** less than this (marker-widths/s) below the fastest it has been in this run */
  improve_margin: number;
  /** and still at least this fast (marker-widths/s), the way the roll should cure */
  slide_min: number;
  /** second check: marker width/height under this (about 41 degrees) ... */
  aspect_floor: number;
  /** ... having fallen by at least this much since the assist started */
  aspect_drop: number;
  // trim suggestion
  /** mean roll over this long before arrival */
  suggest_window_s: number;
  /** no suggestion from less assist time than this */
  suggest_min_s: number;
}

export const DRIFT_ASSIST_CONFIG_DEFAULTS: Readonly<DriftAssistConfig> = Object.freeze({
  roll_max: 0.15,
  gain: 0.11,
  uncalibrated_gain: 0.5,
  rate_max: 0.3,
  rise_per_s: 1.0,
  arm_window_s: 0.4,
  arm_yaw: 0.08,
  arm_centre: 0.12,
  calib_min_yaw: 0.05,
  calib_min_sum: 6e-4,
  calib_range: 4.0,
  axis_gain: 2.0,
  axis_min_size: 0.075,
  axis_full_size: 0.1,
  axis_tau_s: 0.4,
  axis_centre_factor: 1.0,
  measure_tau_s: 0.8,
  check_roll: 0.06,
  bound_dwell_s: 0.6,
  worse_s: 0.6,
  improve_margin: 0.15,
  slide_min: 0.5,
  aspect_floor: 0.75,
  aspect_drop: 0.1,
  suggest_window_s: 3.0,
  suggest_min_s: 1.0,
});

/** DriftAssistConfig(**overrides) */
export function makeDriftAssistConfig(overrides: Partial<DriftAssistConfig> = {}): DriftAssistConfig {
  return { ...DRIFT_ASSIST_CONFIG_DEFAULTS, ...overrides };
}

export const DISABLED_OFF_AXIS = "off_axis_worsening";

/** Which off-axis measure tripped the self-check. */
export type DisabledBy = "slide" | "aspect";

/**
 * (right edge height - left edge height) / (their sum), from corners TL, TR, BR, BL.
 *
 * The nearer edge of a marker seen from the side looks taller, so this is positive when the camera is
 * to the right of the marker's axis and negative when it is to the left.
 */
export function markerSkew(corners: readonly Corner[]): number {
  if (corners.length !== 4) {
    // Python's tuple unpacking error
    throw new ValueError(
      corners.length > 4
        ? "too many values to unpack (expected 4)"
        : `not enough values to unpack (expected 4, got ${corners.length})`,
    );
  }
  const [tl, tr, br, bl] = corners as readonly [Corner, Corner, Corner, Corner];
  const left = pyHypot(bl[0] - tl[0], bl[1] - tl[1]);
  const right = pyHypot(br[0] - tr[0], br[1] - tr[1]);
  const total = left + right;
  return total > 0 ? (right - left) / total : 0.0;
}

/**
 * Roll command that cancels a steady sideways slide, estimated from the camera only.
 *
 * Slide measure. Between two frames the marker centre moves because the drone yawed and because it slid
 * sideways. The yaw part is known (the commands sent one latency earlier, times how far the picture
 * moves per unit of yaw); what is left over is the slide:
 *
 *     slide = (change of cx + yaw effect) / marker size        [marker-widths, + = drone slid left]
 *
 * Dividing by the marker's size turns frame-widths into marker-widths, i.e. into real sideways distance
 * in units of the printed marker, at any range and without knowing the field of view. A drone that
 * merely starts off to one side and flies straight at the marker shows no slide, so being off-axis is
 * not mistaken for drifting. How far the picture moves per unit of yaw is measured during the run's own
 * first turn toward the marker (least squares over the frames with real yaw in them); until then the
 * steering's assumed figure is used at reduced gain.
 *
 * Control. The roll estimate integrates the slide (roll += gain * slide): it settles where the marker no
 * longer slides. The estimate is clamped to roll_max, which is also the anti-windup: it can never hold
 * more than it is allowed to send.
 *
 * Return to the axis. Cancelling the slide leaves the drone wherever the drift had already carried it.
 * Close enough to resolve it, the marker's left and right edges differ in height (the nearer one is
 * taller); that signed off-axis measure sets a small wanted slide back toward the axis, so the roll also
 * undoes the offset instead of only stopping it from growing.
 *
 * Not fooled by the initial heading error. The first turn toward the marker is large and its yaw effect
 * is only known approximately, so the leftover would be mostly error. The assist stays out until the yaw
 * seen in the video has been small for arm_window_s with the marker near the middle and the pursuit
 * flying forward, and it has to qualify again whenever that stops. No roll is sent while it is not
 * qualified.
 *
 * Self-check. If roll pushes this drone the other way (wrong sign), every bit of roll makes the slide
 * worse, so the estimate runs away to the bound and the slide keeps growing. Two off-axis measures are
 * watched: (1) the slide rate, i.e. how fast the drone is moving off the marker's axis: with roll the
 * right way the slide is fastest before the roll takes hold and then comes down; if the estimate has sat
 * at the bound for bound_dwell_s and for a further worse_s the slide is still as fast as it has ever been
 * in this run, in the direction the roll was meant to cure, the assist is making things worse; (2) the
 * marker's width/height ratio, i.e. how far off the axis the drone already is, falling below
 * aspect_floor while the assist is pushing. Either one switches the assist off for the rest of the run.
 * A drift that is merely stronger than roll_max can cancel does not trip (1): full roll the right way
 * still slows the slide.
 *
 * Limits (camera only). At long range a slow yaw drift of the drone moves the marker in the picture
 * exactly as a sideways slide does; the assist cannot tell them apart and will answer either with roll.
 * A drift stronger than roll_max is only reduced, not cancelled. All of this was tuned in the simulator:
 * on a real drone the gains, the sign of roll and the edge-height measure are unverified until flown.
 *
 * No I/O and no clock: the frame time is always passed in.
 */
export class DriftAssist {
  readonly cfg: DriftAssistConfig;
  private readonly _assumedYawRate: number;

  private _estimate!: number;
  private _out!: number;
  private _armed!: boolean;
  /** (frame time, cx) of the previous frame */
  private _prev!: readonly [number, number] | null;
  /** since when the seen yaw has been small */
  private _quietSince!: number | null;
  /** since when the estimate has sat at the bound */
  private _boundSince!: number | null;
  /** largest and smallest smoothed slide rate seen while the assist was active */
  private _slideHigh!: number;
  private _slideLow!: number;
  private _calibXy!: number;
  private _calibXx!: number;
  /** smoothed, marker-widths per second */
  private _slideRate!: number | null;
  /** smoothed off-axis measure */
  private _axis!: number | null;
  /** smoothed marker width/height */
  private _aspect!: number | null;
  /** ... when the assist first started */
  private _aspectRef!: number | null;
  private _worseSince!: number | null;
  /** (time, roll sent) while active */
  private _sent!: [number, number][];
  private _activeS!: number;
  private _disabledReason!: string | null;
  private _disabledBy!: DisabledBy | null;

  constructor(cfg?: DriftAssistConfig | null, assumedYawRate = 2.5) {
    this.cfg = cfg ?? makeDriftAssistConfig();
    this._assumedYawRate = assumedYawRate;
    this.reset();
  }

  /** Start of a run: forget everything, including a self-disable. */
  reset(): void {
    this._estimate = 0.0;
    this._out = 0.0;
    this._armed = false;
    this._prev = null;
    this._quietSince = null;
    this._boundSince = null;
    this._slideHigh = 0.0;
    this._slideLow = 0.0;
    this._calibXy = 0.0;
    this._calibXx = 0.0;
    this._slideRate = null;
    this._axis = null;
    this._aspect = null;
    this._aspectRef = null;
    this._worseSince = null;
    this._sent = [];
    this._activeS = 0.0;
    this._disabledReason = null;
    this._disabledBy = null;
  }

  // ------------------------------------------------------------------------------------------ //
  /** The roll command last returned. */
  get roll(): number {
    return this._out;
  }

  /** True while the estimate is being updated from the picture. */
  get active(): boolean {
    return this._armed && this._disabledReason === null;
  }

  /** Smoothed slide, marker-widths per second; + means the drone is sliding left. */
  get slideRate(): number | null {
    return this._slideRate;
  }

  /** Frame-widths per second at full yaw stick: measured in this run when possible, else assumed. */
  get yawRate(): number {
    if (this._calibXx < this.cfg.calib_min_sum) return this._assumedYawRate;
    const low = this._assumedYawRate / this.cfg.calib_range;
    const high = this._assumedYawRate * this.cfg.calib_range;
    return pyMax(low, pyMin(high, this._calibXy / this._calibXx));
  }

  get calibrated(): boolean {
    return this._calibXx >= this.cfg.calib_min_sum;
  }

  get disabledReason(): string | null {
    return this._disabledReason;
  }

  /** Which of the two off-axis measures tripped the self-check: "slide" or "aspect". */
  get disabledBy(): DisabledBy | null {
    return this._disabledBy;
  }

  /**
   * Marker lost, no new frame, or the approach is over: send no roll and qualify again later.
   *
   * The estimate is kept (the drift has not gone away); only the output is zero meanwhile.
   */
  pause(): number {
    this._armed = false;
    this._prev = null;
    this._quietSince = null;
    this._boundSince = null;
    this._worseSince = null;
    this._out = 0.0;
    return 0.0;
  }

  /** Mean roll sent over the last suggest_window_s of assist time; null when there is no basis. */
  meanRollNearEnd(): number | null {
    if (this._disabledReason !== null || this._activeS < this.cfg.suggest_min_s || this._sent.length === 0) return null;
    return pySum(this._sent.map((entry) => entry[1])) / this._sent.length;
  }

  // ------------------------------------------------------------------------------------------ //
  /**
   * One visible-marker step while approaching. Returns the roll command, within +-roll_max.
   *
   * `ts` is the frame time, `size` the marker's size (larger edge measure, fraction of the frame width),
   * `aspect` its width/height, `skew` its `markerSkew`, `yawSeen` the integral of the yaw commands whose
   * effect appeared since the previous frame (`Steering.yawSeenBetween`), `flyingForward` whether the
   * pursuit is flying forward.
   */
  update(
    ts: number,
    cx: number,
    size: number,
    aspect: number,
    skew: number,
    yawSeen: number,
    flyingForward: boolean,
  ): number {
    const cfg = this.cfg;
    if (this._disabledReason !== null) return 0.0;
    const previous = this._prev;
    this._prev = [ts, cx];
    if (previous === null || !(0.0 < ts - previous[0] && ts - previous[0] <= 0.3)) {
      this._quietSince = null; // first frame, or a gap: nothing to compare with yet
      return this._out;
    }
    const dt = ts - previous[0];
    const moved = cx - previous[1];
    const sz = pyMax(1e-3, size);

    // how far the picture moves per unit of yaw: learn it from frames with real yaw in them
    if (Math.abs(yawSeen) >= cfg.calib_min_yaw * dt) {
      this._calibXy += -moved * yawSeen;
      this._calibXx += yawSeen * yawSeen;
    }

    const slide = (moved + this.yawRate * yawSeen) / sz;
    const quiet = flyingForward && Math.abs(yawSeen) <= cfg.arm_yaw * dt && Math.abs(cx - 0.5) <= cfg.arm_centre;
    if (!flyingForward) {
      // A turn toward the marker is in progress: the leftover would be mostly error.
      this._armed = false;
      this._quietSince = null;
      this._boundSince = null;
      this._worseSince = null;
    } else if (!quiet) {
      this._quietSince = null;
    } else if (this._quietSince === null) {
      this._quietSince = previous[0];
    }
    if (!this._armed && this._quietSince !== null && ts - this._quietSince >= cfg.arm_window_s) {
      this._armed = true;
      if (this._aspectRef === null) this._aspectRef = aspect;
    }

    if (this._armed) {
      const blend = 1.0 - Math.exp(-dt / pyMax(1e-3, cfg.measure_tau_s));
      const rate = slide / dt;
      this._slideRate = this._slideRate === null ? rate : this._slideRate + (rate - this._slideRate) * blend;
      this._aspect = this._aspect === null ? aspect : this._aspect + (aspect - this._aspect) * blend;
      // The edge heights tell how far the CAMERA is turned from the wall's normal. Where the drone IS
      // also depends on where the marker sits in the picture, so that is taken off (the factor is
      // 0.5 / tan(hfov / 2)^2: 1.0 for a 70 degree lens, and the offset is small).
      const axis = skew / sz - cfg.axis_centre_factor * (cx - 0.5);
      const axisBlend = 1.0 - Math.exp(-dt / pyMax(1e-3, cfg.axis_tau_s));
      this._axis = this._axis === null ? axis : this._axis + (axis - this._axis) * axisBlend;
      const trust = (sz - cfg.axis_min_size) / pyMax(1e-6, cfg.axis_full_size - cfg.axis_min_size);
      const wanted = cfg.axis_gain * this._axis * pyMax(0.0, pyMin(1.0, trust)); // + = slide left, back to the axis
      const gain = cfg.gain * (this.calibrated ? 1.0 : cfg.uncalibrated_gain);
      const step = pyMax(-cfg.rate_max * dt, pyMin(cfg.rate_max * dt, gain * (slide - wanted * dt)));
      this._estimate = pyMax(-cfg.roll_max, pyMin(cfg.roll_max, this._estimate + step));
      this._activeS += dt;
      if (this._check(ts)) return 0.0;
    }

    this._hold(dt);
    if (this._armed) {
      this._sent.push([ts, this._out]);
      while (ts - this._sent[0]![0] > cfg.suggest_window_s) this._sent.shift();
    }
    return this._out;
  }

  /** Send the estimate while qualified (rate-limited on the way up, bounded), else nothing. */
  private _hold(dt: number): number {
    const cfg = this.cfg;
    const target = this._armed ? this._estimate : 0.0;
    this._out = pyMax(-cfg.roll_max, pyMin(cfg.roll_max, limitRise(this._out, target, dt, cfg.rise_per_s)));
    return this._out;
  }

  /** The self-check. Returns true when it has just switched the assist off. */
  private _check(ts: number): boolean {
    const cfg = this.cfg;
    const rate = pyOr(this._slideRate, 0.0);
    this._slideHigh = pyMax(this._slideHigh, rate);
    this._slideLow = pyMin(this._slideLow, rate);
    // Along the roll: positive when the picture still asks for more of what was already added.
    const [along, fastest] = this._estimate >= 0.0 ? [rate, this._slideHigh] : [-rate, -this._slideLow];
    if (Math.abs(this._estimate) < 0.98 * cfg.roll_max) {
      this._boundSince = null;
      this._worseSince = null;
    } else if (this._boundSince === null) {
      this._boundSince = ts;
    } else if (ts - this._boundSince >= cfg.bound_dwell_s) {
      const worse = along >= cfg.slide_min && along > fastest - cfg.improve_margin;
      if (!worse) {
        this._worseSince = null;
      } else if (this._worseSince === null) {
        this._worseSince = ts;
      } else if (ts - this._worseSince >= cfg.worse_s) {
        return this._disable("slide");
      }
    }
    const pushing = Math.abs(this._estimate) >= cfg.check_roll;
    if (
      pushing &&
      this._aspect !== null &&
      this._aspectRef !== null &&
      this._aspect < cfg.aspect_floor &&
      this._aspectRef - this._aspect >= cfg.aspect_drop
    ) {
      return this._disable("aspect");
    }
    return false;
  }

  private _disable(by: DisabledBy): boolean {
    this._disabledReason = DISABLED_OFF_AXIS;
    this._disabledBy = by;
    this._armed = false;
    this._estimate = 0.0;
    this._out = 0.0;
    this._prev = null;
    this._quietSince = null;
    this._sent = [];
    return true;
  }
}
