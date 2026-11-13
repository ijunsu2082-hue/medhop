"""Mission runner unit tests: synthetic observations, fake clock, no threads, no sleeping."""
import json
import shutil
import unittest

from medhop.config import Settings
from medhop.care.store import CareStore
from medhop.drone.base import Telemetry
from medhop.mission.runner import ABORT_REASONS, MissionRunner, RunnerConfig, apparent_width
from medhop.mixer import ControlMixer
from medhop.vision.marker import MarkerObs, Observation
from medhop.vision.person import PersonStatus
from tests.harness import FakeClock, RecordingLink, make_temp_dir

DT = 1.0 / 15.0
ARRIVE = 0.16
SETTLE_FRAMES = 20     # past the 1.2 s settle at 15 fps (the toggle goes on the 19th settle frame)


def marker(cx=0.5, width=0.05, aspect=1.0, ts=0.0, cy=0.5):
    """A detection `width` wide and width / aspect tall (aspect < 1: seen from the side)."""
    return MarkerObs(id=7, cx=cx, cy=cy, width=width, corners=((0, 0), (1, 0), (1, 1), (0, 1)), ts=ts,
                     height=width / aspect)


class RunnerTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(500.0)
        self.dir = make_temp_dir()
        self.settings = Settings(data_dir=self.dir, person_check="off", arrive_width=ARRIVE)
        self.link = RecordingLink()
        self.store = CareStore(self.dir, wall_clock=lambda: 1_794_000_000.0 + self.clock.t)
        self.person = PersonStatus()
        self.pilot_window = True                   # a pilot control socket is connected
        self.mixer = ControlMixer(self.link, clock=self.clock)
        self.runner = self.make_runner()
        self.mixer.on_pilot_input = lambda kind: self.runner.abort("estop" if kind == "estop" else "pilot_took_over")
        self.seq = 0
        self.see(marker(width=0.05))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def make_runner(self):
        # Synthetic detections carry placeholder corners, so the camera-geometry line-up is off here
        # (tests/test_alignment.py covers it with real rendered frames).
        return MissionRunner(self.link, self.mixer, self.store, self.settings, clock=self.clock,
                             config=RunnerConfig(align_enabled=False),
                             wall_clock=lambda: 1_794_000_000.0 + self.clock.t,
                             person_status=lambda: self.person,
                             pilot_connected=lambda: self.pilot_window)

    def feed(self, seen=None, dt=DT):
        """Advance one frame period, hand in a frame with (or without) the marker, and tick the mixer."""
        self.clock.advance(dt)
        self.seq += 1
        self.link.new_frame(self.clock.t)
        if seen is not None:
            seen = MarkerObs(id=seen.id, cx=seen.cx, cy=seen.cy, width=seen.width, corners=seen.corners,
                             ts=self.clock.t, height=seen.height)
        self.runner.step(Observation(ts=self.clock.t, seq=self.seq, marker=seen, brightness=100.0), self.clock.t)
        return self.mixer.tick(self.clock.t)

    def see(self, seen, frames=3):
        """The same detection on `frames` frames in a row: enough for the runner to trust it (a start
        then goes straight to approaching, seeded from these detections)."""
        for _ in range(frames):
            axes = self.feed(seen)
        return axes

    def idle(self, seconds, step=0.05):
        """Time passes with no new frames at all."""
        axes = None
        end = self.clock.t + seconds
        while self.clock.t < end - 1e-9:
            self.clock.advance(step)
            self.runner.step(None, self.clock.t)
            axes = self.mixer.tick(self.clock.t)
        return axes

    def start(self, dose_id="d1"):
        ok, blockers = self.runner.start(True, dose_id)
        self.assertTrue(ok, blockers)

    def approach(self, start=0.05, stop=0.2, step=0.004):
        width = start
        while self.runner.state == "approaching" and width < stop:
            self.feed(marker(width=width))
            width += step

    def event_types(self):
        return [e["type"] for e in reversed(self.store.events(50))]

    def assert_aborted(self, reason, toggles=0):
        self.runner.step(None, self.clock.t)       # the vision thread's next step writes the queued events
        self.assertEqual(self.runner.state, "aborted")
        self.assertEqual(self.runner.reason, reason)
        self.assertEqual(self.link.toggles, toggles, "the toggle must never be sent on an abort")
        self.assertEqual(self.event_types()[-1], "run_aborted")
        self.assertEqual(self.store.events(1)[0]["detail"]["reason"], reason)
        self.assertNotIn("arrived_at_station", self.event_types())
        # the mixer falls back to neutral (plus trim, which is zero here) once the pilot window passes
        self.clock.advance(0.5)
        self.link.new_frame(self.clock.t)
        self.assertEqual(self.mixer.tick(self.clock.t), (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(self.runner.snapshot()["command"], {"yaw": 0.0, "pitch": 0.0})


class StartTests(RunnerTestCase):
    def test_start_requires_confirm_airborne(self):
        ok, blockers = self.runner.start(False, "d1")
        self.assertFalse(ok)
        self.assertEqual(blockers, ["confirm_airborne_required"])
        self.assertEqual(self.runner.state, "idle")
        self.assertEqual(self.store.events(), [])

    def test_can_start_and_no_blockers_when_all_is_well(self):
        snap = self.runner.snapshot()
        self.assertTrue(snap["can_start"])
        self.assertEqual(snap["blockers"], [])
        self.assertEqual(snap["arrive_width"], ARRIVE)
        self.assertFalse(snap["land_on_arrival"], "off by default (SPEC 10.2)")

    def test_blocker_no_video(self):
        self.clock.advance(0.6)
        self.assertEqual(self.runner.blockers(), ["no_video"])
        self.link.frame = None
        self.assertEqual(self.runner.start(True)[1], ["no_video"])

    def test_blocker_no_pilot_link(self):
        self.pilot_window = False
        self.assertEqual(self.runner.start(True), (False, ["no_pilot_link"]))
        self.assertEqual(self.runner.blockers(), ["no_pilot_link"])
        self.assertFalse(self.runner.snapshot()["can_start"])
        self.assertEqual(self.runner.state, "idle")
        self.assertEqual(self.store.events(), [])
        self.pilot_window = True
        self.assertEqual(self.runner.blockers(), [])
        self.start()

    def test_blocker_estop_active(self):
        self.mixer.pilot_estop()
        self.assertEqual(self.runner.start(True), (False, ["estop_active"]))

    def test_blocker_already_running(self):
        self.start()
        self.assertEqual(self.runner.start(True), (False, ["already_running"]))
        self.assertFalse(self.runner.snapshot()["can_start"])

    def test_blocker_person_in_view_only_when_the_check_is_on(self):
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t)
        self.assertEqual(self.runner.start(True), (False, ["person_in_view"]))
        self.person = PersonStatus(enabled=False, detected=True, count=1, ts=self.clock.t)
        self.assertEqual(self.runner.blockers(), [])
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t - 5.0)
        self.assertEqual(self.runner.blockers(), [], "a stale result is ignored")

    def test_battery_check_is_disabled_by_default(self):
        self.assertEqual(Settings().battery_low_raw, -1)
        self.assertFalse(self.settings.battery_check_enabled)
        self.link.tel = Telemetry(1, 0, 16, self.clock.t)          # even a zero byte, fresh
        self.assertEqual(self.runner.blockers(), [])
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.assertEqual(self.runner.state, "approaching")

    def test_blocker_battery_low_only_when_enabled_and_telemetry_is_present_and_fresh(self):
        self.settings.battery_low_raw = 35
        self.assertIsNone(self.link.telemetry())
        self.assertEqual(self.runner.blockers(), [])
        self.link.tel = Telemetry(1, 35, 16, self.clock.t)
        self.assertEqual(self.runner.start(True), (False, ["battery_low"]))
        self.link.tel = Telemetry(1, 36, 16, self.clock.t)
        self.assertEqual(self.runner.blockers(), [])
        self.link.tel = Telemetry(1, 35, 16, self.clock.t - 2.9)   # younger than 3.0 s: still counts
        self.assertEqual(self.runner.blockers(), ["battery_low"])
        self.link.tel = Telemetry(1, 35, 16, self.clock.t - 3.0)   # stale: no decision either way
        self.assertEqual(self.runner.blockers(), [])
        self.start()

    def test_blocker_marker_too_close(self):
        self.feed(marker(width=ARRIVE))
        self.assertEqual(self.runner.start(True), (False, ["marker_too_close"]))
        self.feed(marker(width=ARRIVE - 0.01))
        self.assertEqual(self.runner.blockers(), [])

    def test_start_goes_to_approaching_or_searching(self):
        self.start()
        self.assertEqual(self.runner.state, "approaching")
        self.runner.abort()
        self.feed(None)
        self.idle(0.6)
        self.link.new_frame(self.clock.t)
        self.start()
        self.assertEqual(self.runner.state, "searching")

    def test_a_marker_seen_on_one_frame_only_does_not_start_the_approach(self):
        self.feed(None)
        self.feed(marker(cx=0.3, width=0.04))         # one detection, e.g. a false decode
        self.start()
        self.assertEqual(self.runner.state, "searching", "one frame is not enough to approach")
        self.feed(marker(cx=0.3, width=0.04))
        self.assertEqual(self.runner.state, "searching")
        self.feed(marker(cx=0.3, width=0.04))
        self.assertEqual(self.runner.state, "approaching")

    def test_the_runner_never_takes_off(self):
        self.start()
        for _ in range(30):
            self.feed(marker(width=0.05))
        self.assertEqual(self.link.toggles, 0)


class SuccessTests(RunnerTestCase):
    def test_successful_run_sends_the_toggle_exactly_once(self):
        self.runner.set_land_on_arrival(True)
        self.start("d2")
        run_id = self.runner.snapshot()["run_id"]
        self.assertTrue(run_id.startswith("run-"))
        self.approach()
        self.assertEqual(self.runner.state, "arrived")
        self.assertEqual(self.link.toggles, 0)
        for _ in range(17):                                    # 1.13 s: still settling
            axes = self.feed(marker(width=0.17))
            self.assertEqual(axes, (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(self.runner.state, "arrived")
        self.feed(marker(width=0.17))
        self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)
        for _ in range(int(4.0 / DT) + 2):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "done")
        self.assertEqual(self.link.toggles, 1)
        self.assertEqual(self.event_types(), ["run_started", "arrived_at_station"])
        arrived = self.store.events(1)[0]
        self.assertEqual((arrived["dose_id"], arrived["run_id"]), ("d2", run_id))
        self.assertTrue(arrived["detail"]["landing"])
        trace = json.loads((self.dir / "runs" / f"{run_id}.json").read_text())
        self.assertEqual(trace["result"], "done")
        self.assertTrue(trace["toggle_sent"])
        self.assertGreater(len(trace["samples"]), 20)
        self.assertEqual(set(trace["samples"][0]) >= {"t", "state", "cx", "width", "yaw", "pitch",
                                                      "fly_state_raw", "battery_raw", "flags_raw"}, True)
        snap = self.runner.snapshot()
        self.assertEqual((snap["state"], snap["reason"], snap["dose_id"]), ("done", None, "d2"))

    def test_land_on_arrival_false_goes_straight_to_done_without_the_toggle(self):
        self.runner.set_land_on_arrival(True)
        self.assertTrue(self.make_runner().settings()["land_on_arrival"], "persisted")
        self.runner.set_land_on_arrival(False)
        self.assertFalse(self.make_runner().settings()["land_on_arrival"], "persisted")
        self.start()
        self.approach()
        for _ in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "done")
        self.assertEqual(self.link.toggles, 0)
        self.assertEqual(self.event_types(), ["run_started", "arrived_at_station"])
        self.assertFalse(self.store.events(1)[0]["detail"]["landing"])

    def test_arrival_needs_three_consecutive_detections(self):
        self.start()
        self.approach(stop=0.155)
        self.feed(marker(width=0.17))
        self.feed(marker(width=0.17))
        self.feed(marker(width=0.15))             # breaks the streak
        self.feed(marker(width=0.17))
        self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "approaching")
        self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "arrived")

    def test_arrival_needs_15_percent_growth_since_first_seen(self):
        self.see(marker(width=0.15))
        self.start()                               # first seen at 0.15
        for _ in range(30):
            self.feed(marker(width=0.165))         # at the arrive width, but only 10 % larger
        self.assertEqual(self.runner.state, "approaching")
        for _ in range(3):
            self.feed(marker(width=0.175))         # 16.7 % larger
        self.assertEqual(self.runner.state, "arrived")

    def test_a_marker_that_never_grows_times_out_without_the_toggle(self):
        """The drone has landed by itself but still sees the marker: nothing may launch it again."""
        self.runner.set_land_on_arrival(True)
        self.see(marker(width=0.15))
        self.start()
        for _ in range(int(46.0 / DT)):
            self.feed(marker(width=0.165))
            if self.runner.state != "approaching":
                break
        self.assert_aborted("timeout")

    def test_side_view_arrives_on_apparent_width(self):
        side = marker(width=0.14, aspect=0.85)                 # 0.165 tall, about 32 degrees off
        self.assertAlmostEqual(apparent_width(side), 0.14 / 0.85 / 0.85)
        self.assertAlmostEqual(apparent_width(marker(width=0.12)), 0.12)
        self.start()
        self.approach(stop=0.10)
        for _ in range(3):
            self.feed(side)
        self.assertEqual(self.runner.state, "arrived")

    def test_commands_rise_at_most_one_per_second_and_stay_within_caps(self):
        self.start()
        previous = (0.0, 0.0)
        for i in range(40):
            self.feed(marker(cx=0.5 if i > 10 else 0.9, width=0.05))
            command = self.runner.snapshot()["command"]
            for now_value, before in ((command["yaw"], previous[0]), (command["pitch"], previous[1])):
                if abs(now_value) > abs(before):
                    self.assertLessEqual(abs(now_value) - abs(before), 1.0 * DT + 1e-3)
            self.assertLessEqual(abs(command["yaw"]), 0.25 + 1e-9)
            self.assertLessEqual(command["pitch"], 0.22 + 1e-9)
            previous = (command["yaw"], command["pitch"])
        self.assertAlmostEqual(previous[1], 0.22)

    def test_mixer_receives_yaw_and_pitch_only(self):
        self.start()
        for _ in range(10):
            throttle, _yaw, pitch, roll = self.feed(marker(width=0.05))
        self.assertEqual((throttle, roll), (0.0, 0.0))
        self.assertGreater(pitch, 0.0)


class AbortTests(RunnerTestCase):
    def test_marker_not_found_after_12_s_of_searching(self):
        self.feed(None)
        self.idle(0.6)
        self.link.new_frame(self.clock.t)
        self.start()
        yaws = []
        for _ in range(int(11.9 / DT)):
            yaws.append(self.feed(None)[1])
        self.assertEqual(self.runner.state, "searching")
        self.assertAlmostEqual(yaws[-1], 0.12)
        self.assertTrue(all(0.0 <= y <= 0.12 + 1e-9 for y in yaws))
        for _ in range(4):
            self.feed(None)
        self.assert_aborted("marker_not_found")

    def test_search_finds_the_marker_and_approaches(self):
        self.feed(None)
        self.idle(0.6)
        self.link.new_frame(self.clock.t)
        self.start()
        for _ in range(20):
            self.feed(None)
        self.feed(marker(cx=0.8, width=0.05))
        self.assertEqual(self.runner.state, "searching", "needs 3 consecutive detections")
        self.feed(marker(cx=0.79, width=0.05))
        self.feed(marker(cx=0.78, width=0.05))
        self.assertEqual(self.runner.state, "approaching")

    def test_a_single_false_detection_does_not_leave_searching_or_seed_the_growth_check(self):
        self.feed(None)
        self.idle(0.6)
        self.link.new_frame(self.clock.t)
        self.start()
        self.assertEqual(self.runner.state, "searching")
        yaws = []
        for index in range(30):                       # a speck decodes as id 7 now and then
            seen = marker(cx=0.2, cy=0.3, width=0.02) if index % 10 == 5 else None
            yaws.append(self.feed(seen)[1])
            self.assertEqual(self.runner.state, "searching")
        self.assertAlmostEqual(yaws[-1], 0.12, msg="still turning to search")
        # detections that jump around (centres more than 0.1 apart) do not confirm either
        for cx in (0.2, 0.5, 0.8, 0.5, 0.2):
            self.feed(marker(cx=cx, width=0.05))
            self.assertEqual(self.runner.state, "searching")
        # the speck, then the real sign three frames in a row: the growth check starts from the sign
        self.feed(marker(cx=0.9, cy=0.2, width=0.02))
        self.see(marker(width=0.15))
        self.assertEqual(self.runner.state, "approaching")
        for _ in range(20):
            self.feed(marker(width=0.165))            # only 10 % larger than the sign's 0.15
        self.assertEqual(self.runner.state, "approaching")

    def test_marker_lost_holds_neutral_then_creeps_then_aborts(self):
        self.start()
        for _ in range(20):
            self.feed(marker(cx=0.62, width=0.06))
        lost_at = self.clock.t
        while self.clock.t - lost_at < DT + 0.5:
            self.assertEqual(self.feed(None)[1], 0.0)    # first a dropout: coasting, no yaw (DropoutCoastTests)
        while self.clock.t - lost_at < 0.62:
            self.assertEqual(self.feed(None), (0.0, 0.0, 0.0, 0.0))
        creep = []
        while self.clock.t - lost_at < 2.5:
            creep.append(self.feed(None))
        self.assertEqual(self.runner.state, "approaching")
        self.assertTrue(all(axes[2] == 0.0 for axes in creep), "no forward stick while the marker is lost")
        self.assertAlmostEqual(creep[-1][1], 0.08)       # toward the right, where it was last seen
        for _ in range(4):
            self.feed(None)
        self.assert_aborted("marker_lost")

    def test_creep_search_goes_toward_the_side_last_seen_and_can_recover(self):
        self.start()
        for _ in range(10):
            self.feed(marker(cx=0.38, width=0.06))
        for _ in range(int(1.5 / DT)):
            axes = self.feed(None)
        self.assertLess(axes[1], 0.0)
        self.feed(marker(cx=0.45, width=0.06))
        self.assertEqual(self.runner.state, "approaching")
        for _ in range(int(3.0 / DT)):
            self.feed(marker(cx=0.5, width=0.06))
        self.assertEqual(self.runner.state, "approaching")

    def test_video_stale_after_1_5_s_without_a_frame(self):
        self.start()
        for _ in range(15):
            self.feed(marker(width=0.06))
        self.assertGreater(self.runner.snapshot()["command"]["pitch"], 0.0)
        self.idle(0.3)
        self.assertEqual(self.runner.snapshot()["command"], {"yaw": 0.0, "pitch": 0.0})
        self.assertEqual(self.link.last, (0.0, 0.0, 0.0, 0.0))
        self.idle(1.1)
        self.assertEqual(self.runner.state, "approaching")
        self.idle(0.2)
        self.assert_aborted("video_stale")

    def test_timeout_after_45_s(self):
        self.start()
        for _ in range(int(44.5 / DT)):
            self.feed(marker(width=0.05))
        self.assertEqual(self.runner.state, "approaching")
        for _ in range(int(1.0 / DT)):
            self.feed(marker(width=0.05))
        self.assert_aborted("timeout")

    def test_pilot_axes_abort_with_pilot_took_over(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.mixer.pilot_axes(0.0, 0.0, -0.5, 0.0)
        self.assertEqual(self.runner.state, "aborted")
        self.assertLess(self.mixer.tick(self.clock.t + 0.05)[2], 0.0)   # the pilot's stick is what is sent
        self.assert_aborted("pilot_took_over")

    def test_pilot_toggle_aborts_and_only_the_pilots_toggle_is_sent(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.assertEqual(self.mixer.pilot_toggle(), (True, ""))
        self.assert_aborted("pilot_took_over", toggles=1)

    def test_api_abort(self):
        self.start()
        self.feed(marker(width=0.06))
        self.assertTrue(self.runner.abort("pilot_took_over"))
        self.assert_aborted("pilot_took_over")
        self.assertFalse(self.runner.abort("pilot_took_over"))

    def test_estop_aborts_with_estop(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.mixer.pilot_estop()
        self.assertEqual(self.link.estops, 1)
        self.assert_aborted("estop")

    def test_person_in_view_aborts(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t)
        self.feed(marker(width=0.06))
        self.assert_aborted("person_in_view")

    def test_battery_low_aborts(self):
        self.settings.battery_low_raw = 35
        self.link.tel = Telemetry(1, 40, 16, self.clock.t)
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.link.tel = Telemetry(1, 34, 16, self.clock.t)
        self.feed(marker(width=0.06))
        self.assert_aborted("battery_low")

    def test_stale_low_battery_telemetry_does_not_abort(self):
        self.settings.battery_low_raw = 35
        self.start()
        self.link.tel = Telemetry(1, 34, 16, self.clock.t - 3.5)   # the MCU stopped reporting long ago
        for _ in range(20):
            self.feed(marker(width=0.06))
        self.assertEqual(self.runner.state, "approaching")
        self.link.tel = Telemetry(1, 34, 16, self.clock.t)          # a fresh low reading does
        self.feed(marker(width=0.06))
        self.assert_aborted("battery_low")

    def test_battery_check_disabled_never_aborts(self):
        self.start()
        for _ in range(20):
            self.link.tel = Telemetry(1, 0, 16, self.clock.t)
            self.feed(marker(width=0.06))
        self.assertEqual(self.runner.state, "approaching")

    def test_off_axis_aborts(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.feed(marker(width=0.05, aspect=0.6))
        self.feed(marker(width=0.05, aspect=0.6))
        self.assertEqual(self.runner.state, "approaching")
        self.feed(marker(width=0.05, aspect=0.6))
        self.assert_aborted("off_axis")

    def test_marker_vanishing_while_settling_aborts_instead_of_toggling(self):
        self.start()
        self.approach()
        self.assertEqual(self.runner.state, "arrived")
        for _ in range(SETTLE_FRAMES):
            self.feed(None)                        # e.g. the drone dropped to the floor
        self.assert_aborted("marker_lost")

    def arrive_for_landing(self):
        self.runner.set_land_on_arrival(True)
        self.start()
        self.approach()
        self.assertEqual(self.runner.state, "arrived")

    def settle(self, cys):
        """One settle frame per cy (the marker stays in view); returns the state after each."""
        states = []
        for cy in cys:
            self.feed(marker(width=0.17, cy=cy))
            states.append(self.runner.state)
        return states

    def test_marker_rising_in_the_picture_while_settling_aborts_with_unexpected_descent(self):
        """Settle descent guard: the camera is sinking, so the drone is landing by itself."""
        self.arrive_for_landing()
        run_id = self.runner.snapshot()["run_id"]
        states = self.settle([0.5] * 6 + [0.40] * 3)     # reference from frames 4-6, then 0.10 higher
        self.assertEqual(states[:8], ["arrived"] * 8, "two frames above the reference are not enough")
        self.assertEqual(states[8], "aborted")
        self.assert_aborted("unexpected_descent")
        self.assertIs(self.store.events(1)[0]["detail"]["settle_descent"], True)
        trace = json.loads((self.dir / "runs" / f"{run_id}.json").read_text())
        self.assertEqual((trace["reason"], trace["settle_descent"], trace["toggle_sent"]),
                         ("unexpected_descent", True, False))

    def test_marker_moving_down_in_the_picture_while_settling_does_not_trip_the_guard(self):
        self.arrive_for_landing()
        self.settle([0.5] * 6 + [0.62] * 14)
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)

    def test_one_outlier_frame_while_settling_does_not_trip_the_guard(self):
        self.arrive_for_landing()
        self.settle([0.5] * 7 + [0.30] + [0.5] * 12)
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)

    def test_the_settle_reference_is_not_the_arrival_frame(self):
        """The arrival frame is taken while still pitched forward; the settle frames sit 0.10 higher
        all along (the drone pitched back). That is the new reference, not a descent."""
        self.arrive_for_landing()
        self.settle([0.40] * SETTLE_FRAMES)
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)

    def test_the_toggle_waits_while_a_rise_is_still_being_checked(self):
        self.arrive_for_landing()
        states = self.settle([0.5] * 17 + [0.40] * 2)    # frames 18 and 19 are above: 2 of 3
        self.assertEqual(states, ["arrived"] * 19, "no toggle while the guard has a rise pending")
        self.assertEqual(self.link.toggles, 0)
        self.settle([0.5])
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)

    def sparse_settle(self, cys):
        """Settle frames with the marker detected on every 4th frame only (0.27 s apart, still fresh
        enough for the toggle); None in `cys` is a settle frame without a detection. Returns states."""
        states = []
        for cy in cys:
            for _ in range(3):
                self.feed(None)
                states.append(self.runner.state)
            self.feed(None if cy is None else marker(width=0.17, cy=cy))
            states.append(self.runner.state)
        return states

    def test_an_undecided_guard_does_not_hold_the_toggle_past_settle_plus_1_s(self):
        """Detections alternate around the threshold (0.10 above the reference, then on it) on a
        sparse detection rate: the guard never aborts and never clears. After 1.2 + 1.0 s the run
        ends done without the toggle; the arrival is logged and the pilot lands by hand."""
        self.arrive_for_landing()
        run_id = self.runner.snapshot()["run_id"]
        # detections at settle frames 12, 16, 20 (the reference), then 24, 28, 32 (the checks)
        states = self.sparse_settle([None, None, 0.5, 0.5, 0.5, 0.40, 0.5, 0.40])
        self.assertEqual(states, ["arrived"] * 32, "settle frame 32 is 2.13 s: still holding")
        self.feed(None)
        self.feed(None)                                  # settle frame 34: 2.27 s, past 1.2 + 1.0 s
        self.runner.step(None, self.clock.t)             # writes the queued events
        self.assertEqual((self.runner.state, self.runner.reason), ("done", None))
        self.assertEqual(self.link.toggles, 0, "no toggle on a guard that could not decide")
        self.assertEqual(self.event_types(), ["run_started", "arrived_at_station"])
        detail = self.store.events(1)[0]["detail"]
        self.assertEqual((detail["landing"], detail["landing_skipped"]), (False, "settle_guard_undecided"))
        trace = json.loads((self.dir / "runs" / f"{run_id}.json").read_text())
        self.assertEqual((trace["result"], trace["reason"], trace["toggle_sent"]), ("done", None, False))
        self.assertEqual(self.runner.snapshot()["last_landing"], "skipped_settle_guard_undecided")
        self.sparse_settle([0.40, 0.40, 0.40, 0.5])      # nothing more happens after the run ended
        self.assertEqual((self.runner.state, self.link.toggles), ("done", 0))
        self.clock.advance(0.5)
        self.link.new_frame(self.clock.t)
        self.assertEqual(self.mixer.tick(self.clock.t), (0.0, 0.0, 0.0, 0.0))

    def test_with_land_on_arrival_off_the_descent_guard_neither_holds_nor_aborts(self):
        for name, cys in (("would abort", [0.5] * 6 + [0.40] * 14),
                          ("would hold", [0.5] * 17 + [0.40] * 2)):
            with self.subTest(name):
                self.runner.abort()
                self.runner.set_land_on_arrival(False)
                self.link.toggles = 0
                self.see(marker(width=0.05))
                self.start()
                self.approach()
                self.assertEqual(self.runner.state, "arrived")
                states = self.settle(cys)
                self.assertEqual(states[:18], ["arrived"] * 18)
                self.assertEqual(states[18], "done", "done on the 19th settle frame, as with a steady marker")
                self.runner.step(None, self.clock.t)
                self.assertEqual((self.runner.state, self.runner.reason, self.link.toggles), ("done", None, 0))
                closing = self.store.events(1)[0]
                self.assertEqual(closing["type"], "arrived_at_station")
                self.assertIs(closing["detail"]["landing"], False)
                self.assertNotIn("landing_skipped", closing["detail"])

    def test_marker_moving_less_than_0_08_of_the_frame_height_still_lands(self):
        self.runner.set_land_on_arrival(True)
        self.start()
        self.approach()
        self.assertEqual(self.runner.state, "arrived")
        for step in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17, cy=0.5 + (0.07 if step % 2 else -0.07)))
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)

    def test_pilot_link_lost_aborts_in_every_run_state_before_the_toggle(self):
        for state in ("searching", "approaching", "arrived"):
            with self.subTest(state=state):
                self.runner.abort()
                self.link.toggles = 0
                self.store._events.clear()
                if state == "searching":
                    self.feed(None)
                    self.idle(0.6)
                    self.link.new_frame(self.clock.t)
                else:
                    self.see(marker(width=0.05))
                self.start()
                if state == "arrived":
                    self.approach()
                self.assertEqual(self.runner.state, state)
                self.pilot_window = False
                self.assertTrue(self.runner.abort("pilot_link_lost"))   # what the server does on a disconnect
                self.assert_aborted("pilot_link_lost")
                self.pilot_window = True

    def test_pilot_link_lost_during_landing_just_ends_the_run(self):
        self.runner.set_land_on_arrival(True)
        self.start()
        self.approach()
        for _ in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "landing")
        self.assertTrue(self.runner.abort("pilot_link_lost"))
        self.assertEqual(self.runner.state, "done")
        self.assertEqual(self.link.toggles, 1, "the one landing toggle was already sent; no second one")
        self.assertEqual(self.event_types(), ["run_started", "arrived_at_station"])

    def test_pilot_input_while_settling_aborts_without_the_toggle(self):
        self.start()
        self.approach()
        self.assertEqual(self.runner.state, "arrived")
        self.mixer.pilot_axes(0.2, 0.0, 0.0, 0.0)
        self.assert_aborted("pilot_took_over")

    def test_every_abort_reason_is_covered_here(self):
        covered = {"marker_not_found", "marker_lost", "video_stale", "timeout", "pilot_took_over",
                   "person_in_view", "battery_low", "estop", "off_axis", "pilot_link_lost",
                   "unexpected_descent", "takeoff_refused", "not_lined_up", "already_at_station",
                   "path_blocked", "obstacle_in_view"}   # both: tests/test_avoid_runner.py
        self.assertEqual(set(ABORT_REASONS), covered)

    def test_pilot_input_during_landing_just_ends_the_run(self):
        self.runner.set_land_on_arrival(True)
        self.start()
        self.approach()
        for _ in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "landing")
        self.mixer.pilot_axes(0.0, 0.3, 0.0, 0.0)
        self.assertEqual(self.runner.state, "done")
        self.assertEqual(self.link.toggles, 1)
        self.assertEqual(self.event_types(), ["run_started", "arrived_at_station"])

    def test_pilot_toggle_right_after_the_mission_toggle_is_swallowed(self):
        self.runner.set_land_on_arrival(True)
        self.start()
        self.approach()
        for _ in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17))
        self.assertEqual(self.link.toggles, 1)
        ok, why = self.mixer.pilot_toggle()        # a reflex press would launch the landing drone again
        self.assertFalse(ok)
        self.assertEqual(self.link.toggles, 1)

    def test_a_new_run_can_start_after_an_abort(self):
        self.start()
        self.runner.abort()
        self.feed(marker(width=0.05))
        self.start("d3")
        self.assertEqual(self.runner.snapshot()["dose_id"], "d3")
        self.assertIsNone(self.runner.snapshot()["reason"])


class DropoutCoastTests(RunnerTestCase):
    """A detection missing for at most lost_coast_s (0.5 s) is a dropout: the approach coasts on."""

    def test_one_missed_frame_keeps_flying_forward_with_no_yaw(self):
        self.start()
        for _ in range(3):
            axes = self.feed(marker(width=0.06))
        self.assertGreater(axes[2], 0.0)
        coast = self.feed(None)
        self.assertEqual(coast[1], 0.0, "no yaw while the marker's position is unknown")
        self.assertGreater(coast[2], 0.0, "keeps the forward stick through a dropout")
        self.assertLessEqual(coast[2], axes[2])
        self.assertEqual(self.runner.state, "approaching")

    def test_the_coast_fades_and_a_longer_gap_ends_neutral_then_creeps(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        lost_at = self.clock.t + DT                     # the first frame without the marker
        coast = []
        while self.clock.t + DT - lost_at <= 0.5:
            coast.append(self.feed(None))
        self.assertGreater(coast[0][2], 0.0)
        self.assertTrue(all(a[2] >= b[2] for a, b in zip(coast, coast[1:])), "the forward stick fades")
        self.assertTrue(all(axes[1] == 0.0 for axes in coast))
        held = []
        while self.clock.t + DT - lost_at <= 0.6:
            held.append(self.feed(None))
        self.assertTrue(held)
        self.assertTrue(all(axes == (0.0, 0.0, 0.0, 0.0) for axes in held), "past the coast: neutral")
        while self.clock.t - lost_at < 0.7:
            axes = self.feed(None)
        self.assertEqual(axes[2], 0.0, "no forward stick while creep-searching")
        self.assertEqual(self.runner.state, "approaching")

    def test_no_forward_coast_near_the_arrive_width(self):
        self.start()
        width = 0.05
        while width < 0.9 * ARRIVE:
            self.feed(marker(width=width))
            width += 0.004
        self.feed(marker(width=0.9 * ARRIVE + 0.002))
        self.assertEqual(self.runner.state, "approaching")
        self.assertEqual(self.feed(None)[2], 0.0, "never forward blind near the wall")

    def test_arrival_counts_survive_dropouts(self):
        self.start()
        self.approach(stop=ARRIVE - 0.004)
        self.assertEqual(self.runner.state, "approaching")
        for seen in (marker(width=ARRIVE), None, marker(width=ARRIVE), None, marker(width=ARRIVE)):
            self.feed(seen)
        self.assertEqual(self.runner.state, "arrived", "3 detections with gaps of one frame count as 3 in a row")

    def test_a_gap_longer_than_the_coast_resets_the_arrival_counts(self):
        self.start()
        self.approach(stop=ARRIVE - 0.004)
        self.feed(marker(width=ARRIVE))
        self.feed(marker(width=ARRIVE))
        for _ in range(int(0.55 / DT) + 1):
            self.feed(None)
        self.feed(marker(width=ARRIVE))
        self.assertEqual(self.runner.state, "approaching")

    def test_estop_during_a_coast_aborts(self):
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.assertGreater(self.feed(None)[2], 0.0)
        self.mixer.pilot_estop()
        self.feed(None)
        self.assert_aborted("estop")

    def test_coasting_can_be_switched_off(self):
        self.runner = MissionRunner(self.link, self.mixer, self.store, self.settings, clock=self.clock,
                                    config=RunnerConfig(align_enabled=False, lost_coast_s=0.0),
                                    wall_clock=lambda: 1_794_000_000.0 + self.clock.t,
                                    person_status=lambda: self.person, pilot_connected=lambda: self.pilot_window)
        self.see(marker(width=0.05))
        self.start()
        for _ in range(10):
            self.feed(marker(width=0.06))
        self.assertEqual(self.feed(None), (0.0, 0.0, 0.0, 0.0))


class SearchConfirmTests(RunnerTestCase):
    """The detections that confirm the sign may have dropout gaps of up to lost_coast_s (0.5 s)."""

    def forget(self):
        for _ in range(int(0.6 / DT) + 1):             # longer than a dropout: the count starts again
            self.feed(None)

    def test_hit_miss_hit_hit_confirms(self):
        self.forget()
        for seen in (marker(), None, marker(), marker()):
            self.feed(seen)
        self.start()
        self.assertEqual(self.runner.state, "approaching")

    def test_a_gap_longer_than_a_dropout_does_not_confirm(self):
        self.forget()
        self.feed(marker())
        self.forget()
        self.feed(marker())
        self.feed(marker())
        self.start()
        self.assertEqual(self.runner.state, "searching")

    def test_without_coasting_any_miss_starts_again(self):
        self.runner = MissionRunner(self.link, self.mixer, self.store, self.settings, clock=self.clock,
                                    config=RunnerConfig(align_enabled=False, lost_coast_s=0.0),
                                    wall_clock=lambda: 1_794_000_000.0 + self.clock.t,
                                    person_status=lambda: self.person, pilot_connected=lambda: self.pilot_window)
        for seen in (marker(), None, marker(), marker()):
            self.feed(seen)
        self.start()
        self.assertEqual(self.runner.state, "searching")


class LandingDistanceSettingsTests(unittest.TestCase):
    """MEDHOP_LAND_DISTANCE_M sets the arrive width (program's own camera geometry) unless
    MEDHOP_ARRIVE_WIDTH is given; a stored arrival calibration beats both."""

    def setUp(self):
        self.dir = make_temp_dir()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def runner_for(self, settings):
        clock = FakeClock(500.0)
        store = CareStore(self.dir, wall_clock=lambda: 1_794_000_000.0 + clock.t)
        link = RecordingLink()
        return MissionRunner(link, ControlMixer(link, clock=clock), store, settings, clock=clock), store

    def test_default_is_0_45_m(self):
        settings = Settings()
        self.assertEqual(settings.land_distance_m, 0.45)
        self.assertAlmostEqual(settings.arrive_width, 0.2856, places=4)   # 0.18 m marker, 70 degree lens
        runner, _store = self.runner_for(Settings(data_dir=self.dir, person_check="off"))
        self.assertAlmostEqual(runner.snapshot()["arrive_distance_m"], 0.45, places=2)

    def test_the_environment_sets_the_distance(self):
        settings = Settings.from_env({"MEDHOP_LAND_DISTANCE_M": "0.8"})
        self.assertEqual(settings.land_distance_m, 0.8)
        self.assertAlmostEqual(settings.arrive_width, 0.1607, places=4)

    def test_an_explicit_arrive_width_wins(self):
        settings = Settings.from_env({"MEDHOP_LAND_DISTANCE_M": "0.8", "MEDHOP_ARRIVE_WIDTH": "0.2"})
        self.assertEqual(settings.arrive_width, 0.2)

    def test_out_of_range_distances_are_refused(self):
        for raw in ("0.2", "5.0"):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(ValueError, "MEDHOP_LAND_DISTANCE_M"):
                    Settings.from_env({"MEDHOP_LAND_DISTANCE_M": raw})

    def test_a_stored_calibration_beats_both(self):
        CareStore(self.dir).save_arrive_width(0.21)
        for settings in (Settings(data_dir=self.dir, land_distance_m=0.8),
                         Settings(data_dir=self.dir, arrive_width=0.12)):
            with self.subTest(settings=settings):
                runner, _store = self.runner_for(settings)
                self.assertAlmostEqual(runner.arrive_width, 0.21)


class HoverTestTests(RunnerTestCase):
    def run_hover(self, cx_at, width=0.05, visible=lambda i: True):
        ok, problems = self.runner.start_hover_test()
        self.assertTrue(ok, problems)
        self.assertEqual(self.runner.state, "hover_test")
        frames = int(10.0 / DT) + 2
        for i in range(frames):
            seen = marker(cx=cx_at(i / frames), width=width) if visible(i) else None
            axes = self.feed(seen)
            if self.runner.state != "hover_test":
                break
            self.assertEqual(axes, (0.0, 0.0, 0.0, 0.0))
        return self.runner.hover_snapshot()

    def test_null_before_any_hover_test(self):
        self.assertIsNone(self.runner.hover_snapshot())

    def test_steady_hover_passes(self):
        snap = self.run_hover(lambda f: 0.5)
        self.assertFalse(snap["running"])
        self.assertEqual(set(snap["result"]), {"pass", "drift_frame_widths", "drift_m_estimate",
                                                "width_change_pct", "visible_pct", "peak_excursion_m",
                                                "limit_m"})
        self.assertTrue(snap["result"]["pass"])
        self.assertAlmostEqual(snap["result"]["drift_m_estimate"], 0.0, places=3)
        self.assertEqual((snap["result"]["peak_excursion_m"], snap["result"]["limit_m"]), (0.0, 0.5))
        self.assertEqual(snap["result"]["visible_pct"], 100.0)
        self.assertEqual(self.runner.state, "idle")
        self.assertEqual(self.event_types(), ["hover_test"])
        self.assertEqual(self.link.toggles, 0)

    def test_drift_estimate_uses_the_marker_size_as_scale(self):
        # the marker moves 0.2 frame-widths to the left; it is 0.05 wide and 0.18 m in reality
        snap = self.run_hover(lambda f: 0.6 - 0.2 * f)
        result = snap["result"]
        self.assertAlmostEqual(result["drift_frame_widths"], 0.2, delta=0.012)     # drone drifted right
        self.assertAlmostEqual(result["drift_m_estimate"], 0.2 * 0.18 / 0.05, delta=0.05)
        self.assertFalse(result["pass"])                                            # 0.72 m > 0.5 m

    def test_small_drift_passes_and_sign_follows_the_drone(self):
        result = self.run_hover(lambda f: 0.5 + 0.1 * f)["result"]
        self.assertAlmostEqual(result["drift_m_estimate"], -0.36, delta=0.02)       # drone drifted left
        self.assertAlmostEqual(result["peak_excursion_m"], 0.36, delta=0.02)
        self.assertTrue(result["pass"])

    def test_drifting_out_and_back_fails_on_the_peak_excursion(self):
        # out 0.2 frame-widths (0.72 m at this marker size) and back again: start and end agree
        result = self.run_hover(lambda f: 0.5 + 0.2 * (1.0 - abs(2.0 * f - 1.0)))["result"]
        self.assertAlmostEqual(result["drift_m_estimate"], 0.0, delta=0.05)
        self.assertAlmostEqual(result["peak_excursion_m"], 0.72, delta=0.03)
        self.assertEqual(result["limit_m"], 0.5)
        self.assertFalse(result["pass"])

    def test_the_excursion_limit_comes_from_the_settings(self):
        self.assertEqual(Settings.from_env({"MEDHOP_HOVER_MAX_EXCURSION_M": "0.8"}).hover_max_excursion_m, 0.8)
        self.settings.hover_max_excursion_m = 0.8
        result = self.run_hover(lambda f: 0.5 + 0.2 * (1.0 - abs(2.0 * f - 1.0)))["result"]
        self.assertEqual(result["limit_m"], 0.8)
        self.assertTrue(result["pass"])

    def test_low_visibility_fails(self):
        result = self.run_hover(lambda f: 0.5, visible=lambda i: i % 4 != 0)["result"]
        self.assertAlmostEqual(result["visible_pct"], 75.0, delta=1.0)
        self.assertFalse(result["pass"])

    def test_trim_still_applies_during_the_hover_test(self):
        self.mixer.set_trim(0.03, -0.01)
        self.runner.start_hover_test()
        self.assertEqual(self.feed(marker()), (0.0, 0.0, -0.01, 0.03))

    def test_refused_without_marker_or_during_a_run(self):
        self.start()
        self.assertEqual(self.runner.start_hover_test(), (False, ["already_running"]))
        self.runner.abort()
        self.feed(None)
        self.idle(0.6)
        self.assertEqual(self.runner.start_hover_test(), (False, ["marker_not_visible"]))

    def test_hover_test_needs_a_pilot_link_and_is_cancelled_when_it_drops(self):
        self.pilot_window = False
        self.assertEqual(self.runner.start_hover_test(), (False, ["no_pilot_link"]))
        self.pilot_window = True
        self.assertEqual(self.runner.start_hover_test(), (True, []))
        self.assertEqual(self.runner.state, "hover_test")
        self.assertTrue(self.runner.abort("pilot_link_lost"))
        self.runner.step(None, self.clock.t)
        self.assertEqual(self.runner.state, "idle")
        self.assertIs(self.runner.hover_snapshot()["running"], False)
        self.assertEqual(self.store.events(1)[0]["detail"], {"cancelled": "pilot_link_lost"})
        self.assertEqual(self.link.toggles, 0)

    def test_pilot_input_cancels_the_hover_test(self):
        self.runner.start_hover_test()
        for _ in range(10):
            self.feed(marker())
        self.mixer.pilot_axes(0.0, 0.0, 0.0, 0.4)
        self.assertEqual(self.runner.state, "idle")
        snap = self.runner.hover_snapshot()
        self.assertFalse(snap["running"])
        self.assertIsNone(snap["result"])
        self.assertEqual(self.runner.start(True), (True, []))


class LastLandingTests(RunnerTestCase):
    """Every way a run reaches done says truthfully whether the landing toggle went out."""

    def arrive_and_settle(self, land):
        self.runner.set_land_on_arrival(land)
        self.see(marker(width=0.05))
        self.start()
        self.assertIsNone(self.runner.snapshot()["last_landing"], "a new run starts with no landing result")
        self.approach()
        self.assertEqual(self.runner.state, "arrived")
        for _ in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17))
        self.runner.step(None, self.clock.t)       # writes the queued events
        closing = self.store.events(1)[0]
        self.assertEqual(closing["type"], "arrived_at_station")
        return closing["detail"]

    def test_null_before_any_run(self):
        self.assertIsNone(self.runner.snapshot()["last_landing"])

    def test_sent(self):
        detail = self.arrive_and_settle(land=True)
        self.assertEqual((self.runner.state, self.link.toggles), ("landing", 1))
        self.assertIs(detail["landing"], True)
        self.assertNotIn("landing_skipped", detail)
        self.assertEqual(self.runner.snapshot()["last_landing"], "sent")

    def test_off(self):
        detail = self.arrive_and_settle(land=False)
        self.assertEqual((self.runner.state, self.runner.reason, self.link.toggles), ("done", None, 0))
        self.assertIs(detail["landing"], False)
        self.assertNotIn("landing_skipped", detail)
        self.assertEqual(self.runner.snapshot()["last_landing"], "off")

    def test_refused_by_mixer(self):
        refused = []
        self.mixer.mission_toggle = lambda now=None: refused.append(now) or False
        detail = self.arrive_and_settle(land=True)
        self.assertEqual(len(refused), 1, "the runner asked once")
        self.assertEqual((self.runner.state, self.runner.reason, self.link.toggles), ("done", None, 0))
        self.assertIs(detail["landing"], False)
        self.assertEqual(detail["landing_skipped"], "refused_by_mixer")
        self.assertEqual(self.runner.snapshot()["last_landing"], "refused_by_mixer")
        trace = json.loads((self.dir / "runs" / f"{self.runner.snapshot()['run_id']}.json").read_text())
        self.assertIs(trace["toggle_sent"], False)

    def test_an_aborted_run_after_a_landing_has_no_landing_result(self):
        self.arrive_and_settle(land=True)
        for _ in range(int(4.0 / DT) + 2):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.snapshot()["last_landing"], "sent")
        self.feed(marker(width=0.05))
        self.start()
        self.assertIsNone(self.runner.snapshot()["last_landing"])
        self.runner.abort()
        self.assertIsNone(self.runner.snapshot()["last_landing"], "this run never arrived")


class CalibrationTests(RunnerTestCase):
    def test_calibrate_arrival_stores_the_observed_width(self):
        self.feed(marker(width=0.21))
        width, problems = self.runner.calibrate_arrival()
        self.assertEqual(problems, [])
        self.assertAlmostEqual(width, 0.21)
        self.assertAlmostEqual(self.runner.snapshot()["arrive_width"], 0.21)
        again = MissionRunner(self.link, self.mixer, self.store, self.settings, clock=self.clock)
        self.assertAlmostEqual(again.arrive_width, 0.21)

    def test_calibrate_arrival_needs_a_visible_marker_and_no_run(self):
        self.feed(None)
        self.idle(0.6)
        self.assertEqual(self.runner.calibrate_arrival(), (None, ["marker_not_visible"]))
        self.feed(marker(width=0.05))
        self.start()
        self.assertEqual(self.runner.calibrate_arrival(), (None, ["already_running"]))


ASSIST_KEYS = {"enabled", "active", "roll", "disabled_reason", "suggested_trim_roll"}


class DriftAssistRunnerTests(RunnerTestCase):
    """The runner's side of drift assist with synthetic observations: a marker that slides steadily
    left in the picture (the drone is drifting right) while it slowly grows."""

    def slide_left(self, frames, start_cx=0.5, per_frame=0.002, width=0.05, grow=0.0):
        sent, cx = [], start_cx
        for index in range(frames):
            if self.runner.state != "approaching":
                break
            cx -= per_frame
            sent.append(self.feed(marker(cx=cx, width=width + grow * index)))
        return sent

    def test_off_by_default_and_the_status_has_exactly_the_spec_keys(self):
        assist = self.runner.snapshot()["drift_assist"]
        self.assertEqual(assist, {"enabled": False, "active": False, "roll": 0.0, "disabled_reason": None,
                                  "suggested_trim_roll": None})
        self.assertEqual(set(assist), ASSIST_KEYS)
        self.assertEqual(self.runner.settings(), {"land_on_arrival": False, "drift_assist": False,
                                                  "auto_fly": False, "avoid": "off"})

    def test_switch_is_persisted_in_the_data_directory(self):
        self.assertIs(self.runner.set_drift_assist(True), True)
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()), {"drift_assist": True})
        again = self.make_runner()
        self.assertIs(again.snapshot()["drift_assist"]["enabled"], True)
        again.set_drift_assist(False)
        self.assertIs(self.make_runner().snapshot()["drift_assist"]["enabled"], False)

    def test_off_means_no_roll_whatever_the_marker_does(self):
        self.start()
        sent = self.slide_left(45)
        self.assertEqual({axes[3] for axes in sent}, {0.0})
        self.assertEqual({axes[0] for axes in sent}, {0.0})
        self.assertIs(self.runner.snapshot()["drift_assist"]["active"], False)

    def test_on_adds_a_bounded_roll_toward_the_side_the_marker_slides_to(self):
        self.runner.set_drift_assist(True)
        self.start()
        self.assertIs(self.store.events(1)[0]["detail"]["drift_assist"], True)
        sent = self.slide_left(40)
        rolls = [axes[3] for axes in sent]
        self.assertEqual(rolls[0], 0.0)
        self.assertLess(rolls[-1], -0.03, "marker sliding left = drone drifting right = roll left")
        self.assertGreaterEqual(min(rolls), -0.15 - 1e-9)
        self.assertEqual({axes[0] for axes in sent}, {0.0}, "never throttle")
        assist = self.runner.snapshot()["drift_assist"]
        self.assertEqual(set(assist), ASSIST_KEYS)
        self.assertIs(assist["active"], True)
        self.assertAlmostEqual(assist["roll"], rolls[-1], places=4)
        self.assertEqual(self.runner.snapshot()["command"].keys(), {"yaw", "pitch"})

    def test_roll_never_exceeds_the_bound(self):
        self.runner.set_drift_assist(True)
        self.start()
        sent = self.slide_left(60, per_frame=0.002)
        self.assertLessEqual(max(abs(axes[3]) for axes in sent), 0.15 + 1e-9)

    def test_roll_goes_to_zero_on_abort_marker_loss_and_frame_gap(self):
        self.runner.set_drift_assist(True)
        self.start()
        last_roll = self.slide_left(40)[-1][3]
        self.assertLess(last_roll, -0.03)
        coast = self.feed(None)[3]      # a dropout first: the roll fades out over lost_coast_s
        self.assertLessEqual(coast, 0.0)
        self.assertGreaterEqual(coast, last_roll - 1e-9)
        for _ in range(int(0.5 / DT) + 1):
            axes = self.feed(None)
        self.assertEqual(axes[3], 0.0, "no roll once the marker has been gone longer than a dropout")
        self.assertIs(self.runner.snapshot()["drift_assist"]["active"], False)
        self.assertLess(self.slide_left(40, start_cx=0.5)[-1][3], -0.03, "back once it has qualified again")
        self.assertEqual(self.idle(0.3)[3], 0.0, "no roll without fresh frames")
        self.assertLess(self.slide_left(40, start_cx=0.5)[-1][3], -0.03)
        self.runner.abort()
        self.clock.advance(0.5)
        self.link.new_frame(self.clock.t)
        self.assertEqual(self.mixer.tick(self.clock.t), (0.0, 0.0, 0.0, 0.0))
        assist = self.runner.snapshot()["drift_assist"]
        self.assertEqual((assist["active"], assist["roll"], assist["suggested_trim_roll"]), (False, 0.0, None))

    def test_switching_it_off_mid_run_stops_the_roll_at_once(self):
        self.runner.set_drift_assist(True)
        self.start()
        self.assertLess(self.slide_left(40)[-1][3], -0.03)
        self.runner.set_drift_assist(False)
        self.assertEqual(self.slide_left(3, start_cx=0.42)[-1][3], 0.0)

    def test_switching_it_on_mid_run_waits_for_the_next_run(self):
        self.start()
        self.slide_left(10)
        self.runner.set_drift_assist(True)
        self.assertEqual({axes[3] for axes in self.slide_left(40, start_cx=0.48)}, {0.0})

    def test_no_roll_while_settling_or_landing_and_a_trim_suggestion_after_arrival(self):
        self.mixer.set_trim(0.02, 0.0)
        self.runner.set_drift_assist(True)
        self.runner.set_land_on_arrival(True)
        self.start()
        run_id = self.runner.snapshot()["run_id"]
        self.slide_left(28, per_frame=0.0005)          # a small slide (inside the yaw deadband) ...
        width, sent = 0.05, []
        while self.runner.state == "approaching" and width < 0.2:
            sent.append(self.feed(marker(cx=0.486, width=width)))   # ... then steady while it grows to arrival
            width += 0.004
        self.assertEqual(self.runner.state, "arrived")
        assist_roll = sent[-2][3] - 0.02
        self.assertLess(assist_roll, -0.005)
        for _ in range(SETTLE_FRAMES):
            axes = self.feed(marker(width=0.2))
            self.assertEqual(axes, (0.0, 0.0, 0.0, 0.02), "neutral plus trim: the assist roll is gone")
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 1)
        assist = self.runner.snapshot()["drift_assist"]
        self.assertIsNotNone(assist["suggested_trim_roll"])
        self.assertEqual(assist["suggested_trim_roll"], round(assist["suggested_trim_roll"], 2))
        self.assertLess(assist["suggested_trim_roll"], 0.02, "current trim plus a negative mean assist roll")
        self.assertGreaterEqual(assist["suggested_trim_roll"], 0.02 - 0.15)
        arrived = self.store.events(1)[0]
        self.assertEqual(arrived["type"], "arrived_at_station")
        self.assertEqual(arrived["detail"]["suggested_trim_roll"], assist["suggested_trim_roll"])
        self.assertNotIn("drift_assist_disabled", arrived["detail"])
        for _ in range(int(4.0 / DT) + 2):
            self.feed(marker(width=0.2))
        self.assertEqual(self.runner.state, "done")
        self.assertEqual(self.runner.snapshot()["drift_assist"]["suggested_trim_roll"], assist["suggested_trim_roll"])
        trace = json.loads((self.dir / "runs" / f"{run_id}.json").read_text())
        self.assertEqual(trace["drift_assist"]["enabled"], True)
        self.assertEqual(trace["drift_assist"]["drift_assist_disabled"], False)
        self.assertEqual(trace["drift_assist"]["suggested_trim_roll"], assist["suggested_trim_roll"])
        self.assertTrue(any(sample["roll"] < 0 for sample in trace["samples"]))
        # the next run starts without a suggestion
        self.feed(marker(width=0.05))
        self.start()
        self.assertIsNone(self.runner.snapshot()["drift_assist"]["suggested_trim_roll"])

    def test_a_run_without_the_assist_reports_no_suggestion_and_no_assist_keys(self):
        self.start()
        self.approach()
        for _ in range(SETTLE_FRAMES):
            self.feed(marker(width=0.17))
        self.assertIsNone(self.runner.snapshot()["drift_assist"]["suggested_trim_roll"])
        self.assertNotIn("suggested_trim_roll", self.store.events(1)[0]["detail"])

    def test_self_disable_is_reported_in_status_event_detail_and_trace(self):
        self.runner.set_drift_assist(True)
        self.start()
        run_id = self.runner.snapshot()["run_id"]
        # The marker keeps sliding the same way however much roll is added: the assist ends up at
        # its bound with the slide as fast as ever, which is what a wrong roll sign looks like.
        sent = self.slide_left(75, per_frame=0.002, width=0.05)
        assist = self.runner.snapshot()["drift_assist"]
        self.assertEqual(assist["disabled_reason"], "off_axis_worsening")
        self.assertEqual((assist["active"], assist["roll"]), (False, 0.0))
        self.assertIs(assist["enabled"], True, "the switch itself stays on for the next run")
        self.assertEqual(sent[-1][3], 0.0)
        self.assertLessEqual(max(abs(axes[3]) for axes in sent), 0.15 + 1e-9)
        self.assertEqual(self.runner.state, "approaching", "the run itself goes on without roll")
        self.runner.abort()
        self.runner.step(None, self.clock.t)
        detail = self.store.events(1)[0]["detail"]
        self.assertIs(detail["drift_assist_disabled"], True)
        self.assertEqual(detail["drift_assist_disabled_reason"], "off_axis_worsening")
        self.assertEqual(self.link.toggles, 0)
        trace = json.loads((self.dir / "runs" / f"{run_id}.json").read_text())
        self.assertIs(trace["drift_assist"]["drift_assist_disabled"], True)
        self.assertEqual(trace["drift_assist"]["disabled_reason"], "off_axis_worsening")
        self.assertIn(trace["drift_assist"]["disabled_by"], ("slide", "aspect"))
        self.assertGreater(trace["drift_assist"]["disabled_at_s"], 0.5)
        # a new run starts with the assist available again
        self.feed(marker(width=0.05))
        self.start()
        self.assertIsNone(self.runner.snapshot()["drift_assist"]["disabled_reason"])


if __name__ == "__main__":
    unittest.main()
