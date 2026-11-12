#!/usr/bin/env python3
"""Write the printable station sign: an ArUco DICT_4X4_50 marker on an A4 sheet at 300 dpi.

    python tools/make_marker.py                       # -> docs/station-marker-A4.png
    python tools/make_marker.py --size-mm 150 --out /tmp/sign.png

Print at 100 % scale ("actual size", no "fit to page") and measure the black square afterwards: its
edge must match MEDHOP_MARKER_SIZE_M. Mount the sheet flat on a light, matt surface.
"""
from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import cv2  # noqa: E402

from medhop.config import REPO_ROOT, Settings  # noqa: E402
from medhop.vision.marker import A4_WIDTH_M, SIGN_CAPTION, station_sign  # noqa: E402

DPI = 300
PX_PER_M = DPI / 0.0254


def png_with_dpi(png: bytes, px_per_m: float) -> bytes:
    """Insert a pHYs chunk after IHDR so print dialogs know the sheet is A4 at 300 dpi."""
    signature, rest = png[:8], png[8:]
    ihdr_len = struct.unpack(">I", rest[:4])[0]
    ihdr_end = 4 + 4 + ihdr_len + 4
    body = struct.pack(">IIB", int(round(px_per_m)), int(round(px_per_m)), 1)
    chunk = struct.pack(">I", len(body)) + b"pHYs" + body + struct.pack(">I", zlib.crc32(b"pHYs" + body))
    return signature + rest[:ihdr_end] + chunk + rest[ihdr_end:]


def main() -> int:
    settings = Settings.from_env()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--id", type=int, default=settings.marker_id, help="ArUco id (default: MEDHOP_MARKER_ID)")
    parser.add_argument("--size-mm", type=float, default=settings.marker_size_m * 1000.0,
                        help="edge of the black square in millimetres (default: MEDHOP_MARKER_SIZE_M)")
    parser.add_argument("--caption", default=SIGN_CAPTION)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "docs" / "station-marker-A4.png")
    args = parser.parse_args()

    try:
        sheet, (x0, y0, side) = station_sign(args.id, args.size_mm / 1000.0, PX_PER_M, caption=args.caption)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    ok, encoded = cv2.imencode(".png", sheet)
    if not ok:
        print("error: PNG encoding failed", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(png_with_dpi(encoded.tobytes(), PX_PER_M))

    quiet_mm = (A4_WIDTH_M * 1000.0 - args.size_mm) / 2.0
    print(f"wrote {args.out}")
    print(f"  sheet   : {sheet.shape[1]} x {sheet.shape[0]} px (A4 at {DPI} dpi)")
    print(f"  marker  : DICT_4X4_50 id {args.id}, {side} px = {side / PX_PER_M * 1000.0:.1f} mm edge")
    print(f"  quiet   : {quiet_mm:.0f} mm of white left and right, {y0 / PX_PER_M * 1000.0:.0f} mm above")
    print("  print at 100 % scale and measure the black square before flying")
    return 0


if __name__ == "__main__":
    sys.exit(main())
