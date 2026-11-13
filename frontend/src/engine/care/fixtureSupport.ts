// Shared by the care parity tests: local-time components, raw-text templates and the logical listing
// of a storage, written exactly as backend/tools/parity_care.py writes them (see its docstring).

import { loadFixture } from "../testing/fixtures";
import { pyRepr, ValueError } from "../util/num";
import { fromTimestamp, localDate, localFields, timestampOf } from "./localTime";
import { isJsonObject, pyFloatOf } from "./pyCompat";
import { KeyError, RUN_TRACE_PREFIX, STORAGE_PREFIX, type PublicEvent, type StoredEvent } from "./store";
import type { MemoryStorage } from "./storage";

/** Local calendar components [year, month, day, hour, minute, second]; the second may have a fraction. */
export type Fields = number[];

export function loadCareFixture<T>(name: "care_status" | "care_store"): T {
  // loadFixture reads src/engine/__fixtures__/<name>.json; the care fixtures sit next to this file
  return loadFixture<T>(`../care/__fixtures__/${name}`);
}

export function toDate(fields: Fields): Date {
  const [year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0] = fields;
  return localDate(year, month, day, hour, minute, second);
}

export function tsOf(fields: Fields): number {
  return timestampOf(toDate(fields));
}

export function fieldsOf(ts: number): Fields {
  const f = localFields(ts);
  return [f.year, f.month, f.day, f.hour, f.minute, f.second];
}

/** `fields` plus `seconds` of wall-clock time (Python: datetime + timedelta). */
export function addSeconds(fields: Fields, seconds: number): Date {
  const [year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0] = fields;
  return localDate(year, month, day, hour, minute, second + seconds);
}

const TEMPLATE = /\{\{([^{}]*)\}\}/g;

/** Replace each {{y,m,d,h,mi,s}} with repr() of that local time's timestamp. */
export function fill(text: string): string {
  return text.replace(TEMPLATE, (_, inner: string) => pyRepr(tsOf(inner.split(",").map(Number))));
}

const UNIX_TIME = /\d{9,11}(?:\.\d+)?/g;

/** Raw text with every unix-time-like number written back as {{y,m,d,h,mi,s}}. */
export function untemplate(text: string): string {
  return text.replace(UNIX_TIME, (match) => {
    const parts = fieldsOf(Number(match)).map((v) => (Number.isInteger(v) ? String(v) : pyRepr(v)));
    return `{{${parts.join(",")}}}`;
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local time of a whole-second timestamp, as in the names of values set aside. */
export function stamp(seconds: number): string {
  const d = fromTimestamp(seconds);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function publicOut(event: PublicEvent | StoredEvent): Record<string, unknown> {
  return { ...event, ts: fieldsOf(event.ts) };
}

/** A storage key as the tool's logical file name, or null for keys outside the store. */
export function logicalName(key: string): string | null {
  if (key.startsWith(RUN_TRACE_PREFIX)) return `runs/${key.slice(RUN_TRACE_PREFIX.length)}`;
  if (!key.startsWith(STORAGE_PREFIX)) return null;
  const rest = key.slice(STORAGE_PREFIX.length);
  const aside = /^(.+)\.corrupt-(-?\d+)$/.exec(rest);
  if (aside) return `${aside[1]}.corrupt@${stamp(Number(aside[2]))}`;
  return rest;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { $raw: untemplate(text) };
  }
}

function tsField(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return fieldsOf(value);
  if (typeof value === "string") {
    const number = pyFloatOf(value);
    if (number !== null && Number.isFinite(number)) return { $ts_text: fieldsOf(number) };
  }
  return value;
}

function eventLines(text: string, summary: boolean): Record<string, unknown> {
  const trailing = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailing) lines.pop();
  const out = lines.map((line) => {
    let item: unknown;
    try {
      item = JSON.parse(line) as unknown;
    } catch {
      return { $raw: untemplate(line) };
    }
    if (isJsonObject(item) && Object.prototype.hasOwnProperty.call(item, "ts")) return { ...item, ts: tsField(item["ts"]) };
    return item;
  });
  if (summary) {
    return { count: out.length, first: out[0] ?? null, last: out[out.length - 1] ?? null, trailing_newline: trailing };
  }
  return { lines: out, trailing_newline: trailing };
}

/** Every value the store left in `storage`, by logical name (as the tool lists the data directory). */
export function listing(storage: MemoryStorage, summary = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of storage.keys()) {
    const name = logicalName(key);
    const text = storage.getItem(key);
    if (name === null || text === null) continue;
    const isEvents = name === "events" || name.startsWith("events.corrupt@");
    out[name] = isEvents ? eventLines(text, summary && name === "events") : parseJsonText(text);
  }
  return out;
}

/** The value of `fn`, or the error record the tool writes for a ValueError or KeyError. */
export function outcome(fn: () => unknown): unknown {
  try {
    const value = fn();
    return value === undefined ? null : value;
  } catch (error) {
    if (error instanceof ValueError) return { error: "ValueError", message: error.message };
    if (error instanceof KeyError) return { error: "KeyError", message: error.message };
    throw error;
  }
}

/** A plain number from a fixture value (throws on anything else). */
export function num(value: unknown): number {
  if (typeof value !== "number") throw new Error(`expected a number in the fixture, got ${String(value)}`);
  return value;
}
