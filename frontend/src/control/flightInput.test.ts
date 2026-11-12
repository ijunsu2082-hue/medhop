import { describe, expect, it } from "vitest";
import type { AxesMessage } from "../api/types";
import {
  FlightInput,
  flightKeyDown,
  flightKeyUp,
  isFormControl,
  isTextEntry,
  keyAction,
  type FlightKeyHandlers,
  type FocusLike,
  type KeyEventLike,
  type Timers,
} from "./flightInput";
import { HoldGuard } from "./holdGuard";

/** Manual clock: intervals fire only when we advance. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
  const timers: Timers = {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms, next: now + ms });
      return id;
    },
    clearInterval: (h) => {
      intervals.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let due: { id: number; t: { fn: () => void; ms: number; next: number } } | null = null;
      for (const [id, t] of intervals) if (t.next <= end && (!due || t.next < due.t.next)) due = { id, t };
      if (!due) break;
      now = due.t.next;
      due.t.next += due.t.ms;
      due.t.fn();
    }
    now = end;
  };
  return { timers, advance, active: () => intervals.size };
}

function setup() {
  const sent: AxesMessage[] = [];
  const ft = fakeTimers();
  const fi = new FlightInput((m) => sent.push(m), 50, ft.timers);
  return { sent, fi, ...ft };
}

describe("keyAction", () => {
  it("maps the SPEC section 8 keys", () => {
    expect(keyAction("KeyW")).toEqual({ kind: "axis", input: { axis: "pitch", dir: 1 } });
    expect(keyAction("KeyS")).toEqual({ kind: "axis", input: { axis: "pitch", dir: -1 } });
    expect(keyAction("KeyA")).toEqual({ kind: "axis", input: { axis: "roll", dir: -1 } });
    expect(keyAction("KeyD")).toEqual({ kind: "axis", input: { axis: "roll", dir: 1 } });
    expect(keyAction("ArrowUp")).toEqual({ kind: "axis", input: { axis: "throttle", dir: 1 } });
    expect(keyAction("ArrowDown")).toEqual({ kind: "axis", input: { axis: "throttle", dir: -1 } });
    expect(keyAction("ArrowLeft")).toEqual({ kind: "axis", input: { axis: "yaw", dir: -1 } });
    expect(keyAction("ArrowRight")).toEqual({ kind: "axis", input: { axis: "yaw", dir: 1 } });
    expect(keyAction("KeyT")).toEqual({ kind: "takeoff_land" });
    expect(keyAction("Space")).toEqual({ kind: "estop" });
    expect(keyAction("KeyQ")).toBeNull();
  });
});

describe("focus rules", () => {
  it("treats every input/textarea/select/contenteditable as a form control", () => {
    expect(isFormControl({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isFormControl({ tagName: "INPUT", type: "checkbox" })).toBe(true);
    expect(isFormControl({ tagName: "INPUT", type: "range" })).toBe(true);
    expect(isFormControl({ tagName: "TEXTAREA" })).toBe(true);
    expect(isFormControl({ tagName: "SELECT" })).toBe(true);
    expect(isFormControl({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isFormControl({ tagName: "BUTTON" })).toBe(false);
    expect(isFormControl({ tagName: "BODY" })).toBe(false);
    expect(isFormControl(null)).toBe(false);
  });
  it("isTextEntry: only text-type inputs, textarea and contenteditable are text entry (SPEC 10.5)", () => {
    expect(isTextEntry({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "BODY" })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("flight keyboard handlers (focus rules, SPEC 10.5)", () => {
  function key(code: string, extra: Partial<KeyEventLike> = {}) {
    let prevented = false;
    const e: KeyEventLike = {
      code,
      key: code === "Space" ? " " : code,
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => {
        prevented = true;
      },
      ...extra,
    };
    return { e, prevented: () => prevented };
  }
  function handlers() {
    const sent: AxesMessage[] = [];
    const ft = fakeTimers();
    const flight = new FlightInput((m) => sent.push(m), 50, ft.timers);
    const calls = { estop: 0, holdStart: 0, holdCancel: 0, releaseAll: 0 };
    const h: FlightKeyHandlers = {
      flight,
      releaseAll: () => calls.releaseAll++,
      onEstop: () => calls.estop++,
      onTakeoffHoldStart: () => calls.holdStart++,
      onTakeoffHoldCancel: () => calls.holdCancel++,
    };
    return { sent, flight, calls, h };
  }
  const RANGE: FocusLike = { tagName: "INPUT", type: "range" };
  const CHECKBOX: FocusLike = { tagName: "INPUT", type: "checkbox" };
  const SELECT: FocusLike = { tagName: "SELECT" };
  const TEXT: FocusLike = { tagName: "INPUT", type: "text" };

  it("ArrowUp with a focused range input produces flight input and is defaultPrevented", () => {
    const { sent, flight, h } = handlers();
    const k = key("ArrowUp");
    flightKeyDown(k.e, RANGE, false, h);
    expect(k.prevented()).toBe(true);
    expect(flight.current().throttle).toBe(1);
    expect(sent.at(-1)).toEqual({ type: "axes", throttle: 1, yaw: 0, pitch: 0, roll: 0 });
    const up = key("ArrowUp");
    flightKeyUp(up.e, RANGE, h);
    expect(flight.current().throttle).toBe(0);
    expect(sent.at(-1)).toEqual({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  });

  it("Space with a focused select fires emergency stop and is defaultPrevented", () => {
    const { calls, h } = handlers();
    const k = key("Space");
    flightKeyDown(k.e, SELECT, false, h);
    expect(calls.estop).toBe(1);
    expect(k.prevented()).toBe(true);
  });

  it("checkbox, select and button focus never block W/A/S/D, arrows, T or Space", () => {
    for (const focused of [CHECKBOX, SELECT, RANGE, { tagName: "BUTTON" }, { tagName: "INPUT", type: "radio" }, null]) {
      const { flight, calls, h } = handlers();
      const w = key("KeyW");
      flightKeyDown(w.e, focused, false, h);
      expect(w.prevented()).toBe(true);
      expect(flight.current().pitch).toBe(1);
      const left = key("ArrowLeft");
      flightKeyDown(left.e, focused, false, h);
      expect(left.prevented()).toBe(true);
      expect(flight.current().yaw).toBe(-1);
      const t = key("KeyT");
      flightKeyDown(t.e, focused, false, h);
      expect(calls.holdStart).toBe(1);
      const sp = key("Space");
      flightKeyDown(sp.e, focused, false, h);
      expect(calls.estop).toBe(1);
    }
  });

  it("real text entry pauses flight keys, T and Space and leaves the key to the field", () => {
    for (const focused of [TEXT, { tagName: "TEXTAREA" }, { tagName: "DIV", isContentEditable: true }]) {
      const { flight, calls, h } = handlers();
      for (const code of ["KeyW", "ArrowUp", "KeyT", "Space"]) {
        const k = key(code);
        flightKeyDown(k.e, focused, false, h);
        expect(k.prevented()).toBe(false);
      }
      expect(flight.isHolding()).toBe(false);
      expect(calls.holdStart).toBe(0);
      expect(calls.estop).toBe(0);
    }
  });

  it("key-up always releases, even when focus moved into a text field while the key was held", () => {
    const { flight, calls, h } = handlers();
    flightKeyDown(key("KeyD").e, null, false, h);
    expect(flight.current().roll).toBe(1);
    flightKeyUp(key("KeyD").e, TEXT, h);
    expect(flight.current().roll).toBe(0);
    flightKeyUp(key("KeyT").e, TEXT, h);
    expect(calls.holdCancel).toBe(1);
  });

  it("Space repeat does not re-fire; hidden tab and modifier keys do nothing; Meta releases everything", () => {
    const { flight, calls, h } = handlers();
    flightKeyDown(key("Space", { repeat: true }).e, null, false, h);
    expect(calls.estop).toBe(0);
    flightKeyDown(key("KeyW").e, null, true, h);
    flightKeyDown(key("KeyW", { ctrlKey: true }).e, null, false, h);
    expect(flight.isHolding()).toBe(false);
    flightKeyDown(key("MetaLeft", { key: "Meta" }).e, null, false, h);
    expect(calls.releaseAll).toBe(1);
  });

  it("key-up of Space on a focused checkbox or button is defaultPrevented (no click), not in a text field", () => {
    const { h } = handlers();
    const a = key("Space");
    flightKeyUp(a.e, CHECKBOX, h);
    expect(a.prevented()).toBe(true);
    const b = key("Space");
    flightKeyUp(b.e, TEXT, h);
    expect(b.prevented()).toBe(false);
  });
});

describe("FlightInput", () => {
  it("sends immediately on press, at 20 Hz while held, and one zero message on release", () => {
    const { sent, fi, advance, active } = setup();
    fi.press("key:KeyW", { axis: "pitch", dir: 1 });
    expect(sent).toEqual([{ type: "axes", throttle: 0, yaw: 0, pitch: 1, roll: 0 }]);
    advance(1000);
    expect(sent.length).toBe(1 + 20); // 20 Hz for one second
    expect(sent.every((m) => m.pitch === 1)).toBe(true);
    fi.release("key:KeyW");
    expect(sent.at(-1)).toEqual({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 });
    const n = sent.length;
    advance(1000);
    expect(sent.length).toBe(n); // nothing more after release
    expect(active()).toBe(0);
  });

  it("ignores key repeat (a held key does not restart or duplicate)", () => {
    const { sent, fi } = setup();
    fi.press("key:KeyD", { axis: "roll", dir: 1 });
    fi.press("key:KeyD", { axis: "roll", dir: 1 });
    fi.press("key:KeyD", { axis: "roll", dir: 1 });
    expect(sent.length).toBe(1);
  });

  it("combines axes, opposite keys cancel, partial release keeps sending", () => {
    const { sent, fi, advance } = setup();
    fi.press("key:KeyW", { axis: "pitch", dir: 1 });
    fi.press("key:ArrowLeft", { axis: "yaw", dir: -1 });
    expect(fi.current()).toEqual({ throttle: 0, yaw: -1, pitch: 1, roll: 0 });
    fi.press("key:KeyS", { axis: "pitch", dir: -1 });
    expect(fi.current().pitch).toBe(0);
    fi.release("key:KeyS");
    fi.release("key:KeyW");
    expect(sent.at(-1)).toEqual({ type: "axes", throttle: 0, yaw: -1, pitch: 0, roll: 0 });
    const n = sent.length;
    advance(100);
    expect(sent.length).toBe(n + 2);
    expect(sent.at(-1)!.yaw).toBe(-1);
  });

  it("a keyboard key and an on-screen hold button on the same axis release independently", () => {
    const { fi } = setup();
    fi.press("key:KeyW", { axis: "pitch", dir: 1 });
    fi.press("pad:pitch+", { axis: "pitch", dir: 1 });
    expect(fi.current().pitch).toBe(1); // clamped, not 2
    fi.release("key:KeyW");
    expect(fi.current().pitch).toBe(1);
    fi.release("pad:pitch+");
    expect(fi.current().pitch).toBe(0);
  });

  it("releaseAll (window blur / tab hidden) stops the loop and sends zeros", () => {
    const { sent, fi, advance, active } = setup();
    fi.press("key:ArrowUp", { axis: "throttle", dir: 1 });
    fi.press("key:KeyA", { axis: "roll", dir: -1 });
    fi.releaseAll();
    expect(sent.at(-1)).toEqual({ type: "axes", throttle: 0, yaw: 0, pitch: 0, roll: 0 });
    expect(active()).toBe(0);
    const n = sent.length;
    advance(500);
    expect(sent.length).toBe(n);
  });

  it("releasing a key that was never pressed sends nothing", () => {
    const { sent, fi } = setup();
    fi.release("key:KeyW");
    expect(sent.length).toBe(0);
  });
});

describe("HoldGuard (takeoff / land 0.6 s hold)", () => {
  function guard() {
    let now = 0;
    const pending: { fn: () => void; at: number; id: number }[] = [];
    let id = 0;
    let fired = 0;
    const g = new HoldGuard(() => fired++, 600, {
      setTimeout: (fn, ms) => {
        pending.push({ fn, at: now + ms, id: ++id });
        return id;
      },
      clearTimeout: (h) => {
        const i = pending.findIndex((p) => p.id === h);
        if (i >= 0) pending.splice(i, 1);
      },
      now: () => now,
    });
    const advance = (ms: number) => {
      now += ms;
      for (const p of [...pending]) {
        if (p.at <= now) {
          pending.splice(pending.indexOf(p), 1);
          p.fn();
        }
      }
    };
    return { g, advance, fired: () => fired };
  }

  it("does not fire on a short press", () => {
    const { g, advance, fired } = guard();
    g.start();
    advance(300);
    g.cancel();
    advance(1000);
    expect(fired()).toBe(0);
  });

  it("fires once after 0.6 s of holding", () => {
    const { g, advance, fired } = guard();
    g.start();
    advance(599);
    expect(fired()).toBe(0);
    advance(1);
    expect(fired()).toBe(1);
    advance(2000);
    expect(fired()).toBe(1);
  });

  it("key repeat while holding does not restart the hold", () => {
    const { g, advance, fired } = guard();
    g.start();
    advance(400);
    g.start();
    advance(200);
    expect(fired()).toBe(1);
  });
});
