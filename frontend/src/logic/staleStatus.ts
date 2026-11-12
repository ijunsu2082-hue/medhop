// When a status WebSocket that is still open counts as stale (frozen backend, half-open connection).
// The backend pushes status five times a second, so STALE_AFTER_MS without a message is far outside normal jitter.
// Used by hooks/useStatus.tsx, which checks every STALE_CHECK_MS while the socket is open and closes a stale one so
// the usual close path (poll, then reconnect) takes over.

export const STALE_AFTER_MS = 2000;
export const STALE_CHECK_MS = 500;

/** True when more than STALE_AFTER_MS has passed since the last message (both times from the same clock). */
export function isStale(now: number, lastMessageAt: number): boolean {
  return now - lastMessageAt > STALE_AFTER_MS;
}
