// Ports the fakes of backend/tests/harness.py that the engine's tests need: FakeClock and RecordingLink.
// (SimHarness, the closed-loop simulator harness, belongs with the simulator port.)

import type { Mode } from "../../api/types";
import type { DroneLink, Frame, Telemetry } from "../drone/link";
import type { Axes } from "../mixer";

/** Starts at 1000 s like the Python FakeClock: some timestamps start at zero and assume a clock far from it. */
export class FakeClock {
  t: number;

  constructor(t = 1000.0) {
    this.t = t;
  }

  /** The clock function to inject (Python: the FakeClock instance itself is callable). */
  readonly now = (): number => this.t;

  advance(dt: number): number {
    this.t += dt;
    return this.t;
  }
}

/**
 * A DroneLink that records every call. Tests set `frame` and `tel` directly, and `control`
 * (controlUp), `seen` (droneSeen) and `mode` ("real" to test real-drone rules).
 */
export class RecordingLink<P = unknown> implements DroneLink<P> {
  mode: Mode = "sim";
  readonly axes: Axes[] = [];
  toggles = 0;
  estops = 0;
  calibrations = 0;
  frame: Frame<P> | null = null;
  tel: Telemetry | null = null;
  started = false;
  stopped = false;
  private seq = 0;
  /** what controlUp() reports */
  control = true;
  /** what droneSeen() reports */
  seen = true;
  /** what each emergencyStop() call returned */
  readonly estopResults: boolean[] = [];

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.setAxes(0.0, 0.0, 0.0, 0.0);
    this.stopped = true;
  }

  setAxes(throttle: number, yaw: number, pitch: number, roll: number): void {
    this.axes.push([throttle, yaw, pitch, roll]);
  }

  takeoffLandToggle(): boolean {
    this.toggles += 1;
    return this.control;
  }

  emergencyStop(): boolean {
    this.estops += 1;
    this.estopResults.push(this.control);
    return this.control;
  }

  controlUp(): boolean {
    return this.control;
  }

  droneSeen(): boolean {
    return this.seen;
  }

  calibrate(): void {
    this.calibrations += 1;
  }

  latestFrame(): Frame<P> | null {
    return this.frame;
  }

  telemetry(): Telemetry | null {
    return this.tel;
  }

  /** Python new_frame(now, jpeg=b""): the payload defaults to null here. */
  newFrame(now: number, payload: P | null = null): Frame<P | null> {
    this.seq += 1;
    const frame: Frame<P | null> = { payload, timestamp: now, seq: this.seq };
    this.frame = frame as Frame<P>;
    return frame;
  }

  get last(): Axes {
    const last = this.axes[this.axes.length - 1];
    if (last === undefined) throw new RangeError("no axes sent yet");
    return last;
  }
}
