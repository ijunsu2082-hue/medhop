// The request validation FastAPI does before a handler of backend/medhop/server.py runs: the pydantic body
// models (TrimBody, MissionStartBody, ...) and the `limit` query parameter of GET /api/events, in pydantic 2's
// lax mode. A refused request answers 422 with FastAPI's body, `{"detail": [{"type", "loc", "msg", "input",
// "ctx"?}, ...]}`: every error, in field order (the router's contract test checks these against FastAPI).
//
// Covered: the field kinds the models use (float, bool, str, a str Literal, each optionally nullable, with or
// without a default), a missing body, a body that is not an object, and an int query parameter with ge/le.
// Not covered (the browser transport never produces them): invalid JSON text, bytes, and pydantic's rarer
// coercions (for example a float given as "1_000", which pydantic refuses and Python's float() accepts).
// Fields a model does not declare are ignored, as pydantic does by default.

import { pyStrip } from "../care/pyCompat";

export interface ValidationErrorItem {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

export type FieldKind =
  | { kind: "float" }
  | { kind: "bool" }
  | { kind: "str" }
  | { kind: "literal"; values: readonly string[] };

export interface FieldSpec {
  name: string;
  type: FieldKind;
  /** Optional[...]: null is accepted (and kept) */
  nullable: boolean;
  /** no default: the field must be given */
  required: boolean;
  /** used when the field is missing (required false) */
  default?: unknown;
}

export type ModelSpec = readonly FieldSpec[];

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: ValidationErrorItem[] };

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const FLOAT_SPECIAL_RE = /^([+-]?)(inf|infinity|nan)$/i;
const INT_RE = /^[+-]?\d+$/;
const TRUE_WORDS = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_WORDS = new Set(["0", "off", "f", "false", "n", "no"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** pydantic's "'a' or 'b'" / "'a', 'b' or 'c'" for a Literal. */
function expectedText(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

type FieldResult = { ok: true; value: unknown } | { ok: false; error: Omit<ValidationErrorItem, "loc"> };

function validateFloat(value: unknown): FieldResult {
  if (typeof value === "number") return { ok: true, value };
  if (typeof value === "boolean") return { ok: true, value: value ? 1.0 : 0.0 };
  if (typeof value === "string") {
    const text = pyStrip(value);
    const special = FLOAT_SPECIAL_RE.exec(text);
    if (special) {
      if ((special[2] ?? "").toLowerCase() === "nan") return { ok: true, value: Number.NaN };
      return { ok: true, value: special[1] === "-" ? -Infinity : Infinity };
    }
    if (FLOAT_RE.test(text)) return { ok: true, value: Number(text) };
    return {
      ok: false,
      error: { type: "float_parsing", msg: "Input should be a valid number, unable to parse string as a number", input: value },
    };
  }
  return { ok: false, error: { type: "float_type", msg: "Input should be a valid number", input: value } };
}

function validateBool(value: unknown): FieldResult {
  if (typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") {
    if (value === 0) return { ok: true, value: false };
    if (value === 1) return { ok: true, value: true };
    return {
      ok: false,
      error: { type: "bool_parsing", msg: "Input should be a valid boolean, unable to interpret input", input: value },
    };
  }
  if (typeof value === "string") {
    const word = value.toLowerCase();
    if (TRUE_WORDS.has(word)) return { ok: true, value: true };
    if (FALSE_WORDS.has(word)) return { ok: true, value: false };
    return {
      ok: false,
      error: { type: "bool_parsing", msg: "Input should be a valid boolean, unable to interpret input", input: value },
    };
  }
  return { ok: false, error: { type: "bool_type", msg: "Input should be a valid boolean", input: value } };
}

function validateStr(value: unknown): FieldResult {
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, error: { type: "string_type", msg: "Input should be a valid string", input: value } };
}

function validateLiteral(value: unknown, values: readonly string[]): FieldResult {
  if (typeof value === "string" && values.includes(value)) return { ok: true, value };
  const expected = expectedText(values);
  return { ok: false, error: { type: "literal_error", msg: `Input should be ${expected}`, input: value, ctx: { expected } } };
}

function validateField(spec: FieldSpec, value: unknown): FieldResult {
  if (value === null && spec.nullable) return { ok: true, value: null };
  switch (spec.type.kind) {
    case "float":
      return validateFloat(value);
    case "bool":
      return validateBool(value);
    case "str":
      return validateStr(value);
    case "literal":
      return validateLiteral(value, spec.type.values);
  }
}

/**
 * A JSON body against a pydantic model. `body` undefined (or null) is a request without a body, which FastAPI
 * refuses for a route that takes one, even when every field has a default.
 */
export function validateBody<T>(model: ModelSpec, body: unknown): Validated<T> {
  if (body === undefined || body === null) {
    return { ok: false, errors: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }] };
  }
  if (!isPlainObject(body)) {
    return {
      ok: false,
      errors: [
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: body,
        },
      ],
    };
  }
  const out: Record<string, unknown> = {};
  const errors: ValidationErrorItem[] = [];
  for (const spec of model) {
    if (!hasOwn(body, spec.name) || body[spec.name] === undefined) {
      if (spec.required) errors.push({ type: "missing", loc: ["body", spec.name], msg: "Field required", input: body });
      else out[spec.name] = spec.default ?? null;
      continue;
    }
    const result = validateField(spec, body[spec.name]);
    if (result.ok) out[spec.name] = result.value;
    else errors.push({ type: result.error.type, loc: ["body", spec.name], msg: result.error.msg, input: result.error.input, ...(result.error.ctx ? { ctx: result.error.ctx } : {}) });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out as T };
}

/** `name: int = Query(default, ge=..., le=...)` from the raw query string value (null: not given). */
export function validateQueryInt(
  name: string,
  raw: string | null,
  defaultValue: number,
  ge: number,
  le: number,
): Validated<number> {
  if (raw === null) return { ok: true, value: defaultValue };
  const text = pyStrip(raw);
  if (!INT_RE.test(text)) {
    return {
      ok: false,
      errors: [
        { type: "int_parsing", loc: ["query", name], msg: "Input should be a valid integer, unable to parse string as an integer", input: raw },
      ],
    };
  }
  const value = Number(text);
  if (value < ge) {
    return {
      ok: false,
      errors: [{ type: "greater_than_equal", loc: ["query", name], msg: `Input should be greater than or equal to ${ge}`, input: raw, ctx: { ge } }],
    };
  }
  if (value > le) {
    return {
      ok: false,
      errors: [{ type: "less_than_equal", loc: ["query", name], msg: `Input should be less than or equal to ${le}`, input: raw, ctx: { le } }],
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------- //
// the request bodies of server.py

const opt = (name: string, type: FieldKind, defaultValue: unknown = null): FieldSpec => ({
  name,
  type,
  nullable: true,
  required: false,
  default: defaultValue,
});
const FLOAT: FieldKind = { kind: "float" };
const BOOL: FieldKind = { kind: "bool" };
const STR: FieldKind = { kind: "str" };

export interface TrimBody {
  roll: number | null;
  pitch: number | null;
}
export const TRIM_BODY: ModelSpec = [opt("roll", FLOAT), opt("pitch", FLOAT)];

export interface MissionStartBody {
  confirm_airborne: boolean;
  dose_id: string | null;
  automatic: boolean;
}
export const MISSION_START_BODY: ModelSpec = [
  { name: "confirm_airborne", type: BOOL, nullable: false, required: false, default: false },
  opt("dose_id", STR),
  { name: "automatic", type: BOOL, nullable: false, required: false, default: false },
];

export interface MissionSettingsBody {
  land_on_arrival: boolean | null;
  drift_assist: boolean | null;
  auto_fly: boolean | null;
  avoid: "off" | "hold" | null;
}
export const MISSION_SETTINGS_BODY: ModelSpec = [
  opt("land_on_arrival", BOOL),
  opt("drift_assist", BOOL),
  opt("auto_fly", BOOL),
  opt("avoid", { kind: "literal", values: ["off", "hold"] }),
];

export interface ScenarioBody {
  name: string;
}
export const SCENARIO_BODY: ModelSpec = [{ name: "name", type: STR, nullable: false, required: true }];

export interface DoseBody {
  time: string;
  label: string;
  notes: string;
}
export const DOSE_BODY: ModelSpec = [
  { name: "time", type: STR, nullable: false, required: true },
  { name: "label", type: STR, nullable: false, required: true },
  { name: "notes", type: STR, nullable: false, required: false, default: "" },
];

export interface DosePatchBody {
  time: string | null;
  label: string | null;
  notes: string | null;
}
export const DOSE_PATCH_BODY: ModelSpec = [opt("time", STR), opt("label", STR), opt("notes", STR)];
