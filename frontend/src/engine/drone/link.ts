// Ports the DroneLink interface of backend/medhop/drone/base.py (SPEC section 3).
//
// All stick values are true stick fractions in [-1, 1].
// Signs: +throttle up, +yaw turn right, +pitch forward, +roll right.
//
// Differences from Python: Frame carries a generic `payload` instead of `jpeg: bytes` (a browser frame
// carries a pose snapshot of the simulated scene rather than an encoded picture); method names are
// camelCase. `clamp` lives in util/num.ts and is re-exported here, where Python defines it.

import type { Mode } from "../../api/types";

export { clamp } from "../util/num";

export interface Frame<P = unknown> {
  /** What the frame shows. Python: `jpeg` (encoded bytes); in the browser, for example, a pose snapshot. */
  readonly payload: P;
  /** The link's monotonic clock domain (seconds). */
  readonly timestamp: number;
  readonly seq: number;
}

/** Raw status bytes. Units and meanings are NOT verified. (Not the status JSON's Telemetry in api/types.ts.) */
export interface Telemetry {
  readonly fly_state_raw: number;
  readonly battery_raw: number;
  readonly flags_raw: number;
  readonly timestamp: number;
}

export interface DroneLink<P = unknown> {
  /** "sim" or "real". */
  mode: Mode;
  start(): void;
  /** Must send neutral axes first. Never sends the toggle. */
  stop(): void;
  /** Only ControlMixer may call this. */
  setAxes(throttle: number, yaw: number, pitch: number, roll: number): void;
  /**
   * ONE shared toggle: takes off on the ground, lands in the air.
   * Returns true when the command went onto an open socket, false when the link was down.
   */
  takeoffLandToggle(): boolean;
  /** Motor cut. The drone falls. True when the command went onto an open socket, false when the link was down. */
  emergencyStop(): boolean;
  /** True while commands can reach the drone (the control socket is open). */
  controlUp(): boolean;
  /** True once anything (a video frame or an MCU message) has been received from the drone. */
  droneSeen(): boolean;
  /** Gyro calibrate, flat ground only. */
  calibrate(): void;
  latestFrame(): Frame<P> | null;
  telemetry(): Telemetry | null;
}
