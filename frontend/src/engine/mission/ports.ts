// What the mission runner (runner.ts, the port of backend/medhop/mission/runner.py) needs from the
// things around it, as small interfaces, so tests can pass fakes and the engine can pass the real ones.
//
//   RunnerStore     the parts of CareStore (engine/care, the port of backend/medhop/care/store.py) the
//                   runner reads and writes: the persisted switches, the arrive-width calibration, the
//                   event log and the per-run traces. The real CareStore satisfies it as it is.
//   RunnerMixer     the parts of ControlMixer (engine/mixer.ts) it calls. The real ControlMixer satisfies it.
//   PersonStatusProvider, PilotConnected, RunIdGenerator: the injected callables of the Python
//                   constructor (person_status, pilot_connected) and the run-id stamp, which Python
//                   builds from datetime.fromtimestamp(wall_clock()) and secrets.token_hex(2).

import type { AvoidMode } from "../config";
import { localFields } from "../care/localTime";
import type { PersonStatus } from "../vision/person";

/** What CareStore.addEvent takes (Python add_event's keyword arguments). */
export interface RunnerEventOptions {
  doseId?: string | null;
  runId?: string | null;
  detail?: Record<string, unknown> | null;
  /** unix seconds */
  ts?: number | null;
}

/** The store as the runner uses it. engine/care's CareStore implements every method. */
export interface RunnerStore {
  /** The stored arrive width, or null (none stored, or outside 0.03..0.8). */
  loadArriveWidth(): number | null;
  saveArriveWidth(width: number): void;
  /** Off unless the stored value says exactly true. */
  loadLandOnArrival(): boolean;
  saveLandOnArrival(enabled: boolean): void;
  loadDriftAssist(): boolean;
  saveDriftAssist(enabled: boolean): void;
  loadAutoFly(): boolean;
  saveAutoFly(enabled: boolean): void;
  /** "off" or "hold", or null when none is stored (the settings' default applies then). */
  loadAvoid(): AvoidMode | null;
  /** Throws ValueError for anything but "off" or "hold". */
  saveAvoid(mode: AvoidMode): void;
  /** Append an event (types: run_started, arrived_at_station, run_aborted, hover_test, ...). The result is not used. */
  addEvent(eventType: string, options?: RunnerEventOptions): unknown;
  /** Store a run's trace (the result is not used). */
  writeRunTrace(runId: string, trace: Record<string, unknown>): unknown;
}

/** The mixer as the runner uses it. engine/mixer.ts's ControlMixer implements every member. */
export interface RunnerMixer {
  readonly estopActive: boolean;
  /** Time since the last takeoff/land toggle (pilot or mission); null if never. */
  secondsSinceToggle(now?: number | null): number | null;
  /** True only when the toggle went onto an open socket. */
  missionToggle(now?: number | null, landing?: boolean): boolean;
  missionCommand(yaw: number, pitch: number, now?: number | null, roll?: number): void;
  clearMissionCommand(): void;
  /** [roll, pitch] */
  trim(): [roll: number, pitch: number];
}

/** Python `person_status`: the latest person-check result. */
export type PersonStatusProvider = () => PersonStatus;

/** Python `pilot_connected`: whether a pilot control socket is connected. Omitted (null): no check. */
export type PilotConnected = () => boolean;

/** Builds a run id from the wall clock (unix seconds) at the start of a run. */
export type RunIdGenerator = (wallSeconds: number) => string;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Python: f"run-{datetime.fromtimestamp(wall).strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}". The
 * stamp is local time (care/localTime.ts reads it the way CPython does); the four hex digits come from
 * `random` (default Math.random; Python uses the OS's secure generator, but the id only has to tell
 * runs apart).
 */
export function pythonRunId(wallSeconds: number, random: () => number = Math.random): string {
  const f = localFields(wallSeconds);
  const stamp = `${pad(f.year, 4)}${pad(f.month, 2)}${pad(f.day, 2)}-${pad(f.hour, 2)}${pad(f.minute, 2)}${pad(Math.floor(f.second), 2)}`;
  const token = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `run-${stamp}-${token}`;
}
