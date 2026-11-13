import { describe, expect, it } from "vitest";
import { BACKEND_DOWN, modeLabel } from "./shellWording";

describe("modeLabel", () => {
  it("names the browser simulator whatever the status says", () => {
    expect(modeLabel("browser", null, null)).toEqual({ text: "Browser simulator", tone: "sim" });
    expect(modeLabel("browser", true, "sim")).toEqual({ text: "Browser simulator", tone: "sim" });
    expect(modeLabel("browser", false, null).text).toBe("Browser simulator");
  });

  it("follows the Python backend's own report", () => {
    expect(modeLabel("python", true, "sim")).toEqual({ text: "Python simulator", tone: "sim" });
    expect(modeLabel("python", true, "real")).toEqual({ text: "Real drone", tone: "real" });
  });

  it("never names a mode it has not been told", () => {
    expect(modeLabel("python", null, null)).toEqual({ text: "Connecting", tone: "wait" });
    expect(modeLabel("python", true, null)).toEqual({ text: "Connecting", tone: "wait" });
    expect(modeLabel("python", false, "real")).toEqual({ text: "Not connected", tone: "down" });
    expect(modeLabel("python", false, "sim")).toEqual({ text: "Not connected", tone: "down" });
  });
});

describe("the backend banner", () => {
  it("says what is wrong and what happens next, and names no file to run", () => {
    expect(BACKEND_DOWN).toBe("Backend not reachable. Retrying every 2 seconds.");
    expect(BACKEND_DOWN).not.toMatch(/\.command|localhost/);
  });
});
