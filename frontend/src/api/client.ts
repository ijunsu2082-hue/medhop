import { pageModeChange, requestRefusal, type ModeChange } from "../logic/modeGuard";
import { getTransport, type Transport, type TransportResponse } from "../transport";
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

/** Status of a request refused on this page by the mode guard (HTTP 423 Locked). Not 409: some panels read a 409
 * as "no sign in view"; with any other status every panel shows the body's detail. */
export const LOCKED_STATUS = 423;

/**
 * One call through `transport`. An answer outside 200-299 becomes an ApiError with its status and body; a backend
 * that cannot be reached (the transport rejects, or throws) becomes an ApiError with status 0.
 *
 * The mode guard's choke point for REST (logic/modeGuard.ts): once the backend's mode has changed under this page,
 * every request except GETs and the run abort is refused here, before it leaves the page, as an ApiError with
 * LOCKED_STATUS and `{ detail }` saying why. `modeChange` is this page's latch unless a test passes one.
 */
export async function requestVia<T>(
  transport: Pick<Transport, "request">,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
  modeChange: ModeChange | null = pageModeChange(),
): Promise<T> {
  const refusal = requestRefusal(method, path, modeChange);
  if (refusal !== null) {
    throw new ApiError(LOCKED_STATUS, { detail: refusal }, `${method} ${path} refused: controls are locked`);
  }
  let res: TransportResponse;
  try {
    res = await transport.request(method, path, body, timeoutMs);
  } catch {
    throw new ApiError(0, null, "Backend not reachable");
  }
  if (!(res.status >= 200 && res.status <= 299)) {
    throw new ApiError(res.status, res.body, `${method} ${path} failed with HTTP ${res.status}`);
  }
  return res.body as T;
}

function request<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  return requestVia<T>(getTransport(), method, path, body, timeoutMs);
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
  /** Waiting for people and obstacles (SPEC 11.5), through the settings call: "hold" or "off". Returns the full settings. */
  setAvoid: (avoid: NonNullable<MissionSettingsBody["avoid"]>) =>
    request<import("./types").MissionSettings>("PUT", "/api/mission/settings", { avoid } satisfies MissionSettingsBody),
  /** Simulator only (SPEC 11.6): who and what is in the corridor. 409 with blockers on the real drone or during a run. */
  setSimScenario: (name: import("./types").SimScenarioName) =>
    request<import("./types").SimScenarioResponse>("POST", "/api/sim/scenario", { name }),
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
