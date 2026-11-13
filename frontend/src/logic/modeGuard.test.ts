import { describe, expect, it } from "vitest";
import { MODE_GUARD_START, observeMode, type ModeGuardState } from "./modeGuard";

const feed = (modes: unknown[], from: ModeGuardState = MODE_GUARD_START) => modes.reduce<ModeGuardState>(observeMode, from);

describe("mode guard", () => {
  it("starts untripped with nothing pinned", () => {
    expect(MODE_GUARD_START).toEqual({ pinned: null, change: null });
  });

  it("pins the first mode it sees and stays quiet while it does not change", () => {
    expect(feed(["real"])).toEqual({ pinned: "real", change: null });
    expect(feed(["sim", "sim", "sim"])).toEqual({ pinned: "sim", change: null });
  });

  it("trips when a page that saw the real drone is told the backend is now the simulator", () => {
    expect(feed(["real", "real", "sim"])).toEqual({ pinned: "real", change: { from: "real", to: "sim" } });
  });

  it("trips the other way too: a page opened for the simulator must not fly the real drone", () => {
    expect(feed(["sim", "real"])).toEqual({ pinned: "sim", change: { from: "sim", to: "real" } });
  });

  it("stays tripped until the page is reloaded, even when the mode changes back", () => {
    const tripped = feed(["real", "sim"]);
    expect(feed(["real", "real", "sim", "real"], tripped).change).toEqual({ from: "real", to: "sim" });
  });

  it("ignores a status without a known mode (no status yet, an older or a malformed one)", () => {
    expect(feed([null, undefined, "", "REAL", 1])).toBe(MODE_GUARD_START);
    expect(feed(["real", null, undefined, "drone"])).toEqual({ pinned: "real", change: null });
  });

  it("returns the same object when nothing changes, so a state setter does not re-render", () => {
    const pinned = observeMode(MODE_GUARD_START, "real");
    expect(observeMode(pinned, "real")).toBe(pinned);
    expect(observeMode(pinned, null)).toBe(pinned);
    const tripped = observeMode(pinned, "sim");
    expect(observeMode(tripped, "real")).toBe(tripped);
    expect(observeMode(tripped, "sim")).toBe(tripped);
  });
});
