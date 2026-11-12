"""Vision worker: what `link.fps` measures, when the annotated picture is produced, and the rate log."""
import time
import unittest
from unittest import mock

import cv2
import numpy as np

from medhop.drone.base import Frame
from medhop.vision import person as person_module
from medhop.vision import worker as worker_module
from medhop.vision.marker import MarkerDetector
from medhop.vision.person import PersonChecker
from medhop.vision.worker import VisionWorker
from tests.harness import FakeClock, RecordingLink


def plain_jpeg():
    ok, encoded = cv2.imencode(".jpg", np.full((90, 160, 3), 120, np.uint8))
    assert ok
    return encoded.tobytes()


class VisionWorkerTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(50.0)
        self.link = RecordingLink()
        self.jpeg = plain_jpeg()
        self.seen = []
        self.worker = VisionWorker(self.link, MarkerDetector(7), None,
                                   on_observation=lambda obs, now: self.seen.append(obs), clock=self.clock)

    def camera(self, seconds, camera_fps=15.0, processed_every=1):
        """The camera sends frames at `camera_fps`; the worker only gets to every n-th of them."""
        seq = self.link.frame.seq if self.link.frame is not None else 0
        for index in range(int(seconds * camera_fps)):
            self.clock.advance(1.0 / camera_fps)
            seq += 1
            self.link.frame = Frame(jpeg=self.jpeg, timestamp=self.clock.t, seq=seq)
            if index % processed_every == 0:
                self.worker.process_once()


class FrameRateTests(VisionWorkerTestCase):
    def test_fps_is_zero_without_frames(self):
        self.assertEqual(self.worker.snapshot().fps, 0.0)
        self.assertFalse(self.worker.snapshot().video_live)

    def test_fps_is_the_camera_rate_when_every_frame_is_processed(self):
        self.camera(4.0)
        self.assertAlmostEqual(self.worker.snapshot().fps, 15.0, delta=0.6)

    def test_fps_still_reads_the_camera_rate_when_the_worker_skips_frames(self):
        """A slow vision thread sees every third frame: frames still ARRIVE at 15 per second."""
        self.camera(4.0, processed_every=3)
        processed = [obs for obs in self.seen if obs is not None]
        self.assertAlmostEqual(len(processed) / 4.0, 5.0, delta=0.3)
        self.assertAlmostEqual(self.worker.snapshot().fps, 15.0, delta=1.1)

    def test_fps_follows_a_slower_camera(self):
        self.camera(4.0, camera_fps=6.0)
        self.assertAlmostEqual(self.worker.snapshot().fps, 6.0, delta=0.6)

    def test_fps_does_not_overshoot_right_after_start_and_drops_to_zero_when_video_stops(self):
        self.camera(0.14)
        self.assertLessEqual(self.worker.snapshot().fps, 2.0, "too little to go on yet: reads low, never high")
        for _ in range(40):
            self.camera(0.07)
            self.assertLessEqual(self.worker.snapshot().fps, 16.0)
        self.assertGreaterEqual(self.worker.snapshot().fps, 14.0)
        self.camera(3.0)
        self.clock.advance(0.6)
        snapshot = self.worker.snapshot()
        self.assertEqual((snapshot.video_live, snapshot.fps), (False, 0.0))

    def test_rates_are_logged_and_not_part_of_the_snapshot(self):
        with self.assertLogs("medhop.vision", level="INFO") as logs:
            self.camera(worker_module.RATE_LOG_S + 1.0, processed_every=3)
        line = next(text for text in logs.output if "rates over" in text)
        self.assertRegex(line, r"camera 1[45]\.\d fps, vision [45]\.\d fps, marker observations 0\.0 Hz")
        self.assertFalse(hasattr(self.worker.snapshot(), "vision_fps"))
        self.assertRegex(line, r"marker detect median \d+\.\d ms, max \d+\.\d ms")

    def test_the_rate_log_reports_the_marker_detect_time(self):
        durations = iter([0.004] * 60 + [0.050] + [0.004] * 400)   # one slow frame among fast ones
        state = {"t": 0.0, "start": True}

        def fake_perf_counter():
            if not state["start"]:
                state["t"] += next(durations)
            state["start"] = not state["start"]
            return state["t"]

        with mock.patch.object(worker_module.time, "perf_counter", side_effect=fake_perf_counter):
            with self.assertLogs("medhop.vision", level="INFO") as logs:
                self.camera(worker_module.RATE_LOG_S + 1.0)
        line = next(text for text in logs.output if "rates over" in text)
        self.assertIn("marker detect median 4.0 ms, max 50.0 ms", line)


class AnnotatedPictureTests(VisionWorkerTestCase):
    def test_nothing_is_encoded_while_nobody_watches(self):
        with mock.patch.object(worker_module, "encode_jpeg", wraps=worker_module.encode_jpeg) as encode:
            self.camera(2.0)
            self.assertEqual(encode.call_count, 0)
            seq, jpeg = self.worker.annotated_jpeg()               # a viewer arrives
            self.assertEqual(seq, -1, "the generated card until the next frame has been drawn")
            self.assertEqual(jpeg[:3], b"\xff\xd8\xff")
            self.camera(1.0)
            self.assertEqual(encode.call_count, 15, "one encode per frame while watched, not more")
            seq, jpeg = self.worker.annotated_jpeg()
            self.assertGreater(seq, 0)
            # the viewer leaves: encoding stops again after VIEWER_ACTIVE_S
            self.camera(worker_module.VIEWER_ACTIVE_S + 1.0)
            count = encode.call_count
            self.camera(1.0)
            self.assertEqual(encode.call_count, count)

    def test_a_returning_viewer_does_not_get_an_old_picture(self):
        self.worker.annotated_jpeg()
        self.camera(1.0)
        self.assertGreater(self.worker.annotated_jpeg()[0], 0)
        self.camera(worker_module.VIEWER_ACTIVE_S + 1.0)             # nobody watching for a while
        self.assertEqual(self.worker.annotated_jpeg()[0], -1)
        self.camera(0.2)
        self.assertGreater(self.worker.annotated_jpeg()[0], 0)


class PersonCheckLoadTests(unittest.TestCase):
    """The advisory person check must not starve the camera and the marker detection."""

    def test_cpu_threads_are_capped_and_the_live_settings_are_the_shared_ones(self):
        self.assertLessEqual(person_module.TORCH_THREADS, 2)
        self.assertEqual((person_module.CONFIDENCE, person_module.IMAGE_SIZE), (0.4, 640))

    def test_a_slow_detector_gets_fewer_checks_instead_of_all_of_the_cpu(self):
        calls = []

        def slow_detect(_frame):
            calls.append(time.monotonic())
            time.sleep(0.15)
            return []

        with mock.patch.object(person_module, "person_check_available", return_value=(True, "")):
            checker = PersonChecker("on", "weights-not-used.pt")
        checker._load = lambda: True
        checker._detect = slow_detect
        checker.start()
        try:
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                checker.submit(np.zeros((36, 64, 3), np.uint8))     # a new frame is always waiting
                time.sleep(0.01)
        finally:
            checker.stop()
        gaps = [later - earlier for earlier, later in zip(calls, calls[1:])]
        self.assertGreaterEqual(len(calls), 3)
        self.assertGreaterEqual(min(gaps), 0.29, "a 0.15 s check is followed by at least 0.15 s of rest")
        self.assertTrue(checker.status().enabled)
        self.assertIsNotNone(checker.status().ts)


if __name__ == "__main__":
    unittest.main()
