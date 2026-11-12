// Press-and-hold guard: the action fires only after the input has been held continuously for `holdMs`.
// Used for Takeoff / Land (button and T key) so a stray click or tap cannot launch the drone.

export const TAKEOFF_HOLD_MS = 600;

export interface HoldTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}

const defaultTimers: HoldTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export class HoldGuard {
  private timer: unknown = null;
  private startedAt: number | null = null;
  private readonly onFire: () => void;
  private readonly holdMs: number;
  private readonly timers: HoldTimers;

  constructor(onFire: () => void, holdMs = TAKEOFF_HOLD_MS, timers: HoldTimers = defaultTimers) {
    this.onFire = onFire;
    this.holdMs = holdMs;
    this.timers = timers;
  }

  get holding(): boolean {
    return this.startedAt !== null;
  }

  /** 0..1 progress of the current hold, 0 when not holding. */
  progress(): number {
    if (this.startedAt === null) return 0;
    return Math.min(1, (this.timers.now() - this.startedAt) / this.holdMs);
  }

  /** Start a hold. A second start while already holding (key repeat) is ignored. */
  start(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.timers.now();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.startedAt = null;
      this.onFire();
    }, this.holdMs);
  }

  /** Released early (or pointer left / focus lost): nothing happens. */
  cancel(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.startedAt = null;
  }
}
