// The sign the drawing shows is the sign the simulator and the detector use: the marker's bit pattern is
// OpenCV's (fixture __fixtures__/marker7.json, backend/tools/parity_traces.py marker7, from
// cv2.aruco.generateImageMarker), and its size and place are the engine's.
import { describe, expect, it } from "vitest";
import { SIM_CONFIG_DEFAULTS } from "../engine/drone/sim";
import { loadFixture } from "../engine/testing/fixtures";
import { A4_HEIGHT_M, A4_WIDTH_M, ARUCO_DICT_NAME, SIGN_CAPTION, SIGN_TOP_MARGIN_M } from "../engine/vision/marker";
import { MARKER_7, SIGN } from "./room";

interface Marker7Fixture {
  dictionary: string;
  id: number;
  side_cells: number;
  /** six rows of six cells, top row first, 1 = white */
  bits: number[][];
}

describe("the station sign", () => {
  it("MARKER_7 is OpenCV's DICT_4X4_50 id 7, border included", () => {
    const fx = loadFixture<Marker7Fixture>("marker7");
    expect(fx.dictionary).toBe(ARUCO_DICT_NAME);
    expect(fx.id).toBe(SIM_CONFIG_DEFAULTS.marker_id);
    expect(fx.side_cells).toBe(6);
    expect(MARKER_7).toEqual(fx.bits.map((row) => row.join("")));
  });

  it("has the engine's size, height and sheet", () => {
    expect(SIGN.markerSize).toBe(SIM_CONFIG_DEFAULTS.marker_size_m);
    expect(SIGN.markerCentreY).toBe(SIM_CONFIG_DEFAULTS.marker_height_m);
    expect(SIGN.sheetWidth).toBe(A4_WIDTH_M);
    expect(SIGN.sheetHeight).toBe(A4_HEIGHT_M);
    expect(SIGN.topMargin).toBe(SIGN_TOP_MARGIN_M);
    expect(SIGN.caption).toBe(SIGN_CAPTION);
  });
});
