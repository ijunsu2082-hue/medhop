import math
import time
import unittest

from medhop.drone.base import clamp
from medhop.mixer import (
    DRONE_LINK_DOWN, ESTOP_ACTIVE, LANDING_GUARD_S, LANDING_IN_PROGRESS, MISSION_TOGGLE_PILOT_QUIET_S,
    TOGGLE_GUARD, ControlMixer,
)
from tests.harness import FakeClock, RecordingLink


class MixerTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(100.0)
        self.link = RecordingLink()
        self.events = []
        self.mixer = ControlMixer(self.link, rate_hz=20.0, clock=self.clock,
                                  on_pilot_input=self.events.append)
        self.link.new_frame(self.clock.t)

    def tick(self, dt=0.05, fresh_frame=True):
        self.clock.advance(dt)
        if fresh_frame:
            self.link.new_frame(self.clock.t)
        return self.mixer.tick()

    def assertAxes(self, actual, expected):
        for a, e in zip(actual, expected):
            self.assertAlmostEqual(a, e, places=6)


class PriorityTests(MixerTestCase):
    def test_neutral_when_nothing_is_commanded(self):
        self.assertAxes(self.tick(), (0, 0, 0, 0))
        self.assertEqual(self.link.last, (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(self.mixer.snapshot().source, "neutral")

    def test_mission_command_passes_yaw_and_pitch_only(self):
        self.mixer.mission_command(0.12, 0.22)
        self.assertAxes(self.tick(), (0.0, 0.12, 0.22, 0.0))
        self.assertEqual(self.mixer.snapshot().source, "mission")

    def test_mission_command_may_carry_a_small_roll_but_never_throttle(self):
        self.mixer.mission_command(0.12, 0.22, roll=-0.08)
        self.assertAxes(self.tick(), (0.0, 0.12, 0.22, -0.08))
        self.assertEqual(self.mixer.snapshot().source, "mission")
        with self.assertRaises(TypeError):
            self.mixer.mission_command(0.0, 0.0, throttle=0.2)      # there is no such argument

    def test_mission_roll_is_clamped_to_0_15_whatever_is_asked_for(self):
        for asked, sent in ((0.5, 0.15), (-1.0, -0.15), (0.15, 0.15), (float("nan"), 0.0), (float("inf"), 0.0)):
            self.mixer.mission_command(0.0, 0.1, roll=asked)
            self.assertAxes(self.tick(), (0.0, 0.0, 0.1, sent))

    def test_mission_roll_adds_to_trim_and_goes_with_the_command(self):
        self.mixer.set_trim(0.05, 0.0)
        self.mixer.mission_command(0.0, 0.2, roll=-0.15)
        self.assertAxes(self.tick(), (0.0, 0.0, 0.2, -0.10))
        self.mixer.clear_mission_command()
        self.assertAxes(self.tick(), (0.0, 0.0, 0.0, 0.05))          # back to trim alone
        self.mixer.mission_command(0.0, 0.2, roll=-0.15)
        self.assertAxes(self.tick(0.45), (0.0, 0.0, 0.2, -0.10))
        self.assertAxes(self.tick(0.10), (0.0, 0.0, 0.0, 0.05))      # a stale command loses its roll too

    def test_mission_roll_is_dropped_by_pilot_input_estop_and_stale_video(self):
        self.mixer.mission_command(0.0, 0.2, roll=0.1)
        self.assertAxes(self.tick(), (0.0, 0.0, 0.2, 0.1))
        self.assertAxes(self.tick(0.3, fresh_frame=False), (0.0, 0.0, 0.2, 0.1))
        self.assertAxes(self.tick(0.25, fresh_frame=False), (0, 0, 0, 0))   # frame now 0.55 s old
        self.mixer.mission_command(0.0, 0.2, roll=0.1)
        self.mixer.pilot_axes(0.0, 0.0, 0.0, -1.0)
        self.assertLess(self.tick()[3], 0.0)                          # the pilot's roll, not the mission's
        self.mixer.pilot_disconnect()
        self.mixer.mission_command(0.0, 0.2, roll=0.1)
        self.mixer.pilot_estop()
        self.assertAxes(self.tick(), (0, 0, 0, 0))

    def test_mission_command_older_than_half_a_second_is_ignored(self):
        self.mixer.mission_command(0.12, 0.22)
        self.assertAxes(self.tick(0.45), (0.0, 0.12, 0.22, 0.0))
        self.assertAxes(self.tick(0.10), (0, 0, 0, 0))

    def test_pilot_beats_mission(self):
        self.mixer.mission_command(0.12, 0.22)
        self.mixer.pilot_axes(0.0, 0.0, -1.0, 0.0)
        for _ in range(10):
            self.mixer.pilot_axes(0.0, 0.0, -1.0, 0.0)
            axes = self.tick()
        self.assertAxes(axes, (0.0, 0.0, -0.5, 0.0))
        self.assertEqual(self.mixer.snapshot().source, "pilot")
        self.assertTrue(self.mixer.snapshot().manual_active)

    def test_pilot_axes_are_scaled_by_max_stick(self):
        self.mixer.set_max_stick(0.3)
        for _ in range(10):
            self.mixer.pilot_axes(1.0, -1.0, 0.5, 0.2)
            axes = self.tick()
        self.assertAxes(axes, (0.3, -0.3, 0.15, 0.06))

    def test_pilot_is_active_for_0_4_s_after_the_last_non_zero_message(self):
        self.mixer.pilot_axes(0.0, 1.0, 0.0, 0.0)
        self.tick(0.05)
        self.assertTrue(self.mixer.snapshot().manual_active)
        self.tick(0.30)
        self.assertTrue(self.mixer.snapshot().manual_active)
        axes = self.tick(0.10)          # 0.45 s after the message: the deadman has expired
        self.assertFalse(self.mixer.snapshot().manual_active)
        self.assertAxes(axes, (0, 0, 0, 0))

    def test_zero_axes_message_does_not_make_the_pilot_active(self):
        self.mixer.pilot_axes(0.0, 0.0, 0.0, 0.0)
        self.assertEqual(self.events, [])
        self.assertFalse(self.mixer.snapshot().manual_active)
        self.mixer.mission_command(0.1, 0.2)
        self.assertAxes(self.tick(), (0.0, 0.1, 0.2, 0.0))

    def test_mission_resumes_only_with_a_new_command_after_pilot_input(self):
        self.mixer.mission_command(0.12, 0.22)
        self.mixer.pilot_axes(0.0, 0.5, 0.0, 0.0)      # clears the mission command
        self.tick(0.5)
        self.assertAxes(self.tick(), (0, 0, 0, 0))


class RampTests(MixerTestCase):
    def test_pilot_axes_ramp_at_four_per_second(self):
        self.mixer.set_max_stick(1.0)
        self.tick()
        seen = []
        for _ in range(6):
            self.mixer.pilot_axes(0.0, 0.0, 1.0, 0.0)
            seen.append(self.tick(0.05)[2])
        for value, expected in zip(seen, (0.2, 0.4, 0.6, 0.8, 1.0, 1.0)):
            self.assertAlmostEqual(value, expected, places=6)

    def test_release_ramps_down_at_four_per_second(self):
        self.mixer.set_max_stick(1.0)
        for _ in range(6):
            self.mixer.pilot_axes(0.0, 0.0, 1.0, 0.0)
            self.tick(0.05)
        self.mixer.pilot_axes(0.0, 0.0, 0.0, 0.0)
        self.assertAlmostEqual(self.tick(0.05)[2], 0.8, places=6)
        self.assertAlmostEqual(self.tick(0.05)[2], 0.6, places=6)

    def test_pilot_disconnect_zeroes_at_once(self):
        self.mixer.set_max_stick(1.0)
        for _ in range(6):
            self.mixer.pilot_axes(1.0, 1.0, 1.0, 1.0)
            self.tick(0.05)
        self.mixer.pilot_disconnect()
        self.assertAxes(self.tick(0.05), (0, 0, 0, 0))
        self.assertFalse(self.mixer.snapshot().manual_active)


class TrimTests(MixerTestCase):
    def test_trim_is_added_to_neutral_mission_and_pilot(self):
        self.mixer.set_trim(0.05, -0.02)
        self.assertAxes(self.tick(), (0.0, 0.0, -0.02, 0.05))
        self.mixer.mission_command(0.1, 0.2)
        self.assertAxes(self.tick(), (0.0, 0.1, 0.18, 0.05))
        self.mixer.set_max_stick(1.0)
        for _ in range(8):
            self.mixer.pilot_axes(0.0, 0.0, 1.0, -1.0)
            axes = self.tick()
        self.assertAxes(axes, (0.0, 0.0, 0.98, -0.95))

    def test_trim_is_limited_to_0_3_and_result_is_clamped(self):
        self.assertEqual(self.mixer.set_trim(0.9, -0.9), (0.3, -0.3))
        self.mixer.set_max_stick(1.0)
        for _ in range(8):
            self.mixer.pilot_axes(0.0, 0.0, -1.0, 1.0)
            axes = self.tick()
        self.assertAxes(axes, (0.0, 0.0, -1.0, 1.0))

    def test_non_finite_values_are_rejected(self):
        with self.assertRaises(ValueError):
            self.mixer.set_trim(math.nan, 0.0)
        with self.assertRaises(ValueError):
            self.mixer.pilot_axes(0.0, math.inf, 0.0, 0.0)
        with self.assertRaises(ValueError):
            self.mixer.set_max_stick(0.1)
        with self.assertRaises(ValueError):
            self.mixer.set_max_stick(1.5)


class VideoFailsafeTests(MixerTestCase):
    def test_mission_axes_go_neutral_when_the_frame_is_older_than_half_a_second(self):
        frame_at = self.clock.t
        for _ in range(9):                      # 0.45 s without a new frame: still live
            self.mixer.mission_command(0.12, 0.22)
            axes = self.tick(0.05, fresh_frame=False)
        self.assertAxes(axes, (0.0, 0.12, 0.22, 0.0))
        for _ in range(2):                      # 0.55 s: stale, although the command is fresh
            self.mixer.mission_command(0.12, 0.22)
            axes = self.tick(0.05, fresh_frame=False)
        self.assertGreater(self.clock.t - frame_at, 0.5)
        self.assertAxes(axes, (0, 0, 0, 0))

    def test_stale_video_keeps_trim(self):
        self.mixer.set_trim(0.04, 0.01)
        self.mixer.mission_command(0.12, 0.22)
        self.assertAxes(self.tick(0.6, fresh_frame=False), (0.0, 0.0, 0.01, 0.04))

    def test_no_frame_at_all_blocks_mission_axes(self):
        self.link.frame = None
        self.mixer.mission_command(0.12, 0.22)
        self.assertAxes(self.tick(fresh_frame=False), (0, 0, 0, 0))

    def test_pilot_axes_still_pass_with_stale_video(self):
        self.mixer.set_max_stick(1.0)
        for _ in range(20):
            self.mixer.pilot_axes(0.0, 0.0, 1.0, 0.0)
            axes = self.tick(0.05, fresh_frame=False)
        self.assertAxes(axes, (0.0, 0.0, 1.0, 0.0))


class EstopAndToggleTests(MixerTestCase):
    def test_estop_sends_motor_cut_on_every_tick_then_neutral_without_trim(self):
        # Revision 3: the cut is asserted on every tick while latched (was: once).
        self.mixer.set_trim(0.05, 0.05)
        self.mixer.mission_command(0.12, 0.22)
        self.assertIs(self.mixer.pilot_estop(), True)
        self.assertEqual(self.link.estops, 1)
        self.assertEqual(self.link.last, (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(self.events, ["estop"])
        for i in range(40):
            self.mixer.mission_command(0.12, 0.22)
            self.mixer.pilot_axes(1.0, 1.0, 1.0, 1.0)
            self.assertEqual(self.tick(), (0.0, 0.0, 0.0, 0.0))
            self.assertEqual(self.link.estops, 2 + i)      # asserted again before each neutral
        self.assertTrue(self.mixer.snapshot().estop_active)
        self.assertEqual(self.mixer.snapshot().source, "estop")
        self.mixer.estop_reset()
        self.tick()
        self.assertEqual(self.link.estops, 41, "not asserted after reset")

    def test_estop_reset_restores_normal_mixing(self):
        self.mixer.set_trim(0.05, 0.0)
        self.mixer.pilot_estop()
        self.tick()
        self.mixer.estop_reset()
        self.assertFalse(self.mixer.estop_active)
        self.assertAxes(self.tick(), (0.0, 0.0, 0.0, 0.05))

    def test_pilot_toggle_calls_the_link_once_and_notifies(self):
        ok, why = self.mixer.pilot_toggle()
        self.assertTrue(ok, why)
        self.assertEqual(self.link.toggles, 1)
        self.assertEqual(self.events, ["toggle"])

    def test_toggle_is_refused_while_estop_is_active(self):
        self.mixer.pilot_estop()
        result = self.mixer.pilot_toggle()
        ok, why = result
        self.assertFalse(ok)
        self.assertIn("emergency stop", why)
        self.assertEqual(result.code, ESTOP_ACTIVE)
        self.assertFalse(self.mixer.mission_toggle())
        self.assertEqual(self.link.toggles, 0)

    def test_a_second_toggle_within_a_second_is_ignored(self):
        # Revision 3: this used a mission toggle first; that is now covered by the 4 s landing guard
        # (LandingGuardTests), so the 1 s guard is shown with two pilot toggles.
        self.assertTrue(self.mixer.pilot_toggle()[0])
        self.clock.advance(0.5)
        result = self.mixer.pilot_toggle()
        self.assertFalse(result[0])
        self.assertEqual(result.code, TOGGLE_GUARD)
        self.assertEqual(self.link.toggles, 1)
        self.clock.advance(0.6)
        ok, _why = self.mixer.pilot_toggle()
        self.assertTrue(ok)
        self.assertEqual(self.link.toggles, 2)
        self.clock.advance(0.5)
        self.assertFalse(self.mixer.mission_toggle())         # the guard covers the mission too
        self.assertEqual(self.link.toggles, 2)

    def test_non_zero_axes_notify_as_pilot_input(self):
        self.mixer.pilot_axes(0.0, 0.0, 0.3, 0.0)
        self.assertEqual(self.events, ["axes"])

    def test_calibrate_passes_through_unless_estopped(self):
        self.assertEqual(self.mixer.calibrate(), (True, ""))
        self.assertEqual(self.link.calibrations, 1)
        self.mixer.pilot_estop()
        self.assertFalse(self.mixer.calibrate()[0])
        self.assertEqual(self.link.calibrations, 1)


class LandingGuardTests(MixerTestCase):
    def test_pilot_toggle_is_refused_for_4_s_after_a_mission_toggle(self):
        self.assertEqual(LANDING_GUARD_S, 4.0)
        self.assertTrue(self.mixer.mission_toggle())
        self.clock.advance(1.5)
        result = self.mixer.pilot_toggle()
        self.assertEqual(tuple(result)[0], False)
        self.assertEqual(result.code, LANDING_IN_PROGRESS)
        self.assertIn("landing in progress", result.message)
        self.clock.advance(2.4)                              # t + 3.9 s: still refused
        self.assertEqual(self.mixer.pilot_toggle().code, LANDING_IN_PROGRESS)
        self.assertEqual(self.link.toggles, 1)
        self.clock.advance(0.2)                              # t + 4.1 s
        self.assertEqual(self.mixer.pilot_toggle(), (True, ""))
        self.assertEqual(self.link.toggles, 2)

    def test_a_refused_mission_toggle_does_not_start_the_landing_guard(self):
        self.link.control = False
        self.assertFalse(self.mixer.mission_toggle())
        self.assertEqual(self.link.toggles, 0)
        self.link.control = True
        self.clock.advance(1.1)
        self.assertEqual(self.mixer.pilot_toggle(), (True, ""))


class DroneLinkDownTests(MixerTestCase):
    def test_pilot_toggle_is_refused_while_control_is_down(self):
        self.link.control = False
        result = self.mixer.pilot_toggle()
        self.assertFalse(result.ok)
        self.assertEqual(result.code, DRONE_LINK_DOWN)
        self.assertIn("NOT sent", result.message)
        self.assertEqual(self.link.toggles, 0, "the link is not even asked")
        self.assertEqual(self.events, ["toggle"], "still pilot input: a run is aborted")
        self.link.control = True
        self.assertEqual(self.mixer.pilot_toggle(), (True, ""))   # no guard left behind by the refusal
        self.assertEqual(self.link.toggles, 1)

    def test_estop_pressed_while_control_is_down_is_sent_when_the_link_returns(self):
        self.link.control = False
        self.assertIs(self.mixer.pilot_estop(), False)
        for _ in range(20):                                  # 1 s of blackout: asserted every tick
            self.assertEqual(self.tick(), (0, 0, 0, 0))
        self.assertEqual(self.link.estop_results, [False] * 21)
        self.assertFalse(self.mixer.snapshot().estop_confirmed)
        self.link.control = True
        self.tick()
        self.assertIs(self.link.estop_results[-1], True, "the cut goes out on the first tick back")
        self.assertFalse(self.mixer.snapshot().estop_confirmed)
        for _ in range(9):
            self.tick()
        self.assertFalse(self.mixer.snapshot().estop_confirmed)   # 0.45 s of open-socket time
        self.tick()
        self.assertTrue(self.mixer.snapshot().estop_confirmed)    # 0.50 s

    def test_estop_confirmed_after_half_a_second_on_an_open_socket_and_reset_clears_it(self):
        self.assertIs(self.mixer.pilot_estop(), True)
        self.assertFalse(self.mixer.snapshot().estop_confirmed)
        for _ in range(9):
            self.tick()
        self.assertFalse(self.mixer.snapshot().estop_confirmed)   # 0.45 s
        self.tick()
        self.assertTrue(self.mixer.snapshot().estop_confirmed)    # 0.50 s
        self.mixer.estop_reset()
        self.assertFalse(self.mixer.snapshot().estop_confirmed)
        self.assertIs(self.mixer.pilot_estop(), True)             # a new latch starts from zero
        self.tick()
        self.assertFalse(self.mixer.snapshot().estop_confirmed)

    def test_a_socket_drop_in_the_middle_does_not_count(self):
        self.mixer.pilot_estop()
        for _ in range(6):
            self.tick()                                      # 0.30 s credited
        self.link.control = False
        for _ in range(10):
            self.tick()                                      # nothing credited
        self.link.control = True
        for _ in range(4):
            self.tick()                                      # first tick back starts a new interval
        self.assertFalse(self.mixer.snapshot().estop_confirmed)   # 0.30 + 0.15
        self.tick()
        self.assertTrue(self.mixer.snapshot().estop_confirmed)    # 0.50


class SticksBlockedTests(MixerTestCase):
    def hold_pilot(self, ticks, fresh_frame):
        axes = None
        for _ in range(ticks):
            self.mixer.pilot_axes(0.0, 0.0, 1.0, 0.0)
            axes = self.tick(0.05, fresh_frame=fresh_frame)
        return axes

    def test_real_mode_pilot_axes_become_neutral_once_video_is_older_than_3_s(self):
        self.link.mode = "real"
        self.mixer.set_max_stick(1.0)
        self.mixer.set_trim(0.04, 0.01)
        self.assertAxes(self.hold_pilot(10, True), (0.0, 0.0, 1.0, 0.04))
        frame_at = self.clock.t
        self.assertAxes(self.hold_pilot(59, False), (0.0, 0.0, 1.0, 0.04))   # 2.95 s old: still passes
        self.assertFalse(self.mixer.snapshot().sticks_blocked)
        axes = self.hold_pilot(2, False)                                     # 3.05 s old
        self.assertGreater(self.clock.t - frame_at, 3.0)
        self.assertAxes(axes, (0.0, 0.0, 0.01, 0.04))     # neutral plus trim, like any neutral
        self.assertTrue(self.mixer.snapshot().sticks_blocked)
        self.assertTrue(self.mixer.snapshot().manual_active)
        # e-stop and the toggle stay available
        self.assertEqual(self.mixer.pilot_toggle(), (True, ""))
        self.assertIs(self.mixer.pilot_estop(), True)
        self.mixer.estop_reset()
        # video returns: unblocked, and the stick ramps up again from zero
        self.mixer.pilot_axes(0.0, 0.0, 1.0, 0.0)
        axes = self.tick(0.05, fresh_frame=True)
        self.assertFalse(self.mixer.snapshot().sticks_blocked)
        self.assertAlmostEqual(axes[2], 0.2 + 0.01, places=6)

    def test_real_mode_without_any_frame_blocks_the_sticks(self):
        self.link.mode = "real"
        self.link.frame = None
        self.mixer.set_max_stick(1.0)
        self.assertAxes(self.hold_pilot(5, False), (0, 0, 0, 0))
        self.assertTrue(self.mixer.snapshot().sticks_blocked)

    def test_sim_mode_never_blocks_the_sticks(self):
        self.mixer.set_max_stick(1.0)
        self.assertAxes(self.hold_pilot(100, False), (0.0, 0.0, 1.0, 0.0))   # 5 s without a frame
        self.assertFalse(self.mixer.snapshot().sticks_blocked)


class MissionToggleAfterPilotInputTests(MixerTestCase):
    def test_mission_toggle_is_refused_after_any_pilot_input_since_the_last_command(self):
        for pilot_input in (lambda: self.mixer.pilot_axes(0.0, 0.3, 0.0, 0.0),
                            lambda: self.mixer.pilot_toggle(),
                            lambda: (self.mixer.pilot_estop(), self.mixer.estop_reset())):
            self.clock.advance(5.0)
            self.mixer.mission_command(0.0, 0.0)
            pilot_input()
            toggles = self.link.toggles
            self.clock.advance(1.1)
            self.assertFalse(self.mixer.mission_toggle())
            self.assertEqual(self.link.toggles, toggles)

    def test_mission_toggle_is_refused_within_0_4_s_of_pilot_axes_even_after_a_mission_command(self):
        self.assertEqual(MISSION_TOGGLE_PILOT_QUIET_S, 0.4)
        t = self.clock.t
        self.mixer.pilot_axes(0.0, 0.3, 0.0, 0.0, now=t)
        self.mixer.mission_command(0.0, 0.0, now=t + 0.1)      # the runner's step, after the pilot input
        self.assertFalse(self.mixer.mission_toggle(t + 0.2))
        self.assertEqual(self.link.toggles, 0)
        self.mixer.mission_command(0.0, 0.0, now=t + 0.45)
        self.assertTrue(self.mixer.mission_toggle(t + 0.5))
        self.assertEqual(self.link.toggles, 1)

    def test_mission_toggle_is_refused_within_0_4_s_of_a_pilot_toggle_or_estop(self):
        for pilot_input in (lambda now: self.mixer.pilot_toggle(now),
                            lambda now: (self.mixer.pilot_estop(now), self.mixer.estop_reset())):
            self.clock.advance(5.0)
            t = self.clock.t
            pilot_input(t)
            self.mixer.mission_command(0.0, 0.0, now=t + 0.1)
            toggles = self.link.toggles
            self.assertFalse(self.mixer.mission_toggle(t + 0.2))
            self.assertEqual(self.link.toggles, toggles)

    def test_the_next_mission_command_clears_it_and_zero_axes_do_not_count(self):
        self.mixer.pilot_axes(0.0, 0.3, 0.0, 0.0)
        self.clock.advance(0.5)                          # past the 0.4 s quiet time
        self.mixer.mission_command(0.0, 0.0)
        self.mixer.pilot_axes(0.0, 0.0, 0.0, 0.0)      # a release message is not input
        self.assertTrue(self.mixer.mission_toggle())
        self.assertEqual(self.link.toggles, 1)


class NonFiniteTests(MixerTestCase):
    def test_clamp_turns_non_finite_values_into_zero(self):
        self.assertEqual(clamp(float("nan")), 0.0)
        self.assertEqual(clamp(float("inf")), 0.0)
        self.assertEqual(clamp(float("-inf")), 0.0)
        self.assertEqual(clamp(2.0), 1.0)
        self.assertEqual(clamp(float("nan"), 0.2, 1.0), 0.2)   # still inside the range

    def test_non_finite_mission_yaw_or_pitch_is_rejected(self):
        for yaw, pitch in ((float("nan"), 0.2), (0.1, float("inf")), (float("-inf"), float("nan"))):
            self.mixer.mission_command(0.12, 0.22)
            self.assertAxes(self.tick(), (0.0, 0.12, 0.22, 0.0))
            self.mixer.mission_command(yaw, pitch)       # clears the previous command too
            self.assertAxes(self.tick(), (0, 0, 0, 0))
            self.assertEqual(self.mixer.snapshot().source, "neutral")


class ThreadTests(unittest.TestCase):
    def test_thread_ticks_at_about_the_control_rate_and_stops(self):
        link = RecordingLink()
        mixer = ControlMixer(link, rate_hz=50.0)
        mixer.start()
        time.sleep(0.4)
        mixer.stop()
        count = len(link.axes)
        self.assertGreaterEqual(count, 12)
        self.assertLessEqual(count, 30)
        time.sleep(0.1)
        self.assertEqual(len(link.axes), count)


if __name__ == "__main__":
    unittest.main()
