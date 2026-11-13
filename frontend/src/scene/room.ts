// The simulated room and the station sign, in metres. The room's size and the things on its walls follow
// backend/medhop/drone/sim_scene.py; the sign follows backend/medhop/vision/marker.py (station_sign).

export const ROOM = { x0: -5, x1: 5, z0: -8, z1: 0, height: 2.7 } as const;

/** The printed sign: an A4 sheet with the marker 30 mm below its top edge, the marker's centre 1.0 m up the wall. */
export const SIGN = {
  markerSize: 0.18,
  markerCentreY: 1.0,
  sheetWidth: 0.21,
  sheetHeight: 0.297,
  topMargin: 0.03,
  caption: "MEDICINE STATION A",
} as const;

export const SHEET_TOP_Y = SIGN.markerCentreY + SIGN.markerSize / 2 + SIGN.topMargin;

/**
 * ArUco DICT_4X4_50 id 7 with its one-cell black border: six rows of six cells, top row first, 1 = white.
 * Taken from OpenCV (cv2.aruco.generateImageMarker); a test pins it.
 */
export const MARKER_7: readonly string[] = ["000000", "011000", "001000", "011110", "000100", "000000"];

export interface WallRect {
  /** left edge, metres along the wall */
  a0: number;
  a1: number;
  /** bottom and top, metres above the floor */
  y0: number;
  y1: number;
  kind: "door" | "board" | "print";
}

/** On the station wall (z = 0): positions along x. */
export const FRONT_WALL: readonly WallRect[] = [
  { a0: -4.45, a1: -3.3, y0: 1.05, y1: 1.85, kind: "board" },
  { a0: -2.45, a1: -1.83, y0: 1.22, y1: 1.68, kind: "print" },
  { a0: -1.7, a1: -1.24, y0: 1.22, y1: 1.68, kind: "print" },
  { a0: 1.55, a1: 2.45, y0: 0, y1: 2.05, kind: "door" },
  { a0: 3.55, a1: 4.45, y0: 0, y1: 2.05, kind: "door" },
];

/** On the side walls: positions along z, measured back from the station wall. */
export const LEFT_WALL: readonly WallRect[] = [
  { a0: -1.75, a1: -1.2, y0: 1.2, y1: 1.75, kind: "print" },
  { a0: -3.8, a1: -2.9, y0: 0, y1: 2.05, kind: "door" },
  { a0: -6.1, a1: -4.8, y0: 1.05, y1: 1.85, kind: "board" },
];

export const RIGHT_WALL: readonly WallRect[] = [
  { a0: -2.5, a1: -1.6, y0: 0, y1: 2.05, kind: "door" },
  { a0: -4.5, a1: -3.6, y0: 1.2, y1: 1.75, kind: "print" },
  { a0: -6.5, a1: -5.6, y0: 0, y1: 2.05, kind: "door" },
];

/** Ceiling light panels: centres. */
export const LIGHTS_X: readonly number[] = [-3.75, -1.25, 1.25, 3.75];
export const LIGHTS_Z: readonly number[] = [-1.4, -4.0, -6.6];
