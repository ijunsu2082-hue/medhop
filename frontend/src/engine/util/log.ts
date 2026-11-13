// Stand-in for Python's `logging` in the engine. The Python modules log through module loggers
// (logging.getLogger("medhop.mixer") and so on); the ported classes take an optional Logger and emit
// the same level and the same formatted message at the same point. Nothing is printed by default.

/** Python's level names in lower case (logger.exception logs at "error"). */
export type LogLevel = "debug" | "info" | "warning" | "error";

export interface Logger {
  log(level: LogLevel, message: string): void;
}

/** The default: drop every message. */
export const SILENT_LOGGER: Logger = {
  log() {},
};

/** A logger that keeps every message, for tests and for an on-screen event list. */
export class MemoryLogger implements Logger {
  readonly entries: [level: LogLevel, message: string][] = [];

  log(level: LogLevel, message: string): void {
    this.entries.push([level, message]);
  }
}
