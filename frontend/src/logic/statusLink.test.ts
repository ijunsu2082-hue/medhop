import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, STALE_CHECK_MS } from "./staleStatus";
import { POLL_INTERVAL_MS, StatusLink, type SocketHandlers, type StatusSocketState } from "./statusLink";

type S = { n: number };

/** A fake clock, fake sockets and a fake status request whose answers the test controls. */
function harness(opts: { pollTimeoutMs?: number } = {}) {
  const pollTimeoutMs = opts.pollTimeoutMs ?? 1500;
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: { h: SocketHandlers; closed: boolean }[] = [];
  const polls: { at: number; resolve: (s: S) => void; reject: (e: unknown) => void; settled: boolean }[] = [];
  const statuses: S[] = [];
  const events: string[] = [];
  const socketStates: StatusSocketState[] = [];
  /** "answer": answers at once; "fail": fails at once; "hang": fails only at its timeout; "never": never settles. */
  let pollMode: "answer" | "fail" | "hang" | "never" = "answer";

  const setTimer = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, fn });
    return id;
  };

  const link = new StatusLink<S>({
    openSocket: (h) => {
      const s = { h, closed: false };
      sockets.push(s);
      return {
        close: () => {
          s.closed = true;
        },
      };
    },
    fetchStatus: () =>
      new Promise<S>((resolve, reject) => {
        const p = { at: now, resolve, reject, settled: false };
        polls.push(p);
        if (pollMode === "answer") resolve({ n: -1 });
        else if (pollMode === "fail") reject(new Error("down"));
        else if (pollMode === "hang") setTimer(() => reject(new Error("timeout")), pollTimeoutMs);
      }),
    parse: (data) => {
      const v = JSON.parse(String(data)) as S;
      if (typeof v.n !== "number") throw new Error("bad");
      return v;
    },
    setTimer,
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    now: () => now,
    reconnectDelayMs: (a) => [500, 1000, 2000, 3000][Math.min(a, 3)]!,
    onStatus: (s) => {
      statuses.push(s);
      events.push(`status@${now}`);
    },
    onUnreachable: () => events.push(`unreachable@${now}`),
    onSocketState: (s) => socketStates.push(s),
  });

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  /** Advance the clock in small steps, firing due timers and letting promise callbacks run between them. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await flush();
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
    await flush();
  };

  const last = () => sockets[sockets.length - 1]!;

  return {
    link,
    advance,
    sockets,
    polls,
    statuses,
    events,
    socketStates,
    timers,
    last,
    setPollMode: (m: "answer" | "fail" | "hang" | "never") => {
      pollMode = m;
    },
    get now() {
      return now;
    },
  };
}

describe("StatusLink", () => {
  it("opens one socket and polls once right away; the poll stops at the socket's first message", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.polls).toHaveLength(1);
    h.last().h.onOpen();
    h.last().h.onMessage('{"n":1}');
    expect(h.link.isDelivering).toBe(true);
    expect(h.socketStates).toEqual(["open"]);
    for (let i = 0; i < 50; i++) {
      await h.advance(200);
      h.last().h.onMessage(`{"n":${i + 2}}`);
    }
    expect(h.sockets).toHaveLength(1);
    expect(h.polls).toHaveLength(1);
    expect(h.link.isPolling).toBe(false);
  });

  it("an open socket is not delivering: the poll keeps running and the socket state stays 'connecting'", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    h.last().h.onOpen();
    expect(h.link.isDelivering).toBe(false);
    expect(h.socketStates).toEqual([]);
    await h.advance(POLL_INTERVAL_MS + 10);
    expect(h.polls.length).toBe(2);
    expect(h.link.isPolling).toBe(true);
  });

  it("open but silent socket and a failing poll: reported unreachable (the open does not hide the failure)", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    h.setPollMode("fail");
    h.last().h.onOpen();
    await h.advance(POLL_INTERVAL_MS);
    expect(h.events.some((e) => e.startsWith("unreachable"))).toBe(true);
  });

  it("frozen backend that accepts the socket but never sends, with a hanging poll: unreachable within 5 s", async () => {
    // The reproduced defect: delivering socket goes silent; stale check closes it; the poll hangs until its timeout;
    // meanwhile the reconnect opens a new socket that never speaks. The poll's timeout must still count.
    const h = harness({ pollTimeoutMs: 1500 });
    h.link.start();
    await h.advance(0);
    h.last().h.onOpen();
    for (let i = 0; i < 5; i++) {
      h.last().h.onMessage(`{"n":${i}}`);
      await h.advance(200);
    }
    const frozeAt = h.now - 200; // the last message
    h.setPollMode("hang");
    let unreachableAt: number | null = null;
    for (let t = 0; t < 9000 && unreachableAt === null; t += 50) {
      await h.advance(50);
      // every new socket opens at once (handshake succeeds) and then says nothing
      const s = h.last();
      if (!s.closed && !(s as { opened?: boolean }).opened) {
        (s as { opened?: boolean }).opened = true;
        s.h.onOpen();
      }
      const u = h.events.find((e) => e.startsWith("unreachable"));
      if (u) unreachableAt = Number(u.split("@")[1]);
    }
    expect(unreachableAt).not.toBeNull();
    expect(unreachableAt! - frozeAt).toBeLessThanOrEqual(5000);
    expect(h.sockets.length).toBeGreaterThan(1); // it did reconnect, and the new open socket did not hide the failure
    expect(h.socketStates[h.socketStates.length - 1]).not.toBe("open");
  });

  it("a delivering socket that goes silent is closed after STALE_AFTER_MS, then polling and reconnect take over", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    const first = h.last();
    first.h.onOpen();
    first.h.onMessage('{"n":1}');
    const silentFrom = h.now;
    await h.advance(STALE_AFTER_MS + STALE_CHECK_MS + 1);
    expect(first.closed).toBe(true);
    expect(h.socketStates).toEqual(["open", "closed"]);
    expect(h.link.isPolling).toBe(true);
    expect(h.polls.length).toBe(2);
    expect(h.polls[1]!.at - silentFrom).toBeLessThanOrEqual(STALE_AFTER_MS + STALE_CHECK_MS);
    await h.advance(500);
    expect(h.sockets).toHaveLength(2);
    expect(h.socketStates[h.socketStates.length - 1]).toBe("connecting");
  });

  it("regular messages keep the socket open; late handlers from a replaced socket are ignored", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    const first = h.last();
    first.h.onOpen();
    for (let i = 0; i < 50; i++) {
      first.h.onMessage(`{"n":${i}}`);
      await h.advance(200);
    }
    expect(first.closed).toBe(false);
    expect(h.sockets).toHaveLength(1);
    first.h.onClose();
    await h.advance(500);
    expect(h.sockets).toHaveLength(2);
    const before = h.statuses.length;
    first.h.onMessage('{"n":999}'); // stale socket
    first.h.onClose();
    expect(h.statuses.length).toBe(before);
    expect(h.sockets).toHaveLength(2);
  });

  it("a malformed message is ignored and does not count as delivering", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    h.last().h.onOpen();
    h.last().h.onMessage("not json");
    expect(h.link.isDelivering).toBe(false);
    expect(h.statuses.filter((s) => s.n >= 0)).toHaveLength(0);
  });

  it("reconnect backoff grows while sockets fail and resets after a delivered message", async () => {
    const h = harness();
    h.link.start();
    await h.advance(0);
    const opensAt: number[] = [h.now];
    for (let i = 0; i < 4; i++) {
      h.last().h.onClose();
      const n = h.sockets.length;
      while (h.sockets.length === n) await h.advance(50);
      opensAt.push(h.now);
    }
    const gaps = opensAt.slice(1).map((t, i) => t - opensAt[i]!);
    expect(gaps).toEqual([500, 1000, 2000, 3000]);
    h.last().h.onOpen();
    h.last().h.onMessage('{"n":1}');
    h.last().h.onClose();
    const t = h.now;
    const n = h.sockets.length;
    while (h.sockets.length === n) await h.advance(50);
    expect(h.now - t).toBe(500);
  });

  it("a poll answer that arrives after the socket started delivering is discarded", async () => {
    const h = harness();
    h.setPollMode("hang");
    h.link.start();
    await h.advance(0);
    h.last().h.onOpen();
    h.last().h.onMessage('{"n":1}');
    h.polls[0]!.resolve({ n: -7 });
    await h.advance(0);
    expect(h.statuses.map((s) => s.n)).toEqual([1]);
  });

  it("dispose() closes the socket and leaves no timer, whatever state it is in", async () => {
    for (const stage of ["before-connect", "open-silent", "delivering", "reconnecting"] as const) {
      const h = harness();
      h.setPollMode("never");
      h.link.start();
      if (stage !== "before-connect") await h.advance(0);
      if (stage === "open-silent" || stage === "delivering") h.last().h.onOpen();
      if (stage === "delivering") h.last().h.onMessage('{"n":1}');
      if (stage === "reconnecting") h.last().h.onClose();
      h.link.dispose();
      expect(h.timers.size).toBe(0);
      if (stage === "open-silent" || stage === "delivering") expect(h.last().closed).toBe(true);
      const nSockets = h.sockets.length;
      const nPolls = h.polls.length;
      await h.advance(20_000);
      expect(h.sockets.length).toBe(nSockets);
      expect(h.polls.length).toBe(nPolls);
      expect(h.events.filter((e) => e.startsWith("unreachable"))).toHaveLength(0);
    }
  });
});
