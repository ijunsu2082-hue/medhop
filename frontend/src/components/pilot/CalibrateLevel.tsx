import type { PointerEvent as RPointerEvent, KeyboardEvent as RKeyboardEvent } from "react";

interface Props {
  hold: { start: () => void; cancel: () => void; progress: number; holding: boolean };
  /** why the button is disabled, or null when it can be used */
  blocked: string | null;
  note: { ok: boolean | null; text: string } | null;
}

/** "Calibrate level": sends {"type":"calibrate"} on the control socket after a 0.6 s hold (same guard as takeoff). */
export function CalibrateLevel({ hold, blocked, note }: Props) {
  const disabled = blocked !== null;

  const down = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    hold.start();
  };
  const keyDown = (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" && !e.repeat) {
      e.preventDefault();
      hold.start();
    }
  };
  const keyUp = (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") hold.cancel();
  };

  return (
    <div className="calibrate-level">
      <p className="hint">Only on flat ground with the motors off.</p>
      <button
        type="button"
        className="takeoff calibrate-btn"
        disabled={disabled}
        onPointerDown={down}
        onPointerUp={hold.cancel}
        onPointerCancel={hold.cancel}
        onLostPointerCapture={hold.cancel}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onBlur={hold.cancel}
        onContextMenu={(e) => e.preventDefault()}
        aria-describedby="cal-level-desc"
      >
        <span className="takeoff-fill" style={{ transform: `scaleX(${hold.progress})` }} aria-hidden="true" />
        <span className="takeoff-label">Calibrate level</span>
        <span className="takeoff-sub" id="cal-level-desc">
          {hold.holding ? "Keep holding..." : "Press and hold 0.6 s"}
        </span>
      </button>
      {blocked && <p className="muted small">{blocked}</p>}
      {note && (
        <p className={`msg ${note.ok === true ? "msg-pass" : note.ok === false ? "msg-fail" : "msg-warn"}`} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}
