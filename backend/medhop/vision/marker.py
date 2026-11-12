"""ArUco station-marker detection and the printable station sign.

This is classical computer vision (OpenCV ArUco, DICT_4X4_50). It is not AI.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

ARUCO_DICT_ID = cv2.aruco.DICT_4X4_50
ARUCO_DICT_NAME = "DICT_4X4_50"

A4_WIDTH_M = 0.210
A4_HEIGHT_M = 0.297
SIGN_TOP_MARGIN_M = 0.030
SIGN_CAPTION = "MEDICINE STATION A"


@dataclass(frozen=True)
class MarkerObs:
    """One detection.

    cx and cy are the marker centre as fractions of the frame width and height.
    width is the mean length of the top and bottom edges divided by the frame width.
    height is the mean length of the left and right edges, also divided by the frame WIDTH, so the
    two are directly comparable: for a marker seen square-on they are equal.
    """

    id: int
    cx: float
    cy: float
    width: float
    corners: Tuple[Tuple[float, float], ...]  # pixel coordinates: TL, TR, BR, BL
    ts: float = 0.0
    height: float = 0.0
    frame_w: int = 640      # size of the frame the corners are in, pixels
    frame_h: int = 360

    @property
    def size(self) -> float:
        """Apparent size that does not shrink when the marker is seen at an angle.

        A marker viewed from the side gets narrower (width shrinks with the cosine of the angle)
        but not shorter, so the larger of the two edge measures tracks distance much better.
        """
        return max(self.width, self.height)


@dataclass(frozen=True)
class Observation:
    """What the vision thread saw in one frame."""

    ts: float                       # arrival time of the frame (the link's monotonic clock)
    seq: int
    marker: Optional[MarkerObs]
    brightness: float = 0.0         # mean grey level, 0..255


def _dictionary():
    return cv2.aruco.getPredefinedDictionary(ARUCO_DICT_ID)


def make_detector_parameters():
    """Parameters tuned for small, noisy, JPEG-q50 640x360 frames."""
    p = cv2.aruco.DetectorParameters()
    # Several threshold windows: small ones resolve a 20 px marker, larger ones a close marker.
    p.adaptiveThreshWinSizeMin = 3
    p.adaptiveThreshWinSizeMax = 27
    p.adaptiveThreshWinSizeStep = 6
    p.adaptiveThreshConstant = 7
    # Perimeter relative to the longer image side: 0.07 * 640 = 45 px (about 11 px edge). Smaller
    # quads on real footage were mostly scene texture decoding as some ArUco id (SPEC 10.2).
    p.minMarkerPerimeterRate = 0.07
    p.maxMarkerPerimeterRate = 4.0
    # Polygon fit: 0.03 passes fewer non-square contours on to decoding (fewer false decodes, faster).
    p.polygonalApproxAccuracyRate = 0.03
    p.minCornerDistanceRate = 0.05
    p.minDistanceToBorder = 1
    # Sub-pixel corners make the width measurement steadier.
    p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    p.cornerRefinementWinSize = 3
    p.cornerRefinementMaxIterations = 30
    p.cornerRefinementMinAccuracy = 0.05
    # Sample more pixels per cell and ignore blurred cell edges.
    p.perspectiveRemovePixelPerCell = 8
    p.perspectiveRemoveIgnoredMarginPerCell = 0.2
    return p


class MarkerDetector:
    """Detects the one configured station marker. Any other id is ignored, and so is a detection
    narrower than MIN_WIDTH of the frame width (16 px at 640: too small to trust)."""

    MIN_WIDTH = 0.025

    def __init__(self, marker_id: int = 7) -> None:
        self.marker_id = int(marker_id)
        self._detector = cv2.aruco.ArucoDetector(_dictionary(), make_detector_parameters())

    def detect(self, image: np.ndarray, ts: float = 0.0) -> Optional[MarkerObs]:
        if image is None or image.size == 0:
            return None
        gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        height, width = gray.shape[:2]
        corners, ids, _rejected = self._detector.detectMarkers(gray)
        if ids is None:
            return None
        best: Optional[MarkerObs] = None
        for quad, found_id in zip(corners, ids.flatten()):
            if int(found_id) != self.marker_id:
                continue
            pts = np.asarray(quad, dtype=np.float64).reshape(4, 2)
            top = float(np.linalg.norm(pts[1] - pts[0]))
            bottom = float(np.linalg.norm(pts[2] - pts[3]))
            left = float(np.linalg.norm(pts[3] - pts[0]))
            right = float(np.linalg.norm(pts[2] - pts[1]))
            obs = MarkerObs(
                id=self.marker_id,
                cx=float(pts[:, 0].mean()) / width,
                cy=float(pts[:, 1].mean()) / height,
                width=0.5 * (top + bottom) / width,
                corners=tuple((float(x), float(y)) for x, y in pts),
                ts=ts,
                height=0.5 * (left + right) / width,
                frame_w=int(width),
                frame_h=int(height),
            )
            if obs.width < self.MIN_WIDTH:
                continue
            if best is None or obs.size > best.size:
                best = obs
        return best


def marker_image(marker_id: int, side_px: int) -> np.ndarray:
    """Black/white marker bitmap including its own black border, uint8 grayscale."""
    return cv2.aruco.generateImageMarker(_dictionary(), int(marker_id), int(side_px))


def station_sign(
    marker_id: int,
    marker_size_m: float,
    px_per_m: float,
    caption: str = SIGN_CAPTION,
    sheet_w_m: float = A4_WIDTH_M,
    sheet_h_m: float = A4_HEIGHT_M,
) -> Tuple[np.ndarray, Tuple[int, int, int]]:
    """Render the station sign (white sheet, marker, caption, printed edge length).

    Returns (grayscale image, (x0, y0, side) of the marker in pixels).
    Raises ValueError when the marker would leave less than 10 mm of white beside it.
    """
    side_margin_m = (sheet_w_m - marker_size_m) / 2.0
    if side_margin_m < 0.010:
        raise ValueError(
            f"a {marker_size_m * 1000:.0f} mm marker leaves {side_margin_m * 1000:.0f} mm of quiet zone "
            f"on a {sheet_w_m * 1000:.0f} mm wide sheet (need >= 10 mm)"
        )
    width = int(round(sheet_w_m * px_per_m))
    height = int(round(sheet_h_m * px_per_m))
    side = int(round(marker_size_m * px_per_m))
    x0 = (width - side) // 2
    y0 = int(round(SIGN_TOP_MARGIN_M * px_per_m))
    if y0 + side > height:
        raise ValueError("marker does not fit on the sheet")
    sheet = np.full((height, width), 255, np.uint8)
    sheet[y0:y0 + side, x0:x0 + side] = marker_image(marker_id, side)

    below_m = sheet_h_m - SIGN_TOP_MARGIN_M - marker_size_m
    if below_m > 0.035:
        _centered_text(sheet, caption, y_m=SIGN_TOP_MARGIN_M + marker_size_m + 0.030,
                       cap_height_m=0.012, px_per_m=px_per_m, bold=True)
    if below_m > 0.060:
        edge_mm = side / px_per_m * 1000.0
        line1 = f"Marker edge {edge_mm:.0f} mm when printed on A4 at 100% scale (300 dpi)."
        line2 = f"ArUco {ARUCO_DICT_NAME} id {marker_id}. Measure the black square after printing."
        _centered_text(sheet, line1, y_m=SIGN_TOP_MARGIN_M + marker_size_m + 0.050,
                       cap_height_m=0.0032, px_per_m=px_per_m)
        _centered_text(sheet, line2, y_m=SIGN_TOP_MARGIN_M + marker_size_m + 0.058,
                       cap_height_m=0.0032, px_per_m=px_per_m)
    return sheet, (x0, y0, side)


def _centered_text(sheet: np.ndarray, text: str, y_m: float, cap_height_m: float,
                   px_per_m: float, bold: bool = False) -> None:
    """Draw `text` horizontally centred with its baseline at y_m. Skipped when too small to draw."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    cap_px = cap_height_m * px_per_m
    if cap_px < 3.0:
        # Too small for glyphs: draw a grey bar so a far-away sign still has the caption's footprint.
        if bold:
            half = int(0.075 * px_per_m)
            y = int(round(y_m * px_per_m))
            h = max(1, int(round(cap_px)))
            cx = sheet.shape[1] // 2
            sheet[max(0, y - h):y, max(0, cx - half):cx + half] = 120
        return
    scale = cap_px / 22.0  # FONT_HERSHEY_SIMPLEX capitals are about 22 px tall at scale 1
    thickness = max(1, int(round(scale * (3.0 if bold else 1.6))))
    (text_w, _text_h), _baseline = cv2.getTextSize(text, font, scale, thickness)
    max_w = sheet.shape[1] * 0.94
    if text_w > max_w:
        scale *= max_w / text_w
        thickness = max(1, int(round(scale * (3.0 if bold else 1.6))))
        (text_w, _text_h), _baseline = cv2.getTextSize(text, font, scale, thickness)
    x = (sheet.shape[1] - text_w) // 2
    y = int(round(y_m * px_per_m))
    cv2.putText(sheet, text, (x, y), font, scale, 0, thickness, cv2.LINE_AA)
