// Pure keyboard / hold-button flight input logic. No DOM, no React: unit-tested in flightInput.test.ts.
//
// SPEC section 8: W/S pitch forward/back, A/D roll left/right, ArrowUp/ArrowDown throttle,
// ArrowLeft/ArrowRight yaw, T takeoff/land, Space emergency stop.
// While any axis input is held, send `axes` at 20 Hz; on release send one zero message.
// SPEC 10.5: every key (flight keys, T and Space) pauses ONLY for real text entry. Sliders, checkboxes,
// radios, buttons and selects never block them, and flight keys always preventDefault.

import type { AxesMessage } from "../api/types";

export type Axis = "throttle" | "yaw" | "pitch" | "roll";
export type AxisInput = { axis: Axis; dir: 1 | -1 };

export const AXIS_KEYS: Record<string, AxisInput> = {
  KeyW: { axis: "pitch", dir: 1 },
  KeyS: { axis: "pitch", dir: -1 },
  KeyA: { axis: "roll", dir: -1 },
  KeyD: { axis: "roll", dir: 1 },
  ArrowUp: { axis: "throttle", dir: 1 },
  ArrowDown: { axis: "throttle", dir: -1 },
  ArrowLeft: { axis: "yaw", dir: -1 },
  ArrowRight: { axis: "yaw", dir: 1 },
};

export type KeyAction = { kind: "axis"; input: AxisInput } | { kind: "takeoff_land" } | { kind: "estop" } | null;

/** Map a KeyboardEvent.code (physical key, layout independent) to an action. */
export function keyAction(code: string): KeyAction {
  const a = AXIS_KEYS[code];
  if (a) return { kind: "axis", input: a };
  if (code === "KeyT") return { kind: "takeoff_land" };
  if (code === "Space") return { kind: "estop" };
  return null;
}

/** Minimal element shape so this stays testable without a DOM. */
export interface FocusLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** Any form control (input of any type, textarea, select) or contenteditable. No longer used to pause keys (SPEC 10.5). */
export function isFormControl(el: FocusLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Real text entry: text-type inputs, textarea, contenteditable. The only places where flight keys, T and Space
 * are left to the page. A select is NOT text entry (SPEC 10.5).
 */
export function isTextEntry(el: FocusLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
  return false;
}

export interface Axes {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export const ZERO_AXES: Axes = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };

export function axesMessage(a: Axes): AxesMessage {
  return { type: "axes", throttle: a.throttle, yaw: a.yaw, pitch: a.pitch, roll: a.roll };
}

export interface Timers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const defaultTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Tracks held inputs by source id (e.g. "key:KeyW", "pad:pitch+"), so a keyboard key and an on-screen
 * hold button for the same axis do not cancel each other's release. Opposite directions on one axis sum to 0.
 */
export class FlightInput {
  private held = new Map<string, AxisInput>();
  private timer: unknown = null;
  private listeners = new Set<(a: Axes) => void>();
  private readonly send: (m: AxesMessage) => void;
  private readonly intervalMs: number;
  private readonly timers: Timers;

  constructor(send: (m: AxesMessage) => void, intervalMs = 50, timers: Timers = defaultTimers) {
    this.send = send;
    this.intervalMs = intervalMs;
    this.timers = timers;
  }

  current(): Axes {
    const a: Axes = { ...ZERO_AXES };
    for (const { axis, dir } of this.held.values()) a[axis] += dir;
    for (const k of Object.keys(a) as Axis[]) a[k] = Math.max(-1, Math.min(1, a[k]));
    return a;
  }

  isHolding(): boolean {
    return this.held.size > 0;
  }

  subscribe(fn: (a: Axes) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  press(source: string, input: AxisInput): void {
    const prev = this.held.get(source);
    if (prev && prev.axis === input.axis && prev.dir === input.dir) return; // key repeat
    this.held.set(source, input);
    this.emit();
    this.send(axesMessage(this.current()));
    if (this.timer === null) {
      this.timer = this.timers.setInterval(() => this.tick(), this.intervalMs);
    }
  }

  release(source: string): void {
    if (!this.held.delete(source)) return;
    this.emit();
    if (this.held.size === 0) {
      this.stopTimer();
      this.send(axesMessage(ZERO_AXES));
    } else {
      this.send(axesMessage(this.current()));
    }
  }

  /** Window blur / tab hidden / unmount / control link lost: drop everything and send one zero message. */
  releaseAll(): void {
    const had = this.held.size > 0;
    this.held.clear();
    this.stopTimer();
    if (had) this.emit();
    this.send(axesMessage(ZERO_AXES));
  }

  dispose(): void {
    this.held.clear();
    this.stopTimer();
    this.listeners.clear();
  }

  private tick(): void {
    if (this.held.size === 0) {
      this.stopTimer();
      return;
    }
    this.send(axesMessage(this.current()));
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    const a = this.current();
    for (const fn of this.listeners) fn(a);
  }
}

/** The parts of a KeyboardEvent the flight keyboard reads, so the handlers are testable without a DOM. */
export interface KeyEventLike {
  code: string;
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

export interface FlightKeyHandlers {
  flight: Pick<FlightInput, "press" | "release">;
  releaseAll: () => void;
  onEstop: () => void;
  onTakeoffHoldStart: () => void;
  onTakeoffHoldCancel: () => void;
}

/**
 * Window keydown for the Pilot page. Every key pauses only while real text entry has focus. Flight keys, T and
 * Space always preventDefault otherwise, so a focused slider, select or radio never moves and a focused
 * checkbox or button is never toggled by them.
 */
export function flightKeyDown(e: KeyEventLike, focused: FocusLike | null, hidden: boolean, h: FlightKeyHandlers): void {
  if (e.key === "Meta") {
    // macOS drops key-up events while Cmd is held.
    h.releaseAll();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const action = keyAction(e.code);
  if (!action || hidden) return;
  if (isTextEntry(focused)) return;
  e.preventDefault();
  if (action.kind === "estop") {
    if (!e.repeat) h.onEstop();
  } else if (action.kind === "axis") {
    h.flight.press(`key:${e.code}`, action.input);
  } else if (action.kind === "takeoff_land" && !e.repeat) {
    h.onTakeoffHoldStart();
  }
}

/** Window keyup: always releases (even if focus moved into a text field while the key was down). */
export function flightKeyUp(e: KeyEventLike, focused: FocusLike | null, h: FlightKeyHandlers): void {
  if (e.key === "Meta") {
    h.releaseAll();
    return;
  }
  const action = keyAction(e.code);
  if (!action) return;
  // Stop the key-up from also "clicking" a focused button or checkbox.
  if (!isTextEntry(focused)) e.preventDefault();
  if (action.kind === "axis") h.flight.release(`key:${e.code}`);
  else if (action.kind === "takeoff_land") h.onTakeoffHoldCancel();
}
