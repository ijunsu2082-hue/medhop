/** Reconnect delay: 0.5 s, 1 s, 2 s, then 3 s forever (SPEC: backoff up to 3 s). */
export function reconnectDelayMs(attempt: number): number {
  const steps = [500, 1000, 2000, 3000];
  return steps[Math.min(Math.max(attempt, 0), steps.length - 1)]!;
}

/** Close code the backend uses to refuse a second pilot window on /ws/control. */
export const CONTROL_REFUSED_CODE = 4001;
/** After a 4001 refusal, do not retry more often than this. */
export const CONTROL_REFUSED_RETRY_MS = 5000;
