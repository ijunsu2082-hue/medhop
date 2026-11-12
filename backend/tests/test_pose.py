"""vision/pose.py: where the camera is relative to the sign, from the marker's corners."""
import math
import unittest

import cv2
import numpy as np

from medhop.drone.sim import SimConfig, SimLink
from medhop.vision.marker import MarkerDetector
from medhop.vision.pose import _project, fit_sign_pose

W, H, SIZE, HFOV = 640, 360, 0.18, 70.0
FOCAL = (W / 2) / math.tan(math.radians(HFOV / 2))
HALF = SIZE / 2
WORLD = np.array([[-HALF, HALF, 0], [HALF, HALF, 0], [HALF, -HALF, 0], [-HALF, -HALF, 0.0]])


def corners_for(x, y, z, yaw_deg=0.0, pitch_deg=0.0, roll_deg=0.0):
    uv = _project(np.array([x, y, z, math.radians(yaw_deg), math.radians(pitch_deg), math.radians(roll_deg)]),
                  WORLD, FOCAL, W / 2, H / 2)
    return np.stack([uv[:4], uv[4:]], 1)


class SyntheticPoseTests(unittest.TestCase):
    def test_recovers_exact_poses(self):
        for x, y, z, yaw in ((0.0, 0.0, 0.8, 0.0), (0.12, 0.05, 0.8, -6.0), (-0.3, -0.1, 1.2, 10.0),
                             (0.5, 0.2, 2.0, -12.0)):
            with self.subTest(x=x, z=z, yaw=yaw):
                pose = fit_sign_pose(corners_for(x, y, z, yaw, 3.0, 2.0), W, H, SIZE, HFOV)
                self.assertAlmostEqual(pose.lateral_m, x, places=3)
                self.assertAlmostEqual(pose.distance_m, z, places=3)
                self.assertAlmostEqual(pose.yaw_deg, yaw, places=1)
                self.assertLess(pose.rms_px, 0.01)

    def test_sign_of_the_offset_is_never_flipped_by_noise(self):
        """The reason this is not cv2.solvePnP: near head-on, the left/right answer must stay right."""
        rng = np.random.default_rng(3)
        for x in (-0.06, 0.06):
            pts = corners_for(x, 0.0, 0.8)
            fits = [fit_sign_pose(pts + rng.normal(0, 0.3, pts.shape), W, H, SIZE, HFOV).lateral_m
                    for _ in range(200)]
            with self.subTest(x=x):
                self.assertGreater(sum(1 for f in fits if f * x > 0) / len(fits), 0.97)
                self.assertLess(abs(float(np.mean(fits)) - x), 0.01)

    def test_bad_input(self):
        self.assertIsNone(fit_sign_pose([(0, 0), (1, 0), (1, 1), (0, 1)], W, H, SIZE, HFOV))   # too small
        self.assertIsNone(fit_sign_pose([(np.nan, 0)] * 4, W, H, SIZE, HFOV))


class RenderedPoseTests(unittest.TestCase):
    def test_simulator_frames(self):
        detector = MarkerDetector(7)
        for x in (-0.3, -0.1, 0.0, 0.1, 0.3):
            for heading in (0.0, 8.0):
                sim = SimLink(SimConfig(seed=0, start_airborne=True), realtime=False)
                image = cv2.imdecode(np.frombuffer(sim.render_test_frame(0.8, x, heading), np.uint8), 1)
                marker = detector.detect(image)
                if marker is None:
                    continue
                pose = fit_sign_pose(marker.corners, marker.frame_w, marker.frame_h, SIZE, HFOV)
                with self.subTest(x=x, heading=heading):
                    self.assertAlmostEqual(pose.lateral_m, x, delta=0.03)
                    self.assertAlmostEqual(pose.distance_m, 0.8, delta=0.03)


if __name__ == "__main__":
    unittest.main()
