// Releasing held inputs (SPEC 10.5): when the control link leaves "open", nothing may stay held across the
// reconnect. Pure helpers, unit-tested in control.test.ts.

export interface Releasable {
  releaseAll: () => void;
}

export interface Cancelable {
  cancel: () => void;
}

/**
 * Called on every control-link state change. When the link is not open, drop every held stick input
 * (keyboard and on-screen pads, one zero `axes` message) and cancel every hold guard in progress
 * (takeoff/land, calibrate). Returns true when it released.
 */
export function releaseOnLinkChange(linkOpen: boolean, flight: Releasable, holds: Cancelable[]): boolean {
  if (linkOpen) return false;
  flight.releaseAll();
  for (const h of holds) h.cancel();
  return true;
}

/**
 * Which on-screen pad each pointer is holding. A pad button that becomes disabled mid-hold never receives its
 * own pointerup, so the window-level pointerup / pointercancel asks this map which pad to release. Tracking by
 * pointer id keeps a two-finger hold working: lifting one finger releases only its own pad.
 */
export class PadPointers {
  private byPointer = new Map<number, string>();

  down(pointerId: number, source: string): void {
    this.byPointer.set(pointerId, source);
  }

  /** The pad source held by this pointer (to release), or null. */
  up(pointerId: number): string | null {
    const s = this.byPointer.get(pointerId) ?? null;
    this.byPointer.delete(pointerId);
    return s;
  }

  clear(): void {
    this.byPointer.clear();
  }
}
