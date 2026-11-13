// The REST choke point end to end: every method of the real `api` object, through this page's mode-guard latch
// and the Python transport (fetch stubbed). Each method is called once before the guard trips, to learn the HTTP
// call it makes, and once after: only GETs and the run abort may still leave the page. A method added to `api`
// later is covered without touching this file.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { observePageMode } from "../logic/modeGuard";
import { REQUEST_LOCKED_TEXT } from "../text/pilotWording";
import { loadTransport } from "../transport";
import { ApiError, LOCKED_STATUS, api } from "./client";

type Call = { method: string; path: string };
type Outcome = { call: Call | null; error: unknown };

const calls: Call[] = [];

/** Plausible arguments for the methods that take some; any other method is called without arguments. */
const ARGS: Record<string, unknown[]> = {
  putTrim: [{ roll: 0, pitch: 0 }],
  missionStart: [null],
  missionStartAuto: [null],
  missionSettings: [{ land_on_arrival: true }],
  setAvoid: ["off"],
  setSimScenario: ["empty"],
  addDose: [{ time: "08:00", label: "Dose", notes: "" }],
  updateDose: ["a", { time: "08:00", label: "Dose", notes: "" }],
  deleteDose: ["a"],
  acknowledge: ["a"],
  events: [5],
};

async function callEveryMethod(): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  for (const [name, fn] of Object.entries(api)) {
    const before = calls.length;
    let error: unknown = null;
    try {
      await (fn as (...args: unknown[]) => Promise<unknown>)(...(ARGS[name] ?? []));
    } catch (e) {
      error = e;
    }
    out[name] = { call: calls[before] ?? null, error };
  }
  return out;
}

const stillAllowed = (c: Call) => c.method === "GET" || (c.method === "POST" && c.path === "/api/mission/abort");

let before: Record<string, Outcome>;
let after: Record<string, Outcome>;

beforeAll(async () => {
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), path: new URL(url).pathname });
    return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve("{}") });
  });
  await loadTransport();
  before = await callEveryMethod();
  observePageMode("real");
  observePageMode("sim");
  after = await callEveryMethod();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("api through a tripped mode guard", () => {
  it("made one HTTP call per method before the guard tripped", () => {
    for (const [name, o] of Object.entries(before)) {
      expect(o.error, name).toBeNull();
      expect(o.call, name).not.toBeNull();
    }
  });

  it("still sends every GET and the run abort, and nothing else", () => {
    const allowed = Object.keys(before).filter((name) => stillAllowed(before[name]!.call!));
    expect(allowed).toEqual(expect.arrayContaining(["status", "getTrim", "getSchedule", "events", "missionAbort"]));
    for (const name of allowed) {
      expect(after[name]!.error, name).toBeNull();
      expect(after[name]!.call, name).toEqual(before[name]!.call);
    }
  });

  it("refuses every other method locally: no HTTP call, a 423 ApiError with the locked text", () => {
    const refused = Object.keys(before).filter((name) => !stillAllowed(before[name]!.call!));
    expect(refused).toEqual(
      expect.arrayContaining([
        "putTrim",
        "missionStart",
        "missionStartAuto",
        "missionReady",
        "calibrateArrival",
        "missionSettings",
        "hoverTestStart",
        "addDose",
        "updateDose",
        "deleteDose",
        "acknowledge",
      ]),
    );
    for (const name of refused) {
      const o = after[name]!;
      expect(o.call, name).toBeNull();
      expect(o.error, name).toBeInstanceOf(ApiError);
      expect((o.error as ApiError).status, name).toBe(LOCKED_STATUS);
      expect((o.error as ApiError).body, name).toEqual({ detail: REQUEST_LOCKED_TEXT });
    }
  });
});
