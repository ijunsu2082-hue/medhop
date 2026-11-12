"""The advisory person check: optional, lazy, and never required for the app to work.

The test that actually loads the detector runs only when MEDHOP_YOLO_WEIGHTS points at a local
weights file and the ultralytics package is installed. Nothing is ever downloaded.
"""
import os
import time
import unittest

import numpy as np

from medhop.vision.person import PersonChecker, PersonStatus, person_check_available

WEIGHTS = os.environ.get("MEDHOP_YOLO_WEIGHTS", "").strip()


class AvailabilityTests(unittest.TestCase):
    def test_auto_without_weights_is_disabled_and_harmless(self):
        checker = PersonChecker("auto", None)
        self.assertFalse(checker.enabled)
        checker.start()                                   # no thread, no import
        checker.submit(np.zeros((360, 640, 3), np.uint8))
        self.assertEqual(checker.status(), PersonStatus(enabled=False))
        checker.stop()

    def test_auto_with_a_missing_weights_file_is_disabled(self):
        self.assertFalse(PersonChecker("auto", "/nonexistent/yolo11n.pt").enabled)
        available, why = person_check_available("/nonexistent/yolo11n.pt")
        self.assertFalse(available)
        self.assertIn("not found", why)

    def test_off_is_disabled_even_with_weights(self):
        self.assertFalse(PersonChecker("off", WEIGHTS or __file__).enabled)

    def test_on_without_weights_refuses_to_start(self):
        with self.assertRaises(RuntimeError):
            PersonChecker("on", None)

    def test_a_file_that_is_not_a_model_disables_the_check_instead_of_crashing(self):
        available, _ = person_check_available(__file__)
        if not available:
            self.skipTest("ultralytics is not installed")
        checker = PersonChecker("auto", __file__)
        self.assertTrue(checker.enabled)                  # looks usable until the load is attempted
        checker.start()
        deadline = time.monotonic() + 90.0
        while checker.enabled and time.monotonic() < deadline:
            time.sleep(0.1)
        checker.stop()
        self.assertFalse(checker.enabled, "a broken weights file must switch the check off")
        self.assertEqual(checker.status(), PersonStatus(enabled=False))


@unittest.skipUnless(person_check_available(WEIGHTS)[0], "MEDHOP_YOLO_WEIGHTS is not set (or ultralytics is missing)")
class DetectorTests(unittest.TestCase):
    def test_detector_runs_on_its_own_thread_and_reports_no_person_in_an_empty_room(self):
        from medhop.drone.sim import SimConfig, SimLink
        import cv2

        sim = SimLink(SimConfig(seed=1), realtime=False)
        frame = cv2.imdecode(np.frombuffer(sim.render_test_frame(2.0), np.uint8), cv2.IMREAD_COLOR)
        checker = PersonChecker("auto", WEIGHTS)
        self.assertTrue(checker.enabled)
        checker.start()
        try:
            deadline = time.monotonic() + 90.0
            while checker.status().ts is None and time.monotonic() < deadline:
                started = time.monotonic()
                checker.submit(frame)
                self.assertLess(time.monotonic() - started, 0.05, "submit must never block")
                time.sleep(0.1)
            status = checker.status()
        finally:
            checker.stop()
        self.assertIsNotNone(status.ts, "the detector never produced a result")
        self.assertTrue(status.enabled)
        self.assertFalse(status.detected)
        self.assertEqual(status.count, 0)


if __name__ == "__main__":
    unittest.main()
