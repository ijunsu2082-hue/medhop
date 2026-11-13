// Ports SimHarness of backend/tests/harness.py as far as it goes without the mission runner: the
// closed-loop shell that runs the simulator, the vision step and the mixer in simulated time on one
// thread (no sleeping, fully repeatable for a given seed). Checked against Python by simHarness.test.ts
// (fixture: __fixtures__/sim_harness.json, backend/tools/parity_traces.py sim_harness, which runs the
// real SimHarness.step with a scripted stand-in for the runner and the true corners for the detector).
//
// The runner plugs in through `onObservation(obs, now)`, called exactly where Python calls
// `self.runner.step(obs, now)`: with the new frame's Observation when a frame arrived in this step,
// otherwise with null when 0.05 s have passed since the last call. The runner port should also set
// `harness.mixer.onPilotInput` (Python: `lambda kind: runner.abort("estop" if kind == "estop" else
// "pilot_took_over")`) and add run_until_state on top of `run`.
//
// Differences from Python: the detector is the synthetic SignDetector (vision/detector.ts), which reads
// the frame's pose snapshot instead of decoding a JPEG; Observation.brightness is an estimate
// (detector.ts estimatedBrightness, or the `brightness` option) because there is no picture to average;
// no CareStore, PersonStatus or temporary data directory (they belong to the runner's port).

import { makeSettings, type Settings } from "../config";
import { makeSimConfig, SimLink, type SimConfig, type SimSnapshot } from "../drone/sim";
import { ControlMixer, type Axes } from "../mixer";
import type { Logger } from "../util/log";
import { PythonRandom, type RandomSource } from "../util/rng";
import { estimatedBrightness, obstaclesOf, SignDetector, type SignDetectorOptions } from "../vision/detector";
import { Observation } from "../vision/marker";
import { FakeClock } from "./harness";

/** An arbitrary wall-clock origin for simulated runs (tests/harness.py WALL_EPOCH). */
export const WALL_EPOCH = 1_794_000_000.0;

/** Where the runner plugs in: Python's runner.step(obs, now). */
export type ObservationHook = (obs: Observation | null, now: number) => void;

export interface SimHarnessOptions {
  /** default makeSimConfig({ seed: 0 }) (Python: SimConfig(seed=0)) */
  simConfig?: SimConfig;
  /** default makeSettings({ person_check: "off" }); the detector looks for settings.marker_id */
  settings?: Settings;
  /** the synthetic detector's options (marker_id defaults to settings.marker_id) */
  detector?: SignDetectorOptions;
  /** probability that a frame's detection is thrown away, drawn from PythonRandom(dropoutSeed) like Python's random.Random */
  markerDropout?: number;
  dropoutSeed?: number;
  onObservation?: ObservationHook | null;
  /** Observation.brightness for a frame (default: estimatedBrightness of the sim config) */
  brightness?: (snapshot: SimSnapshot) => number;
  /** the simulator's noise generator (default PythonRandom(simConfig.seed ?? 0)) */
  simRng?: RandomSource;
  logger?: Logger;
}

export class SimHarness {
  static readonly PHYSICS_DT = 1.0 / 60.0;
  static readonly CONTROL_DT = 1.0 / 20.0;

  readonly clock = new FakeClock();
  readonly settings: Settings;
  readonly sim: SimLink;
  readonly mixer: ControlMixer;
  readonly detector: SignDetector;
  readonly markerDropout: number;
  /** The runner's step. Set it (or pass it in the options) before running. */
  onObservation: ObservationHook | null;
  /** (now, axes) of every mixer tick */
  readonly sent: [now: number, axes: Axes][] = [];
  readonly observations: Observation[] = [];

  private readonly _dropoutRng: PythonRandom;
  private readonly _brightness: (snapshot: SimSnapshot) => number;
  private _lastSeq = 0;
  private _nextTick: number;
  private _lastRunnerStep: number;

  constructor(options: SimHarnessOptions = {}) {
    this.markerDropout = options.markerDropout ?? 0.0;
    this._dropoutRng = new PythonRandom(options.dropoutSeed ?? 0);
    this.settings = options.settings ?? makeSettings({ person_check: "off" });
    const config = options.simConfig ?? makeSimConfig({ seed: 0 });
    this.sim = new SimLink(config, {
      clock: this.clock.now,
      realtime: false,
      ...(options.simRng ? { rng: options.simRng } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.mixer = new ControlMixer(this.sim, {
      rateHz: 20.0,
      clock: this.clock.now,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.detector = new SignDetector(this.sim.cfg, { marker_id: this.settings.marker_id, ...options.detector });
    this.onObservation = options.onObservation ?? null;
    const cfg = this.sim.cfg;
    this._brightness = options.brightness ?? ((snap) => estimatedBrightness(cfg, snap));
    this._nextTick = this.clock.t;
    this._lastRunnerStep = this.clock.t;
  }

  /** The wall clock of a simulated run. */
  wall(): number {
    return WALL_EPOCH + this.clock.t;
  }

  /**
   * One physics step (1/60 s): advance the simulator; on a new frame build its Observation (marker,
   * brightness, obstacles) and hand it to the runner, else hand the runner null every 0.05 s; tick the
   * mixer every 0.05 s.
   */
  step(): void {
    const now = this.clock.advance(SimHarness.PHYSICS_DT);
    this.sim.advanceTo(now);
    const frame = this.sim.latestFrame();
    if (frame !== null && frame.seq !== this._lastSeq) {
      this._lastSeq = frame.seq;
      let marker = this.detector.detect(frame.payload, frame.timestamp);
      if (this.markerDropout > 0 && this._dropoutRng.random() < this.markerDropout) marker = null;
      const obs = new Observation({
        ts: frame.timestamp,
        seq: frame.seq,
        marker,
        brightness: this._brightness(frame.payload),
        obstacles: obstaclesOf(frame),
      });
      this.observations.push(obs);
      this.onObservation?.(obs, now);
      this._lastRunnerStep = now;
    } else if (now - this._lastRunnerStep >= 0.05) {
      this.onObservation?.(null, now);
      this._lastRunnerStep = now;
    }
    if (now + 1e-9 >= this._nextTick) {
      this.sent.push([now, this.mixer.tick(now)]);
      this._nextTick += SimHarness.CONTROL_DT;
    }
  }

  /** Advance simulated time. Returns true when `until` became true. */
  run(seconds: number, until?: (harness: SimHarness) => boolean): boolean {
    const end = this.clock.t + seconds;
    while (this.clock.t < end) {
      this.step();
      if (until !== undefined && until(this)) return true;
    }
    return false;
  }

  /** Let the first frames arrive before a run is started. */
  warmUp(seconds = 1.0): void {
    this.run(seconds);
  }

  lastSent(): Axes {
    const last = this.sent[this.sent.length - 1];
    if (last === undefined) throw new RangeError("no axes sent yet");
    return last[1];
  }
}
