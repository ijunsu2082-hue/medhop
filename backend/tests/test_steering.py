import unittest

from medhop.mission.steering import (
    DriftAssist,
    DriftAssistConfig,
    MarkerSample,
    Steering,
    SteeringConfig,
    forward_for_width,
    limit_rise,
    marker_skew,
    pending_yaw,
    predict_cx,
    steer,
)

ARRIVE = 0.16


def sample(cx, width=0.05, ts=10.0):
    return MarkerSample(ts=ts, cx=cx, width=width)


class SteerFunctionTests(unittest.TestCase):
    def test_marker_right_of_centre_yaws_right_and_left_yaws_left(self):
        yaw_right, _ = steer([sample(0.6)], (), 10.0, ARRIVE)
        yaw_left, _ = steer([sample(0.4)], (), 10.0, ARRIVE)
        self.assertGreater(yaw_right, 0.0)
        self.assertLess(yaw_left, 0.0)
        self.assertAlmostEqual(yaw_right, -yaw_left)

    def test_deadband_gives_zero_yaw_near_centre(self):
        cfg = SteeringConfig()
        yaw, pitch = steer([sample(0.5 + cfg.yaw_deadband * 0.9)], (), 10.0, ARRIVE, cfg)
        self.assertEqual(yaw, 0.0)
        self.assertGreater(pitch, 0.0)

    def test_yaw_is_capped(self):
        cfg = SteeringConfig()
        yaw, _ = steer([sample(0.95)], (), 10.0, ARRIVE, cfg)
        self.assertAlmostEqual(yaw, cfg.yaw_max)
        yaw, _ = steer([sample(0.05)], (), 10.0, ARRIVE, cfg)
        self.assertAlmostEqual(yaw, -cfg.yaw_max)

    def test_forward_only_when_marker_is_within_the_window(self):
        cfg = SteeringConfig()
        _, inside = steer([sample(0.5 + cfg.forward_window - 0.01)], (), 10.0, ARRIVE, cfg)
        _, outside = steer([sample(0.5 + cfg.forward_window + 0.01)], (), 10.0, ARRIVE, cfg)
        self.assertGreater(inside, 0.0)
        self.assertEqual(outside, 0.0)

    def test_forward_is_capped_and_tapers_toward_arrival(self):
        cfg = SteeringConfig()
        self.assertAlmostEqual(forward_for_width(0.02, ARRIVE, cfg), cfg.forward_max)
        self.assertAlmostEqual(forward_for_width(ARRIVE, ARRIVE, cfg), cfg.forward_near)
        self.assertAlmostEqual(forward_for_width(ARRIVE * 2, ARRIVE, cfg), cfg.forward_near)
        widths = [0.02 + i * 0.005 for i in range(40)]
        values = [forward_for_width(w, ARRIVE, cfg) for w in widths]
        self.assertTrue(all(a >= b for a, b in zip(values, values[1:])))
        self.assertLessEqual(max(values), 0.22 + 1e-9)
        self.assertGreaterEqual(min(values), 0.10 - 1e-9)

    def test_spec_defaults(self):
        cfg = SteeringConfig()
        self.assertEqual(cfg.latency_s, 0.45)
        self.assertEqual(cfg.forward_window, 0.15)
        self.assertEqual(cfg.forward_max, 0.22)
        self.assertEqual(cfg.forward_near, 0.10)
        self.assertEqual(cfg.rise_per_s, 1.0)
        self.assertEqual(cfg.search_yaw, 0.12)

    def test_pending_yaw_integrates_piecewise_constant_commands(self):
        log = ((9.0, 0.1), (9.5, 0.2), (9.8, 0.0))
        self.assertAlmostEqual(pending_yaw(log, 9.0, 10.0), 0.1 * 0.5 + 0.2 * 0.3)
        self.assertAlmostEqual(pending_yaw(log, 9.6, 10.0), 0.2 * 0.2)
        self.assertAlmostEqual(pending_yaw(log, 8.0, 9.25), 0.1 * 0.25)
        self.assertEqual(pending_yaw((), 9.0, 10.0), 0.0)

    def test_latency_compensation_does_not_steer_on_the_stale_position_alone(self):
        cfg = SteeringConfig()
        history = [sample(0.70, ts=10.0)]
        stale_only, _ = steer(history, (), 10.0, ARRIVE, cfg)
        # A right yaw of 0.1 has been held for the whole latency window: its effect is not visible yet.
        log = ((9.0, 0.1),)
        compensated, _ = steer(history, log, 10.0, ARRIVE, cfg)
        expected_cx = 0.70 - cfg.yaw_rate_fw_per_s * 0.1 * cfg.latency_s
        self.assertAlmostEqual(predict_cx(history, log, 10.0, cfg), expected_cx)
        self.assertLess(compensated, stale_only)
        self.assertAlmostEqual(compensated, cfg.yaw_gain * (expected_cx - 0.5))

    def test_compensation_also_covers_the_age_of_the_observation(self):
        cfg = SteeringConfig()
        history = [sample(0.60, ts=10.0)]
        log = ((9.0, 0.1),)
        self.assertAlmostEqual(
            predict_cx(history, log, 10.2, cfg), 0.60 - cfg.yaw_rate_fw_per_s * 0.1 * (cfg.latency_s + 0.2)
        )

    def test_predicted_overshoot_stops_forward_motion(self):
        cfg = SteeringConfig()
        # The marker still looks centred, but a large yaw is already on its way.
        _, pitch = steer([sample(0.5, ts=10.0)], ((9.0, 0.25),), 10.0, ARRIVE, cfg)
        self.assertEqual(pitch, 0.0)

    def test_steer_is_pure(self):
        history = [sample(0.42, ts=9.9), sample(0.44, ts=10.0)]
        log = ((9.7, -0.05), (9.9, -0.03))
        first = steer(history, log, 10.05, ARRIVE)
        second = steer(history, log, 10.05, ARRIVE)
        self.assertEqual(first, second)
        self.assertEqual(history, [sample(0.42, ts=9.9), sample(0.44, ts=10.0)])
        self.assertEqual(steer([], (), 10.0, ARRIVE), (0.0, 0.0))


class RiseLimitTests(unittest.TestCase):
    def test_rise_is_limited_to_one_per_second(self):
        self.assertAlmostEqual(limit_rise(0.0, 0.22, 0.05, 1.0), 0.05)
        self.assertAlmostEqual(limit_rise(0.05, 0.22, 0.05, 1.0), 0.10)
        self.assertAlmostEqual(limit_rise(0.20, 0.22, 0.05, 1.0), 0.22)
        self.assertAlmostEqual(limit_rise(0.0, -0.22, 0.05, 1.0), -0.05)

    def test_reductions_are_immediate(self):
        self.assertEqual(limit_rise(0.22, 0.0, 0.05, 1.0), 0.0)
        self.assertEqual(limit_rise(0.22, 0.10, 0.05, 1.0), 0.10)
        self.assertEqual(limit_rise(-0.2, -0.05, 0.0, 1.0), -0.05)

    def test_sign_change_passes_through_zero(self):
        self.assertAlmostEqual(limit_rise(0.2, -0.2, 0.05, 1.0), -0.05)

    def test_steering_object_ramps_forward_and_drops_at_once(self):
        steering = Steering()
        now = 100.0
        outputs = []
        for i in range(12):
            outputs.append(steering.update([sample(0.5, ts=now)], now, ARRIVE))
            now += 0.05
        pitches = [p for _yaw, p in outputs]
        self.assertEqual(pitches[0], 0.0)
        for a, b in zip(pitches, pitches[1:]):
            self.assertLessEqual(b - a, 0.05 + 1e-9)
        self.assertAlmostEqual(pitches[-1], 0.22)
        _yaw, pitch = steering.update([sample(0.9, ts=now)], now, ARRIVE)
        self.assertEqual(pitch, 0.0)

    def test_search_and_creep_rates(self):
        steering = Steering()
        now = 5.0
        for _ in range(10):
            yaw, pitch = steering.search(now)
            now += 0.05
        self.assertAlmostEqual(yaw, 0.12)
        self.assertEqual(pitch, 0.0)
        steering.reset()
        for _ in range(10):
            yaw, pitch = steering.search(now, direction=-1.0, creep=True)
            now += 0.05
        self.assertAlmostEqual(yaw, -steering.cfg.creep_yaw)
        self.assertEqual(steering.neutral(now), (0.0, 0.0))

    def test_steering_object_uses_its_own_command_log(self):
        steering = Steering()
        now = 50.0
        yaws = []
        for _ in range(20):                       # the picture never changes: the marker stays at 0.6
            yaw, _ = steering.update([sample(0.6, ts=now)], now, ARRIVE)
            yaws.append(yaw)
            now += 0.05
        # Without compensation the command would sit at gain * 0.1; with it the command backs off
        # as the already-sent yaw accumulates in the latency window.
        self.assertLess(yaws[-1], steering.cfg.yaw_gain * 0.1 - 0.01)
        self.assertGreater(yaws[-1], 0.0)


    def test_yaw_seen_between_is_the_command_integral_one_latency_earlier(self):
        steering = Steering()
        for step in range(40):                    # 2 s of commands every 0.05 s: 0.1 for the first second
            steering.shape(0.1 if step < 20 else 0.0, 0.0, 50.0 + 0.05 * step)
        latency = steering.cfg.latency_s
        self.assertAlmostEqual(steering.yaw_seen_between(50.5 + latency, 50.9 + latency), 0.1 * 0.4, places=3)
        self.assertAlmostEqual(steering.yaw_seen_between(51.2 + latency, 51.6 + latency), 0.0, places=6)


DT = 1.0 / 15.0
SIZE = 0.06            # marker size as a fraction of the frame width (about 2 m away)
MARKER_M = 0.18


class DriftAssistTests(unittest.TestCase):
    """The assist alone, against a one-line model of the drone: it slides at `drift` m/s plus
    `authority` m/s per unit of roll, and the pursuit holds the marker in the middle (so every bit
    of slide shows up as yaw, exactly as `Steering.yaw_seen_between` would report it)."""

    def fly(self, assist, seconds, drift=0.08, authority=1.0, start=100.0, forward=True, skew=0.0):
        now, rolls = start, []
        roll = assist.roll
        for _ in range(int(seconds / DT)):
            now += DT
            sliding_right = drift + authority * roll                 # m/s
            slide = -sliding_right / MARKER_M * DT                   # marker-widths this frame, + = left
            yaw_seen = slide * SIZE / assist.yaw_rate                # the yaw that kept the marker centred
            roll = assist.update(now, 0.5, SIZE, 1.0, skew, yaw_seen, forward)
            rolls.append(roll)
        return rolls, now

    def test_spec_bound_and_default_gain(self):
        cfg = DriftAssistConfig()
        self.assertEqual(cfg.roll_max, 0.15)
        self.assertEqual(DriftAssist().roll, 0.0)

    def test_drift_to_the_right_gets_roll_to_the_left_that_cancels_it(self):
        assist = DriftAssist()
        rolls, _ = self.fly(assist, 12.0, drift=0.08)
        self.assertTrue(assist.active)
        self.assertAlmostEqual(rolls[-1], -0.08, delta=0.01)
        self.assertIsNone(assist.disabled_reason)
        left, _ = self.fly(DriftAssist(), 12.0, drift=-0.05)
        self.assertAlmostEqual(left[-1], 0.05, delta=0.01)

    def test_no_drift_no_roll(self):
        rolls, _ = self.fly(DriftAssist(), 6.0, drift=0.0)
        self.assertEqual(max(abs(r) for r in rolls), 0.0)

    def test_roll_never_leaves_the_bound_and_does_not_wind_up(self):
        assist = DriftAssist()
        rolls, now = self.fly(assist, 10.0, drift=0.40)             # far more than 0.15 of roll can cancel
        self.assertLessEqual(max(abs(r) for r in rolls), 0.15 + 1e-12)
        self.assertAlmostEqual(rolls[-1], -0.15)
        self.assertIsNone(assist.disabled_reason, "full roll the right way still slows the slide")
        # the drift goes away: the estimate must come off the bound at once, not after "unwinding"
        after, _ = self.fly(assist, 0.5, drift=0.0, start=now)
        self.assertGreater(after[2], -0.15 + 1e-6)
        self.assertGreater(after[-1], after[2])

    def test_roll_rises_at_most_one_per_second(self):
        rolls, _ = self.fly(DriftAssist(), 6.0, drift=0.40)
        steps = [abs(b) - abs(a) for a, b in zip(rolls, rolls[1:])]
        self.assertLessEqual(max(steps), 1.0 * DT + 1e-9)

    def test_stays_out_during_the_first_turn_toward_the_marker(self):
        assist = DriftAssist()
        now = 100.0
        for step in range(30):                                       # 2 s of hard yaw, marker far off centre
            now += DT
            cx = 0.2 + 0.01 * step
            roll = assist.update(now, cx, SIZE, 1.0, 0.0, -0.25 * DT, False)
            self.assertEqual(roll, 0.0)
            self.assertFalse(assist.active)
        for step in range(4):                                        # centred and quiet, but not for 0.4 s yet
            now += DT
            self.assertEqual(assist.update(now, 0.5, SIZE, 1.0, 0.0, 0.0, True), 0.0)
        self.assertFalse(assist.active)
        for step in range(4):
            now += DT
            assist.update(now, 0.5, SIZE, 1.0, 0.0, 0.0, True)
        self.assertTrue(assist.active)

    def test_a_large_yaw_in_the_video_keeps_it_out_even_when_flying_forward(self):
        assist = DriftAssist()
        now = 100.0
        for _ in range(30):
            now += DT
            assist.update(now, 0.5, SIZE, 1.0, 0.0, 0.2 * DT, True)     # 0.2 stick of yaw still showing
        self.assertFalse(assist.active)
        self.assertEqual(assist.roll, 0.0)

    def test_it_measures_how_far_the_picture_moves_per_unit_of_yaw(self):
        assist = DriftAssist(assumed_yaw_rate=2.5)
        self.assertFalse(assist.calibrated)
        self.assertEqual(assist.yaw_rate, 2.5)
        now, cx = 100.0, 0.2
        for _ in range(15):                                          # yawing right at 0.2: the marker moves left
            now += DT
            cx -= 1.6 * 0.2 * DT                                     # this drone: 1.6 frame-widths/s at full stick
            assist.update(now, cx, SIZE, 1.0, 0.0, 0.2 * DT, False)
        self.assertTrue(assist.calibrated)
        self.assertAlmostEqual(assist.yaw_rate, 1.6, places=2)

    def test_pause_sends_nothing_and_has_to_qualify_again_but_keeps_the_estimate(self):
        assist = DriftAssist()
        rolls, now = self.fly(assist, 8.0, drift=0.08)
        self.assertLess(rolls[-1], -0.06)
        self.assertEqual(assist.pause(), 0.0)
        self.assertEqual(assist.roll, 0.0)
        self.assertFalse(assist.active)
        again, _ = self.fly(assist, 1.0, drift=0.08, start=now + 1.0)
        self.assertEqual(again[0], 0.0)
        self.assertEqual(again[4], 0.0, "not before it has qualified again")
        self.assertLess(again[-1], -0.06, "the estimate was kept")

    def test_not_flying_forward_sends_nothing(self):
        assist = DriftAssist()
        rolls, now = self.fly(assist, 8.0, drift=0.08)
        self.assertLess(rolls[-1], -0.06)
        stopped, _ = self.fly(assist, 0.3, drift=0.08, start=now, forward=False)
        self.assertEqual(stopped[-1], 0.0)
        self.assertFalse(assist.active)

    def test_wrong_roll_sign_switches_it_off_for_the_rest_of_the_run(self):
        for drift in (0.08, 0.20, -0.08):
            assist = DriftAssist()
            rolls, now = self.fly(assist, 10.0, drift=drift, authority=-1.0)   # roll pushes the other way
            with self.subTest(drift=drift):
                self.assertEqual(assist.disabled_reason, "off_axis_worsening")
                self.assertEqual(assist.disabled_by, "slide")
                self.assertLessEqual(max(abs(r) for r in rolls), 0.15 + 1e-12)
                self.assertEqual(rolls[-1], 0.0)
                self.assertFalse(assist.active)
                self.assertIsNone(assist.mean_roll_near_end())
                more, _ = self.fly(assist, 3.0, drift=drift, authority=-1.0, start=now)
                self.assertEqual(set(more), {0.0}, "off for the rest of the run")
                assist.reset()
                self.assertIsNone(assist.disabled_reason, "a new run starts with the assist available again")

    def test_marker_seen_far_off_axis_while_pushing_switches_it_off(self):
        assist = DriftAssist()
        self.fly(assist, 6.0, drift=0.08)
        now = 200.0
        for _ in range(60):                                          # the marker's width/height sinks to 0.6
            now += DT
            assist.update(now, 0.5, SIZE, 0.6, 0.0, -0.002, True)
        self.assertEqual((assist.disabled_reason, assist.disabled_by), ("off_axis_worsening", "aspect"))
        self.assertEqual(assist.roll, 0.0)

    def test_mean_roll_near_the_end_needs_some_assist_time(self):
        assist = DriftAssist()
        self.assertIsNone(assist.mean_roll_near_end())
        self.fly(assist, 0.8, drift=0.08)
        self.assertIsNone(assist.mean_roll_near_end())
        self.fly(assist, 12.0, drift=0.08, start=101.0)
        self.assertAlmostEqual(assist.mean_roll_near_end(), -0.08, delta=0.01)

    def test_off_axis_to_the_right_adds_roll_to_the_left_when_the_marker_is_large_enough(self):
        near, far = DriftAssist(), DriftAssist()
        now = 100.0
        for _ in range(45):                                          # no slide at all, right edge taller
            now += DT
            near.update(now, 0.5, 0.12, 1.0, 0.012, 0.0, True)
            far.update(now, 0.5, 0.05, 1.0, 0.005, 0.0, True)
        self.assertLess(near.roll, -0.01)
        self.assertEqual(far.roll, 0.0, "the edge heights are not trusted while the marker is small")

    def test_marker_skew_sign(self):
        square = ((0, 0), (10, 0), (10, 10), (0, 10))
        right_taller = ((0, 1), (10, 0), (10, 10), (0, 9))
        self.assertEqual(marker_skew(square), 0.0)
        self.assertGreater(marker_skew(right_taller), 0.0)
        left_taller = ((0, 0), (10, 1), (10, 9), (0, 10))
        self.assertAlmostEqual(marker_skew(left_taller), -marker_skew(right_taller))


if __name__ == "__main__":
    unittest.main()
