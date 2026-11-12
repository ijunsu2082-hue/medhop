import { describe, expect, it } from "vitest";
import { videoAlt, videoOverlayText } from "./videoWording";

describe("videoOverlayText", () => {
  it("unreachable", () => {
    expect(videoOverlayText("unreachable", "sim", 3)).toEqual({
      title: "No video",
      detail: "Backend not reachable.",
      age: null,
    });
  });

  it("waiting", () => {
    expect(videoOverlayText("waiting", null, null)).toEqual({
      title: "No video",
      detail: "Waiting for status from the backend.",
      age: null,
    });
  });

  it("connecting has a calm title, in every mode", () => {
    for (const mode of ["sim", "real", null, undefined] as const) {
      expect(videoOverlayText("connecting", mode, 0.1)).toEqual({
        title: "Connecting",
        detail: "Opening the video stream.",
        age: null,
      });
    }
  });

  it("interrupted", () => {
    expect(videoOverlayText("interrupted", "real", 0.2)).toEqual({
      title: "Video stream interrupted",
      detail: "Reconnecting to the stream.",
      age: null,
    });
  });

  it("no_video in the simulator blames the simulator, not a drone camera", () => {
    expect(videoOverlayText("no_video", "sim", 2.44)).toEqual({
      title: "No video",
      detail: "The simulator is not producing frames. This computer may be busy.",
      age: "Last frame 2.4 s ago",
    });
  });

  it("no_video with the real drone or an unknown mode names the drone camera", () => {
    for (const mode of ["real", null, undefined] as const) {
      expect(videoOverlayText("no_video", mode, 12)).toEqual({
        title: "No video",
        detail: "The drone camera is not sending frames.",
        age: "Last frame 12.0 s ago",
      });
    }
  });

  it("no_video has no age line when the age is unknown", () => {
    expect(videoOverlayText("no_video", "sim", null).age).toBeNull();
    expect(videoOverlayText("no_video", "sim", undefined).age).toBeNull();
    expect(videoOverlayText("no_video", "real", Number.NaN).age).toBeNull();
  });
});

describe("videoAlt", () => {
  it("does not call the simulator picture a drone camera view", () => {
    expect(videoAlt("sim")).toBe("Annotated simulator camera view: station sign outline and advisory person boxes");
    expect(videoAlt("sim")).not.toMatch(/drone/i);
  });

  it("names the drone camera otherwise", () => {
    for (const mode of ["real", null, undefined] as const) {
      expect(videoAlt(mode)).toBe("Annotated drone camera view: station sign outline and advisory person boxes");
    }
  });
});
