import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from "react";
import type { Axis, AxisInput, Axes, FlightInput } from "../../control/flightInput";
import type { ControlMessage } from "../../api/types";
import { PadPointers } from "../../control/release";
import { STICKPAD_LOCKED_REASON, backendValueLabel } from "../../text/panelsWording";
import "./manual.css";

const AXES: { axis: Axis; label: string }[] = [
  { axis: "throttle", label: "Throttle" },
  { axis: "yaw", label: "Yaw" },
  { axis: "pitch", label: "Pitch" },
  { axis: "roll", label: "Roll" },
];

export function AxisIndicators({ axes, maxStick }: { axes: Axes; maxStick: number | null }) {
  return (
    <div className="axes" role="group" aria-label="Stick values being sent">
      {AXES.map(({ axis, label }) => {
        const v = axes[axis];
        const pct = Math.abs(v) * 50;
        return (
          <div className="axis" key={axis}>
            <span className="axis-label">{label}</span>
            <span className="axis-track" aria-hidden="true">
              <span className="axis-zero" />
              <span className="axis-fill" style={{ left: v < 0 ? `${50 - pct}%` : "50%", width: `${pct}%` }} />
            </span>
            <span className="axis-value">{v < 0 ? v.toFixed(2) : `+${Math.abs(v).toFixed(2)}`}</span>
          </div>
        );
      })}
      <p className="hint axes-note">
        Fractions of full stick, scaled by Max stick{maxStick !== null ? ` (${maxStick.toFixed(2)})` : ""}.
      </p>
    </div>
  );
}

/** Key legend: WASD and arrow clusters laid out like the keyboard, then T and Space. Display only. */
export function KeyLegend() {
  const key = (k: string, name: string, does: string, area: string) => (
    <span className="key" style={{ gridArea: area }}>
      <kbd aria-hidden="true">{k}</kbd>
      <span className="key-does">
        <span className="sr-only">{name}: </span>
        {does}
      </span>
    </span>
  );
  return (
    <div className="key-legend" role="group" aria-label="Flight keys">
      <div className="key-cluster" role="group" aria-label="Pitch and roll">
        {key("W", "W", "Forward", "up")}
        {key("A", "A", "Left", "left")}
        {key("S", "S", "Back", "down")}
        {key("D", "D", "Right", "right")}
      </div>
      <div className="key-cluster" role="group" aria-label="Throttle and yaw">
        {key("↑", "Arrow up", "Up", "up")}
        {key("←", "Arrow left", "Turn left", "left")}
        {key("↓", "Arrow down", "Down", "down")}
        {key("→", "Arrow right", "Turn right", "right")}
      </div>
      <div className="key-singles">
        <span className="key">
          <kbd aria-hidden="true">T</kbd>
          <span className="key-does">
            <span className="sr-only">T: </span>Hold: takeoff / land
          </span>
        </span>
        <span className="key key-estop">
          <kbd aria-hidden="true" className="kbd-wide">
            Space
          </kbd>
          <span className="key-does">
            <span className="sr-only">Space: </span>Emergency stop
          </span>
        </span>
      </div>
    </div>
  );
}

const PAD: { group: string; buttons: { id: string; label: string; key: string; input: AxisInput }[] }[] = [
  {
    group: "Throttle",
    buttons: [
      { id: "throttle+", label: "Up", key: "Arrow up", input: { axis: "throttle", dir: 1 } },
      { id: "throttle-", label: "Down", key: "Arrow down", input: { axis: "throttle", dir: -1 } },
    ],
  },
  {
    group: "Yaw",
    buttons: [
      { id: "yaw-", label: "Turn left", key: "Arrow left", input: { axis: "yaw", dir: -1 } },
      { id: "yaw+", label: "Turn right", key: "Arrow right", input: { axis: "yaw", dir: 1 } },
    ],
  },
  {
    group: "Pitch",
    buttons: [
      { id: "pitch+", label: "Forward", key: "W", input: { axis: "pitch", dir: 1 } },
      { id: "pitch-", label: "Back", key: "S", input: { axis: "pitch", dir: -1 } },
    ],
  },
  {
    group: "Roll",
    buttons: [
      { id: "roll-", label: "Left", key: "A", input: { axis: "roll", dir: -1 } },
      { id: "roll+", label: "Right", key: "D", input: { axis: "roll", dir: 1 } },
    ],
  },
];

/**
 * On-screen hold buttons (touch and mouse): the axis is held while the pointer is down. The pointerup is also
 * caught at window level, so a button that became disabled mid-hold (control link lost) still releases.
 */
export function StickPad({ flight, disabled }: { flight: FlightInput; disabled: boolean }) {
  const pointers = useRef(new PadPointers());

  useEffect(() => {
    const onPointerEnd = (e: PointerEvent) => {
      const source = pointers.current.up(e.pointerId);
      if (source) flight.release(source);
    };
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    const tracked = pointers.current;
    return () => {
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      tracked.clear();
    };
  }, [flight]);

  const down = (id: string, input: AxisInput) => (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.down(e.pointerId, `pad:${id}`);
    flight.press(`pad:${id}`, input);
  };
  const up = (id: string) => () => flight.release(`pad:${id}`);
  const keyDown = (id: string, input: AxisInput) => (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" && !e.repeat) {
      e.preventDefault();
      flight.press(`pad:${id}`, input);
    }
  };
  const keyUp = (id: string) => (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") flight.release(`pad:${id}`);
  };

  return (
    <div className="stickpad">
      {PAD.map((g) => (
        <div className="stickpad-group" role="group" aria-label={`${g.group} hold buttons`} key={g.group}>
          <span className="stickpad-title">{g.group}</span>
          {g.buttons.map((b) => (
            <button
              type="button"
              key={b.id}
              className="btn hold-btn"
              disabled={disabled}
              onPointerDown={down(b.id, b.input)}
              onPointerUp={up(b.id)}
              onPointerCancel={up(b.id)}
              onLostPointerCapture={up(b.id)}
              onKeyDown={keyDown(b.id, b.input)}
              onKeyUp={keyUp(b.id)}
              onBlur={up(b.id)}
              onContextMenu={(e) => e.preventDefault()}
              aria-label={`${g.group} ${b.label} (hold). Key: ${b.key}`}
            >
              <span>{b.label}</span>
              <kbd>{b.key.replace("Arrow ", "")}</kbd>
            </button>
          ))}
        </div>
      ))}
      {disabled && <p className="hint stickpad-reason">{STICKPAD_LOCKED_REASON}</p>}
    </div>
  );
}

const MAX_STICK_SEND_MS = 100;

/** Max-stick slider, 0.2 to 1.0. Sends `max_stick` (throttled while dragging) and shows the backend's value. */
export function MaxStickSlider({
  serverValue,
  send,
  disabled,
}: {
  serverValue: number | null;
  send: (m: ControlMessage) => boolean;
  disabled: boolean;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const lastSent = useRef(0);
  const dragging = useRef(false);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (trailing.current) clearTimeout(trailing.current);
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );

  const push = (v: number) => {
    lastSent.current = performance.now();
    send({ type: "max_stick", value: v });
  };

  const onChange = (v: number) => {
    setLocal(v);
    const since = performance.now() - lastSent.current;
    if (trailing.current) clearTimeout(trailing.current);
    if (since >= MAX_STICK_SEND_MS) push(v);
    else trailing.current = setTimeout(() => push(v), MAX_STICK_SEND_MS - since);
    if (idle.current) clearTimeout(idle.current);
    // After a quiet second, show the backend's value again.
    idle.current = setTimeout(() => setLocal(null), 1000);
  };

  const shown = local ?? serverValue ?? 0.5;
  return (
    <div className="maxstick">
      <input
        id="max-stick"
        aria-labelledby="h-maxstick"
        type="range"
        min={0.2}
        max={1}
        step={0.05}
        value={shown}
        disabled={disabled}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          // Give focus back to the page so nothing is left focused on a flight control (SPEC 10.5).
          e.currentTarget.blur();
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onChange={(e) => {
          onChange(Math.round(Number(e.target.value) * 100) / 100);
          // A change made without a drag (e.g. Page Up, Home) also gives focus back.
          if (!dragging.current) e.currentTarget.blur();
        }}
        aria-describedby="max-stick-desc"
      />
      <output htmlFor="max-stick">
        {shown.toFixed(2)}
      </output>
      <span id="max-stick-desc" className="hint">
        {backendValueLabel()}: {serverValue !== null ? serverValue.toFixed(2) : "unknown"}.
      </span>
    </div>
  );
}
