import { describe, expect, it } from "vitest";
import {
  CAPTION_DETECTION,
  CAPTION_REAL,
  CAPTION_SIM,
  CAPTION_SIM_CLEAN,
  CAPTION_SIM_DRONE_LIKE,
  cameraCaption,
  checklistSummary,
  headReadout,
  signValue,
  videoRailTone,
  videoRailValue,
  withoutLegend,
} from "./pilotWording";

const ADVISORY = "Person boxes are an advisory check only.";
const ARUCO = "The station sign is detected with ArUco (classical computer vision).";

describe("caption strings", () => {
  it("pins every sentence", () => {
    expect(CAPTION_DETECTION).toBe(
      "The station sign is detected with ArUco (classical computer vision). Person boxes are an advisory check only.",
    );
    expect(CAPTION_REAL).toBe("640x360 stream from the drone, shown enlarged.");
    expect(CAPTION_SIM).toBe(
      "Simulator view: a room drawn by the simulator. It is not a camera recording and not the drone's stream.",
    );
    expect(CAPTION_SIM_CLEAN).toBe(
      "It is drawn cleaner than the real drone's 640x360 camera, so the sign is easier to detect here than in real flight.",
    );
    expect(CAPTION_SIM_DRONE_LIKE).toBe(
      "This profile adds noise, blur and compression to resemble the real drone's 640x360 camera.",
    );
  });
});

describe("cameraCaption", () => {
  const all = [
    cameraCaption("real", { width: 640, height: 360 }),
    cameraCaption("real", null),
    cameraCaption("sim", { width: 1280, height: 720 }),
    cameraCaption("sim", { width: 640, height: 360 }),
    cameraCaption("sim", null),
    cameraCaption(null, null),
    cameraCaption(null, { width: 1280, height: 720 }),
  ];

  it("keeps the original sentence in real mode", () => {
    expect(cameraCaption("real", { width: 640, height: 360 })).toEqual([CAPTION_REAL, CAPTION_DETECTION]);
    expect(cameraCaption("real", null)).toEqual([CAPTION_REAL, CAPTION_DETECTION]);
    expect(cameraCaption("real", null).join(" ")).toContain("640x360 stream from the drone");
  });

  it("never calls the simulator picture the drone's 640x360 stream", () => {
    for (const frame of [{ width: 1280, height: 720 }, { width: 640, height: 360 }, { width: 320, height: 180 }, null]) {
      const text = cameraCaption("sim", frame).join(" ");
      expect(text).not.toContain("640x360 stream from the drone");
      expect(text).not.toContain(CAPTION_REAL);
      expect(text).toContain("not the drone's stream");
    }
  });

  it("says a wide simulator frame is drawn cleaner than the real drone's camera", () => {
    expect(cameraCaption("sim", { width: 1280, height: 720 })).toEqual([CAPTION_SIM, CAPTION_SIM_CLEAN, CAPTION_DETECTION]);
    expect(cameraCaption("sim", { width: 641, height: 360 })[1]).toBe(CAPTION_SIM_CLEAN);
    expect(cameraCaption("sim", { width: 1280, height: 720 }).join(" ")).toContain(
      "drawn cleaner than the real drone's 640x360 camera",
    );
  });

  it("says a 640-wide simulator frame adds noise, blur and compression", () => {
    expect(cameraCaption("sim", { width: 640, height: 360 })).toEqual([
      CAPTION_SIM,
      CAPTION_SIM_DRONE_LIKE,
      CAPTION_DETECTION,
    ]);
    expect(cameraCaption("sim", { width: 480, height: 270 })[1]).toBe(CAPTION_SIM_DRONE_LIKE);
    expect(cameraCaption("sim", { width: 640, height: 360 }).join(" ")).toContain("adds noise, blur and compression");
  });

  it("makes no claim about the picture without a frame", () => {
    expect(cameraCaption("sim", null)).toEqual([CAPTION_SIM, CAPTION_DETECTION]);
    expect(cameraCaption("sim", { width: 0, height: 0 })).toEqual([CAPTION_SIM, CAPTION_DETECTION]);
    expect(cameraCaption(null, null)).toEqual([CAPTION_DETECTION]);
    expect(cameraCaption(undefined, { width: 1280, height: 720 })).toEqual([CAPTION_DETECTION]);
  });

  it("states the ArUco and advisory sentences in every case and never says AI", () => {
    for (const caption of all) {
      const text = caption.join(" ");
      expect(text).toContain(ARUCO);
      expect(text).toContain(ADVISORY);
      expect(text).not.toMatch(/\bAI\b/);
    }
  });
});

describe("headReadout", () => {
  it("joins the measured parts", () => {
    expect(headReadout({ width: 1280, height: 720 }, 15, 0.04)).toBe("1280x720 · 15 fps · frame 0.04 s");
    expect(headReadout({ width: 640, height: 360 }, 14.8, 0.123)).toBe("640x360 · 14.8 fps · frame 0.12 s");
  });

  it("omits missing or non-finite parts and hard-codes nothing", () => {
    expect(headReadout(null, 15, 0.04)).toBe("15 fps · frame 0.04 s");
    expect(headReadout({ width: 1280, height: 720 }, null, null)).toBe("1280x720");
    expect(headReadout(null, Number.NaN, Number.POSITIVE_INFINITY)).toBe("");
    expect(headReadout(undefined, undefined, undefined)).toBe("");
    expect(headReadout({ width: 0, height: 0 }, null, 0.5)).toBe("frame 0.50 s");
  });
});

describe("signValue", () => {
  it("reads in view or not", () => {
    expect(signValue(true)).toBe("In view");
    expect(signValue(false)).toBe("Not in view");
  });
});

describe("videoRailValue", () => {
  it("names every health", () => {
    expect(videoRailValue("live", "playing", 0.04)).toBe("Live");
    expect(videoRailValue("live", "connecting", 0.04)).toBe("Live");
    expect(videoRailValue("delayed", "playing", 0.8)).toBe("Delayed 0.8 s");
    expect(videoRailValue("delayed", "playing", null)).toBe("Delayed");
    expect(videoRailValue("no_video", "playing", 5)).toBe("No video");
    expect(videoRailValue("waiting", "connecting", null)).toBe("Waiting for status");
    expect(videoRailValue("unreachable", "interrupted", null)).toBe("Backend not reachable");
  });

  it("says Reconnecting when this window lost the stream", () => {
    expect(videoRailValue("live", "interrupted", 0.04)).toBe("Reconnecting");
    expect(videoRailValue("delayed", "interrupted", 0.8)).toBe("Reconnecting");
  });

  it("has a tone for each value", () => {
    expect(videoRailTone("live", "playing")).toBe("pass");
    expect(videoRailTone("live", "interrupted")).toBe("warn");
    expect(videoRailTone("delayed", "playing")).toBe("warn");
    expect(videoRailTone("no_video", "playing")).toBe("fail");
    expect(videoRailTone("unreachable", null)).toBe("fail");
    expect(videoRailTone("waiting", "connecting")).toBe("info");
  });
});

describe("checklistSummary", () => {
  const rows = (...v: ("pass" | "warn" | "fail" | "info")[]) => v.map((verdict) => ({ verdict }));

  it("counts in the order fail, warn, pass, info", () => {
    expect(checklistSummary(rows("pass", "warn", "info", "fail", "warn", "pass"))).toBe("1 fail · 2 warn · 2 pass · 1 info");
  });

  it("omits zero counts", () => {
    expect(checklistSummary(rows("pass", "pass", "pass"))).toBe("3 pass");
    expect(checklistSummary(rows("info", "fail"))).toBe("1 fail · 1 info");
    expect(checklistSummary([])).toBe("");
  });
});

describe("withoutLegend", () => {
  it("drops the repeated legend and capitalises the rest", () => {
    expect(withoutLegend("Control link: refused", "Control link:")).toBe("Refused");
    expect(withoutLegend("Control link: disconnected, reconnecting", "Control link:")).toBe("Disconnected, reconnecting");
    expect(withoutLegend("Drone link: connected", "Drone link:")).toBe("Connected");
  });

  it("leaves other text as it is", () => {
    expect(withoutLegend("Simulator (no real drone)", "Drone link:")).toBe("Simulator (no real drone)");
    expect(withoutLegend("Control link:", "Control link:")).toBe("Control link:");
  });
});
