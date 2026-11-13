// Ports MedHopCore.handle_control and the message handling of the /ws/control endpoint of
// backend/medhop/server.py (SPEC 7 and 10.4): one control message in, the reply to send (or null) out. Every ack
// and error carries `of` (the command type); errors carry `code` and `message`. In memory only.

import { pyReprOf } from "../care/pyCompat";
import type { ControlMixer } from "../mixer";
import { ValueError } from "../util/num";

/** error code for a malformed control message */
export const BAD_REQUEST = "bad_request";
/** a second pilot connection is closed with this code */
export const PILOT_BUSY_CLOSE_CODE = 4001;
export const PILOT_BUSY_REASON = "another pilot is connected";
/** What a pilot connection receives first, once it holds the pilot slot. */
export const HELLO = Object.freeze({ type: "hello", pilot: true } as const);

export type ControlAck = { type: "ack"; of: string } | { type: "ack"; of: "estop"; delivered: boolean };
export interface ControlError {
  type: "error";
  of: string | null;
  code: string | null;
  message: string;
}
export type ControlReply = ControlAck | ControlError;

export function controlError(of: string | null, code: string | null, message: string): ControlError {
  return { type: "error", of, code, message };
}

/** What the socket answers to a text frame that is not JSON. */
export const INVALID_JSON_REPLY: ControlError = Object.freeze(controlError(null, BAD_REQUEST, "invalid JSON")) as ControlError;

const AXES = ["throttle", "yaw", "pitch", "roll"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python `message.get(name, default)`. */
function get(message: Record<string, unknown>, name: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(message, name) ? message[name] : fallback;
}

/** Python `isinstance(value, (int, float)) and not isinstance(value, bool)` for a JSON value. */
function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * handle_control(message): `message` is the parsed JSON. `onAxes` is told about every axes message that was
 * accepted (the engine uses it to drop back to real time while the pilot flies by hand).
 */
export function handleControl(
  mixer: ControlMixer,
  message: unknown,
  onAxes?: (values: readonly [number, number, number, number]) => void,
): ControlReply | null {
  if (!isPlainObject(message)) return controlError(null, BAD_REQUEST, "expected a JSON object");
  const kind = get(message, "type", null);
  const of = typeof kind === "string" ? kind : null;
  try {
    if (kind === "axes") {
      const values: number[] = [];
      for (const name of AXES) {
        const value = get(message, name, 0);
        if (!isNumber(value) || !Number.isFinite(value)) {
          return controlError(of, BAD_REQUEST, `axes.${name} must be a number in [-1, 1]`);
        }
        values.push(value);
      }
      const [throttle, yaw, pitch, roll] = values as [number, number, number, number];
      onAxes?.([throttle, yaw, pitch, roll]);
      mixer.pilotAxes(throttle, yaw, pitch, roll);
      return null;
    }
    if (kind === "takeoff_land") {
      const result = mixer.pilotToggle();
      return result.ok ? { type: "ack", of: kind } : controlError(of, result.code, result.message);
    }
    if (kind === "estop") {
      return { type: "ack", of: "estop", delivered: mixer.pilotEstop() === true };
    }
    if (kind === "estop_reset") {
      mixer.estopReset();
      return { type: "ack", of: kind };
    }
    if (kind === "calibrate") {
      const [ok, why] = mixer.calibrate();
      return ok ? { type: "ack", of: kind } : controlError(of, "estop_active", why);
    }
    if (kind === "max_stick") {
      const value = get(message, "value", null);
      if (!isNumber(value)) return controlError(of, BAD_REQUEST, "max_stick.value must be a number from 0.2 to 1.0");
      mixer.setMaxStick(value);
      return { type: "ack", of: kind };
    }
  } catch (error) {
    if (error instanceof ValueError) return controlError(of, BAD_REQUEST, error.message);
    throw error;
  }
  return controlError(of, BAD_REQUEST, `unknown message type ${pyReprOf(kind)}`);
}

/** One text frame as the socket receives it: invalid JSON is answered, anything else goes to handleControl. */
export function handleControlText(
  mixer: ControlMixer,
  text: string,
  onAxes?: (values: readonly [number, number, number, number]) => void,
): ControlReply | null {
  let message: unknown;
  try {
    message = JSON.parse(text) as unknown;
  } catch {
    return { ...INVALID_JSON_REPLY };
  }
  return handleControl(mixer, message, onAxes);
}
