#!/usr/bin/env python3
"""Run the advisory person check over a recorded video, frame by frame, and print raw numbers.

    python tools/eval_person_check.py --weights /path/to/yolo11n.pt recording.mp4 [more.mp4 ...]

It uses the same detector function, weights file, confidence threshold and input size as the live
check (`medhop.vision.person.detect_persons`). The video files are only read.

What this is NOT: a measure of accuracy. There is no ground truth here for which frames really show
a person, so "percent of frames with a detection" says how often the detector fired on this
footage and nothing about misses or false alarms. The person check stays an advisory aid for the
pilot.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from pathlib import Path
from typing import List, Optional

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import cv2  # noqa: E402

from medhop.vision.person import (  # noqa: E402
    CONFIDENCE, IMAGE_SIZE, TORCH_THREADS, detect_persons, load_detector, person_check_available,
)


def quartiles(values: List[float]) -> Optional[tuple]:
    """(min, 25 %, median, 75 %, max), or None for an empty list."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return (ordered[0],) * 5
    q1, q2, q3 = statistics.quantiles(ordered, n=4, method="inclusive")
    return ordered[0], q1, q2, q3, ordered[-1]


def evaluate(model, path: str, confidence: float = CONFIDENCE, limit: Optional[int] = None) -> dict:
    """Read `path` frame by frame (read-only) and collect the raw detection figures."""
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f"could not open {path}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames = with_person = 0
    best_per_frame: List[float] = []      # highest confidence in each frame that had a detection
    all_scores: List[float] = []          # every detection
    longest_gap = current_gap = 0
    started = time.monotonic()
    try:
        while limit is None or frames < limit:
            ok, frame = capture.read()
            if not ok:
                break
            frames += 1
            scores = [score for _box, score in detect_persons(model, frame, confidence)]
            if scores:
                with_person += 1
                best_per_frame.append(max(scores))
                all_scores.extend(scores)
                current_gap = 0
            else:
                current_gap += 1
                longest_gap = max(longest_gap, current_gap)
    finally:
        capture.release()
    return {
        "path": path,
        "width": width,
        "height": height,
        "fps": fps,
        "frames": frames,
        "frames_with_person": with_person,
        "percent_with_person": 100.0 * with_person / frames if frames else 0.0,
        "detections": len(all_scores),
        "best_confidence_quartiles": quartiles(best_per_frame),
        "all_confidence_quartiles": quartiles(all_scores),
        "longest_gap_frames": longest_gap,
        "longest_gap_s": longest_gap / fps if fps > 0 else None,
        "seconds_taken": time.monotonic() - started,
    }


def format_report(result: dict) -> str:
    def five(values: Optional[tuple]) -> str:
        if values is None:
            return "n/a (no detections)"
        return "min %.3f, 25%% %.3f, median %.3f, 75%% %.3f, max %.3f" % values

    gap_s = result["longest_gap_s"]
    lines = [
        result["path"],
        "  video: %dx%d, %.2f frames/s as stored in the file" % (result["width"], result["height"], result["fps"]),
        "  frames processed: %d (in %.0f s)" % (result["frames"], result["seconds_taken"]),
        "  frames with at least one person detection: %d (%.1f %%)"
        % (result["frames_with_person"], result["percent_with_person"]),
        "  person detections in total: %d" % result["detections"],
        "  confidence, highest per frame with a detection: " + five(result["best_confidence_quartiles"]),
        "  confidence, every detection: " + five(result["all_confidence_quartiles"]),
        "  longest run of consecutive frames without a detection: %d frames (%s)"
        % (result["longest_gap_frames"], "n/a: file has no frame rate" if gap_s is None else "%.2f s" % gap_s),
    ]
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("videos", nargs="+", help="video files (read-only)")
    parser.add_argument("--weights", default=os.environ.get("MEDHOP_YOLO_WEIGHTS"),
                        help="local yolo11n.pt (default: MEDHOP_YOLO_WEIGHTS); never downloaded")
    parser.add_argument("--limit", type=int, default=None, help="stop after this many frames per video")
    args = parser.parse_args(argv)

    available, why = person_check_available(args.weights)
    if not available:
        print(f"cannot run the person check: {why}", file=sys.stderr)
        return 2
    model = load_detector(args.weights)
    print("advisory person check: weights %s, confidence threshold %.2f, input size %d, %d CPU threads"
          % (args.weights, CONFIDENCE, IMAGE_SIZE, TORCH_THREADS))
    print("No ground truth: these are detection counts on this footage, not an accuracy figure.")
    status = 0
    for path in args.videos:
        try:
            print(format_report(evaluate(model, path, limit=args.limit)))
        except RuntimeError as exc:
            print(f"{path}\n  {exc}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
