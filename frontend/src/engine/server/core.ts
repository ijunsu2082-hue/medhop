// Ports MedHopCore of backend/medhop/server.py: it owns every long-lived object (simulator, sign detector,
// mixer, mission runner, care store and monitor, the vision bookkeeping), steps them, holds the pilot slot,
// runs the care housekeeping and builds the status document. engine.ts drives it (the loop, speed, frames).
//
// How it is built, as Python builds it for the interactive simulator (Settings.from_env with MEDHOP_DRONE=sim
// and nothing else set, then build_link):
//   settings   Settings defaults with avoid "hold" (from_env's simulator default)
//   link       SimLink(SimConfig.high_quality(marker_id, marker_size_m, reset_pose_on_takeoff=True,
//              start_distance_m=3.2)), the display camera profile; realtime rules on
//   detector   SignDetector with its display-profile defaults (vision/detector.ts), looking for marker_id
//   mixer      ControlMixer(link, rate 20 Hz, trim from the store, on_pilot_input = _on_pilot_input)
//   runner     MissionRunner(link, mixer, store, settings, person_status = disabled, pilot_connected)
//   monitor    CareMonitor(store, grace_min)
//
// One step is exactly SimHarness.step of backend/tests/harness.py (and engine/testing/missionHarness.ts):
// advance the simulator 1/60 s; on a new frame detect the sign, record the frame as the vision worker does and
// step the runner with the Observation; otherwise step the runner with null every 0.05 s; tick the mixer at
// 20 Hz.
//
// Differences from Python:
// - One thread: the vision thread, the mixer thread, the simulator thread and the housekeeping thread are all
//   calls from engine.ts, in virtual time (the housekeeping in wall-clock time).
// - The simulator's and the detector's noise come from PythonRandom(seed) and PythonRandom(seed + 1) (Python
//   seeds the simulator from the OS); the person check is always off (there is no detector for people).
// - The care store keeps its data in the browser's storage (care/store.ts), with the demo seeding rule and the
//   event cap of demoData.ts. Trim and arrival calibration are session-only there (care/store.ts).

import { fromTimestamp, formatDate } from "../care/localTime";
import { CareMonitor, careSnapshot, secondsSinceDoseTime } from "../care/status";
import { CareStore, STORAGE_KEYS, type PublicEvent } from "../care/store";
import { GuardedStorage, MemoryStorage, type KeyValueStorage } from "../care/storage";
import { makeSettings, type Settings } from "../config";
import { highQualitySimConfig, SimLink, type SimSnapshot } from "../drone/sim";
import { ControlMixer, type PilotInputKind } from "../mixer";
import { HOVER_TEST, MissionRunner, RUN_STATES, type ObstacleSnapshot } from "../mission/runner";
import { SILENT_LOGGER, type Logger } from "../util/log";
import { radians } from "../util/num";
import { PythonRandom } from "../util/rng";
import { estimatedBrightness, obstaclesOf, SignDetector } from "../vision/detector";
import { Observation, type MarkerObs } from "../vision/marker";
import { NO_PERSON } from "../vision/person";
import { handleControl, handleControlText, type ControlReply } from "./control";
import { CappedEventsStorage, dosesAhead, markSeeded, reseedSchedule, seededOn } from "./demoData";
import { buildStatus, simSnapshot, type EngineStatus, type StatusSim } from "./status";
import { VisionBook } from "./visionBook";

/** automatic flights only start this soon after the dose time */
export const AUTO_FLY_FRESH_S = 90.0;
/** blocker: a simulator-only request on the real drone (never here: this engine is always the simulator) */
export const NOT_SIMULATOR = "not_simulator";
export const PHYSICS_DT = 1.0 / 60.0;
export const CONTROL_DT = 1.0 / 20.0;
export const IDLE_STEP_S = 0.05;

/** What the runner was told about one released frame, for the camera drawing. */
export interface SteppedFrame {
  readonly view: SimSnapshot;
  readonly marker: MarkerObs | null;
  readonly obstacles: readonly ObstacleSnapshot[];
  /** the frame's arrival time on the virtual clock */
  readonly ts: number;
}

export interface CoreOptions {
  /** the virtual (monotonic) clock, seconds */
  clock: () => number;
  /** unix seconds */
  wallClock: () => number;
  /** the browser's storage, or null: memory only */
  storage: KeyValueStorage | null;
  /** seeds the simulator's and the detector's noise */
  seed: number;
  logger?: Logger;
  /** told about every frame the runner was stepped with */
  onFrame?: ((frame: SteppedFrame) => void) | null;
  /** told about every accepted axes message from the pilot */
  onPilotAxes?: ((values: readonly [number, number, number, number]) => void) | null;
}

export class EngineCore {
  readonly settings: Settings;
  readonly link: SimLink;
  readonly detector: SignDetector;
  readonly mixer: ControlMixer;
  readonly store: CareStore;
  readonly runner: MissionRunner;
  readonly careMonitor: CareMonitor;
  readonly vision = new VisionBook();

  private readonly _clock: () => number;
  private readonly _wallClock: () => number;
  private readonly _logger: Logger;
  private readonly _demoStorage: GuardedStorage;
  private readonly _onFrame: ((frame: SteppedFrame) => void) | null;
  private readonly _onPilotAxes: ((values: readonly [number, number, number, number]) => void) | null;
  private _pilotConnected = false;
  private _lastSeq = 0;
  private _nextTick: number;
  private _lastRunnerStep: number;
  private _seededDay: string;

  constructor(options: CoreOptions) {
    this._clock = options.clock;
    this._wallClock = options.wallClock;
    this._logger = options.logger ?? SILENT_LOGGER;
    this._onFrame = options.onFrame ?? null;
    this._onPilotAxes = options.onPilotAxes ?? null;
    this.settings = makeSettings({ avoid: "hold" });

    // The care store, on the browser's storage with the demo rules (demoData.ts).
    const base = options.storage ?? new MemoryStorage();
    this._demoStorage = new GuardedStorage(base, this._logger);
    const nowLocal = this.nowLocal();
    const hadSchedule = this._demoStorage.getItem(STORAGE_KEYS.schedule) !== null;
    this.store = new CareStore(new CappedEventsStorage(base), {
      wallClock: this._wallClock,
      seedDoses: dosesAhead(nowLocal),
      logger: this._logger,
    });
    this._seededDay = formatDate(nowLocal);
    if (hadSchedule && seededOn(this._demoStorage) !== this._seededDay) reseedSchedule(this.store, nowLocal);
    if (!hadSchedule || seededOn(this._demoStorage) !== this._seededDay) markSeeded(this._demoStorage, nowLocal);

    const s = this.settings;
    this.link = new SimLink(
      highQualitySimConfig({
        marker_id: s.marker_id,
        marker_size_m: s.marker_size_m,
        reset_pose_on_takeoff: true,
        start_distance_m: 3.2,
      }),
      { clock: this._clock, realtime: true, rng: new PythonRandom(options.seed), logger: this._logger },
    );
    this.detector = new SignDetector(this.link.cfg, { marker_id: s.marker_id, rng: new PythonRandom(options.seed + 1) });
    this.mixer = new ControlMixer(this.link, {
      rateHz: s.control_rate,
      clock: this._clock,
      trim: this.store.loadTrim(),
      onPilotInput: (kind) => this._onPilotInput(kind),
      logger: this._logger,
    });
    this.runner = new MissionRunner(this.link, this.mixer, this.store, s, {
      clock: this._clock,
      wallClock: this._wallClock,
      personStatus: () => NO_PERSON,
      pilotConnected: () => this.pilotConnected(),
      logger: this._logger,
    });
    this.careMonitor = new CareMonitor(this.store, s.grace_min);
    this._nextTick = this._clock();
    this._lastRunnerStep = this._clock();
  }

  now(): number {
    return this._clock();
  }

  /** Python now_local(): datetime.fromtimestamp(wall_clock()). */
  nowLocal(): Date {
    return fromTimestamp(this._wallClock());
  }

  // ------------------------------------------------------------------------------------------ //
  // stepping

  /** One physics step; `now` is the virtual clock after it advanced by PHYSICS_DT. */
  step(now: number): void {
    this.link.advanceTo(now);
    const frame = this.link.latestFrame();
    if (frame !== null && frame.seq !== this._lastSeq) {
      this._lastSeq = frame.seq;
      const marker = this.detector.detect(frame.payload, frame.timestamp);
      const brightness = estimatedBrightness(this.link.cfg, frame.payload);
      const obs = new Observation({
        ts: frame.timestamp,
        seq: frame.seq,
        marker,
        brightness,
        obstacles: obstaclesOf(frame),
      });
      this.vision.record(now, frame.timestamp, frame.seq, marker, brightness);
      this._lastRunnerStep = now;
      this.runner.step(obs, now);
      if (this._onFrame !== null) {
        this._onFrame({ view: frame.payload, marker, obstacles: this.runner.obstaclesSnapshot(now), ts: frame.timestamp });
      }
    } else if (now - this._lastRunnerStep >= IDLE_STEP_S) {
      this._lastRunnerStep = now;
      this.runner.step(null, now);
    }
    if (now + 1e-9 >= this._nextTick) {
      this.mixer.tick(now);
      this._nextTick += CONTROL_DT;
    }
  }

  // ------------------------------------------------------------------------------------------ //
  // housekeeping (wall clock)

  /**
   * The housekeeping thread's body, once: a new local day reseeds the demo schedule (demoData.ts), then the
   * care monitor's tick and the automatic-flight rule. Returns the events the monitor wrote.
   */
  housekeeping(): PublicEvent[] {
    try {
      const now = this.nowLocal();
      const day = formatDate(now);
      if (day !== this._seededDay) {
        this._seededDay = day;
        reseedSchedule(this.store, now);
        markSeeded(this._demoStorage, now);
      }
      const written = this.careMonitor.tick(now);
      this._autoFlyForDue(written, now);
      return written;
    } catch (error) {
      this._logger.log("error", `care monitor failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Automatic flights (Python _auto_fly_for_due): a dose that has just come due starts an automatic station
   * run, only within AUTO_FLY_FRESH_S of the dose time, only when a person has marked the drone ready on its
   * start spot, and not for a dose that already has an arrival logged. Otherwise it logs why it did not.
   */
  private _autoFlyForDue(written: readonly PublicEvent[], now: Date): void {
    if (!this.runner.autoFly) return;
    for (const event of written) {
      if (event.type !== "reminder_due" || !event.dose_id) continue;
      const doseId = event.dose_id;
      const dose = this.store.getDose(doseId);
      if (dose === null) continue;
      let reasons: string[] = [];
      const lateS = secondsSinceDoseTime(dose, now);
      if (lateS > AUTO_FLY_FRESH_S) reasons.push("stale_due");
      const status = careSnapshot(this.store, now, this.settings.grace_min).doses.find((d) => d.id === doseId);
      if (status !== undefined && status.arrived_at) reasons.push("already_arrived");
      if (!this.runner.readyForDose) reasons.push("not_ready");
      if (reasons.length === 0) {
        const [started, blockers] = this.runner.start(false, doseId, null, true);
        if (started) {
          this._logger.log("info", `dose ${doseId} is due: automatic station run started`);
          continue;
        }
        reasons = blockers;
      }
      this._logger.log("warning", `dose ${doseId} is due but the automatic run did not start: ${reasons.join(", ")}`);
      this.store.addEvent("auto_run_skipped", { doseId, detail: { blockers: reasons } });
    }
  }

  // ------------------------------------------------------------------------------------------ //
  // pilot

  private _onPilotInput(kind: PilotInputKind): void {
    this.runner.abort(kind === "estop" ? "estop" : "pilot_took_over");
    this.runner.notePilotInput(); // not known to be on its start spot any more
  }

  claimPilot(): boolean {
    if (this._pilotConnected) return false;
    this._pilotConnected = true;
    return true;
  }

  pilotConnected(): boolean {
    return this._pilotConnected;
  }

  /**
   * The pilot's control connection is gone: zero the pilot axes and stop anything that is flying itself,
   * because nobody can press stop any more. Neutral sticks, never the toggle.
   */
  releasePilot(): void {
    this.mixer.pilotDisconnect();
    this._pilotConnected = false;
    if (this.runner.abort("pilot_link_lost")) {
      this._logger.log("warning", "pilot control link lost while the drone was flying itself: stopped");
    }
  }

  /** handle_control (control.ts) on this core's mixer. */
  handleControl(message: unknown): ControlReply | null {
    return handleControl(this.mixer, message, this._onPilotAxes ?? undefined);
  }

  handleControlText(text: string): ControlReply | null {
    return handleControlText(this.mixer, text, this._onPilotAxes ?? undefined);
  }

  // ------------------------------------------------------------------------------------------ //
  // status and the simulator

  status(): EngineStatus {
    return buildStatus({
      now: this._clock(),
      wallNow: this._wallClock(),
      nowLocal: this.nowLocal(),
      settings: this.settings,
      link: this.link,
      mixer: this.mixer,
      vision: this.vision,
      person: NO_PERSON,
      runner: this.runner,
      store: this.store,
    });
  }

  simSnapshot(): StatusSim | null {
    return simSnapshot(this.link);
  }

  /** Put a named scenario's actors in the corridor. Returns blockers, or null. Throws KeyError for an unknown name. */
  setScenario(name: string): string[] | null {
    if (this.link.mode !== "sim") return [NOT_SIMULATOR];
    if (RUN_STATES.includes(this.runner.state) || this.runner.state === HOVER_TEST) return ["already_running"];
    this.link.setScenario(name);
    return null;
  }

  /** Metres from the sign of the spot a run lands on: the arrive width through the camera model. */
  landingDistanceM(): number {
    const half = radians(this.settings.camera_hfov_deg) / 2.0;
    return this.settings.marker_size_m / (2.0 * Math.tan(half) * this.runner.arriveWidth);
  }

  /** Clean shutdown (Python stop()): stop steering, send neutral, never the toggle. */
  shutdown(): void {
    try {
      this.runner.abort("pilot_took_over");
      this.runner.flush();
    } catch {
      this._logger.log("error", "could not stop the mission runner cleanly");
    }
    this.link.stop();
  }
}
