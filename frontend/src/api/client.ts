import { apiUrl } from "./config";
import type {
  BlockersResponse,
  EventsResponse,
  MissionSettingsBody,
  MissionStartBody,
  ScheduleDoseInput,
  ScheduleResponse,
  Status,
  Trim,
} from "./types";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const TIMEOUT_MS = 4000;

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, parsed, `${method} ${path} failed with HTTP ${res.status}`);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, null, "Backend not reachable");
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a blockers list out of a 409 body, if present. */
export function blockersFrom(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const b = err.body as Partial<BlockersResponse> | null;
  if (b && Array.isArray(b.blockers)) return b.blockers.map(String);
  return null;
}

/** A short human message for a failed call. FastAPI puts messages in `detail`. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Backend not reachable.";
    const body = err.body as { detail?: unknown; message?: unknown } | string | null;
    if (body && typeof body === "object") {
      if (typeof body.detail === "string") return body.detail;
      if (typeof body.message === "string") return body.message;
    } else if (typeof body === "string" && body.length < 200) {
      return body;
    }
    return `Request refused (HTTP ${err.status}).`;
  }
  return "Unexpected error.";
}

export const api = {
  status: (timeoutMs?: number) => request<Status>("GET", "/api/status", undefined, timeoutMs),
  getTrim: () => request<Trim>("GET", "/api/trim"),
  putTrim: (trim: Trim) => request<unknown>("PUT", "/api/trim", { roll: trim.roll, pitch: trim.pitch }),
  missionStart: (doseId: string | null) => {
    const body: MissionStartBody = { confirm_airborne: true, dose_id: doseId };
    return request<unknown>("POST", "/api/mission/start", body);
  },
  /** Automatic run: the backend takes off by itself, so no airborne confirmation is sent. */
  missionStartAuto: (doseId: string | null) => {
    const body: MissionStartBody = { automatic: true, dose_id: doseId };
    return request<unknown>("POST", "/api/mission/start", body);
  },
  /** Marks the drone ready on its start spot for the next scheduled automatic flight (no body). */
  missionReady: () => request<unknown>("POST", "/api/mission/ready"),
  missionAbort: () => request<unknown>("POST", "/api/mission/abort"),
  calibrateArrival: () => request<unknown>("POST", "/api/mission/calibrate-arrival"),
  /** Send only the setting(s) being changed: `{"land_on_arrival": bool}`, `{"drift_assist": bool}` and/or `{"auto_fly": bool}`. */
  missionSettings: (body: MissionSettingsBody) => request<unknown>("PUT", "/api/mission/settings", body),
  hoverTestStart: () => request<unknown>("POST", "/api/hover-test/start"),
  getSchedule: () => request<ScheduleResponse>("GET", "/api/schedule"),
  addDose: (d: ScheduleDoseInput) =>
    request<unknown>("POST", "/api/schedule", { time: d.time, label: d.label, notes: d.notes }),
  updateDose: (id: string, d: ScheduleDoseInput) =>
    request<unknown>("PUT", `/api/schedule/${encodeURIComponent(id)}`, { time: d.time, label: d.label, notes: d.notes }),
  deleteDose: (id: string) => request<unknown>("DELETE", `/api/schedule/${encodeURIComponent(id)}`),
  acknowledge: (id: string) => request<unknown>("POST", `/api/doses/${encodeURIComponent(id)}/acknowledge`),
  events: (limit = 50) => request<EventsResponse>("GET", `/api/events?limit=${limit}`),
};
