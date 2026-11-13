// Ports the REST routes of create_app in backend/medhop/server.py: the same paths, methods, status codes and
// bodies, including FastAPI's own answers (404 {"detail": "Not Found"} for an unknown path, 405 {"detail":
// "Method Not Allowed"}, 422 with the pydantic error list for a body or query that does not validate:
// validation.ts). The UI reads `detail` and `blockers` from these. Checked against FastAPI's TestClient by
// router.contract.test.ts (fixture: __fixtures__/api_contract.json, backend/tools/parity_traces.py api_contract).
//
// Not here: the two WebSockets (the browser transport calls status() and the pilot session directly) and
// /video.mjpg (the camera is drawn in the page from the frames the engine emits).

import { timeLocal } from "../care/localTime";
import { careSnapshot } from "../care/status";
import { KeyError, ValueError } from "../care/store";
import { SCENARIO_NAMES } from "../drone/simActors";
import { pyRound, pyStrRepr, KeyError as NumKeyError, ValueError as NumValueError } from "../util/num";
import type { EngineCore } from "./core";
import {
  DOSE_BODY,
  DOSE_PATCH_BODY,
  MISSION_SETTINGS_BODY,
  MISSION_START_BODY,
  SCENARIO_BODY,
  TRIM_BODY,
  validateBody,
  validateQueryInt,
  type DoseBody,
  type DosePatchBody,
  type MissionSettingsBody,
  type MissionStartBody,
  type ModelSpec,
  type ScenarioBody,
  type TrimBody,
  type ValidationErrorItem,
} from "./validation";

export interface RouteResponse {
  status: number;
  body: unknown;
}

interface RequestParts {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (core: EngineCore, req: RequestParts) => RouteResponse;

interface Route {
  method: string;
  /** segments; ":name" is a path parameter (FastAPI {name}: one segment, any text) */
  pattern: readonly string[];
  handler: Handler;
}

const ok = (body: unknown): RouteResponse => ({ status: 200, body });
const error = (status: number, detail: string): RouteResponse => ({ status, body: { detail } });
const blockers = (list: readonly string[]): RouteResponse => ({ status: 409, body: { blockers: [...list] } });
const invalid = (errors: ValidationErrorItem[]): RouteResponse => ({ status: 422, body: { detail: errors } });

/** A handler with a validated body (FastAPI answers 422 before the handler runs otherwise). */
function withBody<T>(model: ModelSpec, handler: (core: EngineCore, body: T, req: RequestParts) => RouteResponse): Handler {
  return (core, req) => {
    const result = validateBody<T>(model, req.body);
    return result.ok ? handler(core, result.value, req) : invalid(result.errors);
  };
}

function isValueError(e: unknown): e is Error {
  return e instanceof ValueError || e instanceof NumValueError;
}

function isKeyError(e: unknown): e is Error {
  return e instanceof KeyError || e instanceof NumKeyError;
}

const ROUTES: Route[] = [
  // ------------------------------ status ------------------------------ //
  { method: "GET", pattern: ["api", "health"], handler: (core) => ok({ ok: true, mode: core.link.mode }) },
  { method: "GET", pattern: ["api", "status"], handler: (core) => ok(core.status()) },

  // ------------------------------ trim -------------------------------- //
  {
    method: "GET",
    pattern: ["api", "trim"],
    handler: (core) => {
      const [roll, pitch] = core.mixer.trim();
      return ok({ roll, pitch });
    },
  },
  {
    method: "PUT",
    pattern: ["api", "trim"],
    handler: withBody<TrimBody>(TRIM_BODY, (core, body) => {
      let [roll, pitch] = core.mixer.trim();
      try {
        [roll, pitch] = core.mixer.setTrim(body.roll === null ? roll : body.roll, body.pitch === null ? pitch : body.pitch);
      } catch (e) {
        if (isValueError(e)) return error(422, e.message);
        throw e;
      }
      core.store.saveTrim(roll, pitch);
      return ok({ roll, pitch });
    }),
  },

  // ------------------------------ mission ----------------------------- //
  {
    method: "POST",
    pattern: ["api", "mission", "start"],
    handler: withBody<MissionStartBody>(MISSION_START_BODY, (core, body) => {
      if (body.dose_id !== null && core.store.getDose(body.dose_id) === null) {
        return error(404, `unknown dose ${pyStrRepr(body.dose_id)}`);
      }
      const [started, list] = core.runner.start(body.confirm_airborne, body.dose_id, null, body.automatic);
      if (!started) return blockers(list);
      const snapshot = core.runner.snapshot();
      return ok({ ok: true, run_id: snapshot.run_id, state: snapshot.state });
    }),
  },
  {
    method: "POST",
    pattern: ["api", "mission", "abort"],
    handler: (core) => {
      const aborted = core.runner.abort("pilot_took_over");
      core.runner.flush();
      return ok({ ok: true, aborted, state: core.runner.state });
    },
  },
  {
    method: "POST",
    pattern: ["api", "mission", "calibrate-arrival"],
    handler: (core) => {
      const [width, list] = core.runner.calibrateArrival();
      if (width === null) return blockers(list);
      return ok({ ok: true, arrive_width: pyRound(width, 4) });
    },
  },
  {
    method: "PUT",
    pattern: ["api", "mission", "settings"],
    handler: withBody<MissionSettingsBody>(MISSION_SETTINGS_BODY, (core, body) => {
      if (body.land_on_arrival === null && body.drift_assist === null && body.auto_fly === null && body.avoid === null) {
        return error(422, "give land_on_arrival, drift_assist, auto_fly or avoid");
      }
      if (body.avoid !== null) core.runner.setAvoid(body.avoid);
      if (body.auto_fly !== null) core.runner.setAutoFly(body.auto_fly);
      if (body.land_on_arrival !== null) core.runner.setLandOnArrival(body.land_on_arrival);
      if (body.drift_assist !== null) core.runner.setDriftAssist(body.drift_assist);
      return ok(core.runner.settings());
    }),
  },
  {
    method: "POST",
    pattern: ["api", "sim", "scenario"],
    handler: withBody<ScenarioBody>(SCENARIO_BODY, (core, body) => {
      if (!SCENARIO_NAMES.includes(body.name)) {
        return error(422, `unknown scenario ${pyStrRepr(body.name)}; one of ${SCENARIO_NAMES.join(", ")}`);
      }
      const list = core.setScenario(body.name);
      if (list && list.length > 0) return blockers(list);
      return ok({ ok: true, ...core.simSnapshot() });
    }),
  },
  {
    method: "POST",
    pattern: ["api", "mission", "ready"],
    handler: (core) => {
      const [done, list] = core.runner.markReadyForDose();
      if (!done) return blockers(list);
      return ok({ ok: true, ready_for_dose: true });
    },
  },
  {
    method: "POST",
    pattern: ["api", "hover-test", "start"],
    handler: (core) => {
      const [started, list] = core.runner.startHoverTest();
      if (!started) return blockers(list);
      return ok({ ok: true });
    },
  },

  // ------------------------------ care -------------------------------- //
  { method: "GET", pattern: ["api", "schedule"], handler: (core) => ok({ doses: core.store.listDoses() }) },
  {
    method: "POST",
    pattern: ["api", "schedule"],
    handler: withBody<DoseBody>(DOSE_BODY, (core, body) => {
      try {
        return ok(core.store.addDose(body.time, body.label, body.notes));
      } catch (e) {
        if (isValueError(e)) return error(422, e.message);
        throw e;
      }
    }),
  },
  {
    method: "PUT",
    pattern: ["api", "schedule", ":dose_id"],
    handler: withBody<DosePatchBody>(DOSE_PATCH_BODY, (core, body, req) => {
      const doseId = req.params["dose_id"] ?? "";
      try {
        return ok(core.store.updateDose(doseId, body.time, body.label, body.notes));
      } catch (e) {
        if (isKeyError(e)) return error(404, `unknown dose ${pyStrRepr(doseId)}`);
        if (isValueError(e)) return error(422, e.message);
        throw e;
      }
    }),
  },
  {
    method: "DELETE",
    pattern: ["api", "schedule", ":dose_id"],
    handler: (core, req) => {
      const doseId = req.params["dose_id"] ?? "";
      if (!core.store.deleteDose(doseId)) return error(404, `unknown dose ${pyStrRepr(doseId)}`);
      return ok({ ok: true });
    },
  },
  {
    method: "POST",
    pattern: ["api", "doses", ":dose_id", "acknowledge"],
    handler: (core, req) => {
      const doseId = req.params["dose_id"] ?? "";
      if (core.store.getDose(doseId) === null) return error(404, `unknown dose ${pyStrRepr(doseId)}`);
      const snapshot = careSnapshot(core.store, core.nowLocal(), core.settings.grace_min);
      const current = snapshot.doses.find((d) => d.id === doseId);
      if (current !== undefined && current.acknowledged_at !== null) {
        return ok({ ok: true, dose_id: doseId, acknowledged_at: current.acknowledged_at, already_acknowledged: true });
      }
      const event = core.store.addEvent("pickup_acknowledged", { doseId, detail: { self_reported: true } });
      return ok({ ok: true, dose_id: doseId, acknowledged_at: timeLocal(event.ts), already_acknowledged: false });
    },
  },
  {
    method: "GET",
    pattern: ["api", "events"],
    handler: (core, req) => {
      const values = req.query.getAll("limit");
      const limit = validateQueryInt("limit", values.length > 0 ? values[values.length - 1]! : null, 50, 1, 500);
      if (!limit.ok) return invalid(limit.errors);
      return ok({ events: core.store.events(limit.value) });
    },
  },
];

function splitPath(path: string): { segments: string[]; query: URLSearchParams } {
  const q = path.indexOf("?");
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = new URLSearchParams(q < 0 ? "" : path.slice(q + 1));
  const segments = pathname.split("/").slice(1);
  return { segments, query };
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function match(route: Route, segments: readonly string[]): Record<string, string> | null {
  if (route.pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const want = route.pattern[i]!;
    const got = decodeSegment(segments[i]!);
    if (got === null) return null;
    if (want.startsWith(":")) {
      if (got === "") return null;
      params[want.slice(1)] = got;
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

/**
 * One REST request: method, path (with its query string, starting with /api/) and the parsed JSON body
 * (undefined: no body). Never throws for a bad request; an error inside a handler is a 500, as in FastAPI.
 */
export function route(core: EngineCore, method: string, path: string, body: unknown): RouteResponse {
  const { segments, query } = splitPath(path);
  const verb = method.toUpperCase();
  let pathMatched = false;
  for (const r of ROUTES) {
    const params = match(r, segments);
    if (params === null) continue;
    pathMatched = true;
    if (r.method !== verb) continue;
    try {
      return r.handler(core, { params, query, body });
    } catch {
      return { status: 500, body: "Internal Server Error" };
    }
  }
  return pathMatched ? error(405, "Method Not Allowed") : error(404, "Not Found");
}
