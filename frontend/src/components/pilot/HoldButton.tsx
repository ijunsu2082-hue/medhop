import type { PointerEvent as RPointerEvent, KeyboardEvent as RKeyboardEvent, ReactNode } from "react";

export interface Hold {
  start: () => void;
  cancel: () => void;
  progress: number;
  holding: boolean;
}

interface Props {
  /** the useHoldGuard object: the command fires only after a full 0.6 s hold */
  hold: Hold;
  disabled: boolean;
  label: ReactNode;
  /** text under the label while not holding; while holding it reads "Keep holding..." */
  sub: string;
  /** id of the sub-text span, used for aria-describedby; must be unique on the page */
  subId: string;
  keyShortcut?: string;
  className?: string;
}

/**
 * Press-and-hold button: starts the hold on pointer-down (left button) or Enter, cancels on release, pointer
 * cancel, lost capture or blur. The same handlers the takeoff button always had, so two of these bound to one
 * `hold` object share a single hold.
 */
export function HoldButton({ hold, disabled, label, sub, subId, keyShortcut, className }: Props) {
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
    <button
      type="button"
      className={`takeoff${className ? ` ${className}` : ""}`}
      disabled={disabled}
      onPointerDown={down}
      onPointerUp={hold.cancel}
      onPointerCancel={hold.cancel}
      onLostPointerCapture={hold.cancel}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onBlur={hold.cancel}
      onContextMenu={(e) => e.preventDefault()}
      aria-keyshortcuts={keyShortcut}
      aria-describedby={subId}
      data-holding={hold.holding ? "true" : undefined}
    >
      <span className="takeoff-fill" style={{ transform: `scaleX(${hold.progress})` }} aria-hidden="true" />
      <span className="takeoff-label">{label}</span>
      <span className="takeoff-sub" id={subId}>
        {hold.holding ? "Keep holding..." : sub}
      </span>
    </button>
  );
}
