"""Automatic station runs: countdown, takeoff, landing on arrival, landing where it is on a stop,
the stricter arrival rule, and the dose-time trigger. Fake clock, synthetic observations, no threads."""
import logging
import shutil
import unittest
from datetime import datetime

from medhop.config import Settings
from medhop.drone.base import Telemetry
from medhop.vision.person import PersonStatus
from medhop.mission.runner import RunnerConfig
from tests.harness import SimHarness
from tests.test_runner import DT, RunnerTestCase, marker
from medhop.drone.sim import SimConfig

COUNTDOWN_FRAMES = int(5.0 / DT) + 2
TAKEOFF_FRAMES = int(4.0 / DT) + 2


def setUpModule():
    logging.disable(logging.WARNING)


def tearDownModule():
    logging.disable(logging.NOTSET)


class AutomaticRunTests(RunnerTestCase):
    def start_auto(self, dose_id=None):
        ok, blockers = self.runner.start(False, dose_id, automatic=True)
        self.assertTrue(ok, blockers)
        return ok

    def through_takeoff(self, seen=None):
        """Countdown on the ground, then the takeoff wait, with `seen` (default: no marker) in view."""
        for _ in range(COUNTDOWN_FRAMES):
            self.feed(seen)
        self.assertEqual(self.runner.state, "taking_off")
        for _ in range(TAKEOFF_FRAMES):
            self.feed(seen)

    def fly_in(self, cy=0.5, stop=None):
        """Detections growing from 0.05 to 0.17 wide, centred, square-on."""
        width = 0.05
        while width < 0.17 and (stop is None or width < stop):
            self.feed(marker(width=width, cy=cy))
            width += 0.004

    def last_event(self, kind):
        return next(e for e in self.store.events(50) if e["type"] == kind)

    # -------------------------------------------------------------- #
    def test_counts_down_then_takes_off_once_then_lands_on_arrival(self):
        self.start_auto("d1")
        self.assertEqual(self.runner.state, "countdown")
        snap = self.runner.snapshot()
        self.assertTrue(snap["automatic"])
        self.assertAlmostEqual(snap["countdown_remaining_s"], 5.0, places=1)
        for _ in range(int(4.5 / DT)):
            self.feed(marker(width=0.05))
        self.assertEqual(self.link.toggles, 0, "nothing is sent during the countdown")
        self.assertEqual(self.runner.state, "countdown")
        for _ in range(int(1.0 / DT)):
            self.feed(marker(width=0.05))
        self.assertEqual(self.runner.state, "taking_off")
        for _ in range(TAKEOFF_FRAMES):
            self.feed(marker(width=0.05))
        self.assertEqual(self.link.toggles, 1, "one takeoff toggle")
        self.assertIn(self.runner.state, ("searching", "approaching"))
        self.fly_in()
        for _ in range(30):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.state, "landing")
        self.assertEqual(self.link.toggles, 2, "takeoff plus the landing toggle, with the switch off")
        started = self.last_event("run_started")
        self.assertIs(started["detail"]["automatic"], True)
        self.assertIs(started["detail"]["land_on_arrival"], True)
        self.assertIs(self.last_event("arrived_at_station")["detail"]["landing"], True)

    def test_stop_during_the_countdown_never_flies(self):
        self.start_auto()
        self.feed(marker(width=0.05))
        self.assertTrue(self.runner.abort("pilot_took_over"))
        for _ in range(COUNTDOWN_FRAMES):
            self.feed(marker(width=0.05))
        self.assertEqual(self.link.toggles, 0)
        self.assertFalse(self.runner.snapshot()["needs_pilot"])

    def test_takeoff_refused_when_the_link_is_down(self):
        self.start_auto()
        self.link.control = False
        for _ in range(COUNTDOWN_FRAMES):
            self.feed(marker(width=0.05))
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "takeoff_refused"))
        self.assertFalse(self.runner.snapshot()["needs_pilot"])

    def test_manual_runs_still_need_the_confirmation_and_never_take_off(self):
        ok, blockers = self.runner.start(False, None)
        self.assertFalse(ok)
        self.assertEqual(blockers[0], "confirm_airborne_required")
        self.runner.start(True, None)
        self.assertEqual(self.runner.state, "approaching")
        self.assertEqual(self.link.toggles, 0)

    # ------------------------------ blockers ------------------------ #
    def test_recent_toggle_blocks_an_automatic_start(self):
        self.assertTrue(self.mixer.pilot_toggle().ok)
        self.assertIn("recent_toggle", self.runner.snapshot()["auto_blockers"])
        self.assertEqual(self.runner.start(False, None, automatic=True)[1], ["recent_toggle"])
        self.clock.advance(10.5)
        self.feed(marker(width=0.05))
        self.assertNotIn("recent_toggle", self.runner.snapshot()["auto_blockers"])

    def test_simulated_airborne_telemetry_blocks_an_automatic_start(self):
        self.link.tel = Telemetry(timestamp=self.clock.t, fly_state_raw=1, battery_raw=42, flags_raw=0)
        self.assertEqual(self.runner.start(False, None, automatic=True)[1], ["drone_flying"])
        self.link.mode = "real"     # the real fly-state byte is unverified: not used
        self.assertNotIn("drone_flying", self.runner.snapshot()["auto_blockers"])

    def test_no_pilot_window_blocks_an_automatic_start(self):
        self.pilot_window = False
        self.assertIn("no_pilot_link", self.runner.start(False, None, automatic=True)[1])

    # ------------------------------ safe landing --------------------- #
    def test_a_stop_after_a_confirmed_flight_lands_where_it_is(self):
        self.start_auto()
        self.through_takeoff(marker(width=0.05))
        self.fly_in(stop=0.10)
        self.assertTrue(self.runner.snapshot()["flight_confirmed"])
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t)
        self.feed(marker(width=0.10))
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "person_in_view"))
        self.assertEqual(self.link.toggles, 2)
        snap = self.runner.snapshot()
        self.assertEqual(snap["last_landing"], "safe_landing")
        self.assertFalse(snap["needs_pilot"])
        self.assertIs(self.last_event("run_aborted")["detail"]["safe_landing"], True)

    def test_no_landing_toggle_when_the_marker_is_rising_in_the_picture(self):
        """A sinking camera (the drone landing by itself) sees the marker move up: no toggle."""
        self.start_auto()
        self.through_takeoff(marker(width=0.05))
        self.fly_in(stop=0.10)
        for i in range(12):
            self.feed(marker(width=0.10, cy=0.5 - 0.02 * i))
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t)
        self.feed(marker(width=0.10, cy=0.25))
        self.assertEqual(self.runner.reason, "person_in_view")
        self.assertEqual(self.link.toggles, 1)
        self.assertTrue(self.runner.snapshot()["needs_pilot"])

    def test_no_landing_toggle_when_the_marker_is_lost(self):
        self.start_auto()
        self.through_takeoff(marker(width=0.05))
        self.fly_in(stop=0.10)
        for _ in range(int(3.0 / DT)):
            self.feed(None)
        self.assertEqual(self.runner.reason, "marker_lost")
        self.assertEqual(self.link.toggles, 1, "without a picture there is no evidence it is flying")
        self.assertTrue(self.runner.snapshot()["needs_pilot"])

    def test_no_landing_toggle_before_the_flight_is_confirmed(self):
        self.start_auto()
        self.through_takeoff()
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t)
        self.feed(None)
        self.assertEqual(self.runner.reason, "person_in_view")
        self.assertEqual(self.link.toggles, 1)
        self.assertTrue(self.runner.snapshot()["needs_pilot"])
        self.runner.note_pilot_input()
        self.assertFalse(self.runner.snapshot()["needs_pilot"])

    def test_estop_and_pilot_take_over_never_toggle(self):
        for reason in ("estop", "pilot_took_over"):
            with self.subTest(reason=reason):
                self.clock.advance(11.0)
                self.mixer.estop_reset()
                self.feed(marker(width=0.05))
                self.start_auto()
                self.through_takeoff(marker(width=0.05))
                self.fly_in(stop=0.10)
                toggles = self.link.toggles
                if reason == "estop":
                    self.mixer.pilot_estop()
                else:
                    self.runner.abort("pilot_took_over")
                self.feed(marker(width=0.10))
                self.assertEqual(self.runner.reason, reason)
                self.assertEqual(self.link.toggles, toggles)
                self.assertFalse(self.runner.snapshot()["needs_pilot"])

    def test_already_at_the_sign_after_takeoff(self):
        self.start_auto()
        for _ in range(COUNTDOWN_FRAMES):
            self.feed(None)
        for _ in range(TAKEOFF_FRAMES):
            self.feed(marker(width=0.17))
        self.assertEqual(self.runner.reason, "already_at_station")
        self.assertEqual(self.link.toggles, 1)


class ArrivalRuleTests(RunnerTestCase):
    """Where it lands: only close, centred and in front of the sign, never because it saw it far away."""

    def approach_to(self, width, **kw):
        w = 0.05
        while w < width:
            self.feed(marker(width=w, **kw))
            w += 0.004

    def test_seeing_the_sign_far_away_never_lands(self):
        self.runner.set_land_on_arrival(True)
        self.runner.start(True, None)
        for _ in range(int(40.0 / DT)):
            self.feed(marker(width=0.05))
            if self.runner.state != "approaching":
                break
        self.assertEqual(self.link.toggles, 0)
        self.assertNotIn(self.runner.state, ("arrived", "landing", "done"))

    def test_off_centre_at_arrive_size_does_not_arrive_and_holds_position(self):
        self.runner.start(True, None)
        self.approach_to(0.15)
        for _ in range(10):
            self.feed(marker(width=0.18, cx=0.65))     # beyond the 0.12 centre tolerance
        self.assertEqual(self.runner.state, "approaching")
        self.assertEqual(self.runner.snapshot()["command"]["pitch"], 0.0, "no creeping toward the wall")
        for _ in range(4):
            self.feed(marker(width=0.18, cx=0.5))
        self.assertEqual(self.runner.state, "arrived")

    def test_beside_the_station_stops_as_not_lined_up(self):
        self.runner.set_land_on_arrival(True)
        self.runner.start(True, None)
        self.approach_to(0.15)
        for _ in range(int(3.0 / DT)):
            self.feed(marker(width=0.15, aspect=0.75))   # 0.2 tall: arrive size, about 41 degrees off
            if self.runner.state != "approaching":
                break
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "not_lined_up"))
        self.assertEqual(self.link.toggles, 0)

    def test_distance_estimate(self):
        snap = self.runner.snapshot()
        self.assertAlmostEqual(snap["arrive_distance_m"], 0.80, places=2)   # 0.18 m marker, 70 degree lens
        self.assertAlmostEqual(snap["distance_m"], 2.57, places=2)          # 0.05 of the frame


class AutoFlySwitchTests(RunnerTestCase):
    def test_switch_is_persisted_and_off_by_default(self):
        self.assertFalse(self.runner.auto_fly)
        self.runner.set_auto_fly(True)
        self.assertTrue(self.make_runner().auto_fly)
        self.assertEqual(self.runner.settings()["auto_fly"], True)

    def test_ready_flag_clears_on_start_and_on_pilot_input(self):
        self.assertTrue(self.runner.mark_ready_for_dose()[0])
        self.assertTrue(self.runner.ready_for_dose)
        self.runner.note_pilot_input()
        self.assertFalse(self.runner.ready_for_dose)
        self.runner.mark_ready_for_dose()
        self.runner.start(False, None, automatic=True)
        self.assertFalse(self.runner.ready_for_dose)
        self.assertEqual(self.runner.mark_ready_for_dose(), (False, ["already_running"]))


class DoseTriggerTests(unittest.TestCase):
    """MedHopCore._auto_fly_for_due, with the server's own objects (simulator link, not started)."""

    def setUp(self):
        from medhop.server import MedHopCore
        from tests.harness import make_temp_dir
        self.dir = make_temp_dir()
        self.now = datetime(2026, 11, 12, 8, 0, 30)
        self.core = MedHopCore(Settings(data_dir=self.dir, person_check="off"),
                               wall_clock=lambda: self.now.timestamp())
        self.dose = self.core.store.add_dose("08:00", "Morning")
        self.core.runner.set_auto_fly(True)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def due(self):
        written = self.core.care_monitor.tick(self.now)
        self.core._auto_fly_for_due(written, self.now)
        return [e for e in self.core.store.events(50)
                if e["type"] == "auto_run_skipped" and e["dose_id"] == self.dose["id"]]

    def test_not_ready_is_logged_once(self):
        skipped = self.due()
        self.assertEqual(len(skipped), 1)
        self.assertIn("not_ready", skipped[0]["detail"]["blockers"])
        self.assertEqual(len(self.due()), 1, "once per dose per day")

    def test_a_dose_time_already_past_does_not_fly(self):
        self.now = datetime(2026, 11, 12, 9, 30, 0)
        self.core.runner.mark_ready_for_dose()
        skipped = self.due()
        self.assertEqual(skipped[0]["detail"]["blockers"], ["stale_due"])
        self.assertEqual(self.core.runner.state, "idle")

    def test_ready_but_blocked_logs_the_blockers(self):
        self.core.runner.mark_ready_for_dose()
        skipped = self.due()
        self.assertIn("no_pilot_link", skipped[0]["detail"]["blockers"])
        self.assertEqual(self.core.runner.state, "idle")

    def test_switch_off_does_nothing(self):
        self.core.runner.set_auto_fly(False)
        self.assertEqual(self.due(), [])


class AutomaticClosedLoopTests(unittest.TestCase):
    """The whole automatic run in the simulator: on the ground, countdown, takeoff, find, fly, land."""

    def test_ground_to_station_on_five_seeds(self):
        for seed in range(5):
            with self.subTest(seed=seed):
                harness = SimHarness(SimConfig(seed=seed, start_airborne=False, start_distance_m=2.5,
                                               start_heading_deg=10.0 if seed % 2 else -10.0))
                try:
                    harness.warm_up(1.0)
                    started, blockers = harness.runner.start(False, "d1", automatic=True)
                    self.assertTrue(started, blockers)
                    harness.run(70.0, until=lambda h: h.runner.state in ("done", "aborted"))
                    harness.run(1.5)
                    pose = harness.sim.pose()
                    self.assertEqual((harness.runner.state, harness.runner.reason), ("done", None))
                    self.assertEqual(harness.sim.toggle_count, 2, "takeoff and landing, nothing else")
                    self.assertFalse(pose["airborne"])
                    self.assertGreater(pose["distance_m"], 0.5)
                    self.assertLess(pose["distance_m"], 0.95)
                    self.assertLess(abs(pose["x_m"]), 0.08, "on the sign's centre line, not beside it")
                    arrival = harness.runner.snapshot()["last_arrival"]
                    self.assertIs(arrival["aligned"], True)
                finally:
                    harness.close()


if __name__ == "__main__":
    unittest.main()
