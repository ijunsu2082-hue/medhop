// The key-value storage the care store keeps its data in: the browser's localStorage, or memory.
//
// In Python the store writes files under the data directory; here every file is one key. A browser
// can refuse storage at any point (private windows, blocked site data, a full quota, a sandboxed
// frame), so the store never talks to the storage directly: it goes through GuardedStorage, which
// falls back to memory for one key as soon as reading or writing that key throws. The data then lives
// for the rest of the session and the page keeps working.

import { SILENT_LOGGER, type Logger } from "../util/log";

/** The part of the DOM Storage interface the store uses (window.localStorage satisfies it). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A KeyValueStorage in memory: for tests, for session-only data, and where no browser storage exists. */
export class MemoryStorage implements KeyValueStorage {
  private readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  /** Every key, in insertion order (not part of KeyValueStorage). */
  keys(): string[] {
    return [...this.items.keys()];
  }

  get size(): number {
    return this.items.size;
  }
}

/**
 * The browser's localStorage, or null where there is none or touching it throws (a SecurityError
 * when site data is blocked). Call it when the store is built, never at module load.
 */
export function browserStorage(): KeyValueStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (!candidate || typeof candidate.getItem !== "function") return null;
    return candidate;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * A KeyValueStorage that never throws. A key whose read or write fails once is served from memory
 * from then on (holding the last value written, or nothing when the read failed), and a warning is
 * logged once for it. `storage` null keeps everything in memory.
 */
export class GuardedStorage implements KeyValueStorage {
  private readonly fallback = new Map<string, string | null>();

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly logger: Logger = SILENT_LOGGER,
  ) {}

  /** True when `key` is kept in memory because the storage failed for it (or there is no storage). */
  inMemory(key: string): boolean {
    return this.storage === null || this.fallback.has(key);
  }

  getItem(key: string): string | null {
    if (this.fallback.has(key)) return this.fallback.get(key) ?? null;
    if (this.storage === null) return null;
    try {
      const value = this.storage.getItem(key);
      return typeof value === "string" ? value : null;
    } catch (error) {
      this.toMemory(key, null, "read", error);
      return null;
    }
  }

  setItem(key: string, value: string): void {
    if (this.storage === null) {
      this.fallback.set(key, value);
      return;
    }
    if (this.fallback.has(key)) {
      this.fallback.set(key, value);
      return;
    }
    try {
      this.storage.setItem(key, value);
    } catch (error) {
      this.toMemory(key, value, "write", error);
    }
  }

  removeItem(key: string): void {
    if (this.storage === null || this.fallback.has(key)) {
      this.fallback.set(key, null);
      return;
    }
    try {
      this.storage.removeItem(key);
    } catch (error) {
      this.toMemory(key, null, "remove", error);
    }
  }

  /**
   * Write straight to the storage, without the memory fallback: true when it worked. For keeping a
   * copy of a corrupt value, which is only worth anything if it survives the session.
   */
  trySetItem(key: string, value: string): boolean {
    if (this.storage === null) return false;
    try {
      this.storage.setItem(key, value);
      return true;
    } catch (error) {
      this.logger.log("warning", `could not write ${key} (${describeError(error)})`);
      return false;
    }
  }

  private toMemory(key: string, value: string | null, what: string, error: unknown): void {
    this.fallback.set(key, value);
    this.logger.log("warning", `could not ${what} ${key} (${describeError(error)}); keeping it in memory for this session`);
  }
}
