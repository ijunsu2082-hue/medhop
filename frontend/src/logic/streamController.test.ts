import { describe, expect, it } from "vitest";
import {
  BROKEN_AFTER_SAMPLES,
  LOAD_WATCHDOG_MS,
  RETRY_STEPS_MS,
  StreamController,
  type StreamState,
} from "./streamController";

/** A fake clock plus a fake element that enforces the close-before-replace invariant. */
function harness() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const srcCalls: (string | null)[] = [];
  const states: StreamState[] = [];
  let active: string | null = null;
  const violations: string[] = [];

  const c = new StreamController("http://api/video.mjpg", {
    setSrc: (url) => {
      srcCalls.push(url);
      if (url !== null && active !== null) violations.push(`set ${url} while ${active} was active`);
      active = url;
    },
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, ms });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    onState: (s) => states.push(s),
  });

  /** Advance the clock, firing due timers in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };

  return {
    c,
    advance,
    srcCalls,
    states,
    violations,
    timers,
    get active() {
      return active;
    },
    pendingDelays: () => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b),
  };
}

describe("StreamController", () => {
  it("sets one cache-busted URL on start and arms the load watchdog", () => {
    const h = harness();
    h.c.start(true);
    expect(h.srcCalls).toEqual(["http://api/video.mjpg?r=1"]);
    expect(h.pendingDelays()).toEqual([LOAD_WATCHDOG_MS]);
    expect(h.c.current).toBe("connecting");
  });

  it("does nothing while the backend is not reachable", () => {
    const h = harness();
    h.c.start(false);
    expect(h.srcCalls).toEqual([]);
    expect(h.timers.size).toBe(0);
  });

  it("loaded() clears the watchdog and reports playing once", () => {
    const h = harness();
    h.c.start(true);
    h.c.loaded();
    h.c.loaded(); // multipart images may fire load more than once
    expect(h.timers.size).toBe(0);
    expect(h.states).toEqual(["playing"]);
    h.advance(60_000);
    expect(h.srcCalls).toHaveLength(1);
  });

  it("watchdog: a stream with no first frame within 5 s is cleared and retried", () => {
    const h = harness();
    h.c.start(true);
    h.advance(LOAD_WATCHDOG_MS - 1);
    expect(h.states).toEqual([]);
    h.advance(1);
    expect(h.states).toEqual(["interrupted"]);
    expect(h.active).toBeNull();
    expect(h.srcCalls).toEqual(["http://api/video.mjpg?r=1", null]);
    expect(h.pendingDelays()).toEqual([RETRY_STEPS_MS[0]]);
    h.advance(RETRY_STEPS_MS[0]);
    expect(h.active).toBe("http://api/video.mjpg?r=2");
    h.c.loaded();
    expect(h.states).toEqual(["interrupted", "playing"]);
  });

  it("errors back off 1 s, 2 s, 3 s, then 5 s, and a load resets the backoff", () => {
    const h = harness();
    h.c.start(true);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.c.errored();
      const retry = h.pendingDelays();
      expect(retry).toHaveLength(1); // the watchdog was cleared; only the retry remains
      seen.push(retry[0]!);
      h.advance(retry[0]!);
    }
    expect(seen).toEqual([1000, 2000, 3000, 5000, 5000, 5000]);
    h.c.loaded();
    h.c.errored();
    expect(h.pendingDelays()).toEqual([1000]);
    expect(h.violations).toEqual([]);
  });

  it("ignores stray events when no stream is active, and never schedules two retries", () => {
    const h = harness();
    h.c.start(true);
    h.c.errored();
    h.c.errored(); // src already removed: ignored
    h.c.loaded(); // ignored too
    expect(h.pendingDelays()).toEqual([1000]);
    expect(h.states).toEqual(["interrupted"]);
  });

  it("close before replace: no new URL is ever set while another is active", () => {
    const h = harness();
    h.c.start(true);
    h.c.loaded();
    h.c.setReachable(false);
    h.c.setReachable(true);
    h.advance(LOAD_WATCHDOG_MS);
    h.advance(1000);
    h.c.errored();
    h.c.setReachable(false);
    h.c.setReachable(true);
    h.c.loaded();
    expect(h.violations).toEqual([]);
    const sets = h.srcCalls.filter((u) => u !== null);
    expect(new Set(sets).size).toBe(sets.length); // every URL is new
    for (let i = 1; i < h.srcCalls.length; i++) {
      if (h.srcCalls[i] !== null) expect(h.srcCalls[i - 1]).toBeNull();
    }
  });

  it("unreachable clears the element and cancels timers; reachable again requests exactly one stream", () => {
    const h = harness();
    h.c.start(true);
    h.c.errored(); // retry pending
    h.c.setReachable(false);
    expect(h.timers.size).toBe(0);
    expect(h.active).toBeNull();
    h.c.setReachable(false);
    h.advance(60_000);
    expect(h.srcCalls.filter((u) => u !== null)).toHaveLength(1);
    h.c.setReachable(true);
    h.c.setReachable(true);
    expect(h.srcCalls.filter((u) => u !== null)).toHaveLength(2);
    expect(h.c.current).toBe("connecting");
  });

  it("stop() removes the src and leaves no timer, whatever state it is in", () => {
    for (const setup of [
      (c: StreamController) => c.start(true),
      (c: StreamController) => {
        c.start(true);
        c.errored();
      },
      (c: StreamController) => {
        c.start(true);
        c.loaded();
      },
    ]) {
      const h = harness();
      setup(h.c);
      const statesBefore = h.states.length;
      h.c.stop();
      expect(h.active).toBeNull();
      expect(h.timers.size).toBe(0);
      h.c.errored();
      h.c.setReachable(true);
      h.advance(60_000);
      expect(h.active).toBeNull();
      expect(h.timers.size).toBe(0);
      expect(h.states.length).toBe(statesBefore);
    }
  });

  it("stop() then start() (React StrictMode remount) gives one active stream with a fresh URL", () => {
    const h = harness();
    h.c.start(true);
    h.c.stop();
    h.c.start(true);
    expect(h.srcCalls).toEqual(["http://api/video.mjpg?r=1", null, "http://api/video.mjpg?r=2"]);
    expect(h.violations).toEqual([]);
  });

  it("broken() while playing (mid-play reset, no error event) clears src, reports interrupted and retries once", () => {
    const h = harness();
    h.c.start(true);
    h.c.loaded();
    h.c.broken();
    expect(h.c.current).toBe("interrupted");
    expect(h.states).toEqual(["playing", "interrupted"]);
    expect(h.active).toBeNull();
    expect(h.srcCalls).toEqual(["http://api/video.mjpg?r=1", null]);
    expect(h.pendingDelays()).toEqual([1000]);
    h.c.broken(); // already cleared: ignored, still one retry
    expect(h.pendingDelays()).toEqual([1000]);
    h.advance(1000);
    expect(h.active).toBe("http://api/video.mjpg?r=2");
    expect(h.pendingDelays()).toEqual([LOAD_WATCHDOG_MS]);
    h.c.loaded();
    expect(h.c.current).toBe("playing");
    expect(h.violations).toEqual([]);
  });

  it("broken() is ignored unless a stream is playing", () => {
    const h = harness();
    h.c.broken(); // nothing started
    h.c.start(true);
    h.c.broken(); // connecting: the load watchdog covers this
    expect(h.states).toEqual([]);
    expect(h.srcCalls).toEqual(["http://api/video.mjpg?r=1"]);
    h.c.stop();
    h.c.broken();
    expect(h.timers.size).toBe(0);
  });

  it("samplePicture: two misses in a row while playing take the broken path; a picture in between resets it", () => {
    expect(BROKEN_AFTER_SAMPLES).toBe(2);
    const h = harness();
    h.c.start(true);
    h.c.samplePicture(false); // connecting: not counted
    h.c.samplePicture(false);
    expect(h.states).toEqual([]);
    h.c.loaded();
    h.c.samplePicture(false);
    h.c.samplePicture(true);
    h.c.samplePicture(false);
    expect(h.c.current).toBe("playing");
    h.c.samplePicture(false);
    expect(h.c.current).toBe("interrupted");
    expect(h.active).toBeNull();
    expect(h.pendingDelays()).toEqual([1000]);
    // samples while interrupted or reconnecting do not schedule anything more
    h.c.samplePicture(false);
    h.c.samplePicture(false);
    expect(h.pendingDelays()).toEqual([1000]);
    h.advance(1000);
    h.c.samplePicture(false);
    h.c.samplePicture(false);
    expect(h.c.current).toBe("interrupted");
    expect(h.active).toBe("http://api/video.mjpg?r=2");
    h.c.loaded();
    h.c.samplePicture(false); // the miss count started again after the new load
    expect(h.c.current).toBe("playing");
    expect(h.violations).toEqual([]);
  });

  it("repeated mid-play breaks after each successful load retry after 1 s, with fresh URLs", () => {
    const h = harness();
    h.c.start(true);
    for (let i = 0; i < 4; i++) {
      h.c.loaded();
      h.c.broken();
      expect(h.pendingDelays()).toEqual([1000]);
      h.advance(1000);
    }
    const sets = h.srcCalls.filter((u) => u !== null);
    expect(sets).toHaveLength(5);
    expect(new Set(sets).size).toBe(5);
    expect(h.violations).toEqual([]);
  });
});
