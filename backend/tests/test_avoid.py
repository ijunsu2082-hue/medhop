"""Unit tests for mission/avoid.py (experimental obstacle avoidance): the distance and sideways
estimates against known camera geometry, lane membership, and every state transition (clear, slow,
hold, blocked). Pure: no simulator, no clock (time is passed in)."""
import math
import unittest

from medhop.config import AVOID_MODES
from medhop.mission import avoid
from medhop.mission.avoid import (
    AVOID_STATES, BLOCKED, CLEAR, HOLD, SLOW, AvoidConfig, Avoider, blind_distance_m, estimate,
    floor_distance_m, focal_fh, focal_fw,
)

CFG = AvoidConfig()
# With the drone's camera at 1 m nothing closer than about 2.54 m has its base in the picture, so the
# hold and back-off thresholds are reached only as "very close". A camera at 0.3 m sees the floor from
# 0.76 m, so the threshold tests can place things at every distance.
LOW = AvoidConfig(camera_height_m=0.3)
DT = 1.0 / 15.0


def box_at(distance, lateral=0.0, width=0.45, height=1.7, cfg=CFG):
    """The box (fractions of the frame) of an upright box standing on the floor `distance` metres ahead
    (its front face) and `lateral` metres right of the line of flight, seen by the level camera."""
    f, fh = focal_fw(cfg), focal_fh(cfg)
    x1 = 0.5 + (lateral - width / 2.0) * f / distance
    x2 = 0.5 + (lateral + width / 2.0) * f / distance
    y2 = 0.5 + cfg.camera_height_m * fh / distance
    y1 = 0.5 - (height - cfg.camera_height_m) * fh / distance
    return tuple(max(0.0, min(1.0, v)) for v in (x1, y1, x2, y2))


def seen(distance, lateral=0.0, kind="person", width=0.45, height=1.7, ts=0.0, cfg=CFG):
    return estimate(kind, box_at(distance, lateral, width, height, cfg), ts, cfg)


def low(distance, lateral=0.0, kind="object", width=0.45, height=0.2):
    return seen(distance, lateral, kind, width, height, cfg=LOW)


class EstimateTests(unittest.TestCase):
    def test_floor_plane_distance_matches_the_geometry(self):
        for distance in (2.6, 3.0, 4.5, 7.0):
            with self.subTest(distance=distance):
                s = seen(distance, kind="object", height=0.9)
                self.assertAlmostEqual(s.distance_m, distance, places=6)

    def test_a_person_uses_the_smaller_of_the_floor_and_the_assumed_height(self):
        self.assertAlmostEqual(seen(3.0, height=1.7).distance_m, 3.0, places=6)
        # a taller person makes the height estimate shorter: the smaller (closer) one wins
        tall = seen(3.0, height=2.0)
        self.assertAlmostEqual(tall.distance_m, 1.7 / 1.0 * 3.0 / (2.0 / 1.0), places=6)
        self.assertLess(tall.distance_m, 3.0)
        # an object never uses the person height
        self.assertAlmostEqual(seen(3.0, kind="object", height=2.0).distance_m, 3.0, places=6)

    def test_a_box_cut_off_at_the_bottom_counts_as_very_close_and_in_the_lane(self):
        s = seen(2.0, lateral=1.5)            # base below the picture, well to the side
        self.assertTrue(s.very_close)
        self.assertIsNone(s.distance_m)
        self.assertIsNone(s.lateral_m)
        self.assertTrue(s.in_lane)

    def test_a_bottom_edge_at_or_above_the_horizon_gives_no_distance(self):
        self.assertIsNone(floor_distance_m(0.5, CFG))
        self.assertIsNone(estimate("object", (0.4, 0.2, 0.6, 0.45), 0.0, CFG).distance_m)

    def test_the_blind_distance(self):
        f = 0.5 / math.tan(math.radians(35.0))
        self.assertAlmostEqual(blind_distance_m(CFG), 1.0 * f * 16.0 / 9.0 / 0.5, places=9)
        self.assertAlmostEqual(blind_distance_m(CFG), 2.539, places=3)
        self.assertTrue(seen(blind_distance_m(CFG) - 0.05).very_close)
        self.assertFalse(seen(blind_distance_m(CFG) + 0.1).very_close)

    def test_sideways_position_and_half_width(self):
        s = seen(3.5, lateral=0.8, width=0.6, kind="object", height=0.9)
        self.assertAlmostEqual(s.lateral_m, 0.8, places=6)
        self.assertAlmostEqual(s.half_width_m, 0.3, places=6)
        self.assertAlmostEqual(s.lo_m, 0.5, places=6)
        self.assertAlmostEqual(s.near_m, 0.5, places=6)
        left = seen(3.5, lateral=-0.8, width=0.6, kind="object", height=0.9)
        self.assertAlmostEqual(left.hi_m, -0.5, places=6)

    def test_lane_membership(self):
        self.assertTrue(seen(3.0, lateral=0.0).in_lane)
        self.assertEqual(seen(3.0, lateral=0.0).near_m, 0.0)            # across the line of flight
        self.assertTrue(seen(3.0, lateral=0.225 + 0.54).in_lane)        # nearer edge 0.54 m away
        self.assertFalse(seen(3.0, lateral=0.225 + 0.56).in_lane)       # 0.56 m away
        self.assertFalse(seen(3.0, lateral=-(0.225 + 0.56)).in_lane)


class NoGoingRoundTests(unittest.TestCase):
    def test_hold_is_the_only_avoiding_mode_and_there_is_no_way_to_go_round(self):
        self.assertEqual(AVOID_MODES, ("off", "hold"))
        self.assertEqual(AVOID_STATES, ("clear", "slow", "hold", "blocked"))
        for name in ("SIDESTEP", "PASSING", "SignFix", "sign_position"):
            self.assertFalse(hasattr(avoid, name), name)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.avoider = Avoider(AvoidConfig())
        self.t = 100.0

    def low_avoider(self):
        self.avoider = Avoider(LOW)

    def step(self, items=(), dt=DT, **kw):
        self.t += dt
        return self.avoider.update(self.t, list(items), **kw)

    def test_clear_slow_hold_and_back(self):
        self.low_avoider()
        self.assertEqual(self.step().state, CLEAR)
        self.assertEqual(self.step([low(3.5)]).state, CLEAR)
        self.assertEqual(self.step([low(2.5, lateral=1.5)]).state, CLEAR)     # not in the lane
        cmd = self.step([low(2.9)])
        self.assertEqual((cmd.state, cmd.pitch_cap, cmd.roll), (SLOW, 0.10, None))
        cmd = self.step([low(1.7)])
        self.assertEqual((cmd.state, cmd.pitch_cap, cmd.pitch), (HOLD, 0.0, None))
        cmd = self.step([low(0.85)])                                          # closer than 0.9 m: back off
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))
        cmd = self.step([low(0.7)])                                           # base out of view: very close
        self.assertTrue(low(0.7).very_close)
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))
        self.assertEqual(self.avoider.holds, 1)

    def test_the_drone_camera_reads_anything_inside_the_hold_distance_as_very_close(self):
        cmd = self.step([seen(1.7)])
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))
        self.assertIsNone(self.avoider.snapshot()["distance_m"])
        self.assertEqual(set(self.avoider.snapshot()), {"state", "kind", "distance_m", "held_s"})

    def test_back_to_moving_only_after_the_lane_was_clear_for_a_second(self):
        self.step([seen(1.5)])
        self.assertEqual(self.avoider.state, HOLD)
        for _ in range(int(0.9 / DT)):
            self.assertEqual(self.step([seen(4.0, lateral=2.0)]).state, HOLD)
        cmd = self.step([seen(1.5)])                       # back in the way: the second starts again
        self.assertEqual(cmd.state, HOLD)
        for _ in range(int(0.95 / DT)):
            self.assertEqual(self.step().state, HOLD)
        for _ in range(3):
            cmd = self.step()
        self.assertEqual(cmd.state, CLEAR)
        self.assertEqual((cmd.pitch_cap, cmd.pitch, cmd.roll), (None, None, None))
        self.assertEqual([e["state"] for e in self.avoider.events], [HOLD, CLEAR])

    def test_something_beyond_the_slow_distance_does_not_keep_it_holding(self):
        self.step([seen(1.5)])
        for _ in range(int(1.2 / DT)):
            cmd = self.step([seen(3.5, kind="object", height=0.9)])
        self.assertEqual(cmd.state, CLEAR)

    def test_no_current_evidence_never_clears(self):
        self.step([seen(1.5)])
        for _ in range(int(3.0 / DT)):
            cmd = self.step([], fresh=False)
        self.assertEqual(cmd.state, HOLD)
        self.assertEqual(cmd.pitch_cap, 0.0)

    def test_no_current_evidence_keeps_the_last_limit_while_moving(self):
        self.step([seen(2.9, kind="object", height=0.9)])
        self.assertEqual(self.step([], fresh=False).state, SLOW)

    def test_blocked_after_25_s_held_and_it_stays_blocked(self):
        self.step([seen(1.5)])
        for _ in range(int(24.8 / DT)):
            cmd = self.step([seen(1.5)])
        self.assertEqual(cmd.state, HOLD)
        for _ in range(int(0.4 / DT)):
            cmd = self.step([seen(1.5)])
        self.assertEqual((cmd.state, cmd.reason, cmd.blocked), (BLOCKED, "timeout", True))
        self.assertEqual((cmd.pitch, cmd.roll), (0.0, 0.0))
        self.assertTrue(self.step().blocked, "blocked stays blocked")
        self.assertTrue(self.step([seen(6.0, lateral=3.0)]).blocked, "even when the way clears")
        self.assertAlmostEqual(self.avoider.no_progress_s, 25.0, delta=0.1)

    def test_time_holding_adds_up_over_several_holds(self):
        for _ in range(2):
            self.step([seen(1.5)])
            for _ in range(int(10.0 / DT)):
                self.step([seen(1.5)])
            for _ in range(int(1.2 / DT)):
                self.step()
        self.assertEqual(self.avoider.state, CLEAR)
        self.assertEqual(self.avoider.holds, 2)
        self.assertAlmostEqual(self.avoider.no_progress_s, 22.4, delta=0.3)
        self.step([seen(1.5)])
        for _ in range(int(3.0 / DT)):
            cmd = self.step([seen(1.5)])
        self.assertEqual(cmd.state, BLOCKED)

    def test_the_hold_freezes_yaw_and_starts_with_no_roll(self):
        cmd = self.step([seen(1.5)])
        self.assertEqual((cmd.state, cmd.freeze_yaw, cmd.roll), (HOLD, True, 0.0))
        self.assertFalse(self.step([seen(1.5)], fresh=False).freeze_yaw is False)
        self.assertFalse(Avoider().update(0.0, []).freeze_yaw, "clear: the approach steers as usual")

    def test_the_hold_rolls_against_a_sideways_drift_seen_on_the_obstacle(self):
        """A drone drifting right sees the obstacle's box move left: the roll answers to the left."""
        self.step([seen(2.8, kind="object", height=0.9)])            # slow first
        self.assertEqual(self.step([seen(1.5)]).state, HOLD)
        rolls = []
        for k in range(int(3.0 / DT)):
            # measurable (its base in view on the low camera), moving left as the drone drifts right
            cmd = self.step([estimate("object", box_at(1.5, -0.02 * k, 0.45, 0.2, LOW), self.t, LOW)])
            rolls.append(cmd.roll)
        self.assertEqual(cmd.state, HOLD)
        self.assertLess(rolls[-1], -0.05)
        self.assertGreaterEqual(min(rolls), -0.15)

    def test_the_hold_rolls_against_a_sideways_drift_seen_on_the_sign(self):
        """With the heading held still, the sign moving right in the picture means the drone moved left:
        the roll answers to the right. The sign wins over an obstacle box that cannot be measured."""
        self.assertEqual(self.step([seen(1.5)], sign=(0.5, 3.5)).state, HOLD)
        f = focal_fw(CFG)
        rolls = []
        for k in range(int(3.0 / DT)):
            lateral = -0.02 * k                                       # the drone drifts left
            cx = 0.5 + f * (-lateral) / 3.5                           # so the sign appears to the right
            cmd = self.step([seen(2.0)], sign=(cx, 3.5))              # the obstacle itself is very close
            rolls.append(cmd.roll)
        self.assertGreater(rolls[-1], 0.05)
        self.assertLessEqual(max(rolls), 0.15)
        self.assertEqual(cmd.pitch, -0.08, "still backing away from the very close obstacle")


if __name__ == "__main__":
    unittest.main()
