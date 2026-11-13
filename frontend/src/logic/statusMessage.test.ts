import { describe, expect, it } from "vitest";
import { statusMessageValue } from "./statusLink";

describe("statusMessageValue: one status-stream message", () => {
  it("parses JSON text, as the Python backend sends it", () => {
    expect(statusMessageValue('{"mode":"sim","n":1}')).toEqual({ mode: "sim", n: 1 });
  });

  it("takes a plain object as it is, as the in-page simulator may hand it over", () => {
    const snapshot = { mode: "sim", link: { video_live: true } };
    expect(statusMessageValue(snapshot)).toBe(snapshot);
    const bare = Object.assign(Object.create(null) as object, { mode: "sim" });
    expect(statusMessageValue(bare)).toBe(bare);
  });

  it("throws on malformed text, so the link ignores the message", () => {
    expect(() => statusMessageValue("{not json")).toThrow();
  });

  it("throws on anything that is neither text nor a plain object", () => {
    class Frame {
      mode = "sim";
    }
    for (const data of [null, undefined, 42, true, new Frame(), new Uint8Array([123, 125]), ["a"]]) {
      expect(() => statusMessageValue(data), String(data)).toThrow();
    }
  });
});
