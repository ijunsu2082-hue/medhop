// Lifecycle of the MJPEG <img> stream, without React so it can be tested with fake timers (streamController.test.ts).
//
// Why this exists: Chrome keeps an MJPEG connection open for as long as an <img> still points at it, even after
// the element is replaced. Mounting a fresh <img> on every recovery leaked one connection each time, and after
// six of them the per-host connection pool was exhausted and the picture stayed black for ever. This controller
// owns exactly one element and one connection: every new URL is preceded by clearing the old one (which aborts
// the request), and stop() leaves the element with no src and no timer behind.
//
// There is deliberately no re-request when link.video_live changes: the backend keeps the stream open through a
// gap in camera frames and resumes on the same connection.
//
// How a dead stream is noticed:
// - no first frame within LOAD_WATCHDOG_MS: the load watchdog fails it;
// - the element's error event: errored();
// - a connection reset mid-play (socket destroyed, proxy or network drop): Chrome fires NO error event, but the
//   element's naturalWidth drops to 0. VideoFeed samples the element once a second and reports each sample through
//   samplePicture(); BROKEN_AFTER_SAMPLES samples in a row without a picture while playing take the same path as
//   errored() (clear src, 'interrupted', backoff retry).
//
// Known limitation: a stream that ends cleanly mid-play (a terminating chunk, i.e. the server closes the response
// on purpose) gives the browser no signal at all. The last frame stays drawn, img.complete stays true,
// naturalWidth keeps its value and no resource-timing entry appears, so the state stays 'playing'. With this
// backend a clean end only happens when the backend shuts down, and then the status path (socket closes, poll
// fails, reachable becomes false) clears the frame and shows 'Backend not reachable' instead.

export type StreamState = "connecting" | "playing" | "interrupted";

/** Time allowed for the first frame of a new stream before it counts as stalled. */
export const LOAD_WATCHDOG_MS = 5000;
/** Retry delays after a failed or stalled stream; the last step repeats. */
export const RETRY_STEPS_MS = [1000, 2000, 3000, 5000] as const;
/** Consecutive picture samples without a picture, while playing, that count as a broken stream. */
export const BROKEN_AFTER_SAMPLES = 2;

export interface StreamDeps {
  /** Point the element at `url`, or remove its src attribute when null (never set it to ""). */
  setSrc: (url: string | null) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Called only when the state changes. */
  onState: (state: StreamState) => void;
  /** Cache-busting token for the next URL. Defaults to a per-controller counter starting at 1. */
  nextToken?: () => number | string;
}

export class StreamController {
  private readonly base: string;
  private readonly deps: StreamDeps;
  private state: StreamState = "connecting";
  private reachable = false;
  private activeUrl: string | null = null;
  private watchdog: unknown = null;
  private retryTimer: unknown = null;
  private attempt = 0;
  private counter = 0;
  private stopped = false;
  private missedSamples = 0;

  constructor(base: string, deps: StreamDeps) {
    this.base = base;
    this.deps = deps;
  }

  get current(): StreamState {
    return this.state;
  }

  /** The URL the element currently points at, or null. */
  get url(): string | null {
    return this.activeUrl;
  }

  start(reachable: boolean): void {
    this.stopped = false;
    this.reachable = false;
    this.setReachable(reachable);
  }

  setReachable(reachable: boolean): void {
    if (this.stopped || reachable === this.reachable) return;
    this.reachable = reachable;
    if (reachable) {
      this.attempt = 0;
      this.request();
    } else {
      this.cancelTimers();
      this.clear();
      this.setState("connecting");
    }
  }

  /** The element's load event: the stream is delivering frames. */
  loaded(): void {
    if (this.stopped || this.activeUrl === null) return;
    this.clearWatchdog();
    this.attempt = 0;
    this.missedSamples = 0;
    this.setState("playing");
  }

  /** The element's error event. */
  errored(): void {
    if (this.stopped || this.activeUrl === null) return;
    this.fail();
  }

  /**
   * The element stopped showing a picture while playing (a mid-play connection reset fires no error event).
   * Same path as errored(). Ignored unless a stream is playing.
   */
  broken(): void {
    if (this.stopped || this.activeUrl === null || this.state !== "playing") return;
    this.fail();
  }

  /**
   * One periodic sample of the element: does it have a picture (naturalWidth > 0)? Calls broken() after
   * BROKEN_AFTER_SAMPLES samples in a row without one while playing; any sample with a picture resets the count.
   */
  samplePicture(hasPicture: boolean): void {
    if (hasPicture || this.stopped || this.activeUrl === null || this.state !== "playing") {
      this.missedSamples = 0;
      return;
    }
    this.missedSamples += 1;
    if (this.missedSamples >= BROKEN_AFTER_SAMPLES) this.broken();
  }

  stop(): void {
    this.stopped = true;
    this.reachable = false;
    this.cancelTimers();
    this.clear();
  }

  private request(): void {
    if (this.stopped || !this.reachable) return;
    // Close before replace: the old request is aborted before a new one can start.
    this.clear();
    const token = this.deps.nextToken ? this.deps.nextToken() : ++this.counter;
    const url = `${this.base}?r=${token}`;
    this.activeUrl = url;
    this.deps.setSrc(url);
    this.clearWatchdog();
    this.watchdog = this.deps.setTimer(() => {
      this.watchdog = null;
      this.fail();
    }, LOAD_WATCHDOG_MS);
  }

  private fail(): void {
    this.missedSamples = 0;
    this.clearWatchdog();
    this.clear();
    this.setState("interrupted");
    if (this.retryTimer !== null || !this.reachable) return;
    const delay = RETRY_STEPS_MS[Math.min(this.attempt, RETRY_STEPS_MS.length - 1)]!;
    this.attempt += 1;
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.request();
    }, delay);
  }

  private clear(): void {
    if (this.activeUrl === null) return;
    this.activeUrl = null;
    this.deps.setSrc(null);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) this.deps.clearTimer(this.watchdog);
    this.watchdog = null;
  }

  private cancelTimers(): void {
    this.clearWatchdog();
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(s: StreamState): void {
    if (this.stopped || this.state === s) return;
    this.state = s;
    this.deps.onState(s);
  }
}
