"""Unit tests for mission/avoid.py (experimental obstacle avoidance): the distance and sideways
estimates against known camera geometry, lane membership, and every state transition. Pure: no
simulator, no clock (time is passed in)."""
import math
import unittest

from medhop.mission.avoid import (
    BLOCKED, CLEAR, HOLD, PASSING, SIDESTEP, SLOW, AvoidConfig, Avoider, SignFix, blind_distance_m,
    estimate, floor_distance_m, focal_fh, focal_fw, sign_position,
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

    def test_the_sign_position_frame(self):
        self.assertEqual(sign_position(SignFix(0.0, 0.5, 3.0), CFG), (0.0, 3.0))
        x, z = sign_position(SignFix(0.0, 0.5 + focal_fw(CFG) * math.tan(math.radians(20)), 3.0), CFG)
        self.assertAlmostEqual(x, -3.0 * math.sin(math.radians(20)), places=9)   # sign to the right: drone left
        self.assertAlmostEqual(z, 3.0 * math.cos(math.radians(20)), places=9)


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
        self.assertEqual((cmd.state, cmd.pitch_cap), (SLOW, 0.10))
        cmd = self.step([low(1.7)])
        self.assertEqual((cmd.state, cmd.pitch_cap, cmd.pitch), (HOLD, 0.0, None))
        cmd = self.step([low(0.85)])                                          # closer than 0.9 m: back off
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))
        cmd = self.step([low(0.7)])                                           # base out of view: very close
        self.assertTrue(low(0.7).very_close)
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))

    def test_the_drone_camera_reads_anything_inside_the_hold_distance_as_very_close(self):
        cmd = self.step([seen(1.7)])
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))
        self.assertIsNone(self.avoider.snapshot()["distance_m"])

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
        self.assertEqual(cmd.pitch_cap, None)

    def test_no_current_evidence_never_clears(self):
        self.step([seen(1.5)])
        for _ in range(int(3.0 / DT)):
            cmd = self.step([], fresh=False)
        self.assertEqual(cmd.state, HOLD)
        self.assertEqual(cmd.pitch_cap, 0.0)

    def test_mode_hold_never_goes_round(self):
        self.step([seen(1.5)])
        for _ in range(int(10.0 / DT)):
            cmd = self.step([seen(2.8, lateral=0.1)], allow_pass=False)
        self.assertEqual(cmd.state, HOLD)

    def test_patience_before_going_round(self):
        self.step([seen(1.7)])                       # into hold (1.7 < 1.8 m)
        for _ in range(int(3.8 / DT)):
            self.assertEqual(self.step([seen(2.8, lateral=0.1)], allow_pass=True).state, HOLD)
        for _ in range(int(0.4 / DT)):
            cmd = self.step([seen(2.8, lateral=0.1)], allow_pass=True)
        self.assertEqual(cmd.state, SIDESTEP)
        self.assertTrue(cmd.freeze_yaw)
        self.assertEqual(self.avoider.side, -1, "something right of centre: go left, the shorter way")

    def test_a_blocker_whose_base_is_out_of_view_is_backed_away_from_first(self):
        self.step([seen(1.5)])
        for _ in range(int(6.0 / DT)):
            cmd = self.step([seen(2.0)], allow_pass=True)      # base below the picture
        self.assertEqual((cmd.state, cmd.pitch), (HOLD, -0.08))

    def test_no_way_round(self):
        wide = seen(2.8, kind="object", width=3.2, height=1.2)
        self.step([seen(1.5)])
        cmds = [self.step([wide], allow_pass=True) for _ in range(int(4.3 / DT))]
        self.assertEqual(cmds[-1].state, BLOCKED)
        self.assertTrue(cmds[-1].blocked)
        self.assertEqual(cmds[-1].reason, "no_way_round")
        self.assertEqual(self.avoider.blocked_reason, "no_way_round")

    def test_something_else_on_one_side_makes_it_go_the_other_way(self):
        self.step([seen(1.5)])
        blocker = seen(2.8, lateral=-0.05)                       # slightly left: right is shorter
        beside = seen(3.0, lateral=1.4, kind="object", width=0.6, height=0.9)
        for _ in range(int(4.2 / DT)):
            cmd = self.step([blocker, beside], allow_pass=True)
        self.assertEqual(cmd.state, SIDESTEP)
        self.assertEqual(self.avoider.side, -1)

    def test_the_sidestep_limit_from_the_sign(self):
        self.step([seen(1.5)])
        for _ in range(int(4.2 / DT)):
            self.step([seen(2.8)], allow_pass=True)
        self.assertEqual(self.avoider.state, SIDESTEP)
        far_off = SignFix(self.t, 0.5 + focal_fw(CFG) * math.tan(math.radians(30)), 3.0)   # 1.5 m off
        cmd = self.step([seen(2.8, lateral=0.1)], allow_pass=True, sign=far_off)
        self.assertEqual((cmd.state, cmd.reason), (BLOCKED, "no_way_round"))

    def test_the_sidestep_time_limit_without_the_sign(self):
        self.step([seen(1.5)])
        for _ in range(int(4.2 / DT)):
            self.step([seen(2.8)], allow_pass=True)
        self.assertEqual(self.avoider.state, SIDESTEP)
        limit = CFG.max_sidestep_m / CFG.sidestep_speed_m_s           # 10 s
        cmds = [self.step([seen(2.8)], allow_pass=True) for _ in range(int((limit - 0.3) / DT))]
        self.assertEqual(cmds[-1].state, SIDESTEP)
        for _ in range(int(0.6 / DT)):
            cmd = self.step([seen(2.8)], allow_pass=True)
        self.assertEqual((cmd.state, cmd.reason), (BLOCKED, "no_way_round"))

    def test_blocked_after_25_s_without_progress(self):
        self.step([seen(1.5)])
        for _ in range(int(24.8 / DT)):
            cmd = self.step([seen(1.5)])
        self.assertEqual(cmd.state, HOLD)
        for _ in range(int(0.4 / DT)):
            cmd = self.step([seen(1.5)])
        self.assertEqual((cmd.state, cmd.reason, cmd.blocked), (BLOCKED, "timeout", True))
        self.assertTrue(self.step().blocked, "blocked stays blocked")
        self.assertAlmostEqual(self.avoider.no_progress_s, 25.0, delta=0.1)


class GoingRoundTests(unittest.TestCase):
    """A small kinematic stand-in for the drone (roll and pitch move it at 1 m/s per full stick, no lag,
    yaw frozen, a steady sideways drift) around one static person, to drive the sidestep and the pass."""

    def run_round(self, drift=0.05, other=None, seconds=80.0):
        avoider = Avoider(AvoidConfig())
        x, z = 0.0, 3.0                  # drone sideways and distance to the person's front face
        person_x, depth = 0.05, 0.3
        t, roll, pitch, closest = 0.0, 0.0, 0.0, 9.0
        log = []
        while t < seconds:
            t += DT
            x += (roll + drift) * DT
            z -= pitch * DT
            items = []
            if z > 0.05:
                items.append(estimate("person", box_at(z, person_x - x), t, CFG))
                if items[0].box[2] <= 0.0 or items[0].box[0] >= 1.0:
                    items = []
            if other is not None and t > other[0]:
                items.append(estimate("person", box_at(other[1], other[2]), t, CFG))
            cmd = avoider.update(t, items, allow_pass=True)
            log.append((t, cmd.state))
            roll = 0.0 if cmd.roll is None else cmd.roll
            if cmd.pitch is not None:
                pitch = cmd.pitch
            else:
                pitch = 0.2 if cmd.pitch_cap is None else min(0.2, cmd.pitch_cap)
            # the person's footprint, sideways and along
            dx = max(abs(x - person_x) - 0.225, 0.0)
            dz = 0.0 if -depth <= z <= 0.0 else (z if z > 0 else -(z + depth))
            closest = min(closest, math.hypot(dx, dz))
            if cmd.handed_back or cmd.blocked:
                return avoider, cmd, x, z, closest, log
        return avoider, cmd, x, z, closest, log

    def test_goes_round_and_hands_back_beside_it(self):
        avoider, cmd, x, z, closest, log = self.run_round()
        states = [s for _t, s in log]
        self.assertIn(HOLD, states)
        self.assertIn(SIDESTEP, states)
        self.assertIn(PASSING, states)
        self.assertTrue(cmd.handed_back, states[-5:])
        self.assertGreater(abs(x - 0.05) - 0.225, 0.85, "passed with at least about pass_clear_m of gap")
        self.assertLess(z, -CFG.pass_beside_m + 0.05, "handed back once beside the front face")
        self.assertGreater(closest, 0.8)
        self.assertEqual(avoider.passes, 1)

    def test_the_hold_learns_the_drift_and_the_pass_holds_its_line(self):
        _avoider, cmd, x, _z, _closest, log = self.run_round(drift=0.08)
        self.assertTrue(cmd.handed_back, log[-3:])
        self.assertLess(abs(abs(x - 0.05) - 0.225 - 0.9), 0.35, x)

    def test_someone_stepping_into_the_way_stops_the_pass(self):
        avoider = Avoider(AvoidConfig())
        t = 0.0
        avoider.update(t, [estimate("person", box_at(1.5, 0.0), t, CFG)], allow_pass=True)
        for _ in range(int(5.0 / DT)):
            t += DT
            avoider.update(t, [estimate("person", box_at(2.8, 0.0), t, CFG)], allow_pass=True)
        self.assertEqual(avoider.state, SIDESTEP)
        side = avoider.side
        # the sidestep moves the drone: the blocker slides across the picture until the gap is wide
        for k in range(1, 21):
            t += DT
            cmd = avoider.update(t, [estimate("person", box_at(2.8, -side * 0.06 * k), t, CFG)], allow_pass=True)
        self.assertEqual(cmd.state, PASSING)
        for _ in range(5):
            t += DT
            cmd = avoider.update(t, [estimate("person", box_at(2.7, -side * 1.2), t, CFG)], allow_pass=True)
        self.assertGreater(cmd.pitch, 0.0)
        t += DT
        cmd = avoider.update(t, [estimate("person", box_at(2.7, -side * 1.2), t, CFG),
                                 estimate("person", box_at(2.9, 0.1), t, CFG)], allow_pass=True)
        self.assertEqual(cmd.state, PASSING)
        self.assertEqual(cmd.pitch, 0.0, "something else in the lane: no forward stick")


if __name__ == "__main__":
    unittest.main()
