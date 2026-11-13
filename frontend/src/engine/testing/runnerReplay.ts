// Replays a runner_* fixture (backend/tools/parity_traces.py, "runner_*: mission/runner.py and the mixer
// it drives, recorded call by call") into the TypeScript MissionRunner and ControlMixer, and compares
// every op with what Python did. Used by mission/runner.test.ts.
//
// The link answers what Python's link answered (ReplayLink: the latest frame's timestamp and sequence,
// the telemetry and the mode as recorded before each op; control_up, the toggle, the motor cut and
// calibrate from the op's recorded calls, in order); no simulator is involved. Per op, compared with
// Python: the return value, the mission commands, mission toggles and clear_mission_command calls the
// runner made, the link calls, the store writes (events, run traces, the persisted switches), the log
// lines and, after every op but a mixer tick, the runner's whole public state (snapshot() and the other
// read methods), with object keys in Python's order. Floats within the parity tolerance (1e-9 relative);
// strings, booleans, null and integers exactly.
//
// The line-up's pose fit (vision/pose.ts) cannot agree with numpy to the last bit, so every fit is
// checked on its own with the rule of pose.test.ts (the parity tolerance, or 16 times Python's own
// one-ulp spread, recorded with each fit), and the runner then continues on Python's pose: the rest of
// the line-up is held to the parity tolerance, not to the pose fit's.

import { CareStore, MemoryStorage } from "../care";
import { makeSettings, type AvoidMode, type Settings, type SettingsInit } from "../config";
import type { DroneLink, Frame, Telemetry } from "../drone/link";
import { ControlMixer } from "../mixer";
import { makeAvoidConfig, type AvoidConfig } from "../mission/avoid";
import type { RunnerEventOptions, RunnerStore } from "../mission/ports";
import { makeRunnerConfig, MissionRunner, type RunnerConfig } from "../mission/runner";
import { MemoryLogger } from "../util/log";
import { ValueError } from "../util/num";
import { MarkerObs, Observation, Obstacle, type Corner } from "../vision/marker";
import { makePersonStatus, type PersonBox, type PersonStatus } from "../vision/person";
import { fitSignPose, type SignPose } from "../vision/pose";
import { compareValues, floatsClose, PARITY, type ParityStats } from "./fixtures";
import { FakeClock } from "./harness";

export const POSE_FIELDS = ["lateral_m", "distance_m", "height_m", "yaw_deg", "rms_px"] as const;
/** As vision/pose.test.ts: the largest difference allowed, in units of Python's own one-ulp spread. */
export const SPREAD_FACTOR = 16;

export interface RunnerScenarioInit {
  kind: "scripted" | "closed_loop";
  settings: SettingsInit & Record<string, unknown>;
  runner_config: Partial<RunnerConfig>;
  avoid_config: Partial<AvoidConfig>;
  pilot_check: boolean;
  frame_size: [number, number];
  marker_id: number;
  loads: { arrive_width: number | null; land_on_arrival: boolean; drift_assist: boolean; auto_fly: boolean; avoid: string | null };
  clock: number;
}

export interface RunnerOp {
  o: string;
  t: number;
  [key: string]: unknown;
}

export interface RunnerScenario {
  name: string;
  description: string;
  init: RunnerScenarioInit;
  ops: RunnerOp[];
}

export interface RunnerFixture {
  wall_epoch: number;
  constants: { ABORT_REASONS: string[]; BLOCKERS: string[]; SAFE_LANDING_REASONS: string[]; runner_config: Record<string, unknown> };
  scenarios: RunnerScenario[];
}

type ObsRecord = [ts: number | null, seq: number, marker: [number, number, number, number, number[] | null] | null, obstacles: [string, number, number, number, number][]];

/** What one replay found: counts and the pose-fit statistics. */
export interface ReplayOutcome {
  ops: number;
  steps: number;
  ticks: number;
  fits: number;
  fitsWithinParity: number;
  fitsNeedingSpread: number;
  worstSpreadRatio: number;
  storeWrites: number;
  logs: number;
  states: Set<string>;
  reasons: Set<string>;
}

/** The DroneLink the runner and the mixer see in a replay: Python's recorded answers. */
export class ReplayLink implements DroneLink<null> {
  mode: "sim" | "real" = "sim";
  frame: Frame<null> | null = null;
  tel: Telemetry | null = null;
  /** The op's recorded control_up / toggle / estop / calibrate calls still to come. */
  calls: [string, boolean | null][] = [];
  axesSent = 0;

  private _next(name: string): boolean | null {
    const call = this.calls.shift();
    if (call === undefined) throw new Error(`the runner or mixer called ${name}, which Python did not call here`);
    if (call[0] !== name) throw new Error(`called ${name} where Python called ${call[0]}`);
    return call[1];
  }

  start(): void {}
  stop(): void {}
  setAxes(): void {
    this.axesSent += 1;
  }
  takeoffLandToggle(): boolean {
    return this._next("toggle") === true;
  }
  emergencyStop(): boolean {
    return this._next("estop") === true;
  }
  controlUp(): boolean {
    return this._next("control_up") === true;
  }
  droneSeen(): boolean {
    return true;
  }
  calibrate(): void {
    this._next("calibrate");
  }
  latestFrame(): Frame<null> | null {
    return this.frame;
  }
  telemetry(): Telemetry | null {
    return this.tel;
  }
}

/** The runner's calls into the mixer, recorded on their way through. */
class SpyMixer extends ControlMixer {
  cmd: unknown[] = [];
  mt: unknown[] = [];
  clr: unknown[] = [];

  override missionCommand(yaw: number, pitch: number, now?: number | null, roll = 0.0): void {
    this.cmd.push([yaw, pitch, roll]);
    super.missionCommand(yaw, pitch, now, roll);
  }

  override missionToggle(now?: number | null, landing = true): boolean {
    const result = super.missionToggle(now, landing);
    this.mt.push([landing, result]);
    return result;
  }

  override clearMissionCommand(): void {
    this.clr.push(1);
    super.clearMissionCommand();
  }
}

/** The real CareStore (in memory) with every write recorded as the tool records Python's. */
class RecordingStore implements RunnerStore {
  readonly writes: unknown[] = [];
  readonly inner: CareStore;

  constructor(wallClock: () => number) {
    this.inner = new CareStore(new MemoryStorage(), { wallClock });
  }

  loadArriveWidth(): number | null {
    return this.inner.loadArriveWidth();
  }
  saveArriveWidth(width: number): void {
    this.writes.push(["save_arrive_width", width]);
    this.inner.saveArriveWidth(width);
  }
  loadLandOnArrival(): boolean {
    return this.inner.loadLandOnArrival();
  }
  saveLandOnArrival(enabled: boolean): void {
    this.writes.push(["save_land_on_arrival", enabled]);
    this.inner.saveLandOnArrival(enabled);
  }
  loadDriftAssist(): boolean {
    return this.inner.loadDriftAssist();
  }
  saveDriftAssist(enabled: boolean): void {
    this.writes.push(["save_drift_assist", enabled]);
    this.inner.saveDriftAssist(enabled);
  }
  loadAutoFly(): boolean {
    return this.inner.loadAutoFly();
  }
  saveAutoFly(enabled: boolean): void {
    this.writes.push(["save_auto_fly", enabled]);
    this.inner.saveAutoFly(enabled);
  }
  loadAvoid(): AvoidMode | null {
    return this.inner.loadAvoid();
  }
  saveAvoid(mode: AvoidMode): void {
    this.writes.push(["save_avoid", mode]);
    this.inner.saveAvoid(mode);
  }
  addEvent(eventType: string, options: RunnerEventOptions = {}): unknown {
    this.writes.push(["event", eventType, options.doseId ?? null, options.runId ?? null, options.detail ?? null, options.ts ?? null]);
    return this.inner.addEvent(eventType, options);
  }
  writeRunTrace(runId: string, trace: Record<string, unknown>): unknown {
    this.writes.push(["trace", runId, trace]);
    return this.inner.writeRunTrace(runId, trace);
  }
}

/** A recorded run trace with its run-length encoded sample columns expanded back into sample objects. */
export function expandTrace(trace: Record<string, unknown>): Record<string, unknown> {
  const packed = trace["samples"] as { keys: string[]; n: number; columns: [unknown, number][][] };
  const columns = packed.columns.map((runs) => runs.flatMap(([value, count]) => Array.from({ length: count }, () => value)));
  const samples: Record<string, unknown>[] = [];
  for (let i = 0; i < packed.n; i++) {
    const sample: Record<string, unknown> = {};
    packed.keys.forEach((key, k) => {
      sample[key] = columns[k]![i];
    });
    samples.push(sample);
  }
  return { ...trace, samples };
}

/** Every object's keys in the expected order (Python dicts keep insertion order; so does JSON.parse). */
export function keyOrderProblems(actual: unknown, expected: unknown, path: string, out: string[] = []): string[] {
  if (out.length > 10) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    expected.forEach((item, i) => keyOrderProblems(actual[i], item, `${path}[${i}]`, out));
  } else if (expected !== null && typeof expected === "object" && actual !== null && typeof actual === "object") {
    const a = Object.keys(actual);
    const e = Object.keys(expected);
    if (a.join(",") !== e.join(",")) out.push(`${path}: keys [${a.join(", ")}], Python [${e.join(", ")}]`);
    for (const key of e) {
      keyOrderProblems((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
  }
  return out;
}

/** Python's datetime.fromtimestamp(ts, timezone.utc).strftime("%Y%m%d-%H%M%S") (the tool's run-id stamp). */
export function utcStamp(ts: number): string {
  let whole = Math.floor(ts);
  const x = (ts - whole) * 1e6;
  const floor = Math.floor(x);
  const micro = x - floor > 0.5 || (x - floor === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
  if (micro >= 1_000_000) whole += 1;
  const d = new Date(whole * 1000);
  const p = (v: number, n = 2): string => String(v).padStart(n, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function personOf(row: unknown): PersonStatus {
  const [enabled, detected, count, ts, boxes] = row as [boolean, boolean, number, number | null, number[][]];
  return makePersonStatus({ enabled, detected, count, ts, boxes: boxes.map((b) => [b[0]!, b[1]!, b[2]!, b[3]!] as PersonBox) });
}

/** Replay one scenario. Throws on the first op that differs from Python, with the differences. */
export function replayScenario(fx: RunnerFixture, scenario: RunnerScenario, stats: ParityStats): ReplayOutcome {
  const init = scenario.init;
  const clock = new FakeClock(init.clock);
  const wall = (): number => fx.wall_epoch + clock.t;
  const link = new ReplayLink();
  const mixer = new SpyMixer(link, { clock: clock.now, rateHz: 20.0 });
  const store = new RecordingStore(wall);
  const logger = new MemoryLogger();
  const settings: Settings = makeSettings(init.settings);
  let person: PersonStatus = makePersonStatus();
  let pilot = true;
  let op: RunnerOp = scenario.ops[0]!;
  let label = "";
  let fits: [number[] | null, number[] | null][] = [];
  const outcome: ReplayOutcome = {
    ops: 0,
    steps: 0,
    ticks: 0,
    fits: 0,
    fitsWithinParity: 0,
    fitsNeedingSpread: 0,
    worstSpreadRatio: 0,
    storeWrites: 0,
    logs: 0,
    states: new Set(),
    reasons: new Set(),
  };

  const fitPose = (corners: readonly Corner[], w: number, h: number, size: number, hfov: number): SignPose | null => {
    const mine = fitSignPose(corners, w, h, size, hfov);
    const recorded = fits.shift();
    if (recorded === undefined) throw new Error(`${label}: a pose fit Python did not make`);
    const [out, spread] = recorded;
    outcome.fits += 1;
    if (out === null || mine === null) {
      if ((out === null) !== (mine === null)) throw new Error(`${label}: pose fit ${JSON.stringify(mine)}, Python ${JSON.stringify(out)}`);
      outcome.fitsWithinParity += 1;
      return null;
    }
    let needed = false;
    POSE_FIELDS.forEach((field, i) => {
      const actual = (mine as unknown as Record<string, number>)[field]!;
      const expected = out[i]!;
      if (floatsClose(actual, expected, PARITY)) return;
      const allowed = SPREAD_FACTOR * (spread?.[i] ?? 0);
      const diff = Math.abs(actual - expected);
      if (!(diff <= allowed)) {
        throw new Error(`${label}: pose fit ${field} ${actual}, Python ${expected}: ${diff} is more than ${SPREAD_FACTOR} x Python's one-ulp spread`);
      }
      needed = true;
      outcome.worstSpreadRatio = Math.max(outcome.worstSpreadRatio, diff / (spread?.[i] ?? Infinity));
    });
    if (needed) outcome.fitsNeedingSpread += 1;
    else outcome.fitsWithinParity += 1;
    // continue on Python's answer
    return { lateral_m: out[0]!, distance_m: out[1]!, height_m: out[2]!, yaw_deg: out[3]!, rms_px: out[4]! };
  };

  const avoidOverrides = init.avoid_config;
  const runner = new MissionRunner(link, mixer, store, settings, {
    clock: clock.now,
    wallClock: wall,
    personStatus: () => person,
    config: makeRunnerConfig(init.runner_config),
    pilotConnected: init.pilot_check ? () => pilot : null,
    avoidConfig: Object.keys(avoidOverrides).length > 0 ? makeAvoidConfig({ hfov_deg: settings.camera_hfov_deg, ...avoidOverrides }) : null,
    runId: (wallSeconds) => {
      const rid = op["rid"];
      if (typeof rid !== "string") throw new Error(`${label}: a run id where Python started no run`);
      const stamp = utcStamp(wallSeconds);
      if (!rid.startsWith(`run-${stamp}-`)) throw new Error(`${label}: run id ${rid} does not carry the stamp ${stamp}`);
      return rid;
    },
    fitPose,
    logger,
  });
  mixer.onPilotInput = (kind) => {
    runner.abort(kind === "estop" ? "estop" : "pilot_took_over");
  };

  const loads = {
    arrive_width: store.loadArriveWidth(),
    land_on_arrival: store.loadLandOnArrival(),
    drift_assist: store.loadDriftAssist(),
    auto_fly: store.loadAutoFly(),
    avoid: store.loadAvoid(),
  };
  const loadProblems = compareValues(loads, init.loads, PARITY, `${scenario.name}.loads`);
  if (loadProblems.length > 0) throw new Error(loadProblems.join("\n"));

  let expectedState: Record<string, unknown> = {};
  let lastTick: unknown = null;
  let previousCorners: number[] | null = null;
  const [frameW, frameH] = init.frame_size;

  const publicState = (now: number): Record<string, unknown> => ({
    ...runner.snapshot(now),
    _obstacles: runner.obstaclesSnapshot(now),
    _hover: runner.hoverSnapshot(now),
    _settings: runner.settings(),
    _ready_for_dose: runner.readyForDose,
    _auto_fly: runner.autoFly,
    _avoid_mode: runner.avoidMode,
    _arrive_width: runner.arriveWidth,
    _state: runner.state,
    _reason: runner.reason,
  });

  const decodeObs = (rec: ObsRecord | null): Observation | null => {
    if (rec === null) return null;
    const [tsRec, seq, m, boxes] = rec;
    const ts = tsRec === null ? op.t : tsRec;
    let marker: MarkerObs | null = null;
    if (m !== null) {
      const flat = m[4] ?? previousCorners;
      if (flat === null) throw new Error(`${label}: repeated corners before any`);
      previousCorners = flat;
      const corners: Corner[] = [0, 1, 2, 3].map((i) => [flat[2 * i]!, flat[2 * i + 1]!] as Corner);
      marker = new MarkerObs({ id: init.marker_id, cx: m[0], cy: m[1], width: m[2], height: m[3], corners, ts, frame_w: frameW, frame_h: frameH });
    }
    const obstacles = boxes.map(([kind, x1, y1, x2, y2]) => new Obstacle({ kind, box: [x1, y1, x2, y2], ts }));
    return new Observation({ ts, seq, marker, obstacles });
  };

  const fail = (problems: string[]): void => {
    if (problems.length === 0) return;
    const shown = problems.slice(0, 12).join("\n  ");
    throw new Error(`${label}: ${problems.length} difference(s) from Python\n  ${shown}`);
  };

  scenario.ops.forEach((current, index) => {
    op = current;
    label = `${scenario.name} op ${index} (${op.o} at t=${op.t})`;
    outcome.ops += 1;
    clock.t = op.t;
    // what the link showed before the op
    const obsRec = (op["obs"] ?? null) as ObsRecord | null;
    if ("f" in op) {
      if (op["f"] === 1) {
        if (obsRec === null) throw new Error(`${label}: "f": 1 without an observation`);
        link.frame = { payload: null, timestamp: obsRec[0] === null ? op.t : obsRec[0], seq: obsRec[1] };
      } else if (op["f"] === null) {
        link.frame = null;
      } else {
        const [timestamp, seq] = op["f"] as [number, number];
        link.frame = { payload: null, timestamp, seq };
      }
    }
    if ("tel" in op) {
      const tel = op["tel"] as [number, number, number, number] | null;
      link.tel = tel === null ? null : { fly_state_raw: tel[0], battery_raw: tel[1], flags_raw: tel[2], timestamp: tel[3] };
    }
    if ("mode" in op) link.mode = op["mode"] as "sim" | "real";
    if ("person" in op) person = personOf(op["person"]);
    if ("pilot" in op && op["pilot"] !== null) pilot = op["pilot"] as boolean;
    link.calls = ((op["lk"] as [string, boolean | null][] | undefined) ?? []).map((c) => [c[0], c[1]]);
    fits = ((op["fits"] as [number[] | null, number[] | null][] | undefined) ?? []).slice();
    mixer.cmd = [];
    mixer.mt = [];
    mixer.clr = [];
    const writesBefore = store.writes.length;
    const logsBefore = logger.entries.length;

    let out: unknown = undefined;
    try {
      switch (op.o) {
        case "s":
          outcome.steps += 1;
          runner.step(decodeObs(obsRec), op.t);
          break;
        case "k":
          outcome.ticks += 1;
          out = [...mixer.tick(op.t)];
          break;
        case "start":
          out = runner.start(op["c"] as boolean, op["d"] as string | null, op.t, op["a"] as boolean);
          break;
        case "abort":
          out = runner.abort(op["r"] as string, op.t);
          break;
        case "set": {
          const name = op["n"] as string;
          const value = op["v"];
          if (name === "land_on_arrival") out = runner.setLandOnArrival(value as boolean);
          else if (name === "drift_assist") out = runner.setDriftAssist(value as boolean);
          else if (name === "auto_fly") out = runner.setAutoFly(value as boolean);
          else if (name === "avoid") out = runner.setAvoid(value as string);
          else throw new Error(`unknown setting ${name}`);
          break;
        }
        case "hover":
          out = runner.startHoverTest(op.t);
          break;
        case "calibrate":
          out = runner.calibrateArrival(op.t);
          break;
        case "ready":
          out = runner.markReadyForDose();
          break;
        case "note":
          runner.notePilotInput();
          out = null;
          break;
        case "blockers":
          out = runner.blockers(op.t);
          break;
        case "flush":
          runner.flush();
          out = null;
          break;
        case "pilot_axes": {
          const [throttle, yaw, pitch, roll] = op["v"] as [number, number, number, number];
          mixer.pilotAxes(throttle, yaw, pitch, roll, op.t);
          out = null;
          break;
        }
        case "pilot_toggle": {
          const r = mixer.pilotToggle(op.t);
          out = [r.ok, r.message, r.code];
          break;
        }
        case "pilot_estop":
          out = mixer.pilotEstop(op.t);
          break;
        case "estop_reset":
          mixer.estopReset();
          out = null;
          break;
        case "pilot_disconnect":
          mixer.pilotDisconnect();
          out = null;
          break;
        case "set_trim": {
          const [roll, pitch] = op["v"] as [number, number];
          out = mixer.setTrim(roll, pitch);
          break;
        }
        case "settings":
          Object.assign(settings, op["v"] as Record<string, unknown>);
          out = null;
          break;
        default:
          throw new Error(`unknown op ${op.o}`);
      }
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      out = { error: "ValueError", message: error.message };
    }

    const problems: string[] = [];
    if (op.o === "k") {
      const expected = "out" in op ? op["out"] : lastTick;
      compareValues(out, expected, PARITY, "out", stats, problems);
      lastTick = expected;
    } else if ("out" in op) {
      compareValues(out, op["out"], PARITY, "out", stats, problems);
    }
    compareValues(mixer.cmd, op["cmd"] ?? [], PARITY, "mission_command", stats, problems);
    compareValues(mixer.mt, op["mt"] ?? [], PARITY, "mission_toggle", stats, problems);
    compareValues(mixer.clr, op["clr"] ?? [], PARITY, "clear_mission_command", stats, problems);
    if (link.calls.length > 0) problems.push(`link calls Python made and TypeScript did not: ${JSON.stringify(link.calls)}`);
    if (fits.length > 0) problems.push(`${fits.length} pose fit(s) Python made and TypeScript did not`);
    const writes = store.writes.slice(writesBefore);
    const expectedWrites = ((op["store"] as unknown[][] | undefined) ?? []).map((w) =>
      w[0] === "trace" ? [w[0], w[1], expandTrace(w[2] as Record<string, unknown>)] : w,
    );
    outcome.storeWrites += writes.length;
    compareValues(writes, expectedWrites, PARITY, "store", stats, problems);
    keyOrderProblems(writes, expectedWrites, "store", problems);
    const logs = logger.entries.slice(logsBefore);
    outcome.logs += logs.length;
    compareValues(logs, op["log"] ?? [], PARITY, "log", stats, problems);
    if (op.o !== "k") {
      const changed = (op["S"] as Record<string, unknown> | undefined) ?? {};
      expectedState = { ...expectedState, ...changed };
      const state = publicState(op.t);
      compareValues(state, expectedState, PARITY, "state", stats, problems);
      if (Object.keys(state).join(",") !== Object.keys(expectedState).join(",")) {
        problems.push(`state: keys [${Object.keys(state).join(", ")}], Python [${Object.keys(expectedState).join(", ")}]`);
      }
      for (const key of Object.keys(changed)) keyOrderProblems(state[key], changed[key], `state.${key}`, problems);
      outcome.states.add(runner.state);
      if (runner.reason !== null) outcome.reasons.add(runner.reason);
    }
    fail(problems);
  });
  return outcome;
}

/** The fixture's groups, for the test. */
export const RUNNER_GROUPS = ["runner_scripted", "runner_quick", "runner_manual", "runner_auto", "runner_avoid"] as const;
