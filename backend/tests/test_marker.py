import unittest

import cv2
import numpy as np

from medhop.drone.sim import SimConfig, SimLink
from medhop.vision.marker import MarkerDetector, marker_image, station_sign
from medhop.vision.worker import annotate, no_video_jpeg
from medhop.vision.person import PersonStatus

# Minimum share of noisy 640x360 JPEG-q50 sim frames in which the 0.18 m marker must be found.
REQUIRED_RATE = {1.0: 0.98, 1.5: 0.98, 2.0: 0.98, 2.5: 0.95, 3.0: 0.95, 3.5: 0.85}
FRAMES_PER_DISTANCE = 40


def decode(jpeg):
    return cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)


def detection_table(frames=FRAMES_PER_DISTANCE, seed=7):
    """{distance: (detection rate, mean width, expected width)} on rendered sim frames."""
    sim = SimLink(SimConfig(seed=seed), realtime=False)
    detector = MarkerDetector(7)
    rng = np.random.default_rng(seed)
    table = {}
    for distance in REQUIRED_RATE:
        widths = []
        for _ in range(frames):
            jpeg = sim.render_test_frame(distance, x_m=rng.uniform(-0.2, 0.2), heading_deg=rng.uniform(-8, 8))
            obs = detector.detect(decode(jpeg))
            if obs is not None:
                widths.append(obs.width)
        expected = sim._focal * sim.cfg.marker_size_m / distance / sim.cfg.width
        table[distance] = (len(widths) / frames, float(np.mean(widths)) if widths else 0.0, expected)
    return table


class RenderedFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim = SimLink(SimConfig(seed=3), realtime=False)
        cls.detector = MarkerDetector(7)

    def test_detection_rate_by_distance(self):
        table = detection_table()
        for distance, (rate, mean_width, expected) in table.items():
            self.assertGreaterEqual(rate, REQUIRED_RATE[distance], f"{distance} m: {rate:.0%}")
            self.assertAlmostEqual(mean_width, expected, delta=expected * 0.08, msg=f"{distance} m")

    def test_centre_and_width_of_a_square_on_marker(self):
        obs = self.detector.detect(decode(self.sim.render_test_frame(1.5)))
        self.assertIsNotNone(obs)
        self.assertEqual(obs.id, 7)
        self.assertAlmostEqual(obs.cx, 0.5, delta=0.01)
        self.assertAlmostEqual(obs.cy, 0.5, delta=0.06)
        expected = self.sim._focal * 0.18 / 1.5 / 640
        self.assertAlmostEqual(obs.width, expected, delta=0.004)
        self.assertAlmostEqual(obs.height, obs.width, delta=0.004)
        self.assertEqual(len(obs.corners), 4)

    def test_heading_moves_the_marker_across_the_frame(self):
        right = self.detector.detect(decode(self.sim.render_test_frame(2.0, heading_deg=-15)))
        left = self.detector.detect(decode(self.sim.render_test_frame(2.0, heading_deg=15)))
        self.assertGreater(right.cx, 0.6)       # drone turned left: the marker is right of centre
        self.assertLess(left.cx, 0.4)

    def test_oblique_view_shrinks_width_but_not_size(self):
        # 1.2 m from the wall, 1.2 m to the side, turned to face the marker: 45 degrees off the normal
        obs = self.detector.detect(decode(self.sim.render_test_frame(1.2, x_m=1.2, heading_deg=-45)))
        self.assertIsNotNone(obs)
        self.assertLess(obs.width / obs.height, 0.8)
        self.assertGreater(obs.width / obs.height, 0.6)
        self.assertEqual(obs.size, obs.height)

    def test_frame_without_marker_gives_none(self):
        jpeg = self.sim._render_jpeg({"x": 0.0, "z": -2.0, "heading": 0.0, "cam_y": 1.04, "marker_hidden": True})
        self.assertIsNone(self.detector.detect(decode(jpeg)))


class SyntheticTests(unittest.TestCase):
    def canvas_with_marker(self, marker_id, side=80, x0=200, y0=100):
        canvas = np.full((360, 640), 200, np.uint8)
        canvas[y0 - 20:y0 + side + 20, x0 - 20:x0 + side + 20] = 255
        canvas[y0:y0 + side, x0:x0 + side] = marker_image(marker_id, side)
        return canvas

    def test_width_is_mean_of_top_and_bottom_edges_over_frame_width(self):
        obs = MarkerDetector(7).detect(self.canvas_with_marker(7))
        self.assertIsNotNone(obs)
        self.assertAlmostEqual(obs.width, 80 / 640, delta=0.003)
        self.assertAlmostEqual(obs.cx, (200 + 40) / 640, delta=0.003)
        self.assertAlmostEqual(obs.cy, (100 + 40) / 360, delta=0.005)

    def test_detections_narrower_than_0_025_of_the_frame_width_are_ignored(self):
        class NoFloor(MarkerDetector):
            MIN_WIDTH = 0.0

        for side in (12, 15):                                 # 0.019 and 0.023 of 640 px
            canvas = self.canvas_with_marker(7, side=side, x0=300, y0=150)
            self.assertIsNotNone(NoFloor(7).detect(canvas), f"{side} px decodes without the floor")
            self.assertIsNone(MarkerDetector(7).detect(canvas), f"{side} px is dropped")
        obs = MarkerDetector(7).detect(self.canvas_with_marker(7, side=18, x0=300, y0=150))
        self.assertIsNotNone(obs, "18 px (0.028) is kept")
        self.assertEqual(MarkerDetector.MIN_WIDTH, 0.025)

    def test_detector_parameters_are_the_revision_3_ones(self):
        from medhop.vision.marker import make_detector_parameters

        p = make_detector_parameters()
        self.assertAlmostEqual(p.minMarkerPerimeterRate, 0.07)
        self.assertAlmostEqual(p.polygonalApproxAccuracyRate, 0.03)

    def test_other_marker_ids_are_ignored(self):
        self.assertIsNone(MarkerDetector(7).detect(self.canvas_with_marker(3)))
        self.assertIsNotNone(MarkerDetector(3).detect(self.canvas_with_marker(3)))

    def test_accepts_bgr_and_handles_empty_input(self):
        bgr = cv2.cvtColor(self.canvas_with_marker(7), cv2.COLOR_GRAY2BGR)
        self.assertIsNotNone(MarkerDetector(7).detect(bgr, ts=12.5))
        self.assertEqual(MarkerDetector(7).detect(bgr, ts=12.5).ts, 12.5)
        self.assertIsNone(MarkerDetector(7).detect(np.zeros((0, 0), np.uint8)))

    def test_station_sign_layout(self):
        sheet, (x0, y0, side) = station_sign(7, 0.18, 2000.0)
        self.assertEqual(sheet.shape, (594, 420))
        self.assertEqual(side, 360)
        self.assertEqual(x0, 30)                      # 15 mm of white on each side
        self.assertTrue((sheet[:, :x0 - 1] == 255).all())
        self.assertIsNotNone(MarkerDetector(7).detect(sheet))
        with self.assertRaises(ValueError):
            station_sign(7, 0.20, 2000.0)             # would leave only 5 mm of quiet zone

    def test_annotation_and_no_video_card(self):
        frame = cv2.cvtColor(self.canvas_with_marker(7), cv2.COLOR_GRAY2BGR)
        obs = MarkerDetector(7).detect(frame)
        person = PersonStatus(enabled=True, detected=True, count=1, ts=0.0, boxes=((0.6, 0.2, 0.9, 0.9),))
        out = annotate(frame, obs, person, "SIM | approaching")
        self.assertEqual(out.shape, frame.shape)
        self.assertFalse(np.array_equal(out, frame))
        self.assertTrue(np.array_equal(frame, cv2.cvtColor(self.canvas_with_marker(7), cv2.COLOR_GRAY2BGR)))
        card = decode(no_video_jpeg())
        self.assertEqual(card.shape, (360, 640, 3))


if __name__ == "__main__":
    unittest.main()
