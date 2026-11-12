"""Vision thread: frames -> observations -> mission step, plus the annotated JPEG for the MJPEG stream.

One thread does: take the newest frame from the link, decode it, detect the station marker (ArUco),
hand the frame to the optional person check (which runs on its own thread), step the mission runner,
and draw the annotated picture. When no new frame arrives it still steps the runner about 20 times a
second so the runner's timers and failsafes keep running without video.

Two rates are kept apart. The status field `link.fps` is the rate at which frames ARRIVE from the camera
(counted from the link's frame sequence numbers, so frames this thread had to skip still count). How
many frames this thread actually processed, and in how many of them the marker was found, is written
to the log every few seconds; it is not part of the status contract.

The annotated JPEG is only drawn and encoded while somebody is watching the stream.
"""
from __future__ import annotations

import logging
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, List, Optional

import cv2
import numpy as np

from medhop.drone.base import DroneLink
from medhop.vision.marker import MarkerDetector, MarkerObs, Observation
from medhop.vision.person import PersonChecker, PersonStatus

logger = logging.getLogger("medhop.vision")

DARK_BRIGHTNESS = 40.0        # mean grey level below this is reported as dark
MARKER_VISIBLE_S = 1.0        # status shows the marker for this long after its last detection
VIDEO_LIVE_S = 0.5            # same threshold as the mixer's video failsafe
NO_VIDEO_AFTER_S = 2.0        # the stream shows the "No video" card when frames are older than this
ANNOTATED_JPEG_QUALITY = 80
IDLE_STEP_S = 0.05
FPS_WINDOW_S = 2.0            # link.fps is averaged over this long
VIEWER_ACTIVE_S = 2.0         # the annotated picture is produced for this long after it was last asked for
RATE_LOG_S = 10.0             # how often the camera / vision / marker rates are logged

_FONT = cv2.FONT_HERSHEY_SIMPLEX


@dataclass(frozen=True)
class VisionSnapshot:
    frame_age_s: Optional[float]
    video_live: bool
    fps: float
    marker: Optional[MarkerObs]
    marker_age_s: Optional[float]
    brightness: Optional[float]
    dark: bool


def encode_jpeg(image: np.ndarray, quality: int = ANNOTATED_JPEG_QUALITY) -> bytes:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return encoded.tobytes()


def no_video_jpeg(text: str = "No video", width: int = 640, height: int = 360) -> bytes:
    """A generated card so the page never hangs waiting for the first frame."""
    image = np.full((height, width, 3), 28, np.uint8)
    cv2.rectangle(image, (8, 8), (width - 9, height - 9), (70, 70, 70), 1)
    (text_w, text_h), _ = cv2.getTextSize(text, _FONT, 1.2, 2)
    cv2.putText(image, text, ((width - text_w) // 2, (height + text_h) // 2), _FONT, 1.2,
                (210, 210, 210), 2, cv2.LINE_AA)
    return encode_jpeg(image)


def annotate(image: np.ndarray, marker: Optional[MarkerObs], person: PersonStatus, banner: str) -> np.ndarray:
    """Draw the marker outline, person boxes and a small state banner on a copy of the frame."""
    out = image.copy()
    height, width = out.shape[:2]
    if person.enabled:
        for x1, y1, x2, y2 in person.boxes:
            cv2.rectangle(out, (int(x1 * width), int(y1 * height)), (int(x2 * width), int(y2 * height)),
                          (0, 140, 255), 2)
            cv2.putText(out, "person", (int(x1 * width) + 3, max(12, int(y1 * height) - 5)), _FONT, 0.45,
                        (0, 140, 255), 1, cv2.LINE_AA)
    if marker is not None:
        pts = np.array(marker.corners, dtype=np.int32).reshape(-1, 1, 2)
        cv2.polylines(out, [pts], True, (0, 220, 0), 2, cv2.LINE_AA)
        centre = (int(marker.cx * width), int(marker.cy * height))
        cv2.drawMarker(out, centre, (0, 220, 0), cv2.MARKER_CROSS, 12, 1)
        label = f"station {marker.id}  w={marker.width:.3f}"
        cv2.putText(out, label, (max(2, centre[0] - 70), max(14, int(min(p[1] for p in marker.corners)) - 8)),
                    _FONT, 0.45, (0, 220, 0), 1, cv2.LINE_AA)
    if banner:
        (text_w, text_h), _ = cv2.getTextSize(banner, _FONT, 0.5, 1)
        cv2.rectangle(out, (0, 0), (text_w + 12, text_h + 12), (0, 0, 0), -1)
        cv2.putText(out, banner, (6, text_h + 6), _FONT, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return out


class VisionWorker:
    def __init__(
        self,
        link: DroneLink,
        detector: MarkerDetector,
        person: Optional[PersonChecker] = None,
        on_observation: Optional[Callable[[Optional[Observation], float], None]] = None,
        banner: Optional[Callable[[], str]] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._link = link
        self._detector = detector
        self._person = person
        self._on_observation = on_observation
        self._banner = banner or (lambda: "")
        self._clock = clock
        self._lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._last_seq: Optional[int] = None
        self._last_step = 0.0
        self._frame_ts: Optional[float] = None
        self._arrivals: Deque[tuple] = deque(maxlen=128)   # (time first seen here, frame seq)
        self._viewer_at: Optional[float] = None            # when the annotated picture was last asked for
        self._rate_at: Optional[float] = None              # start of the current rate-log period
        self._rate_seq = 0
        self._rate_frames = 0
        self._rate_markers = 0
        self._rate_gap = 0.0
        self._rate_detect_ms: List[float] = []
        self._last_processed: Optional[float] = None
        self._marker: Optional[MarkerObs] = None
        self._brightness: Optional[float] = None
        self._annotated: Optional[bytes] = None
        self._annotated_seq = 0
        self._no_video = no_video_jpeg()

    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_evt.clear()
        if self._person is not None:
            self._person.start()
        self._thread = threading.Thread(target=self._run, name="medhop-vision", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_evt.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        self._thread = None
        if self._person is not None:
            self._person.stop()

    def _run(self) -> None:
        while not self._stop_evt.is_set():
            try:
                worked = self.process_once()
            except Exception:
                logger.exception("vision step failed")
                worked = False
            if not worked:
                self._stop_evt.wait(0.005)

    # ------------------------------------------------------------------ #
    def process_once(self, now: Optional[float] = None) -> bool:
        """Handle the newest frame if it is new. Returns True when a frame was processed."""
        now = self._clock() if now is None else now
        frame = self._link.latest_frame()
        if frame is None or frame.seq == self._last_seq:
            if now - self._last_step >= IDLE_STEP_S:
                self._last_step = now
                if self._on_observation is not None:
                    self._on_observation(None, now)
            return False
        self._last_seq = frame.seq

        image = cv2.imdecode(np.frombuffer(frame.jpeg, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            logger.warning("could not decode frame %d (%d bytes)", frame.seq, len(frame.jpeg))
            return True
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        detect_start = time.perf_counter()     # real time, not the injected clock: this is a cost
        marker = self._detector.detect(gray, ts=frame.timestamp)
        detect_ms = (time.perf_counter() - detect_start) * 1000.0
        brightness = float(gray.mean())
        obs = Observation(ts=frame.timestamp, seq=frame.seq, marker=marker, brightness=brightness)

        if self._person is not None:
            self._person.submit(image)
        with self._lock:
            self._frame_ts = frame.timestamp
            self._arrivals.append((now, frame.seq))
            self._brightness = brightness
            if marker is not None:
                self._marker = marker
            watched = self._viewer_at is not None and (now - self._viewer_at) <= VIEWER_ACTIVE_S
        self._log_rates(now, frame.seq, marker is not None, detect_ms)

        self._last_step = now
        if self._on_observation is not None:
            self._on_observation(obs, now)

        if watched:
            person = self._person.status() if self._person is not None else PersonStatus()
            jpeg = encode_jpeg(annotate(image, marker, person, self._banner()))
            with self._lock:
                self._annotated = jpeg
                self._annotated_seq += 1
        elif self._annotated is not None:
            with self._lock:
                self._annotated = None     # nobody is watching: do not keep an old picture for later
        return True

    def _log_rates(self, now: float, seq: int, marker_seen: bool, detect_ms: float = 0.0) -> None:
        """Every RATE_LOG_S: camera frame rate, frames processed here, marker observations, longest gap,
        and the marker detector's time per frame (median and max, milliseconds)."""
        if self._last_processed is not None:
            self._rate_gap = max(self._rate_gap, now - self._last_processed)
        self._last_processed = now
        if self._rate_at is None:
            self._rate_at, self._rate_seq = now, seq
            self._rate_frames = self._rate_markers = 0
            self._rate_gap = 0.0
            self._rate_detect_ms = []
            return
        self._rate_frames += 1
        self._rate_markers += 1 if marker_seen else 0
        self._rate_detect_ms.append(detect_ms)
        elapsed = now - self._rate_at
        if elapsed < RATE_LOG_S:
            return
        logger.info(
            "rates over %.0f s: camera %.1f fps, vision %.1f fps, marker observations %.1f Hz, "
            "longest gap between processed frames %.2f s, marker detect median %.1f ms, max %.1f ms",
            elapsed, (seq - self._rate_seq) / elapsed, self._rate_frames / elapsed,
            self._rate_markers / elapsed, self._rate_gap,
            statistics.median(self._rate_detect_ms), max(self._rate_detect_ms),
        )
        self._rate_at, self._rate_seq = now, seq
        self._rate_frames = self._rate_markers = 0
        self._rate_gap = 0.0
        self._rate_detect_ms = []

    # ------------------------------------------------------------------ #
    def person_status(self) -> PersonStatus:
        return self._person.status() if self._person is not None else PersonStatus()

    def snapshot(self, now: Optional[float] = None) -> VisionSnapshot:
        now = self._clock() if now is None else now
        with self._lock:
            frame_age = None if self._frame_ts is None else max(0.0, now - self._frame_ts)
            # Camera frame arrival: frames that came in on the link (by sequence number) during the
            # last FPS_WINDOW_S, divided by that time. A frame this thread skipped still counts.
            fps = 0.0
            if self._arrivals:
                start = now - FPS_WINDOW_S
                before = [item for item in self._arrivals if item[0] < start]
                latest = self._arrivals[-1]
                if latest[0] >= start:
                    if before:
                        fps = (latest[1] - before[-1][1]) / FPS_WINDOW_S
                    else:
                        # Less than a full window of history (just started, or video just came
                        # back): never divide by less than a second, so a first burst of frames
                        # reads low for a moment instead of impossibly high.
                        fps = (latest[1] - self._arrivals[0][1]) / max(1.0, now - self._arrivals[0][0])
                fps = max(0.0, fps)
            marker = self._marker
            marker_age = None if marker is None else max(0.0, now - marker.ts)
            if marker_age is None or marker_age > MARKER_VISIBLE_S:
                marker, marker_age = None, None
            brightness = self._brightness
        live = frame_age is not None and frame_age <= VIDEO_LIVE_S
        return VisionSnapshot(
            frame_age_s=frame_age,
            video_live=live,
            fps=fps if live else 0.0,
            marker=marker,
            marker_age_s=marker_age,
            brightness=brightness,
            dark=brightness is not None and brightness < DARK_BRIGHTNESS,
        )

    def annotated_jpeg(self, now: Optional[float] = None) -> tuple:
        """(sequence number, JPEG bytes). Falls back to a generated "No video" card.

        Asking also tells the vision thread that somebody is watching: it draws and encodes the
        annotated picture only for VIEWER_ACTIVE_S after the last call, so the first call after a
        pause may still return the card or an older picture.
        """
        now = self._clock() if now is None else now
        with self._lock:
            self._viewer_at = now
            stale = self._frame_ts is None or (now - self._frame_ts) > NO_VIDEO_AFTER_S
            if self._annotated is None or stale:
                return -1, self._no_video
            return self._annotated_seq, self._annotated
