// Ports backend/medhop/drone/sim.py: SimConfig (the drone-like defaults and high_quality()) and SimLink,
// the 2-D kinematic drone simulator, in its stepped mode (`advance_to(now)` with an injected clock).
// Checked step by step against Python by sim.test.ts (fixture: __fixtures__/sim_physics.json, written
// by backend/tools/parity_traces.py sim_physics, with the simulator's noise set to zero).
//
// World frame: the station wall is the plane z = 0, x runs along the wall (positive to the right when
// facing it), y is up. The drone flies at z < 0, so its distance to the wall is -z. Heading 0 faces the
// wall; positive heading is a turn to the right (camera/projection.ts has the camera model).
//
// What a frame is here: the payload of every Frame is the SimSnapshot taken when the frame was CAPTURED
// (pose, camera height with the hover bob, the hide-marker hook, the actors where they were), released
// `video_delay_s` later, exactly when Python releases the JPEG it renders from the same snapshot.
// Frame.obstacles carries the actors' boxes like Python's Frame.obstacles. Nothing is drawn here: a
// canvas renderer draws the payload, and vision/detector.ts turns it into a MarkerObs.
//
// Differences from Python:
// - No thread and no lock: `start()` does nothing, the caller calls advanceTo(now) (Python's _run loop
//   in realtime mode calls advance_to every 4 ms). `realtime: true` keeps the two realtime rules of
//   advance_to (a gap over 0.5 s is not replayed; when several captures are due only the newest one is
//   kept), so a browser tab that was asleep does not replay minutes of physics.
// - The clock must be passed in. The noise generator is a RandomSource (default PythonRandom(seed ?? 0),
//   deterministic, where Python's default_rng(None) is seeded from the OS): numpy's generator cannot be
//   reproduced, so with noise on the run differs from Python's; with the noise at zero it is the same.
// - The config is copied: set_drift and set_scenario change the link's own config, where Python's change
//   the SimConfig object the caller passed in.
// - The snapshot carries `t`, the capture time (Python's snapshot dict does not hold it).
// - The scene is not built (no textures, no sign pyramid); the scene name is still checked as in Python
//   and `focal` and `K` are the same as Python's _focal and _K.
// - Log lines go to an optional Logger.

import type { Mode } from "../../api/types";
import { cameraExtrinsics, cameraMatrix, focalLength, type Mat3 } from "../camera/projection";
import { SILENT_LOGGER, type Logger } from "../util/log";
import { clamp, degrees, pyMax, pyMin, pyOr, pyStrRepr, radians, ValueError } from "../util/num";
import { PythonRandom, type RandomSource } from "../util/rng";
import type { DroneLink, Frame, FrameObstacle, Telemetry } from "./link";
import { actorBoxes, footprintDistance, scenarioByName, type Actor } from "./simActors";

export const PHYSICS_STEP_S = 1.0 / 60.0;

export const GROUND = "ground";
export const TAKING_OFF = "taking_off";
export const AIRBORNE = "airborne";
export const LANDING = "landing";
export type SimPhase = typeof GROUND | typeof TAKING_OFF | typeof AIRBORNE | typeof LANDING;

/** "plain": drone-like wall and floor; "room": the rendered room of sim_scene.py. */
export const SIM_SCENES = ["plain", "room"] as const;

/** SimConfig with the Python field names. Plain data: makeSimConfig / highQualitySimConfig build one. */
export interface SimConfig {
  // dynamics
  /** m/s at full pitch stick */
  forward_gain: number;
  /** m/s at full roll stick */
  lateral_gain: number;
  /** deg/s at full yaw stick */
  yaw_gain_deg: number;
  /** m/s at full throttle stick */
  climb_gain: number;
  /** first-order lag of the velocities */
  velocity_lag_s: number;
  yaw_lag_s: number;
  /** constant body-frame drift, m/s, + is to the drone's right */
  lateral_drift: number;
  /** m/s, slowly varying */
  noise_velocity: number;
  /** deg/s, slowly varying */
  noise_yaw_deg: number;
  // camera (the picture settings are kept for a renderer; the simulator itself only uses the geometry)
  width: number;
  height: number;
  fps: number;
  hfov_deg: number;
  jpeg_quality: number;
  /** sigma, grey levels */
  sensor_noise: number;
  blur_sigma: number;
  /** scene brightness gain */
  light: number;
  /** "plain" or "room" */
  scene: string;
  /** room scene: render this many times larger, then scale down */
  supersample: number;
  /** room scene: darkening toward the corners (0 = none) */
  vignette: number;
  // transport: command delay + video delay = command-to-video latency (about 0.45 s)
  command_delay_s: number;
  video_delay_s: number;
  // world
  marker_id: number;
  marker_size_m: number;
  /** height of the marker centre on the wall */
  marker_height_m: number;
  hover_height_m: number;
  takeoff_s: number;
  land_s: number;
  // start pose
  start_distance_m: number;
  start_x_m: number;
  start_heading_deg: number;
  start_airborne: boolean;
  /** Put the drone back at the start pose on every takeoff from the ground (the interactive simulator). */
  reset_pose_on_takeoff: boolean;
  /** Seeds the default noise generator (null: 0 here; Python seeds from the OS). */
  seed: number | null;
  /** Simulated people and objects (simActors.ts). Empty by default. */
  actors: readonly Actor[];
}

/** SimConfig(): the drone-like profile. */
export const SIM_CONFIG_DEFAULTS: Readonly<SimConfig> = Object.freeze({
  forward_gain: 1.0,
  lateral_gain: 1.0,
  yaw_gain_deg: 150.0,
  climb_gain: 0.5,
  velocity_lag_s: 0.25,
  yaw_lag_s: 0.12,
  lateral_drift: 0.08,
  noise_velocity: 0.02,
  noise_yaw_deg: 1.0,
  width: 640,
  height: 360,
  fps: 15.0,
  hfov_deg: 70.0,
  jpeg_quality: 50,
  sensor_noise: 6.0,
  blur_sigma: 0.8,
  light: 1.0,
  scene: "plain",
  supersample: 1,
  vignette: 0.0,
  command_delay_s: 0.1,
  video_delay_s: 0.35,
  marker_id: 7,
  marker_size_m: 0.18,
  marker_height_m: 1.0,
  hover_height_m: 1.0,
  takeoff_s: 1.5,
  land_s: 1.2,
  start_distance_m: 2.5,
  start_x_m: 0.0,
  start_heading_deg: 0.0,
  start_airborne: false,
  reset_pose_on_takeoff: false,
  seed: null,
  actors: Object.freeze([]) as readonly Actor[],
});

/** SimConfig(**init): the drone-like defaults with the given fields replaced. */
export function makeSimConfig(init: Partial<SimConfig> = {}): SimConfig {
  return { ...SIM_CONFIG_DEFAULTS, ...init, actors: [...(init.actors ?? SIM_CONFIG_DEFAULTS.actors)] };
}

/**
 * SimConfig.high_quality(**overrides): the display camera profile, a rendered room at 1280x720, 15 fps,
 * a clean picture. The interactive simulator uses it by default.
 */
export function highQualitySimConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return makeSimConfig({
    width: 1280,
    height: 720,
    fps: 15.0,
    jpeg_quality: 92,
    sensor_noise: 1.2,
    blur_sigma: 0.0,
    scene: "room",
    supersample: 2,
    vignette: 0.16,
    ...overrides,
  });
}

/**
 * What a frame shows: Python's _snapshot() dict, taken when the frame is captured, plus `t`.
 * Everything a renderer needs besides the SimConfig (frame size, lens, marker geometry, light).
 */
export interface SimSnapshot {
  /** camera position along the wall, metres */
  readonly x: number;
  /** camera position, metres (negative: the wall is at 0) */
  readonly z: number;
  /** radians, 0 faces the wall, positive turns right */
  readonly heading: number;
  /** camera height above the floor: altitude + 0.04 m, plus a 0.015 m bob at 0.7 Hz while flying */
  readonly cam_y: number;
  /** the drop_marker test hook: the sign is not drawn */
  readonly marker_hidden: boolean;
  /** the actors where they were at capture time */
  readonly actors: readonly Actor[];
  /** capture time on the link's clock (not in Python's snapshot); for testSnapshot, the current time */
  readonly t: number;
}

/** SimLink.pose(): simulator truth. */
export interface SimPose {
  readonly x_m: number;
  readonly distance_m: number;
  readonly heading_deg: number;
  readonly altitude_m: number;
  readonly phase: SimPhase;
  readonly airborne: boolean;
}

/** set_pose's keyword arguments; a missing (or null) one is left as it is. */
export interface SetPoseOptions {
  distance_m?: number | null;
  x_m?: number | null;
  heading_deg?: number | null;
  airborne?: boolean | null;
}

export interface SimLinkOptions {
  /** Monotonic seconds; used to stamp commands as they are sent (set_axes, toggle, e-stop). */
  clock: () => number;
  /** Python's realtime flag (default false: the stepped mode). See the header. */
  realtime?: boolean;
  /** Draws the velocity and yaw noise (default PythonRandom(config.seed ?? 0)). */
  rng?: RandomSource;
  logger?: Logger;
  /**
   * Inspection hook (not in Python): called with every snapshot as it is captured, before its transport
   * delay; in realtime mode also with the captures that are then dropped. Not for drawing: draw what
   * latestFrame() releases.
   */
  onCapture?: ((snapshot: SimSnapshot) => void) | null;
}

type Axes4 = readonly [throttle: number, yaw: number, pitch: number, roll: number];
type InboxItem = readonly [t: number, kind: "axes" | "toggle" | "estop", payload: Axes4 | null];

interface Pending {
  readonly releaseT: number;
  readonly snapshot: SimSnapshot;
  readonly boxes: readonly FrameObstacle[];
}

export class SimLink implements DroneLink<SimSnapshot> {
  mode: Mode = "sim";
  /** The link's own copy of the config (set_drift and setScenario change it). */
  readonly cfg: SimConfig;
  /** SimLink._focal, pixels */
  readonly focal: number;
  /** SimLink._K */
  readonly K: Mat3;

  // counters for tests (Python: toggle_count, estop_count, calibrate_count, last_axes_sent)
  toggleCount = 0;
  estopCount = 0;
  calibrateCount = 0;
  lastAxesSent: Axes4 = [0.0, 0.0, 0.0, 0.0];

  private readonly _clock: () => number;
  private readonly _realtime: boolean;
  private readonly _rng: RandomSource;
  private readonly _logger: Logger;
  private readonly _onCapture: ((snapshot: SimSnapshot) => void) | null;

  // pose and motion state
  private _x: number;
  private _z: number;
  private _heading: number;
  private _phase: SimPhase;
  private _alt: number;
  private _vFwd = 0.0;
  private _vLat = 0.0;
  private _vYaw = 0.0;
  private _nFwd = 0.0;
  private _nLat = 0.0;
  private _nYaw = 0.0;
  /** throttle, yaw, pitch, roll currently acting on the drone */
  private _axes: Axes4 = [0.0, 0.0, 0.0, 0.0];
  private _inbox: InboxItem[] = [];
  private _flightTime = 0.0;
  private _batteryRaw = 42;

  // clocks
  private _t: number | null = null;
  private _nextFrameT = 0.0;
  private _nextTelemetryT = 0.0;

  // video
  private _pending: Pending[] = [];
  private _frame: Frame<SimSnapshot> | null = null;
  private _seq = 0;
  private _videoFrozen = false;
  private _markerHidden = false;
  /** m/s for a forced landing; null uses cfg.land_s */
  private _landRate: number | null = null;
  private _telemetry: Telemetry | null = null;
  // actors: their own clock starts at the takeoff (or at the first step when starting airborne)
  private _actors: readonly Actor[];
  private _scenario: string;
  private readonly _defaultStartDistance: number;
  private _actorOrigin: number | null = null;

  constructor(config: SimConfig = makeSimConfig(), options: SimLinkOptions) {
    this.cfg = { ...config, actors: [...config.actors] };
    this._clock = options.clock;
    this._realtime = options.realtime ?? false;
    this._rng = options.rng ?? new PythonRandom(this.cfg.seed ?? 0);
    this._logger = options.logger ?? SILENT_LOGGER;
    this._onCapture = options.onCapture ?? null;

    const c = this.cfg;
    this._x = c.start_x_m;
    this._z = -Math.abs(c.start_distance_m);
    this._heading = radians(c.start_heading_deg);
    this._phase = c.start_airborne ? AIRBORNE : GROUND;
    this._alt = c.start_airborne ? c.hover_height_m : 0.0;
    this._actors = [...c.actors];
    this._scenario = this._actors.length > 0 ? "custom" : "empty";
    this._defaultStartDistance = c.start_distance_m;

    // _build_scene: the camera is the same for both scenes
    if (!(SIM_SCENES as readonly string[]).includes(c.scene)) {
      throw new ValueError(`SimConfig.scene must be 'plain' or 'room', got ${pyStrRepr(c.scene)}`);
    }
    this.focal = focalLength(c.width, c.hfov_deg);
    this.K = cameraMatrix(c.width, c.height, c.hfov_deg);
  }

  // ------------------------------------------------------------------------------------------ //
  // DroneLink API

  /** Nothing to start: the caller steps the simulator with advanceTo(now). */
  start(): void {}

  stop(): void {
    this.setAxes(0.0, 0.0, 0.0, 0.0);
  }

  setAxes(throttle: number, yaw: number, pitch: number, roll: number): void {
    const axes: Axes4 = [clamp(throttle), clamp(yaw), clamp(pitch), clamp(roll)];
    this.lastAxesSent = axes;
    this._inbox.push([this._clock(), "axes", axes]);
  }

  takeoffLandToggle(): boolean {
    this.toggleCount += 1;
    this._inbox.push([this._clock(), "toggle", null]);
    return true;
  }

  emergencyStop(): boolean {
    this.estopCount += 1;
    this._inbox.push([this._clock(), "estop", null]);
    return true;
  }

  controlUp(): boolean {
    return true;
  }

  droneSeen(): boolean {
    return true;
  }

  calibrate(): void {
    this.calibrateCount += 1;
  }

  latestFrame(): Frame<SimSnapshot> | null {
    return this._frame;
  }

  telemetry(): Telemetry | null {
    return this._telemetry;
  }

  // ------------------------------------------------------------------------------------------ //
  // test hooks

  /**
   * Simulate the drone landing by itself (as it does on low battery). `descentMS` gives a slower sink
   * than the normal landing, so the marker stays in the picture for a while.
   */
  forceAutoLand(dropBattery = false, descentMS: number | null = null): void {
    if (this._phase === AIRBORNE || this._phase === TAKING_OFF) {
      this._phase = LANDING;
      this._landRate = descentMS === null ? null : Math.abs(descentMS);
    }
    if (dropBattery) this._batteryRaw = 30;
  }

  freezeVideo(frozen = true): void {
    this._videoFrozen = frozen;
  }

  /** Hide the sign (the drop_marker hook): frames captured while hidden have marker_hidden set. */
  dropMarker(hidden = true): void {
    this._markerHidden = hidden;
  }

  setPose(options: SetPoseOptions = {}): void {
    const { distance_m, x_m, heading_deg, airborne } = options;
    if (distance_m !== undefined && distance_m !== null) this._z = -Math.abs(distance_m);
    if (x_m !== undefined && x_m !== null) this._x = x_m;
    if (heading_deg !== undefined && heading_deg !== null) this._heading = radians(heading_deg);
    if (airborne !== undefined && airborne !== null) {
      this._phase = airborne ? AIRBORNE : GROUND;
      this._alt = airborne ? this.cfg.hover_height_m : 0.0;
      // A toggle or motor cut still travelling to the drone must not undo the forced state.
      this._inbox = this._inbox.filter((item) => item[1] === "axes");
    }
    this._vFwd = 0.0;
    this._vLat = 0.0;
    this._vYaw = 0.0;
  }

  setDrift(lateralMS: number): void {
    this.cfg.lateral_drift = lateralMS;
  }

  /** Python's int(value): truncated toward zero. */
  setBatteryRaw(value: number): void {
    this._batteryRaw = Math.trunc(value);
  }

  pose(): SimPose {
    return {
      x_m: this._x,
      distance_m: -this._z,
      heading_deg: degrees(this._heading),
      altitude_m: this._alt,
      phase: this._phase,
      airborne: this._phase === AIRBORNE,
    };
  }

  /** The current simulated time (null before the first advanceTo). */
  get now(): number | null {
    return this._t;
  }

  // ------------------------------------------------------------------------------------------ //
  // stepping

  /** Advance physics, capture due frames and release frames whose transport delay has passed. */
  advanceTo(now: number): void {
    const captures: [number, SimSnapshot][] = [];
    if (this._t === null) {
      this._t = now;
      this._nextFrameT = now;
      this._nextTelemetryT = now;
      if (this._phase === AIRBORNE) this._actorOrigin = now; // started in the air: the actors' clock starts now
    }
    if (now - this._t > 0.5 && this._realtime) {
      this._t = now - 0.5; // the process was paused; do not replay the gap
      this._nextFrameT = pyMax(this._nextFrameT, this._t);
    }
    while (this._t + PHYSICS_STEP_S <= now + 1e-9) {
      this._physics(PHYSICS_STEP_S);
      this._t += PHYSICS_STEP_S;
      if (this._t + 1e-9 >= this._nextFrameT) {
        const snap = this._snapshot();
        captures.push([this._t, snap]);
        this._onCapture?.(snap);
        this._nextFrameT += 1.0 / this.cfg.fps;
      }
      if (this._t + 1e-9 >= this._nextTelemetryT) {
        this._telemetry = {
          fly_state_raw: this._alt > 0.15 ? 1 : 0,
          battery_raw: this._batteryRaw,
          flags_raw: 16,
          timestamp: this._t,
        };
        this._nextTelemetryT += 0.5;
      }
    }
    const due = this._realtime && captures.length > 1 ? captures.slice(-1) : captures;
    for (const [t, snap] of due) {
      this._pending.push({ releaseT: t + this.cfg.video_delay_s, snapshot: snap, boxes: this._boxes(snap) });
    }
    while (this._pending.length > 0 && this._pending[0]!.releaseT <= now + 1e-9) {
      const { releaseT, snapshot, boxes } = this._pending.shift()!;
      if (this._videoFrozen) continue;
      this._seq += 1;
      this._frame = { payload: snapshot, timestamp: releaseT, seq: this._seq, obstacles: boxes };
    }
  }

  private _physics(dt: number): void {
    const c = this.cfg;
    const t = this._t!;
    // commands take effect after the command delay
    while (this._inbox.length > 0 && this._inbox[0]![0] <= t - c.command_delay_s + 1e-9) {
      const [, kind, payload] = this._inbox.shift()!;
      if (kind === "axes") {
        this._axes = payload!;
      } else if (kind === "toggle") {
        if (this._phase === GROUND || this._phase === LANDING) {
          if (this._phase === GROUND && c.reset_pose_on_takeoff) {
            this._x = c.start_x_m;
            this._z = -Math.abs(c.start_distance_m);
            this._heading = radians(c.start_heading_deg);
          }
          if (this._phase === GROUND) this._actorOrigin = t; // the actors' clock starts at the takeoff
          this._phase = TAKING_OFF;
        } else {
          this._phase = LANDING;
          this._landRate = null;
        }
      } else {
        this._phase = GROUND;
        this._alt = 0.0;
      }
    }

    const [throttle, yaw, pitch, roll] = this._axes;
    if (this._phase === TAKING_OFF) {
      this._alt += (c.hover_height_m / c.takeoff_s) * dt;
      if (this._alt >= c.hover_height_m) {
        this._alt = c.hover_height_m;
        this._phase = AIRBORNE;
      }
    } else if (this._phase === LANDING) {
      const rate = this._landRate === null ? c.hover_height_m / c.land_s : this._landRate;
      this._alt -= rate * dt;
      if (this._alt <= 0.0) {
        this._alt = 0.0;
        this._phase = GROUND;
      }
    } else if (this._phase === AIRBORNE) {
      this._alt = pyMin(1.9, pyMax(0.3, this._alt + throttle * c.climb_gain * dt));
    }

    const flying = this._alt > 0.15;
    if (!flying) {
      this._vFwd = 0.0;
      this._vLat = 0.0;
      this._vYaw = 0.0;
      return;
    }

    this._flightTime += dt;
    if (this._flightTime >= 60.0) {
      this._flightTime -= 60.0;
      this._batteryRaw = pyMax(0, this._batteryRaw - 1);
    }

    // slowly varying disturbances (Ornstein-Uhlenbeck, 1 s correlation time)
    const k = Math.sqrt(2.0 * dt);
    this._nFwd += -this._nFwd * dt + c.noise_velocity * k * this._rng.normal();
    this._nLat += -this._nLat * dt + c.noise_velocity * k * this._rng.normal();
    this._nYaw += -this._nYaw * dt + radians(c.noise_yaw_deg) * k * this._rng.normal();

    const aV = 1.0 - Math.exp(-dt / pyMax(1e-3, c.velocity_lag_s));
    const aY = 1.0 - Math.exp(-dt / pyMax(1e-3, c.yaw_lag_s));
    this._vFwd += (pitch * c.forward_gain - this._vFwd) * aV;
    this._vLat += (roll * c.lateral_gain + c.lateral_drift - this._vLat) * aV;
    this._vYaw += (yaw * radians(c.yaw_gain_deg) - this._vYaw) * aY;

    const vFwd = this._vFwd + this._nFwd;
    const vLat = this._vLat + this._nLat;
    this._heading += (this._vYaw + this._nYaw) * dt;
    const sinH = Math.sin(this._heading);
    const cosH = Math.cos(this._heading);
    this._x += (vFwd * sinH + vLat * cosH) * dt;
    this._z += (vFwd * cosH - vLat * sinH) * dt;
    this._z = pyMin(this._z, -0.15); // cannot pass through the wall
    this._z = pyMax(this._z, -7.5);
    this._x = pyMin(4.5, pyMax(-4.5, this._x));
  }

  private _snapshot(): SimSnapshot {
    const t = pyOr(this._t, 0.0);
    const bob = this._alt > 0.15 ? 0.015 * Math.sin(2.0 * Math.PI * 0.7 * t) : 0.0;
    return {
      x: this._x,
      z: this._z,
      heading: this._heading,
      cam_y: this._alt + 0.04 + bob,
      marker_hidden: this._markerHidden,
      actors: this._actorsAt(this._t),
      t: this._t ?? 0.0,
    };
  }

  private _actorsAt(t: number | null): readonly Actor[] {
    if (this._actors.length === 0) return [];
    const since = this._actorOrigin === null || t === null ? null : t - this._actorOrigin;
    return this._actors.map((actor) => actor.at(since));
  }

  // ------------------------------------------------------------------------------------------ //
  // actors (scenarios)

  get scenario(): string {
    return this._scenario;
  }

  /**
   * Put a named scenario's actors (simActors.SCENARIOS) in the corridor, with its start distance (the
   * next takeoff from the ground starts there when reset_pose_on_takeoff is on; a drone on the ground is
   * carried there now). The actors' clock starts again at the next takeoff, or now when the drone is
   * already in the air. Throws KeyError for an unknown name.
   */
  setScenario(name: string): void {
    const scenario = scenarioByName(name);
    this._actors = [...scenario.actors];
    this._scenario = scenario.name;
    const start = scenario.start_distance_m === null ? this._defaultStartDistance : scenario.start_distance_m;
    this.cfg.start_distance_m = start;
    if (this._phase === GROUND) {
      this._actorOrigin = null;
      this._x = this.cfg.start_x_m;
      this._z = -Math.abs(this.cfg.start_distance_m);
      this._heading = radians(this.cfg.start_heading_deg);
    } else {
      this._actorOrigin = this._t;
    }
    this._logger.log("info", `simulator scenario: ${scenario.name} (${scenario.actors.length} actors)`);
  }

  /** Test hook: put these actors in the corridor (their clock starts now when originNow). */
  setActors(actors: readonly Actor[], originNow = true): void {
    this._actors = [...actors];
    this._scenario = this._actors.length > 0 ? "custom" : "empty";
    if (originNow) this._actorOrigin = this._t;
  }

  /** The actors where they are now (simulator truth). */
  actorsNow(): Actor[] {
    return [...this._actorsAt(this._t)];
  }

  /**
   * Simulator truth: horizontal distance from the drone to the nearest actor's footprint; null without
   * actors.
   */
  clearanceM(): number | null {
    const actors = this._actorsAt(this._t);
    if (actors.length === 0) return null;
    const distances = actors.map((a) => footprintDistance(a, this._x, -this._z));
    return pyMin(distances[0]!, ...distances.slice(1));
  }

  /** The actors' boxes in this snapshot, through the output camera (Python's _boxes). */
  private _boxes(snap: SimSnapshot): FrameObstacle[] {
    if (snap.actors.length === 0) return [];
    const { position, rot } = cameraExtrinsics(snap);
    return actorBoxes(snap.actors, position, rot, this.K, this.cfg.width, this.cfg.height);
  }

  /**
   * render_test_frame's snapshot: an arbitrary hovering pose with the actors where they are now (for
   * detection tests). Python renders it to a JPEG; here the snapshot is what a renderer would draw.
   */
  testSnapshot(distanceM: number, xM = 0.0, headingDeg = 0.0): SimSnapshot {
    return {
      x: xM,
      z: -Math.abs(distanceM),
      heading: radians(headingDeg),
      cam_y: this.cfg.hover_height_m + 0.04,
      marker_hidden: false,
      actors: this._actorsAt(this._t),
      t: this._t ?? 0.0,
    };
  }
}
