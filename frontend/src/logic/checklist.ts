import type { Status, Telemetry } from "../api/types";

/** "info": shown without a pass/fail judgement (e.g. the battery check is off on the backend). */
export type Verdict = "pass" | "warn" | "fail" | "info";

export interface CheckRow {
  id: string;
  label: string;
  verdict: Verdict;
  text: string;
}

const f2 = (n: number) => n.toFixed(2);

/** Telemetry older than this is "no recent reading" (SPEC 10.1: treated as absent for decisions). */
export const TELEMETRY_STALE_S = 3;

export const BATTERY_CHECK_OFF_TEXT = "Battery check is off (the meaning of this number has not been verified on this drone)";

/**
 * The battery line: the raw byte and its age. "No recent reading" when older than 3 s (or of unknown age).
 * When the backend's battery check is off there is no pass/fail, only the number.
 */
export function batteryLine(t: Telemetry | null): { verdict: Verdict; text: string } {
  if (!t || t.battery_raw === null) return { verdict: "warn", text: "No reading yet (raw, unverified units)" };
  const sim = t.simulated ? ", simulated" : "";
  const age = t.age_s !== null && Number.isFinite(t.age_s) ? `${t.age_s.toFixed(1)} s ago` : "age unknown";
  const raw = `raw ${t.battery_raw}, ${age} (raw, unverified units${sim})`;
  const checkOff = t.battery_check_enabled === false;
  const stale = t.age_s === null || !Number.isFinite(t.age_s) || t.age_s > TELEMETRY_STALE_S;
  if (stale) {
    return {
      verdict: checkOff ? "info" : "warn",
      text: `No recent reading. Last: ${raw}${checkOff ? `. ${BATTERY_CHECK_OFF_TEXT}` : ""}`,
    };
  }
  if (checkOff) return { verdict: "info", text: `${raw}. ${BATTERY_CHECK_OFF_TEXT}` };
  return { verdict: t.battery_low ? "fail" : "pass", text: `${t.battery_low ? "Low: " : ""}${raw}` };
}

/** Pre-flight checklist, derived only from the status snapshot. */
export function preflightChecklist(s: Status): CheckRow[] {
  const rows: CheckRow[] = [];

  rows.push(
    s.link.video_live
      ? {
          id: "video",
          label: "Video",
          verdict: "pass",
          text: s.link.fps !== null ? `Live, ${s.link.fps.toFixed(1)} fps` : "Live",
        }
      : { id: "video", label: "Video", verdict: "fail", text: "No live video" },
  );

  const m = s.vision.marker;
  const arrive = s.mission.arrive_width;
  if (!m) {
    rows.push({ id: "marker", label: "Station sign", verdict: "warn", text: "Not in view" });
  } else if (m.width >= arrive) {
    rows.push({
      id: "marker",
      label: "Station sign",
      verdict: "warn",
      text: `In view, width ${f2(m.width)} is already at or above arrive width ${f2(arrive)}. Move back.`,
    });
  } else {
    rows.push({
      id: "marker",
      label: "Station sign",
      verdict: "pass",
      text: `In view (id ${m.id}), width ${f2(m.width)} of frame, arrive at ${f2(arrive)}`,
    });
  }

  const p = s.vision.person;
  if (!p.enabled) {
    rows.push({ id: "person", label: "Advisory person check", verdict: "warn", text: "Off. Check the corridor by eye." });
  } else if (p.detected) {
    rows.push({
      id: "person",
      label: "Advisory person check",
      verdict: "fail",
      text: p.count > 1 ? `${p.count} people in view` : "Person in view",
    });
  } else {
    rows.push({ id: "person", label: "Advisory person check", verdict: "pass", text: "Clear (advisory only, not a safety system)" });
  }

  const b = s.vision.brightness;
  rows.push(
    s.vision.dark
      ? {
          id: "light",
          label: "Light",
          verdict: "warn",
          text: `Too dark for position hold${b !== null ? ` (brightness ${b.toFixed(0)})` : ""}`,
        }
      : { id: "light", label: "Light", verdict: "pass", text: `Brightness ok${b !== null ? ` (${b.toFixed(0)})` : ""}` },
  );

  rows.push({ id: "battery", label: "Battery", ...batteryLine(s.telemetry) });

  rows.push(
    s.pilot.estop_active
      ? { id: "estop", label: "Emergency stop", verdict: "fail", text: "Active. Reset before flying." }
      : { id: "estop", label: "Emergency stop", verdict: "pass", text: "Not active" },
  );

  return rows;
}
