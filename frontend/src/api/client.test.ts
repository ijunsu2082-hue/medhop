import { describe, expect, it } from "vitest";
import type { Transport, TransportResponse } from "../transport";
import { ApiError, blockersFrom, errorText, requestVia } from "./client";

/** A transport whose request answers with `answer`, and records what it was asked. */
function fake(answer: () => Promise<TransportResponse>) {
  const calls: { method: string; path: string; body: unknown; timeoutMs: number }[] = [];
  const transport: Pick<Transport, "request"> = {
    request: (method, path, body, timeoutMs) => {
      calls.push({ method, path, body, timeoutMs });
      return answer();
    },
  };
  return { transport, calls };
}

const answering = (status: number, body: unknown) => fake(() => Promise.resolve({ status, body }));

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("requestVia: the client's error mapping over a transport", () => {
  it("passes the call through, with the default 4 s timeout", async () => {
    const { transport, calls } = answering(200, { ok: true });
    await expect(requestVia(transport, "PUT", "/api/trim", { roll: 1, pitch: 0 })).resolves.toEqual({ ok: true });
    await requestVia(transport, "GET", "/api/status", undefined, 1500);
    expect(calls).toEqual([
      { method: "PUT", path: "/api/trim", body: { roll: 1, pitch: 0 }, timeoutMs: 4000 },
      { method: "GET", path: "/api/status", body: undefined, timeoutMs: 1500 },
    ]);
  });

  it("returns the body of any 2xx answer, null for an empty one", async () => {
    await expect(requestVia(answering(201, { id: "a" }).transport, "POST", "/api/schedule")).resolves.toEqual({ id: "a" });
    await expect(requestVia(answering(204, null).transport, "DELETE", "/api/schedule/a")).resolves.toBeNull();
  });

  it("turns a 409 with blockers into an ApiError that blockersFrom reads", async () => {
    const body = { blockers: ["no_marker", "estop_active"] };
    const err = await failure(requestVia(answering(409, body).transport, "POST", "/api/mission/start", {}));
    expect(err.status).toBe(409);
    expect(err.body).toEqual(body);
    expect(err.message).toBe("POST /api/mission/start failed with HTTP 409");
    expect(blockersFrom(err)).toEqual(["no_marker", "estop_active"]);
  });

  it("keeps FastAPI's detail, a short text body, or says the request was refused", async () => {
    const detail = await failure(requestVia(answering(400, { detail: "Time must be HH:MM." }).transport, "POST", "/api/schedule"));
    expect(errorText(detail)).toBe("Time must be HH:MM.");
    expect(blockersFrom(detail)).toBeNull();
    const text = await failure(requestVia(answering(500, "Internal Server Error").transport, "GET", "/api/status"));
    expect(errorText(text)).toBe("Internal Server Error");
    const bare = await failure(requestVia(answering(503, null).transport, "GET", "/api/status"));
    expect(errorText(bare)).toBe("Request refused (HTTP 503).");
  });

  it("treats a 3xx answer as a failure too, as fetch's res.ok did", async () => {
    const err = await failure(requestVia(answering(304, null).transport, "GET", "/api/status"));
    expect(err.status).toBe(304);
  });

  it("maps an unreachable backend to status 0", async () => {
    const err = await failure(requestVia(fake(() => Promise.reject(new TypeError("Failed to fetch"))).transport, "GET", "/api/status"));
    expect(err.status).toBe(0);
    expect(err.body).toBeNull();
    expect(errorText(err)).toBe("Backend not reachable.");
    expect(blockersFrom(err)).toBeNull();
  });

  it("maps a transport that throws instead of rejecting to status 0 as well", async () => {
    const throwing: Pick<Transport, "request"> = {
      request: () => {
        throw new Error("not wired in");
      },
    };
    const err = await failure(requestVia(throwing, "GET", "/api/status"));
    expect(err.status).toBe(0);
  });
});
