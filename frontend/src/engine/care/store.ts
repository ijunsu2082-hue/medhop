// Ports backend/medhop/care/store.py: the dose schedule, the event log, trim, arrival calibration,
// the mission settings and the per-run traces, kept in a KeyValueStorage instead of files.
//
//   Python file          key                              kind          default
//   schedule.json        medhop.v1.schedule               schedule      persisted
//   events.jsonl         medhop.v1.events                 events        persisted
//   mission.json         medhop.v1.mission                mission       persisted
//   trim.json            medhop.v1.trim                   trim          session only
//   calibration.json     medhop.v1.calibration            calibration   session only
//   runs/<run_id>.json   medhop.v1.runs.<run_id>          runs          session only
//
// A session-only kind lives in memory and is never read from or written to the storage, so a bad
// stored value can never break a later visit. The values have the Python file formats: the schedule
// is {"doses": [...], "next_id": n}, the event log is JSON lines, one event per line, so a damaged
// line spoils only itself, exactly as in events.jsonl. A value that is not valid JSON is set aside
// under `<key>.corrupt-<unix time>` and then treated as missing, as Python renames a corrupt file.
//
// Errors are those of the Python: ValueError (re-exported from util/num) with the same message for a
// bad value, KeyError for an unknown dose id in updateDose. Storage failures never throw (see
// GuardedStorage in storage.ts).
//
// Deliberate differences from the Python, all on hand-edited or non-finite data only:
//   - JSON is standard JSON: Python also reads and writes NaN and Infinity; here a non-finite number
//     is written as null and a NaN literal makes a value unreadable (set aside like a corrupt file).
//   - An event line whose dose_id or run_id is neither a string nor null loads with null there
//     (Python keeps the odd value, and an unhashable one, a list, crashes its status code).
//   - A next_id of 1e400 (infinite) counts as invalid, where Python's int() raises OverflowError and
//     the store fails to open.

import type { CareEvent, EventType, ScheduleDose, ScheduleDoseInput } from "../../api/types";
import { SILENT_LOGGER, type Logger } from "../util/log";
import { pyStrRepr, pyTupleRepr, ValueError } from "../util/num";
import { timeLocal } from "./localTime";
import {
  codePointLength,
  compareStrings,
  digitsToBigInt,
  isJsonObject,
  ND_DIGIT,
  pyFloatOf,
  pyIntOf,
  pyStrip,
  pyStrOf,
  pyTruthy,
} from "./pyCompat";
import { GuardedStorage, MemoryStorage, type KeyValueStorage } from "./storage";

export { ValueError };
export { timeLocal };

export const EVENT_TYPES = [
  "reminder_due",
  "run_started",
  "arrived_at_station",
  "run_aborted",
  "pickup_acknowledged",
  "needs_attention",
  "hover_test",
  "auto_run_skipped", // a dose came due with automatic flights on, but the run could not start
] as const satisfies readonly EventType[];

export const SEED_DOSES: readonly Readonly<ScheduleDoseInput>[] = Object.freeze([
  Object.freeze({ time: "08:00", label: "Morning dose (demo)", notes: "" }),
  Object.freeze({ time: "13:00", label: "Midday dose (demo)", notes: "" }),
  Object.freeze({ time: "20:00", label: "Evening dose (demo)", notes: "" }),
]);

export const LABEL_MAX = 80;
export const NOTES_MAX = 300;

/** Obstacle avoidance modes (AVOID_MODES of backend/medhop/config.py). */
export const AVOID_MODES = ["off", "hold"] as const;
export type AvoidMode = (typeof AVOID_MODES)[number];

/** Python: re.compile(r"^([01]\d|2[0-3]):[0-5]\d$"), where \d is any Unicode decimal digit. */
const TIME_RE = new RegExp(`^([01]${ND_DIGIT}|2[0-3]):[0-5]${ND_DIGIT}$`, "u");
/** Python: re.fullmatch(r"d(\d+)", ...) in _next_id. */
const DOSE_ID_RE = new RegExp(`^d(${ND_DIGIT}+)$`, "u");

/** Python's KeyError(key): the message is repr(key), as str(KeyError("x")) is "'x'". */
export class KeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(pyStrRepr(key));
    this.name = "KeyError";
    this.key = key;
  }
}

export function validateTime(value: unknown): string {
  if (typeof value !== "string" || !TIME_RE.test(pyStrip(value))) {
    throw new ValueError("time must be 24-hour HH:MM");
  }
  return pyStrip(value);
}

export function validateLabel(value: unknown): string {
  if (typeof value !== "string" || !pyStrip(value)) throw new ValueError("label must not be empty");
  if (codePointLength(pyStrip(value)) > LABEL_MAX) {
    throw new ValueError(`label must be at most ${LABEL_MAX} characters`);
  }
  return pyStrip(value);
}

/** null (Python None) and undefined give "". The length limit applies before stripping, as in Python. */
export function validateNotes(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new ValueError("notes must be text");
  if (codePointLength(value) > NOTES_MAX) throw new ValueError(`notes must be at most ${NOTES_MAX} characters`);
  return pyStrip(value);
}

/** An event as the store keeps it (what eventsBetween returns). */
export interface StoredEvent {
  /** unix seconds */
  ts: number;
  type: string;
  dose_id: string | null;
  run_id: string | null;
  detail: Record<string, unknown>;
}

/** An event as events(), addEvent() and CareMonitor.tick() return it (SPEC section 7). */
export interface PublicEvent extends CareEvent {
  detail: Record<string, unknown>;
}

/** The mission settings as stored (every key optional; only exact `true` switches a setting on). */
export interface MissionSettingsRecord {
  drift_assist?: boolean;
  land_on_arrival?: boolean;
  auto_fly?: boolean;
  avoid?: AvoidMode;
}

export type CareDataKind = "schedule" | "events" | "mission" | "trim" | "calibration" | "runs";

export const CARE_DATA_KINDS: readonly CareDataKind[] = ["schedule", "events", "mission", "trim", "calibration", "runs"];

export const STORAGE_PREFIX = "medhop.v1.";

/** The storage key of each kind (run traces: RUN_TRACE_PREFIX + run id). */
export const STORAGE_KEYS = Object.freeze({
  schedule: `${STORAGE_PREFIX}schedule`,
  events: `${STORAGE_PREFIX}events`,
  mission: `${STORAGE_PREFIX}mission`,
  trim: `${STORAGE_PREFIX}trim`,
  calibration: `${STORAGE_PREFIX}calibration`,
} as const);

export const RUN_TRACE_PREFIX = `${STORAGE_PREFIX}runs.`;

/** Which kinds stay in memory unless the constructor says otherwise. */
export const DEFAULT_SESSION_ONLY: Readonly<Record<CareDataKind, boolean>> = Object.freeze({
  schedule: false,
  events: false,
  mission: false,
  trim: true,
  calibration: true,
  runs: true,
});

export interface CareStoreOptions {
  /** unix seconds (Python: wall_clock, time.time) */
  wallClock: () => number;
  /** The doses written on first use (Python: SEED_DOSES). Validated; ids d1, d2, ... in this order. */
  seedDoses?: readonly ScheduleDoseInput[];
  /** Per kind, true keeps it in memory only. Merged over DEFAULT_SESSION_ONLY. */
  sessionOnly?: Partial<Record<CareDataKind, boolean>>;
  logger?: Logger;
}

export interface AddEventOptions {
  doseId?: string | null;
  runId?: string | null;
  detail?: Record<string, unknown> | null;
  /** unix seconds; null or missing: the wall clock */
  ts?: number | null;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byTimeThenId(a: ScheduleDose, b: ScheduleDose): number {
  return compareStrings(a.time, b.time) || compareStrings(a.id, b.id);
}

function byTs(a: StoredEvent, b: StoredEvent): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

/** Python's int() of an events() limit: a number truncated toward zero. */
function intLimit(limit: number): number {
  if (Number.isNaN(limit)) throw new ValueError("cannot convert float NaN to integer");
  if (!Number.isFinite(limit)) throw new RangeError("cannot convert float infinity to integer");
  return Math.trunc(limit);
}

export class CareStore {
  private readonly wallClock: () => number;
  private readonly logger: Logger;
  private readonly sessionOnly: Readonly<Record<CareDataKind, boolean>>;
  private readonly persistent: GuardedStorage;
  private readonly session = new MemoryStorage();
  private readonly seedDoses: readonly ScheduleDoseInput[];
  private nextNumber = 1n;
  private doses: ScheduleDose[];
  private eventLog: StoredEvent[];

  constructor(storage: KeyValueStorage | null, options: CareStoreOptions) {
    this.wallClock = options.wallClock;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.sessionOnly = Object.freeze({ ...DEFAULT_SESSION_ONLY, ...(options.sessionOnly ?? {}) });
    this.persistent = new GuardedStorage(storage, this.logger);
    this.seedDoses = (options.seedDoses ?? SEED_DOSES).map((seed) => ({
      time: validateTime(seed.time),
      label: validateLabel(seed.label),
      notes: validateNotes(seed.notes),
    }));
    this.doses = this.loadSchedule();
    this.eventLog = this.loadEvents();
  }

  /** True when `kind` is kept in memory only (never read from or written to the storage). */
  isSessionOnly(kind: CareDataKind): boolean {
    return this.sessionOnly[kind];
  }

  // ------------------------------------------------------------------------------------------ //
  // storage

  private storageFor(kind: CareDataKind): KeyValueStorage {
    return this.sessionOnly[kind] ? this.session : this.persistent;
  }

  private writeText(kind: CareDataKind, key: string, text: string): void {
    this.storageFor(kind).setItem(key, text);
  }

  private writeJson(kind: CareDataKind, key: string, payload: unknown): void {
    this.writeText(kind, key, JSON.stringify(payload));
  }

  /** Parsed content, or null when missing. A corrupt value is set aside, not overwritten. */
  private readJson(kind: CareDataKind, key: string): unknown {
    const text = this.storageFor(kind).getItem(key);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      this.moveAside(kind, key, `could not read ${key} (${describeError(error)})`);
      return null;
    }
  }

  /** Copy a bad value to `<key>.corrupt-<unix time>` and remove it, so nothing is overwritten. */
  private moveAside(kind: CareDataKind, key: string, reason: string): void {
    const aside = `${key}.corrupt-${Math.trunc(this.wallClock())}`;
    this.logger.log("error", `${reason}; moving it to ${aside}`);
    const target = this.storageFor(kind);
    const text = target.getItem(key);
    if (text === null) return;
    let kept = true;
    if (target === this.persistent) kept = this.persistent.trySetItem(aside, text);
    else target.setItem(aside, text);
    if (!kept) {
      this.logger.log("error", "could not move the corrupt value aside");
      return;
    }
    target.removeItem(key);
  }

  // ------------------------------------------------------------------------------------------ //
  // schedule

  /** Invalid doses are left out of memory but the stored value is not rewritten until the schedule is edited. */
  private loadSchedule(): ScheduleDose[] {
    const key = STORAGE_KEYS.schedule;
    const raw = this.readJson("schedule", key);
    const doses: ScheduleDose[] = [];
    if (isJsonObject(raw) && Array.isArray(raw["doses"])) {
      for (const item of raw["doses"] as unknown[]) {
        const dose = this.parseDose(item);
        if (dose !== null) doses.push(dose);
      }
      const next = hasOwn(raw, "next_id") ? pyIntOf(raw["next_id"]) : 1n;
      this.nextNumber = next !== null && next > 1n ? next : 1n;
      return doses;
    }
    if (this.storageFor("schedule").getItem(key) !== null) {
      this.moveAside("schedule", key, `${key} does not hold a doses list`);
    }
    // first run (or unreadable or wrong-shape value): seed clearly labelled demo doses
    this.seedDoses.forEach((seed, index) => {
      doses.push({ id: `d${index + 1}`, time: seed.time, label: seed.label, notes: seed.notes });
    });
    this.nextNumber = BigInt(doses.length + 1);
    this.doses = doses;
    this.saveSchedule();
    this.logger.log("info", `seeded ${doses.length} demo doses in ${key}`);
    return doses;
  }

  private parseDose(item: unknown): ScheduleDose | null {
    try {
      if (!isJsonObject(item)) throw new TypeError("a dose must be an object");
      for (const name of ["id", "time", "label"]) if (!hasOwn(item, name)) throw new TypeError(`missing ${name}`);
      return {
        id: pyStrOf(item["id"]),
        time: validateTime(item["time"]),
        label: validateLabel(item["label"]),
        notes: validateNotes(hasOwn(item, "notes") ? item["notes"] : ""),
      };
    } catch (error) {
      if (!(error instanceof ValueError || error instanceof TypeError)) throw error;
      this.logger.log("warning", `skipping an invalid dose in ${STORAGE_KEYS.schedule}: ${error.message}`);
      return null;
    }
  }

  private saveSchedule(): void {
    // next_id is a bigint (Python int): written by hand so a large one stays exact.
    const text = `{"doses":${JSON.stringify(this.doses)},"next_id":${this.nextNumber.toString()}}`;
    this.writeText("schedule", STORAGE_KEYS.schedule, text);
  }

  /**
   * The highest dose number the persistent storage knows, in the schedule, its next_id and the event log. Another
   * tab of the same site shares that storage but not this store's memory, and may have made doses since this one
   * loaded. 0 when there is none, or the data lives in memory only.
   */
  private storedHighest(): bigint {
    let highest = 0n;
    const raise = (digits: string | undefined, less = 0n) => {
      if (!digits) return;
      const n = BigInt(digits) - less;
      if (n > highest) highest = n;
    };
    for (const [kind, key] of [
      ["schedule", STORAGE_KEYS.schedule],
      ["events", STORAGE_KEYS.events],
    ] as const) {
      if (this.sessionOnly[kind]) continue;
      let text: string | null;
      try {
        text = this.storageFor(kind).getItem(key);
      } catch {
        text = null;
      }
      if (!text) continue;
      for (const found of text.matchAll(/"(?:id|dose_id)"\s*:\s*"d([0-9]+)"/g)) raise(found[1]);
      raise(/"next_id"\s*:\s*([0-9]+)/.exec(text)?.[1], 1n);
    }
    return highest;
  }

  /**
   * Ids are never reused, so a new dose can not inherit the events of a deleted one. That holds across tabs too:
   * what another tab has stored counts (storedHighest), or two tabs would both make "d4" and each one's arrival
   * and acknowledgement would show on the other's dose.
   */
  private nextId(): string {
    let highest = this.nextNumber - 1n;
    const stored = this.storedHighest();
    if (stored > highest) highest = stored;
    for (const dose of this.doses) {
      const match = DOSE_ID_RE.exec(dose.id);
      if (match) {
        const n = digitsToBigInt(match[1] ?? "0");
        if (n > highest) highest = n;
      }
    }
    for (const event of this.eventLog) {
      const match = DOSE_ID_RE.exec(event.dose_id || "");
      if (match) {
        const n = digitsToBigInt(match[1] ?? "0");
        if (n > highest) highest = n;
      }
    }
    this.nextNumber = highest + 2n;
    return `d${(highest + 1n).toString()}`;
  }

  /** Copies, ordered by time, then id. */
  listDoses(): ScheduleDose[] {
    return this.doses.map((d) => ({ ...d })).sort(byTimeThenId);
  }

  getDose(doseId: string): ScheduleDose | null {
    const dose = this.doses.find((d) => d.id === doseId);
    return dose === undefined ? null : { ...dose };
  }

  /** Throws ValueError for a bad value (time first, then label, then notes). */
  addDose(time: unknown, label: unknown, notes: unknown = ""): ScheduleDose {
    const fields = { time: validateTime(time), label: validateLabel(label), notes: validateNotes(notes) };
    const dose: ScheduleDose = { id: this.nextId(), ...fields };
    this.doses.push(dose);
    this.saveSchedule();
    return { ...dose };
  }

  /**
   * Update the given fields (null or undefined: keep). Throws KeyError for an unknown id (checked
   * first), ValueError for a bad value; nothing changes then.
   */
  updateDose(doseId: string, time?: unknown, label?: unknown, notes?: unknown): ScheduleDose {
    for (const dose of this.doses) {
      if (dose.id !== doseId) continue;
      const updated = { ...dose };
      if (time !== null && time !== undefined) updated.time = validateTime(time);
      if (label !== null && label !== undefined) updated.label = validateLabel(label);
      if (notes !== null && notes !== undefined) updated.notes = validateNotes(notes);
      Object.assign(dose, updated);
      this.saveSchedule();
      return { ...dose };
    }
    throw new KeyError(doseId);
  }

  /** False for an unknown id. */
  deleteDose(doseId: string): boolean {
    const before = this.doses.length;
    this.doses = this.doses.filter((d) => d.id !== doseId);
    if (this.doses.length === before) return false;
    this.saveSchedule();
    return true;
  }

  // ------------------------------------------------------------------------------------------ //
  // events

  private loadEvents(): StoredEvent[] {
    const text = this.storageFor("events").getItem(STORAGE_KEYS.events);
    const events: StoredEvent[] = [];
    if (text === null) return events;
    // Python reads the file with universal newlines: \n, \r\n and \r all end a line.
    text.split(/\r\n|\r|\n/).forEach((rawLine, index) => {
      const line = pyStrip(rawLine);
      if (!line) return;
      const event = parseEventLine(line);
      if (event === null) this.logger.log("warning", `skipping unreadable line ${index + 1} of ${STORAGE_KEYS.events}`);
      else events.push(event);
    });
    events.sort(byTs);
    return events;
  }

  /** Append an event. Throws ValueError for an event type that is not in EVENT_TYPES. */
  addEvent(eventType: string, options: AddEventOptions = {}): PublicEvent {
    if (!(EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new ValueError(`unknown event type ${pyStrRepr(eventType)}`);
    }
    const event: StoredEvent = {
      ts: options.ts === null || options.ts === undefined ? this.wallClock() : options.ts,
      type: eventType,
      dose_id: options.doseId ?? null,
      run_id: options.runId ?? null,
      detail: { ...(options.detail ?? {}) },
    };
    const target = this.storageFor("events");
    const current = target.getItem(STORAGE_KEYS.events);
    // a crash can leave a truncated last line; start on a fresh line so this event is not glued to it
    const prefix = current === null || current === "" || current.endsWith("\n") ? "" : "\n";
    target.setItem(STORAGE_KEYS.events, `${current ?? ""}${prefix}${JSON.stringify(event)}\n`);
    this.eventLog.push(event);
    const n = this.eventLog.length;
    if (n > 1 && this.eventLog[n - 2]!.ts > event.ts) this.eventLog.sort(byTs);
    return publicEvent(event);
  }

  /** Newest first; `limit` is clamped to 1..500. */
  events(limit = 50): PublicEvent[] {
    const n = Math.max(1, Math.min(500, intLimit(limit)));
    return this.eventLog.slice(-n).reverse().map(publicEvent);
  }

  /** Events with startTs <= ts < endTs, oldest first. */
  eventsBetween(startTs: number, endTs: number): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (let i = this.eventLog.length - 1; i >= 0; i -= 1) {
      const event = this.eventLog[i]!;
      if (event.ts < startTs) break;
      if (event.ts < endTs) out.push({ ...event, detail: { ...event.detail } });
    }
    return out.reverse();
  }

  // ------------------------------------------------------------------------------------------ //
  // trim and calibration

  /** [roll, pitch]; [0, 0] when nothing (valid) is stored. */
  loadTrim(): [number, number] {
    const raw = this.readJson("trim", STORAGE_KEYS.trim);
    if (isJsonObject(raw) && hasOwn(raw, "roll")) {
      const roll = pyFloatOf(raw["roll"]);
      if (roll !== null && hasOwn(raw, "pitch")) {
        const pitch = pyFloatOf(raw["pitch"]);
        if (pitch !== null) return [roll, pitch];
      }
    }
    return [0.0, 0.0];
  }

  saveTrim(roll: number, pitch: number): void {
    this.writeJson("trim", STORAGE_KEYS.trim, { roll: Number(roll), pitch: Number(pitch) });
  }

  /** The stored arrive width, or null when none is stored or it is outside 0.03..0.8. */
  loadArriveWidth(): number | null {
    const raw = this.readJson("calibration", STORAGE_KEYS.calibration);
    if (!isJsonObject(raw) || !hasOwn(raw, "arrive_width")) return null;
    const value = pyFloatOf(raw["arrive_width"]);
    if (value === null) return null;
    return value >= 0.03 && value <= 0.8 ? value : null;
  }

  saveArriveWidth(width: number): void {
    this.writeJson("calibration", STORAGE_KEYS.calibration, { arrive_width: Number(width) });
  }

  // ------------------------------------------------------------------------------------------ //
  // mission settings

  private missionRecord(): unknown {
    return this.readJson("mission", STORAGE_KEYS.mission);
  }

  /** The stored drift-assist switch. Off unless the stored value says exactly `true`. */
  loadDriftAssist(): boolean {
    const raw = this.missionRecord();
    return isJsonObject(raw) && raw["drift_assist"] === true;
  }

  /** Python: bool(enabled). */
  saveDriftAssist(enabled: boolean): void {
    this.saveMissionSetting("drift_assist", pyTruthy(enabled));
  }

  /** The stored land-on-arrival switch. Off unless the stored value says exactly `true`. */
  loadLandOnArrival(): boolean {
    const raw = this.missionRecord();
    return isJsonObject(raw) && raw["land_on_arrival"] === true;
  }

  /** Python: bool(enabled). */
  saveLandOnArrival(enabled: boolean): void {
    this.saveMissionSetting("land_on_arrival", pyTruthy(enabled));
  }

  /** The stored automatic-flights switch. Off unless the stored value says exactly `true`. */
  loadAutoFly(): boolean {
    const raw = this.missionRecord();
    return isJsonObject(raw) && raw["auto_fly"] === true;
  }

  /** Python: bool(enabled). */
  saveAutoFly(enabled: boolean): void {
    this.saveMissionSetting("auto_fly", pyTruthy(enabled));
  }

  /**
   * The stored obstacle-avoidance mode ("off" or "hold"), or null when none is stored (or the stored
   * value is not one of those): the settings' default applies then.
   */
  loadAvoid(): AvoidMode | null {
    const raw = this.missionRecord();
    const value = isJsonObject(raw) ? raw["avoid"] : null;
    return isAvoidMode(value) ? value : null;
  }

  /** Throws ValueError for anything but "off" or "hold". */
  saveAvoid(mode: unknown): void {
    if (!isAvoidMode(mode)) throw new ValueError(`avoid must be one of ${pyTupleRepr(AVOID_MODES)}`);
    this.saveMissionSetting("avoid", mode);
  }

  /** Read-modify-write of the mission settings, so saving one setting keeps the others. */
  private saveMissionSetting(key: keyof MissionSettingsRecord, value: boolean | AvoidMode): void {
    const raw = this.missionRecord();
    const settings: Record<string, boolean | AvoidMode> = {};
    if (isJsonObject(raw)) {
      for (const name of ["drift_assist", "land_on_arrival", "auto_fly"]) {
        if (hasOwn(raw, name)) settings[name] = raw[name] === true;
      }
      const avoid = raw["avoid"];
      if (isAvoidMode(avoid)) settings["avoid"] = avoid;
    }
    settings[key] = value;
    this.writeJson("mission", STORAGE_KEYS.mission, settings);
  }

  // ------------------------------------------------------------------------------------------ //
  // run traces

  /** Store a run's trace; returns its storage key (Python returns the file path). */
  writeRunTrace(runId: string, trace: Record<string, unknown>): string {
    const key = `${RUN_TRACE_PREFIX}${runId}`;
    this.writeJson("runs", key, trace);
    return key;
  }

  /** A stored trace, or null (TypeScript only: Python leaves the files for people to read). */
  readRunTrace(runId: string): unknown {
    const text = this.storageFor("runs").getItem(`${RUN_TRACE_PREFIX}${runId}`);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

function isAvoidMode(value: unknown): value is AvoidMode {
  return typeof value === "string" && (AVOID_MODES as readonly string[]).includes(value);
}

/** One line of the event log, or null where Python skips it (any ValueError, KeyError, TypeError or AttributeError). */
function parseEventLine(line: string): StoredEvent | null {
  let item: unknown;
  try {
    item = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isJsonObject(item)) return null; // item.get(...) fails
  const rawDetail = hasOwn(item, "detail") ? item["detail"] : null;
  const detail = pyTruthy(rawDetail) ? rawDetail : {};
  if (!isJsonObject(detail)) return null;
  if (!hasOwn(item, "ts") || !hasOwn(item, "type")) return null;
  const ts = pyFloatOf(item["ts"]);
  if (ts === null) return null;
  const doseId = item["dose_id"];
  const runId = item["run_id"];
  return {
    ts,
    type: pyStrOf(item["type"]),
    dose_id: typeof doseId === "string" ? doseId : null,
    run_id: typeof runId === "string" ? runId : null,
    detail,
  };
}

function publicEvent(event: StoredEvent): PublicEvent {
  return {
    ts: event.ts,
    time_local: timeLocal(event.ts),
    type: event.type,
    dose_id: event.dose_id,
    run_id: event.run_id,
    detail: { ...event.detail },
  };
}
