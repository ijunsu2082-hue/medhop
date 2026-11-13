import { describe, expect, it } from "vitest";
import type { CareEvent, DoseToday, Obstacle, Status } from "../api/types";
import { arrivalLine, careFocus, isEarlyArrival, newlyNeedingAttention, reminderMaySpeak, spokenReminder } from "./care";
import { doseTableStatusLine, eventDetailText, eventWhen, lastRunResult, localDateOf, simulatorSuffix } from "./caregiver";
import { BATTERY_CHECK_OFF_TEXT, batteryLine, pathAheadLine, preflightChecklist } from "./checklist";
import { formatClock, isBeforeClock, isValidHHMM, normaliseHHMM } from "./time";
import { suggestedTrimBody } from "./trim";
import {
  ABORT_TEXT,
  BLOCKER_TEXT,
  CONTROL_ERROR_TEXT,
  DRIFT_ASSIST_DISABLED_TEXT,
  EVENT_TEXT,
  abortText,
  blockerText,
  controlErrorText,
  doseStatusLine,
  driftDisabledText,
  eventText,
  missionStateText,
} from "../text/wording";
import { reconnectDelayMs } from "../hooks/backoff";

const dose = (id: string, time: string, status: DoseToday["status"], extra: Partial<DoseToday> = {}): DoseToday => ({
  id,
  time,
  label: `Dose ${id} (demo)`,
  notes: "",
  status,
  arrived_at: null,
  acknowledged_at: null,
  ...extra,
});

function baseStatus(): Status {
  return {
    server_time: 0,
    mode: "sim",
    link: { video_live: true, frame_age_s: 0.07, fps: 14.8 },
    telemetry: null,
    trim: { roll: 0, pitch: 0 },
    pilot: { manual_active: false, max_stick: 0.5, estop_active: false },
    vision: {
      marker: null,
      person: { enabled: true, detected: false, count: 0, age_s: 0.2 },
      brightness: 96,
      dark: false,
    },
    mission: {
      state: "idle",
      reason: null,
      run_id: null,
      dose_id: null,
      elapsed_s: 0,
      command: { yaw: 0, pitch: 0 },
      arrive_width: 0.16,
      land_on_arrival: true,
      can_start: true,
      blockers: [],
    },
    hover_test: null,
    care: { now_local: "08:01", date_local: "2026-11-11", doses: [], next_due_id: null },
  };
}

describe("time", () => {
  it("validates strict 24-hour HH:MM", () => {
    for (const ok of ["00:00", "08:05", "23:59", "12:30"]) expect(isValidHHMM(ok)).toBe(true);
    for (const bad of ["24:00", "8:05", "12:60", "1230", "", "ab:cd", "12:3"]) expect(isValidHHMM(bad)).toBe(false);
  });
  it("normalises convenient forms and rejects nonsense", () => {
    expect(normaliseHHMM("8:05")).toBe("08:05");
    expect(normaliseHHMM("0805")).toBe("08:05");
    expect(normaliseHHMM(" 19:30 ")).toBe("19:30");
    expect(normaliseHHMM("25:00")).toBeNull();
    expect(normaliseHHMM("7")).toBeNull();
  });
});

describe("wording", () => {
  it("maps every blocker, abort reason and event code to plain English", () => {
    for (const code of Object.keys(BLOCKER_TEXT)) expect(blockerText(code)).not.toMatch(/code:/);
    for (const code of Object.keys(ABORT_TEXT)) expect(abortText(code)).not.toMatch(/code:/);
    for (const code of Object.keys(EVENT_TEXT)) expect(eventText(code)).not.toContain("_");
    expect(Object.keys(BLOCKER_TEXT).sort()).toEqual(
      [
        "already_running",
        "battery_low",
        "estop_active",
        "marker_too_close",
        "no_video",
        "person_in_view",
        "confirm_airborne_required",
        "marker_not_visible",
        "no_pilot_link",
        "drone_flying",
        "recent_toggle",
        "obstacle_in_view",
      ].sort(),
    );
    expect(Object.keys(ABORT_TEXT).sort()).toEqual(
      [
        "battery_low",
        "estop",
        "marker_lost",
        "marker_not_found",
        "off_axis",
        "person_in_view",
        "pilot_took_over",
        "timeout",
        "video_stale",
        "pilot_link_lost",
        "unexpected_descent",
        "takeoff_refused",
        "not_lined_up",
        "already_at_station",
        "path_blocked",
        "obstacle_in_view",
      ].sort(),
    );
    expect(blockerText("new_thing")).toContain("new_thing");
  });
  it("has the revision 4 texts for every new code", () => {
    expect(blockerText("obstacle_in_view")).toBe("Something is in the drone's path. Clear the corridor first.");
    expect(abortText("obstacle_in_view")).toBe("Something was in the drone's path before takeoff, so it did not take off.");
    expect(abortText("path_blocked")).toBe(
      "The way stayed blocked for 25 seconds. The drone landed where it was: clear the corridor and send it again.",
    );
    // A simulated person counts as a person in view even with the person check off: the words name no source.
    expect(blockerText("person_in_view")).toBe("A person is in view of the camera. Clear the corridor first.");
    expect(abortText("person_in_view")).toBe("A person came into view of the camera during the run.");
  });
  it("has the revision 3 texts for every new code", () => {
    expect(abortText("pilot_link_lost")).toBe(
      "The Pilot page lost its control link, so the run was stopped. Reopen the Pilot page and land by hand.",
    );
    expect(abortText("unexpected_descent")).toBe(
      "The drone looked like it was already coming down, so the run stopped without sending the landing command. Land by hand.",
    );
    expect(blockerText("no_pilot_link")).toBe("Open the Pilot page and keep it open: a run needs a pilot connected.");
    expect(driftDisabledText("off_axis_worsening")).toBe(
      "Drift assist switched itself off because its correction was making the approach worse. Check the trim sign.",
    );
    for (const code of Object.keys(DRIFT_ASSIST_DISABLED_TEXT)) expect(driftDisabledText(code)).not.toMatch(/code:/);
    expect(Object.keys(CONTROL_ERROR_TEXT).sort()).toEqual(
      ["drone_link_down", "estop_active", "landing_in_progress", "toggle_guard"].sort(),
    );
    for (const code of Object.keys(CONTROL_ERROR_TEXT)) {
      const t = controlErrorText(code, "raw server text");
      expect(t).not.toContain(code);
      expect(t).not.toContain("raw server text");
    }
    expect(controlErrorText(undefined, "something")).toBe("Backend: something");
    expect(controlErrorText("brand_new", "")).toContain("(code: brand_new)");
    // An unknown drift-assist code is never shown as a raw code alone.
    const unknown = driftDisabledText("roll_sign_wrong");
    expect(unknown).toMatch(/^Drift assist switched itself off/);
    expect(unknown).toContain("(code: roll_sign_wrong)");
  });
  it("has the revision 2 texts", () => {
    expect(abortText("off_axis")).toBe("The drone was too far to the side of the sign to continue safely.");
    expect(blockerText("confirm_airborne_required")).toMatch(/hovering/);
    expect(blockerText("marker_not_visible")).toMatch(/station sign must be in view/);
  });
  it("never renders an unknown code blank: a generic sentence plus the code", () => {
    for (const [fn, code] of [
      [blockerText, "brand_new_blocker"],
      [abortText, "brand_new_reason"],
      [eventText, "brand_new_event"],
      [missionStateText, "brand_new_state"],
      [driftDisabledText, "roll_sign_wrong"],
    ] as const) {
      const text = fn(code);
      expect(text).toContain(`(code: ${code})`);
      expect(text.replace(`(code: ${code})`, "").trim().length).toBeGreaterThan(5);
    }
    expect(blockerText("").trim().length).toBeGreaterThan(5);
    expect(eventText("").trim().length).toBeGreaterThan(5);
    expect(driftDisabledText("The off-axis measure kept getting worse")).toBe(
      "Drift assist switched itself off for this run: The off-axis measure kept getting worse",
    );
    // An unknown dose status still renders something with the code.
    expect(doseStatusLine({ status: "new_status" as never, arrived_at: null, acknowledged_at: null })).toContain(
      "(code: new_status)",
    );
  });
  it("never says delivered; pickup is self-reported", () => {
    const all = [...Object.values(BLOCKER_TEXT), ...Object.values(ABORT_TEXT), ...Object.values(EVENT_TEXT)].join(" ");
    expect(all.toLowerCase()).not.toContain("deliver");
    expect(doseStatusLine(dose("a", "08:00", "acknowledged", { acknowledged_at: "08:20" }))).toBe(
      "Acknowledged 08:20 (self-reported)",
    );
    expect(doseStatusLine(dose("a", "08:00", "arrived", { arrived_at: "08:12" }))).toBe("Arrived at station 08:12");
  });
});

describe("dose times", () => {
  it("shows backend HH:MM strings as they are", () => {
    expect(formatClock("17:05")).toBe("17:05");
    expect(formatClock(null)).toBeNull();
    expect(formatClock("")).toBeNull();
    expect(doseStatusLine(dose("a", "17:00", "arrived", { arrived_at: "17:05" }))).toBe("Arrived at station 17:05");
    expect(doseStatusLine(dose("a", "17:00", "acknowledged", { acknowledged_at: "17:20" }))).toBe(
      "Acknowledged 17:20 (self-reported)",
    );
  });
  it("formats a number (unix seconds or ms, or a numeric string) as local HH:MM instead of printing it raw", () => {
    const ts = new Date(2026, 10, 11, 17, 5, 30).getTime() / 1000 + 0.4186728; // local 17:05:30
    expect(formatClock(ts)).toBe("17:05");
    expect(formatClock(ts * 1000)).toBe("17:05");
    expect(formatClock(String(ts))).toBe("17:05");
    expect(formatClock(Number.NaN)).toBeNull();
    const line = doseStatusLine(dose("a", "17:00", "arrived", { arrived_at: ts }));
    expect(line).toBe("Arrived at station 17:05");
    expect(line).not.toMatch(/\d{6,}/);
    expect(doseStatusLine(dose("a", "17:00", "acknowledged", { acknowledged_at: ts }))).toBe(
      "Acknowledged 17:05 (self-reported)",
    );
    expect(doseStatusLine(dose("a", "17:00", "needs_attention", { arrived_at: ts }))).toBe(
      "Needs attention (arrived at station 17:05, not acknowledged)",
    );
  });
});

describe("early arrival", () => {
  it("compares local clock strings", () => {
    expect(isBeforeClock("11:59", "12:00")).toBe(true);
    expect(isBeforeClock("12:00", "12:00")).toBe(false);
    expect(isBeforeClock("12:01", "12:00")).toBe(false);
    expect(isBeforeClock("bad", "12:00")).toBe(false);
  });
  it("shows the pouch but does not speak 'it is time' before the dose time; speaks once the time comes", () => {
    const d = dose("n", "12:00", "arrived", { arrived_at: "11:40" });
    expect(isEarlyArrival(d, "11:45")).toBe(true);
    expect(reminderMaySpeak(d, "11:45")).toBe(false);
    expect(reminderMaySpeak(d, "11:59")).toBe(false);
    // The clock reaches the dose time, still unacknowledged: spoken as normal.
    expect(isEarlyArrival(d, "12:00")).toBe(false);
    expect(reminderMaySpeak(d, "12:00")).toBe(true);
    expect(reminderMaySpeak(d, "12:10")).toBe(true);
    // Once acknowledged, never spoken.
    expect(reminderMaySpeak({ ...d, status: "acknowledged" }, "12:10")).toBe(false);
    // An early arrival is still the focus of the Care page (so the pickup button is there).
    const care = baseStatus().care;
    care.now_local = "11:45";
    care.doses = [d, dose("m", "18:00", "upcoming")];
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "n" } });
  });
  it("due and needs_attention doses speak as before", () => {
    expect(reminderMaySpeak(dose("a", "08:00", "due"), "08:01")).toBe(true);
    expect(reminderMaySpeak(dose("a", "08:00", "needs_attention"), "09:00")).toBe(true);
    expect(reminderMaySpeak(dose("a", "08:00", "upcoming"), "07:00")).toBe(false);
  });
});

describe("apply suggested trim", () => {
  it("uses the suggested roll as the new roll trim and keeps the current pitch", () => {
    expect(suggestedTrimBody(0.06, { roll: 0.02, pitch: -0.01 })).toEqual({ roll: 0.06, pitch: -0.01 });
    expect(suggestedTrimBody(-0.034999, { roll: 0, pitch: 0.03 })).toEqual({ roll: -0.03, pitch: 0.03 });
  });
  it("clamps to the backend limit and refuses a missing suggestion", () => {
    expect(suggestedTrimBody(0.42, { roll: 0, pitch: 0 })).toEqual({ roll: 0.3, pitch: 0 });
    expect(suggestedTrimBody(-0.5, { roll: 0, pitch: 0.1 })).toEqual({ roll: -0.3, pitch: 0.1 });
    expect(suggestedTrimBody(null, { roll: 0, pitch: 0 })).toBeNull();
    expect(suggestedTrimBody(undefined, { roll: 0, pitch: 0 })).toBeNull();
    expect(suggestedTrimBody(Number.NaN, { roll: 0, pitch: 0 })).toBeNull();
  });
});

describe("care arrival line (SPEC 10.5)", () => {
  it("a needs_attention dose with arrived_at still shows and speaks the arrival", () => {
    const d = dose("a", "08:00", "needs_attention", { arrived_at: "08:12" });
    expect(arrivalLine(d)).toBe("The drone reached the station at 08:12");
    expect(spokenReminder(d)).toContain("The drone reached the station at 08:12.");
  });
  it("prefixes (simulator) for a simulator arrival, on screen and spoken", () => {
    const d = dose("a", "08:00", "arrived", { arrived_at: "08:12", arrived_mode: "sim" });
    expect(arrivalLine(d)).toBe("(simulator) The drone reached the station at 08:12");
    expect(spokenReminder(d)).toContain("(simulator) The drone reached the station at 08:12.");
    expect(arrivalLine({ arrived_at: "08:12", arrived_mode: "real" })).toBe("The drone reached the station at 08:12");
  });
  it("no arrival line without arrived_at; an older backend without arrived_mode is not labelled", () => {
    expect(arrivalLine(dose("a", "08:00", "due"))).toBeNull();
    expect(spokenReminder(dose("a", "08:00", "due"))).not.toMatch(/station/);
    expect(arrivalLine(dose("a", "08:00", "arrived", { arrived_at: "08:12" }))).toBe("The drone reached the station at 08:12");
  });
  it("never says the pouch has arrived", () => {
    for (const st of ["due", "arrived", "needs_attention"] as const) {
      const d = dose("a", "08:00", st, { arrived_at: "08:12", arrived_mode: "sim" });
      expect(spokenReminder(d).toLowerCase()).not.toContain("pouch has arrived");
      expect(spokenReminder(d).toLowerCase()).not.toContain("deliver");
    }
  });
  it("after an acknowledgement the just-acknowledged dose is not offered again: the next waiting one is", () => {
    const care = baseStatus().care;
    care.doses = [dose("a", "08:00", "due"), dose("b", "09:00", "needs_attention"), dose("c", "18:00", "upcoming")];
    care.next_due_id = "a";
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "a" } });
    expect(careFocus(care, "a")).toMatchObject({ kind: "pending", dose: { id: "b" } });
    care.doses = [dose("a", "08:00", "due"), dose("c", "18:00", "upcoming")];
    expect(careFocus(care, "a")).toMatchObject({ kind: "upcoming", dose: { id: "c" } });
  });
});

describe("caregiver helpers (SPEC 10.5)", () => {
  const ts = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
  const ev = (over: Partial<CareEvent>): CareEvent => ({
    ts: ts(2026, 11, 11, 14, 30),
    time_local: "14:30",
    type: "arrived_at_station",
    dose_id: null,
    run_id: null,
    detail: null,
    ...over,
  });
  it("shows the date on events that are not from today", () => {
    expect(localDateOf(ts(2026, 11, 10, 23, 59))).toBe("2026-11-10");
    expect(eventWhen(ev({}), "2026-11-11")).toBe("14:30");
    expect(eventWhen(ev({ ts: ts(2026, 11, 10, 14, 30) }), "2026-11-11")).toBe("2026-11-10 14:30");
  });
  it("labels simulator run events", () => {
    expect(simulatorSuffix(ev({ detail: { mode: "sim" } }))).toBe(" (simulator)");
    expect(simulatorSuffix(ev({ type: "run_started", detail: { mode: "sim" } }))).toBe(" (simulator)");
    expect(simulatorSuffix(ev({ type: "run_aborted", detail: { mode: "sim", reason: "timeout" } }))).toBe(" (simulator)");
    expect(simulatorSuffix(ev({ detail: { mode: "real" } }))).toBe("");
    expect(simulatorSuffix(ev({ detail: null }))).toBe("");
    expect(simulatorSuffix(ev({ type: "pickup_acknowledged", detail: { mode: "sim" } }))).toBe("");
  });
  it("shows the dose time on reminder_due and needs_attention rows", () => {
    expect(eventDetailText(ev({ type: "reminder_due", detail: { time: "08:00" } }))).toBe("due 08:00, logged 14:30");
    expect(eventDetailText(ev({ type: "needs_attention", detail: { time: "08:00" } }))).toBe("due 08:00, logged 14:30");
    expect(eventDetailText(ev({ type: "needs_attention", detail: null }))).toBeNull();
    expect(eventDetailText(ev({ type: "run_aborted", detail: { reason: "pilot_link_lost" } }))).toMatch(/lost its control link/);
  });
  it("shows how far from the centre line an arrival ended", () => {
    expect(eventDetailText(ev({ detail: { lateral_offset_m: -0.034, distance_m: 0.8, aligned: true } }))).toBe("3 cm from the centre line");
    expect(eventDetailText(ev({ detail: { lateral_offset_m: 0.12, aligned: false } }))).toBe("12 cm from the centre line");
    expect(eventDetailText(ev({ detail: { lateral_offset_m: null } }))).toBeNull();
    expect(eventDetailText(ev({ detail: { mode: "sim" } }))).toBeNull();
    expect(eventDetailText(ev({ detail: null }))).toBeNull();
  });
  it("marks automatic runs and explains skipped automatic flights", () => {
    expect(eventText("auto_run_skipped")).toBe("Automatic flight skipped");
    expect(eventDetailText(ev({ type: "run_started", detail: { automatic: true, mode: "sim" } }))).toBe("Automatic");
    expect(eventDetailText(ev({ type: "run_started", detail: { automatic: false } }))).toBeNull();
    expect(eventDetailText(ev({ type: "run_started", detail: null }))).toBeNull();
    expect(eventDetailText(ev({ type: "auto_run_skipped", detail: { blockers: ["stale_due"] } }))).toBe(
      "Not started: the dose time had already passed.",
    );
    expect(eventDetailText(ev({ type: "auto_run_skipped", detail: { blockers: ["not_ready", "already_arrived"] } }))).toBe(
      "Not started: the drone was not marked ready; the drone had already arrived at the station for this dose.",
    );
    expect(eventDetailText(ev({ type: "auto_run_skipped", detail: { blockers: ["no_video"] } }))).toBe(
      "Not started: there is no live video from the drone.",
    );
    expect(eventDetailText(ev({ type: "auto_run_skipped", detail: { blockers: [] } }))).toBeNull();
    expect(eventDetailText(ev({ type: "auto_run_skipped", detail: null }))).toBeNull();
    // A skipped flight is not a flight: no simulator label.
    expect(simulatorSuffix(ev({ type: "auto_run_skipped", detail: { mode: "sim" } }))).toBe("");
  });
  it("labels a simulator arrival in the doses table", () => {
    expect(doseTableStatusLine(dose("d1", "08:00", "arrived", { arrived_at: "08:12", arrived_mode: "sim" }))).toBe(
      "Arrived at station 08:12 (simulator)",
    );
    expect(doseTableStatusLine(dose("d1", "08:00", "arrived", { arrived_at: "08:12", arrived_mode: "real" }))).toBe(
      "Arrived at station 08:12",
    );
    expect(doseTableStatusLine(dose("d1", "08:00", "arrived", { arrived_at: "08:12" }))).toBe("Arrived at station 08:12");
    expect(
      doseTableStatusLine(dose("d1", "08:00", "needs_attention", { arrived_at: "08:12", arrived_mode: "sim" })),
    ).toBe("Needs attention (arrived at station 08:12, not acknowledged) (simulator)");
    expect(doseTableStatusLine(dose("d1", "08:00", "needs_attention", { arrived_mode: "sim" }))).toBe("Needs attention");
    expect(
      doseTableStatusLine(dose("d1", "08:00", "acknowledged", { arrived_at: "08:12", acknowledged_at: "08:20", arrived_mode: "sim" })),
    ).toBe("Acknowledged 08:20 (self-reported)");
  });
  it("'Last run result' is today's, or carries its date when it is not from today", () => {
    expect(lastRunResult(null, "2026-11-11")).toBe("Loading.");
    expect(lastRunResult([], "2026-11-11")).toBe("No run in the recent events.");
    expect(lastRunResult([ev({ detail: { mode: "real" } })], "2026-11-11")).toBe("Arrived at station at 14:30");
    expect(lastRunResult([ev({ detail: { mode: "sim" } })], "2026-11-11")).toBe("Arrived at station at 14:30 (simulator)");
    expect(lastRunResult([ev({ ts: ts(2026, 11, 9, 14, 30) })], "2026-11-11")).toBe(
      "Arrived at station at 14:30 on 2026-11-09 (not today)",
    );
    expect(
      lastRunResult([ev({ type: "run_aborted", detail: { reason: "unexpected_descent", mode: "sim" } })], "2026-11-11"),
    ).toMatch(/^Stopped early at 14:30 \(simulator\): The drone looked like/);
  });
  it("a path_blocked run reads properly, landed or not (SPEC 11.6)", () => {
    const blocked = {
      reason: "path_blocked",
      mode: "sim",
      automatic: true,
      safe_landing: true,
      avoid: { mode: "hold", holds: 2, held_s: 25.1 },
      blocked_by: "timeout",
      obstacle_kind: "person",
      obstacle_distance_m: 2.61,
    };
    expect(eventDetailText(ev({ type: "run_aborted", detail: blocked }))).toBe(
      "The way stayed blocked for 25 seconds. The drone landed where it was: clear the corridor and send it again.",
    );
    expect(lastRunResult([ev({ type: "run_aborted", detail: blocked })], "2026-11-11")).toBe(
      "Stopped early at 14:30 (simulator): The way stayed blocked for 25 seconds. The drone landed where it was: clear the corridor and send it again.",
    );
    // Not landed by the run (no evidence it was flying, or a step-by-step run): land it by hand.
    for (const detail of [{ ...blocked, safe_landing: false }, { reason: "path_blocked", mode: "sim" }]) {
      const text = eventDetailText(ev({ type: "run_aborted", detail })) ?? "";
      expect(text).toBe("The way stayed blocked for 25 seconds. It did not land by itself: land it by hand, then clear the corridor.");
      expect(text).not.toMatch(/landed where it was/);
      expect(lastRunResult([ev({ type: "run_aborted", detail })], "2026-11-11")).toMatch(/land it by hand/);
    }
    expect(eventDetailText(ev({ type: "run_aborted", detail: { reason: "obstacle_in_view", automatic: true, safe_landing: false } }))).toBe(
      "Something was in the drone's path before takeoff, so it did not take off.",
    );
  });
});

describe("battery line (SPEC 10.5)", () => {
  const tel = (over: Partial<NonNullable<Status["telemetry"]>>): NonNullable<Status["telemetry"]> => ({
    simulated: false,
    age_s: 0.4,
    fly_state_raw: 1,
    battery_raw: 42,
    flags_raw: 16,
    battery_low: false,
    ...over,
  });
  it("shows the raw byte and its age", () => {
    expect(batteryLine(tel({}))).toEqual({ verdict: "pass", text: "raw 42, 0.4 s ago (raw, unverified units)" });
    expect(batteryLine(tel({ battery_low: true })).verdict).toBe("fail");
  });
  it("'No recent reading' when older than 3 s, with no pass/fail", () => {
    const v = batteryLine(tel({ age_s: 3.5, battery_low: true }));
    expect(v.verdict).toBe("warn");
    expect(v.text).toMatch(/^No recent reading\. Last: raw 42, 3\.5 s ago/);
    expect(batteryLine(tel({ age_s: 3 })).verdict).toBe("pass");
    expect(batteryLine(tel({ age_s: null })).text).toMatch(/^No recent reading/);
  });
  it("battery check off: says so and shows no pass/fail", () => {
    const v = batteryLine(tel({ battery_check_enabled: false, battery_low: true }));
    expect(v.verdict).toBe("info");
    expect(v.text).toContain(BATTERY_CHECK_OFF_TEXT);
    expect(v.text).toContain("raw 42, 0.4 s ago");
    expect(v.text).not.toMatch(/Low:/);
    const stale = batteryLine(tel({ battery_check_enabled: false, age_s: 10 }));
    expect(stale.verdict).toBe("info");
    expect(stale.text).toMatch(/^No recent reading/);
    expect(stale.text).toContain(BATTERY_CHECK_OFF_TEXT);
    // Check enabled (or an older backend without the field): pass/fail as before.
    expect(batteryLine(tel({ battery_check_enabled: true, battery_low: true })).verdict).toBe("fail");
  });
  it("no telemetry: no reading yet", () => {
    expect(batteryLine(null)).toEqual({ verdict: "warn", text: "No reading yet (raw, unverified units)" });
    expect(batteryLine(tel({ battery_raw: null })).verdict).toBe("warn");
  });
});

describe("careFocus", () => {
  it("prefers a pending dose, then the next upcoming one", () => {
    const care = baseStatus().care;
    care.doses = [dose("b", "12:00", "upcoming"), dose("a", "08:00", "due")];
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "a" } });
    care.doses = [dose("b", "12:00", "upcoming"), dose("a", "08:00", "acknowledged"), dose("c", "18:00", "upcoming")];
    expect(careFocus(care)).toMatchObject({ kind: "upcoming", dose: { id: "b" } });
    care.doses = [dose("a", "08:00", "acknowledged")];
    expect(careFocus(care)).toEqual({ kind: "all_done" });
    care.doses = [];
    expect(careFocus(care)).toEqual({ kind: "none_scheduled" });
  });
  it("prefers a dose the drone reached the station for over earlier overdue doses", () => {
    const care = baseStatus().care;
    care.now_local = "22:02";
    care.doses = [
      dose("d1", "08:00", "needs_attention"),
      dose("d2", "13:00", "needs_attention"),
      dose("d3", "20:00", "needs_attention", { arrived_at: "22:01", arrived_mode: "sim" }),
    ];
    care.next_due_id = "d1";
    const focus = careFocus(care);
    expect(focus).toMatchObject({ kind: "pending", dose: { id: "d3" } });
    if (focus.kind !== "pending") throw new Error("expected pending");
    expect(arrivalLine(focus.dose)).toBe("(simulator) The drone reached the station at 22:01");
    // Status "arrived" counts too.
    care.doses = [dose("a", "08:00", "due"), dose("b", "12:00", "arrived", { arrived_at: "11:40" })];
    care.next_due_id = "a";
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "b" } });
  });
  it("with two arrivals, picks the most recent arrival", () => {
    const care = baseStatus().care;
    care.doses = [
      dose("d1", "08:00", "needs_attention", { arrived_at: "21:30" }),
      dose("d2", "13:00", "arrived", { arrived_at: "22:01" }),
      dose("d3", "20:00", "needs_attention", { arrived_at: "21:45" }),
    ];
    care.next_due_id = "d1";
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "d2" } });
  });
  it("with no arrival, falls back to next_due_id, then the earliest pending", () => {
    const care = baseStatus().care;
    care.doses = [dose("d1", "08:00", "needs_attention"), dose("d2", "13:00", "due"), dose("d3", "20:00", "upcoming")];
    care.next_due_id = "d2";
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "d2" } });
    care.next_due_id = null;
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "d1" } });
  });
  it("never picks an acknowledged arrived dose; after picking up the arrival, Next is the earliest outstanding", () => {
    const care = baseStatus().care;
    care.doses = [
      dose("d1", "08:00", "needs_attention"),
      dose("d2", "13:00", "needs_attention"),
      dose("d3", "20:00", "acknowledged", { arrived_at: "22:01", acknowledged_at: "22:03", arrived_mode: "sim" }),
    ];
    care.next_due_id = "d1";
    expect(careFocus(care)).toMatchObject({ kind: "pending", dose: { id: "d1" } });
    // Just acknowledged on this page, snapshot not caught up yet: still not offered again.
    care.doses[2] = dose("d3", "20:00", "needs_attention", { arrived_at: "22:01", arrived_mode: "sim" });
    expect(careFocus(care, "d3")).toMatchObject({ kind: "pending", dose: { id: "d1" } });
    care.next_due_id = null;
    expect(careFocus(care, "d3")).toMatchObject({ kind: "pending", dose: { id: "d1" } });
  });
  it("detects transitions into needs_attention only", () => {
    const prev = new Map([
      ["a", "due"],
      ["b", "needs_attention"],
    ]);
    const now = [dose("a", "08:00", "needs_attention"), dose("b", "09:00", "needs_attention")];
    expect(newlyNeedingAttention(prev, now).map((d) => d.id)).toEqual(["a"]);
    expect(newlyNeedingAttention(null, now)).toEqual([]);
  });
});

describe("preflightChecklist", () => {
  it("handles null telemetry and null marker", () => {
    const rows = preflightChecklist(baseStatus());
    expect(rows.find((r) => r.id === "battery")).toMatchObject({ verdict: "warn" });
    expect(rows.find((r) => r.id === "marker")).toMatchObject({ verdict: "warn", text: "Not in view" });
  });
  it("flags problems with text", () => {
    const s = baseStatus();
    s.link.video_live = false;
    s.vision.person.detected = true;
    s.vision.person.count = 1;
    s.vision.dark = true;
    s.pilot.estop_active = true;
    s.telemetry = { simulated: true, age_s: 0.4, fly_state_raw: 1, battery_raw: 30, flags_raw: 16, battery_low: true };
    s.vision.marker = { id: 7, cx: 0.5, cy: 0.5, width: 0.2, age_s: 0.05 };
    const v = Object.fromEntries(preflightChecklist(s).map((r) => [r.id, r]));
    expect(v.video!.verdict).toBe("fail");
    expect(v.person!.verdict).toBe("fail");
    expect(v.light!.text).toContain("Too dark for position hold");
    expect(v.estop!.verdict).toBe("fail");
    expect(v.battery!.text).toContain("raw, unverified units");
    expect(v.battery!.verdict).toBe("fail");
    expect(v.marker!.verdict).toBe("warn");
  });
});

describe("preflightChecklist: Path ahead (SPEC 11.6)", () => {
  const obstacle = (over: Partial<Obstacle>): Obstacle => ({
    kind: "person",
    box: [0.612, 0.202, 0.746, 0.986],
    distance_m: 2.61,
    lateral_m: 0.66,
    in_lane: true,
    ...over,
  });
  const withObstacles = (obstacles: Obstacle[] | undefined, over: Partial<Status> = {}): Status => {
    const s = { ...baseStatus(), ...over };
    s.vision = { ...s.vision, obstacles };
    return s;
  };
  const row = (s: Status) => preflightChecklist(s).find((r) => r.id === "path");

  it("is one row, after the person check, labelled Path ahead", () => {
    const ids = preflightChecklist(withObstacles([])).map((r) => r.id);
    expect(ids).toEqual(["video", "marker", "person", "path", "light", "battery", "estop"]);
    expect(row(withObstacles([]))?.label).toBe("Path ahead");
  });
  it("passes when nothing is in the lane", () => {
    expect(pathAheadLine(withObstacles([]))).toEqual({ verdict: "pass", text: "Nothing in the way" });
    expect(pathAheadLine(withObstacles([obstacle({ in_lane: false })]))).toEqual({ verdict: "pass", text: "Nothing in the way" });
  });
  it("warns, naming what is in the lane and how far", () => {
    expect(pathAheadLine(withObstacles([obstacle({})]))).toEqual({ verdict: "warn", text: "In the way: person about 2.6 m ahead" });
    expect(pathAheadLine(withObstacles([obstacle({ kind: "object", distance_m: null, lateral_m: null })]))).toEqual({
      verdict: "warn",
      text: "In the way: object closer than about 2.5 m",
    });
    // Nearest first, and how many more.
    expect(
      pathAheadLine(
        withObstacles([obstacle({ distance_m: 2.9 }), obstacle({ kind: "object", distance_m: 2.4 }), obstacle({ in_lane: false, distance_m: 1 })]),
      ).text,
    ).toBe("In the way: object about 2.4 m ahead, and 1 more");
    expect(pathAheadLine(withObstacles([obstacle({ distance_m: 2.9 }), obstacle({ distance_m: null })])).text).toBe(
      "In the way: person closer than about 2.5 m, and 1 more",
    );
  });
  it("gives no distance a camera on the floor would misread as very far", () => {
    // The trolley 2.7 m away, seen from the ground: the backend's hover-height estimate reads 62.5 m.
    expect(pathAheadLine(withObstacles([obstacle({ kind: "object", distance_m: 62.5, lateral_m: 3.75 })]))).toEqual({
      verdict: "warn",
      text: "In the way: object ahead",
    });
    expect(pathAheadLine(withObstacles([obstacle({ distance_m: 8 })])).text).toBe("In the way: person about 8.0 m ahead");
  });
  it("info when the backend does not report it, or without live video", () => {
    expect(pathAheadLine(withObstacles(undefined))).toEqual({
      verdict: "info",
      text: "Not reported by this backend. Check the corridor by eye.",
    });
    const noVideo = withObstacles([]);
    noVideo.link = { ...noVideo.link, video_live: false };
    expect(pathAheadLine(noVideo)).toEqual({ verdict: "info", text: "Not known without live video" });
  });
  it("on the real drone: only people, and only with the person check on", () => {
    const real = withObstacles([], { mode: "real" });
    expect(pathAheadLine(real)).toEqual({
      verdict: "pass",
      text: "No person in the way. Objects are not detected on this drone: check by eye.",
    });
    real.vision = { ...real.vision, person: { ...real.vision.person, enabled: false } };
    expect(pathAheadLine(real)).toEqual({
      verdict: "info",
      text: "Not checked: the person check is off. Check the corridor by eye.",
    });
    expect(pathAheadLine(withObstacles([obstacle({})], { mode: "real" })).text).toBe("In the way: person about 2.6 m ahead");
  });
  it("is never a fail and never claims safety", () => {
    for (const obstacles of [undefined, [], [obstacle({})], [obstacle({ distance_m: null })]]) {
      const v = pathAheadLine(withObstacles(obstacles));
      expect(v.verdict).not.toBe("fail");
      expect(v.text.toLowerCase()).not.toMatch(/safe|deliver|prevent/);
    }
  });
});

describe("connections", () => {
  it("backs off up to 3 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelayMs)).toEqual([500, 1000, 2000, 3000, 3000, 3000]);
  });
});
