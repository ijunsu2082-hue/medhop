// The wording added for browser builds (the simulator runs in the page) and for the mode guard. The Python-mode
// wording is pinned in pilotWording.test.ts and videoWording.test.ts and must not change.

import { describe, expect, it } from "vitest";
import type { MissionStatus, Status } from "../api/types";
import {
  BATTERY_CHECK_OFF_BROWSER_TEXT,
  BATTERY_CHECK_OFF_TEXT,
  PERSON_CHECK_BROWSER_TEXT,
  batteryLine,
  preflightChecklist,
} from "../logic/checklist";
import { autoBackendRefuses, autoReadyView, landingExplainerText, startSpotText } from "../logic/pilot";
import { PILOT_ABOUT_TEXT, arrivalCalibrationHint, backendValueLabel, pilotAboutText } from "./panelsWording";
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
  videoRailValue,
} from "./pilotWording";
import { backendName, backendNameCapital, notReachableReason } from "./shellWording";
import {
  CANVAS_CONNECTING_DETAIL,
  CANVAS_UNREACHABLE_DETAIL,
  CANVAS_VIEW_LABEL,
  CANVAS_WAITING_DETAIL,
  videoOverlayText,
  type VideoOverlayKind,
} from "./videoWording";
import { CONTROL_ERROR_TEXT, TOGGLE_GUARD_BROWSER_TEXT, controlErrorText } from "./wording";

describe("browser-build camera caption", () => {
  it("pins every sentence", () => {
    expect(CAPTION_BROWSER_PICTURE).toBe(
      "Simulator view: a drawing made by the simulator running in this page. It is not a camera picture.",
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
      "Drawing made by the simulator in this page, from the drone's position: the room, the station sign, " +
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

  it("names the simulator in this page, not a backend, when there is no status", () => {
    expect(videoOverlayText("unreachable", "sim", null, "canvas")).toEqual({
      title: "No video",
      detail: CANVAS_UNREACHABLE_DETAIL,
      age: null,
    });
    expect(videoOverlayText("waiting", "sim", null, "canvas")).toEqual({
      title: "No video",
      detail: CANVAS_WAITING_DETAIL,
      age: null,
    });
    expect(CANVAS_UNREACHABLE_DETAIL).toBe("The simulator in this page is not answering.");
    expect(CANVAS_WAITING_DETAIL).toBe("Waiting for status from the simulator in this page.");
    expect(videoOverlayText("unreachable", "sim", null).detail).toBe("Backend not reachable.");
    expect(videoOverlayText("waiting", "sim", null).detail).toBe("Waiting for status from the backend.");
  });

  it("uses the MJPEG feed's text for every other overlay, and the MJPEG text is the default", () => {
    const kinds: VideoOverlayKind[] = ["no_video", "interrupted"];
    for (const kind of kinds) {
      expect(videoOverlayText(kind, "sim", 1.25, "canvas")).toEqual(videoOverlayText(kind, "sim", 1.25));
    }
    expect(videoOverlayText("connecting", "sim", null)).toEqual(videoOverlayText("connecting", "sim", null, "mjpeg"));
    expect(videoOverlayText("connecting", "sim", null).detail).toBe("Opening the video stream.");
  });
});

// Sentences the Python build shows about its backend process, a laptop, a printed sign or a drone in someone's
// hand, and what a browser build (the simulator runs in this page) shows instead. The Python wording is unchanged.
describe("no backend process in a browser build", () => {
  const status = (person: { enabled: boolean; detected: boolean; count: number }) =>
    ({
      mode: "sim",
      link: { video_live: true, fps: 15 },
      vision: { marker: null, person, obstacles: [], brightness: 150, dark: false },
      mission: { arrive_width: 0.29 },
      telemetry: {
        simulated: true,
        age_s: 0.2,
        fly_state_raw: 0,
        battery_raw: 42,
        flags_raw: 0,
        battery_low: false,
        battery_check_enabled: false,
      },
      pilot: { estop_active: false },
    }) as unknown as Status;

  it("names the program the page talks to", () => {
    expect(backendName("python")).toBe("the backend");
    expect(backendName("browser")).toBe("the simulator in this page");
    expect(backendNameCapital("browser")).toBe("The simulator in this page");
    expect(notReachableReason("python")).toBe("Not available: backend not reachable.");
    expect(notReachableReason("browser")).toBe("Not available: the simulator in this page is not answering.");
    expect(videoRailValue("unreachable", null, null, "python")).toBe("Backend not reachable");
    expect(videoRailValue("unreachable", null, null, "browser")).toBe("Simulator not answering");
  });

  it("shows the person check as not part of the browser simulator, never as passing or as a warning", () => {
    const row = (kind: "browser" | "python") =>
      preflightChecklist(status({ enabled: false, detected: false, count: 0 }), kind).find((r) => r.id === "person")!;
    expect(row("browser")).toEqual({
      id: "person",
      label: "Advisory person check",
      verdict: "info",
      text: "Not part of the browser simulator.",
    });
    expect(PERSON_CHECK_BROWSER_TEXT).toBe("Not part of the browser simulator.");
    expect(row("python")).toEqual({
      id: "person",
      label: "Advisory person check",
      verdict: "warn",
      text: "Off. Check the corridor by eye.",
    });
  });

  it("does not say the battery number is unverified on a drone that does not exist", () => {
    const t = status({ enabled: false, detected: false, count: 0 }).telemetry;
    expect(batteryLine(t, "browser")).toEqual({
      verdict: "info",
      text: "raw 42, 0.2 s ago (raw, unverified units, simulated). Battery check is off (this number is simulated)",
    });
    expect(batteryLine(t, "python").text).toContain(BATTERY_CHECK_OFF_TEXT);
    expect(BATTERY_CHECK_OFF_BROWSER_TEXT).not.toMatch(/drone/);
  });

  it("describes the simulated drone, not a laptop, a printed sign, a ruler or a hand", () => {
    expect(pilotAboutText("browser")).toBe(
      "Fly a simulated toy drone in this page. A station run turns the drone until its simulated camera sees the " +
        "station sign, flies toward it and stops. The Care page then shows that it arrived at the station.",
    );
    expect(pilotAboutText("python")).toBe(PILOT_ABOUT_TEXT);
    expect(PILOT_ABOUT_TEXT).toContain("from this laptop");
    expect(arrivalCalibrationHint("browser")).toBe("Fly the simulated drone to the stopping distance, facing the sign, then press.");
    expect(arrivalCalibrationHint("python")).toBe("Hold the drone by hand at the stopping distance, facing the sign, then press.");
    expect(backendValueLabel("browser")).toBe("Value in the simulator");
    expect(backendValueLabel("python")).toBe("Backend value");
    expect(startSpotText("browser")).toBe(
      "The simulator puts the drone back on its start spot, facing the sign, when it takes off.",
    );
    expect(startSpotText("python")).toBe("Put the drone on its start spot, facing the sign.");
    expect(landingExplainerText(0.45, "browser")).toBe(
      "It only lands when the sign fills enough of the simulated camera view, sits in the middle of the picture and " +
        "is seen from the front, three frames in a row, after the drone has clearly flown toward it. That is about " +
        "0.45 m in front of the sign. A sign farther than about 5 m is too small to count.",
    );
    expect(landingExplainerText(0.45, "python")).toContain("measure the real distance with a ruler");
    const notReady = { auto_fly: true, ready_for_dose: false } as unknown as MissionStatus;
    expect(autoReadyView(notReady, "browser")?.text).toBe(
      "The simulator puts the drone back on its start spot, facing the sign, when it takes off. Before the next dose, press",
    );
    expect(autoReadyView(notReady, "python")?.text).toBe(
      "Before the next dose: put the drone on its start spot facing the sign, then press",
    );
  });

  it("refusals name the simulator in this page", () => {
    expect(autoBackendRefuses("browser")).toBe("The simulator in this page reports it cannot start a run right now.");
    expect(autoBackendRefuses("python")).toBe("The backend reports it cannot start a run right now.");
    expect(controlErrorText("toggle_guard", undefined, "browser")).toBe(TOGGLE_GUARD_BROWSER_TEXT);
    expect(controlErrorText("toggle_guard", undefined, "python")).toBe(CONTROL_ERROR_TEXT.toggle_guard);
    expect(controlErrorText(undefined, "busy", "browser")).toBe("Simulator: busy");
    expect(controlErrorText(undefined, "busy", "python")).toBe("Backend: busy");
    expect(controlErrorText("odd", undefined, "browser")).toBe(
      "The simulator in this page refused the command, for a reason this page does not describe yet (code: odd).",
    );
  });

  it("every browser sentence keeps the wording rules", () => {
    const sentences = [
      backendName("browser"),
      notReachableReason("browser"),
      videoRailValue("unreachable", null, null, "browser"),
      CANVAS_UNREACHABLE_DETAIL,
      CANVAS_WAITING_DETAIL,
      PERSON_CHECK_BROWSER_TEXT,
      BATTERY_CHECK_OFF_BROWSER_TEXT,
      pilotAboutText("browser"),
      arrivalCalibrationHint("browser"),
      backendValueLabel("browser"),
      startSpotText("browser"),
      landingExplainerText(0.45, "browser"),
      landingExplainerText(null, "browser"),
      autoBackendRefuses("browser"),
      TOGGLE_GUARD_BROWSER_TEXT,
    ];
    for (const s of sentences) {
      expect(s).not.toMatch(/[Bb]ackend|laptop|ruler|by hand|\bAI\b|deliver|Python|OpenCV|safety system/);
    }
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
