import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE, apiUrl, createTransport, normaliseBase, wsUrl, wsUrlFrom } from "./python";

describe("Python backend URLs", () => {
  it("derives ws URLs from the API base", () => {
    expect(wsUrlFrom("http://localhost:8010", "/ws/status")).toBe("ws://localhost:8010/ws/status");
    expect(wsUrlFrom("https://example.test/base", "/ws/control")).toBe("wss://example.test/base/ws/control");
  });

  it("drops trailing slashes from the base before adding the path", () => {
    expect(wsUrlFrom("http://example.test:9000//", "/ws/status")).toBe("ws://example.test:9000/ws/status");
  });

  it("normalises the configured base: trimmed, no trailing slash, the local backend when empty", () => {
    expect(normaliseBase(undefined)).toBe("http://localhost:8010");
    expect(normaliseBase("")).toBe("http://localhost:8010");
    expect(normaliseBase("   ")).toBe("http://localhost:8010");
    expect(normaliseBase(" http://drone.local:8010/ ")).toBe("http://drone.local:8010");
    expect(normaliseBase("https://example.test/medhop///")).toBe("https://example.test/medhop");
  });

  it("builds HTTP and WebSocket URLs from API_BASE", () => {
    expect(API_BASE.endsWith("/")).toBe(false);
    expect(apiUrl("/api/status")).toBe(`${API_BASE}/api/status`);
    expect(wsUrl("/ws/status")).toBe(wsUrlFrom(API_BASE, "/ws/status"));
  });

  it("points the camera at the MJPEG stream of its base", () => {
    expect(createTransport("http://example.test:9000").camera).toEqual({
      kind: "mjpeg",
      url: "http://example.test:9000/video.mjpg",
    });
    expect(createTransport().camera).toEqual({ kind: "mjpeg", url: apiUrl("/video.mjpg") });
    expect(createTransport().kind).toBe("python");
  });
});

describe("Python transport requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Stub fetch with one answer and record the calls. */
  function answer(status: number, text: string) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ status, ok: status >= 200 && status <= 299, text: () => Promise.resolve(text) });
    });
    return calls;
  }

  const t = () => createTransport("http://example.test:9000");

  it("sends the method, the JSON body and its content type to the base URL plus the path", async () => {
    const calls = answer(200, "{}");
    await t().request("PUT", "/api/trim", { roll: 1, pitch: 0 }, 4000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://example.test:9000/api/trim");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(calls[0]!.init.body).toBe('{"roll":1,"pitch":0}');
  });

  it("sends no body and no content type when there is no body", async () => {
    const calls = answer(200, "");
    await t().request("POST", "/api/mission/abort", undefined, 4000);
    expect(calls[0]!.init.headers).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("resolves with the status and the parsed body, error statuses included", async () => {
    answer(200, '{"mode":"sim"}');
    await expect(t().request("GET", "/api/status", undefined, 4000)).resolves.toEqual({ status: 200, body: { mode: "sim" } });
    answer(409, '{"blockers":["no_marker"]}');
    await expect(t().request("POST", "/api/mission/start", {}, 4000)).resolves.toEqual({
      status: 409,
      body: { blockers: ["no_marker"] },
    });
  });

  it("gives the raw text when the body is not JSON, and null when it is empty", async () => {
    answer(500, "Internal Server Error");
    await expect(t().request("GET", "/api/status", undefined, 4000)).resolves.toEqual({ status: 500, body: "Internal Server Error" });
    answer(204, "");
    await expect(t().request("DELETE", "/api/schedule/a", undefined, 4000)).resolves.toEqual({ status: 204, body: null });
  });

  it("rejects when the backend cannot be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(t().request("GET", "/api/status", undefined, 4000)).rejects.toThrow();
  });

  it("aborts and rejects when there is no answer within the timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const pending = t().request("GET", "/api/status", undefined, 1500);
    const settled = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await settled;
  });
});
