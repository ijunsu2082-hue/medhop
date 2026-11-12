"""Optional person check using a pretrained YOLO detector.

This is an ADVISORY pre-flight and in-flight check. It is not a safety system or an interlock:
it can miss people, and a human pilot stays responsible for keeping the corridor empty.

The model is imported lazily and never downloaded: with no local weights file or no `ultralytics`
package the check is simply reported as disabled and everything else works normally.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional, Tuple

logger = logging.getLogger("medhop.vision.person")

PERSON_CLASS_ID = 0  # "person" in the COCO classes the pretrained model uses
CONFIDENCE = 0.4     # detections below this are ignored
IMAGE_SIZE = 640     # the detector's input size (longer side, pixels)
# The detector may use this many CPU threads. Left alone, torch takes every core for each check and
# the camera and the marker detection stall while it runs.
TORCH_THREADS = 2
# After a check the thread rests at least this fraction of the time the check took, so a slow machine
# gets fewer checks per second instead of a detector that never lets go of the CPU.
REST_FRACTION = 1.0
Box = Tuple[float, float, float, float]  # x1, y1, x2, y2 as fractions of the frame


@dataclass(frozen=True)
class PersonStatus:
    enabled: bool = False
    detected: bool = False
    count: int = 0
    ts: Optional[float] = None            # when the last check finished (monotonic), None before the first
    boxes: Tuple[Box, ...] = field(default_factory=tuple)


def person_check_available(weights: Optional[str]) -> Tuple[bool, str]:
    """Cheap test (no heavy import): is there a local weights file and an ultralytics package?"""
    if not weights:
        return False, "MEDHOP_YOLO_WEIGHTS is not set"
    if not os.path.isfile(weights):
        return False, f"weights file not found: {weights}"
    if importlib.util.find_spec("ultralytics") is None:
        return False, "the ultralytics package is not installed"
    return True, ""


def load_detector(weights: str):
    """Load the pretrained detector from a local file (never downloaded) with capped CPU threads."""
    import torch
    from ultralytics import YOLO  # heavy import

    torch.set_num_threads(TORCH_THREADS)
    return YOLO(weights)


def detect_persons(model, bgr, confidence: float = CONFIDENCE) -> list:
    """One check of one BGR frame: [(box as frame fractions, confidence), ...] for the person class.

    The live check and tools/eval_person_check.py both call this, so they use the same weights,
    threshold and input size.
    """
    height, width = bgr.shape[:2]
    results = model.predict(bgr, classes=[PERSON_CLASS_ID], conf=confidence, verbose=False, imgsz=IMAGE_SIZE)
    found = []
    for result in results:
        if result.boxes is None:
            continue
        for (x1, y1, x2, y2), score in zip(result.boxes.xyxy.tolist(), result.boxes.conf.tolist()):
            found.append(((x1 / width, y1 / height, x2 / width, y2 / height), float(score)))
    return found


class PersonChecker:
    """Runs the detector on its own thread, at most about 5 times a second and never for more than
    half of the time, with capped CPU threads, so it does not delay marker detection."""

    def __init__(
        self,
        mode: str = "auto",
        weights: Optional[str] = None,
        rate_hz: float = 5.0,
        confidence: float = CONFIDENCE,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self._weights = weights
        self._period = 1.0 / rate_hz
        self._confidence = confidence
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop_evt = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._pending = None  # newest BGR frame waiting to be checked
        self._model = None

        mode = (mode or "auto").strip().lower()
        if mode == "off":
            self._enabled, why = False, "MEDHOP_PERSON_CHECK=off"
        else:
            self._enabled, why = person_check_available(weights)
            if mode == "on" and not self._enabled:
                raise RuntimeError(f"MEDHOP_PERSON_CHECK=on but the person check cannot run: {why}")
        self._status = PersonStatus(enabled=self._enabled)
        if self._enabled:
            logger.info("advisory person check enabled (weights: %s)", weights)
        else:
            logger.info("advisory person check disabled: %s", why)

    @property
    def enabled(self) -> bool:
        with self._lock:
            return self._enabled

    def start(self) -> None:
        if not self.enabled or (self._thread and self._thread.is_alive()):
            return
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._run, name="medhop-person", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_evt.set()
        self._wake.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
        self._thread = None

    def submit(self, bgr) -> None:
        """Hand over the newest frame. Never blocks; an unchecked older frame is replaced."""
        if not self._enabled:
            return
        with self._lock:
            self._pending = bgr
        self._wake.set()

    def status(self) -> PersonStatus:
        with self._lock:
            return self._status

    # ------------------------------------------------------------------ #
    def _disable(self, why: str) -> None:
        logger.error("advisory person check disabled: %s", why)
        with self._lock:
            self._enabled = False
            self._status = PersonStatus(enabled=False)

    def _load(self) -> bool:
        try:
            import numpy as np

            self._model = load_detector(self._weights)   # heavy import, kept off the main thread
            # One dry run: a file that is not a usable model fails here, not in the middle of a flight.
            self._detect(np.zeros((360, 640, 3), np.uint8))
            return True
        except Exception as exc:  # missing torch, bad weights file, ...
            self._disable(f"could not load the detector: {exc}")
            return False

    def _run(self) -> None:
        if not self._load():
            return
        logger.info("advisory person check ready")
        while not self._stop_evt.is_set():
            self._wake.wait(0.5)
            self._wake.clear()
            if self._stop_evt.is_set():
                break
            with self._lock:
                frame, self._pending = self._pending, None
            if frame is None:
                continue
            started = self._clock()
            try:
                boxes = self._detect(frame)
            except Exception as exc:
                self._disable(f"detector failed: {exc}")
                return
            with self._lock:
                self._status = PersonStatus(
                    enabled=True, detected=bool(boxes), count=len(boxes), ts=self._clock(), boxes=tuple(boxes)
                )
            took = self._clock() - started
            remaining = max(self._period - took, REST_FRACTION * took)
            if remaining > 0:
                self._stop_evt.wait(remaining)

    def _detect(self, bgr) -> list:
        return [box for box, _score in detect_persons(self._model, bgr, self._confidence)]
