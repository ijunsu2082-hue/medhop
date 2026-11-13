// The wording added for browser builds (the simulator runs in the page) and for the mode guard. The Python-mode
// wording is pinned in pilotWording.test.ts and videoWording.test.ts and must not change.

import { describe, expect, it } from "vitest";
import {
  CAPTION_BROWSER_DETECTION,
  CAPTION_BROWSER_PICTURE,
  CAPTION_DETECTION,
  CAPTION_REAL,
  CAPTION_SIM,
  CONTROLS_LOCKED_REASON,
  REQUEST_LOCKED_TEXT,
  cameraCaption,
  controlLockedText,
  modeChangedText,
} from "./pilotWording";
import { CANVAS_CONNECTING_DETAIL, CANVAS_VIEW_LABEL, videoOverlayText, type VideoOverlayKind } from "./videoWording";

describe("browser-build camera caption", () => {
  it("pins every sentence", () => {
    expect(CAPTION_BROWSER_PICTURE).toBe(
      "Simulator view: a line drawing made by the simulator running in this page. It is not a camera picture.",
    );
    expect(CAPTION_BROWSER_DETECTION).toBe(
      "No picture is analysed: the station sign's position comes from the simulator's geometry, with noise and " +
        "dropped frames added, not from OpenCV. The people and objects are simulated.",
    );
  });

  it("is the same two sentences whatever the mode and the frame size", () => {
    const expected = [CAPTION_BROWSER_PICTURE, CAPTION_BROWSER_DETECTION];
    for (const mode of ["sim", "real", null, undefined] as const) {
      for (const frame of [null, undefined, { width: 640, height: 360 }, { width: 1280, height: 720 }]) {
        expect(cameraCaption(mode, frame, "browser")).toEqual(expected);
      }
    }
  });

  it("never claims a camera, a stream, ArUco detection or the drone's picture", () => {
    const text = cameraCaption("sim", null, "browser").join(" ");
    expect(text).not.toContain(CAPTION_DETECTION);
    expect(text).not.toContain(CAPTION_SIM);
    expect(text).not.toMatch(/ArUco|640x360|stream|recording|\bAI\b/);
    expect(text).toContain("not a camera picture");
    expect(text).toContain("not from OpenCV");
  });

  it("leaves the Python-build caption as it was", () => {
    expect(cameraCaption("real", null, "python")).toEqual([CAPTION_REAL, CAPTION_DETECTION]);
    for (const mode of ["sim", "real", null] as const) {
      for (const frame of [null, { width: 640, height: 360 }, { width: 1280, height: 720 }]) {
        expect(cameraCaption(mode, frame, "python")).toEqual(cameraCaption(mode, frame));
      }
    }
  });
});

describe("canvas feed wording", () => {
  it("says what the drawing is, without calling it a camera view", () => {
    expect(CANVAS_VIEW_LABEL).toBe(
      "Line drawing made by the simulator in this page, from the drone's position: the room, the station sign, " +
        "the simulated people and objects, an outline round the tracked sign and a box round each obstacle",
    );
    expect(CANVAS_VIEW_LABEL).not.toMatch(/camera|stream/i);
  });

  it("waits for a first picture instead of opening a stream", () => {
    expect(videoOverlayText("connecting", "sim", null, "canvas")).toEqual({
      title: "Connecting",
      detail: CANVAS_CONNECTING_DETAIL,
      age: null,
    });
    expect(CANVAS_CONNECTING_DETAIL).toBe("Waiting for the first picture from the simulator in this page.");
  });

  it("uses the MJPEG feed's text for every other overlay, and the MJPEG text is the default", () => {
    const kinds: VideoOverlayKind[] = ["unreachable", "waiting", "no_video", "interrupted"];
    for (const kind of kinds) {
      expect(videoOverlayText(kind, "sim", 1.25, "canvas")).toEqual(videoOverlayText(kind, "sim", 1.25));
    }
    expect(videoOverlayText("connecting", "sim", null)).toEqual(videoOverlayText("connecting", "sim", null, "mjpeg"));
    expect(videoOverlayText("connecting", "sim", null).detail).toBe("Opening the video stream.");
  });
});

describe("mode guard banner", () => {
  it("says in plain words that the real drone became the simulator, and what to do", () => {
    expect(modeChangedText({ from: "real", to: "sim" })).toBe(
      "The backend has switched from the real drone to the simulator while this page was open. Flight controls " +
        "on this page are locked. The emergency stop still works. Reloading the page clears this.",
    );
  });

  it("says the same for the simulator becoming the real drone", () => {
    expect(modeChangedText({ from: "sim", to: "real" })).toBe(
      "The backend has switched from the simulator to the real drone while this page was open. Flight controls " +
        "on this page are locked. The emergency stop still works. Reloading the page clears this.",
    );
  });

  it("never says the emergency stop is off, or that the control link is closed", () => {
    for (const change of [{ from: "real", to: "sim" }, { from: "sim", to: "real" }] as const) {
      const text = modeChangedText(change);
      expect(text).toContain("locked");
      expect(text).toContain("The emergency stop still works.");
      expect(text).toContain("Reloading the page clears this.");
      expect(text).not.toMatch(/closed|disconnected/);
    }
  });
});

describe("mode guard reasons", () => {
  it("pins the reasons shown for locked controls and refused requests", () => {
    expect(CONTROLS_LOCKED_REASON).toBe("Not available: controls are locked because the backend switched mode.");
    expect(controlLockedText("takeoff_land")).toBe(
      "Not sent: takeoff / land. Controls are locked because the backend switched mode; only the emergency stop is sent.",
    );
    expect(controlLockedText("axes")).toBe(
      "Not sent: stick input. Controls are locked because the backend switched mode; only the emergency stop is sent.",
    );
    expect(controlLockedText("something_new")).toContain("Not sent: that command.");
    expect(REQUEST_LOCKED_TEXT).toBe(
      "Controls are locked because the backend switched mode while this page was open. Reload the page to clear this.",
    );
  });
});
