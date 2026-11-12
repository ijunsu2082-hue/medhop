"""Closed-loop simulator tests of the station run and its failsafes (SPEC sections 5 and 6).

SimLink, marker detection on the rendered noisy camera, the mission runner and the mixer run together
in simulated time (see tests/harness.py). Nothing here sleeps or uses a real clock.
"""
import json
import logging
import unittest

from medhop.drone.sim import SimConfig
from medhop.mission.runner import RunnerConfig
from tests.harness import SimHarness

NEUTRAL = (0.0, 0.0, 0.0, 0.0)
SEEDS = range(10)


def setUpModule():
    logging.disable(logging.WARNING)


def tearDownModule():
    logging.disable(logging.NOTSET)


def make_harness(seed=0, drift=0.08, distance=2.5, heading=25.0, airborne=True, runner_config=None, **sim):
    config = SimConfig(seed=seed, lateral_drift=drift, start_distance_m=distance,
                       start_heading_deg=heading, start_airborne=airborne, **sim)
    harness = SimHarness(config, runner_config=runner_config)
    harness.warm_up(1.0)
    return harness


def run_station(seed, drift, trim_roll=0.0, distance=2.5, heading=None, limit_s=70.0, assist=False,
                land=True, **sim):
    """One full station run. Heading starts 25 degrees off, alternating side with the seed.

    `land` switches "land on arrival" on explicitly (it is off by default since SPEC 10.2), so these
    runs exercise the settle and the one landing toggle unless a test says otherwise."""
    heading = (25.0 if seed % 2 == 0 else -25.0) if heading is None else heading
    harness = make_harness(seed=seed, drift=drift, distance=distance, heading=heading, **sim)
    try:
        harness.runner.set_land_on_arrival(land)
        if trim_roll:
            harness.mixer.set_trim(trim_roll, 0.0)
        if assist:
            harness.runner.set_drift_assist(True)
        started, blockers = harness.runner.start(True, "d1")
        assert started, blockers
        t0 = harness.clock.t
        min_distance = [harness.sim.pose()["distance_m"]]

        def finished(h):
            min_distance[0] = min(min_distance[0], h.sim.pose()["distance_m"])
            return h.runner.state in ("done", "aborted")

        harness.run(limit_s, until=finished)
        at_end = harness.sim.pose()
        snapshot = harness.runner.snapshot()
        harness.run(0.5)                           # let the mixer settle after the run ended
        yaws = [axes[1] for t, axes in harness.sent if t > t0]
        closing = [e for e in harness.store.events(20) if e["type"] in ("arrived_at_station", "run_aborted")]
        trace_path = harness.data_dir / "runs" / f"{snapshot['run_id']}.json"
        return {
            "assist": snapshot["drift_assist"],
            "closing_detail": closing[0]["detail"] if closing else {},
            "trace_assist": json.loads(trace_path.read_text())["drift_assist"],
            "max_roll_sent": max(abs(axes[3] - trim_roll) for t, axes in harness.sent if t > t0),
            "max_throttle_sent": max(abs(axes[0]) for t, axes in harness.sent if t > t0),
            "seed": seed,
            "state": harness.runner.state,
            "reason": harness.runner.reason,
            "duration_s": harness.clock.t - 0.5 - t0,
            "wall_distance_m": at_end["distance_m"],
            "lateral_offset_m": at_end["x_m"],
            "min_wall_distance_m": min_distance[0],
            "toggles": harness.sim.toggle_count,
            "phase": at_end["phase"],
            "last_sent": harness.last_sent(),
            "yaw_reversals": sum(1 for a, b in zip(yaws, yaws[1:]) if a * b < 0),
            "events": [e["type"] for e in reversed(harness.store.events(20))],
        }
    finally:
        harness.close()


class StationRunTests(unittest.TestCase):
    def test_a_default_drift_reaches_done_on_ten_seeds(self):
        """2.5 m away, 25 degrees off, 0.08 m/s sideways drift, 0.45 s latency."""
        results = [run_station(seed, drift=0.08) for seed in SEEDS]
        done = [r for r in results if r["state"] == "done"]
        self.assertGreaterEqual(len(done), 8, [(r["seed"], r["reason"]) for r in results])
        for r in results:
            if r["state"] != "done":
                # Drifted beside the station: it must stop without landing there as "arrived".
                with self.subTest(seed=r["seed"], stopped=True):
                    self.assertIn(r["reason"], ("off_axis", "not_lined_up"))
                    self.assertEqual(r["toggles"], 0, "a manual run never toggles on an abort")
                    self.assertEqual(r["events"], ["run_started", "run_aborted"])
        for r in done:
            with self.subTest(seed=r["seed"]):
                self.assertEqual(r["toggles"], 1, "exactly one toggle on a successful run")
                self.assertEqual(r["events"], ["run_started", "arrived_at_station"])
                self.assertGreater(r["wall_distance_m"], 0.45)
                self.assertLess(r["wall_distance_m"], 0.85)
                self.assertGreater(r["min_wall_distance_m"], 0.45)
                self.assertLess(abs(r["lateral_offset_m"]), 0.95)
                self.assertLess(r["duration_s"], 30.0)
                self.assertLessEqual(r["yaw_reversals"], 3, "the yaw loop must not oscillate")
                self.assertEqual(r["last_sent"], NEUTRAL)

    def test_a_no_drift_stops_in_front_of_the_marker(self):
        for seed in (0, 1):
            r = run_station(seed, drift=0.0)
            self.assertEqual(r["state"], "done")
            self.assertEqual(r["toggles"], 1)
            self.assertLess(abs(r["lateral_offset_m"]), 0.15)
            self.assertGreater(r["wall_distance_m"], 0.55)
            self.assertLess(r["wall_distance_m"], 0.85)

    def test_a_trim_that_cancels_the_drift_removes_the_sideways_offset(self):
        for seed in (0, 1):
            r = run_station(seed, drift=0.08, trim_roll=-0.08)
            self.assertEqual(r["state"], "done")
            self.assertEqual(r["toggles"], 1)
            self.assertLess(abs(r["lateral_offset_m"]), 0.20)
            self.assertGreater(r["wall_distance_m"], 0.55)

    def test_b_strong_drift_never_ends_at_the_wall_and_never_toggles_on_abort(self):
        """0.20 m/s drift is outside what yaw-and-pitch steering can handle: it must fail safely."""
        results = [run_station(seed, drift=0.20) for seed in SEEDS]
        for r in results:
            with self.subTest(seed=r["seed"]):
                self.assertIn(r["state"], ("done", "aborted"))
                self.assertGreater(r["min_wall_distance_m"], 0.30, "must stop well before the wall")
                if r["state"] == "aborted":
                    self.assertEqual(r["toggles"], 0)
                    self.assertEqual(r["last_sent"], NEUTRAL)
                    self.assertEqual(r["events"], ["run_started", "run_aborted"])
                else:
                    self.assertEqual(r["toggles"], 1)
        self.assertGreaterEqual(sum(1 for r in results if r["reason"] == "off_axis"), 8)

    def test_run_stays_stable_with_twice_the_yaw_rate_and_more_latency(self):
        fast = run_station(0, drift=0.08, yaw_gain_deg=300.0)
        slow_video = run_station(1, drift=0.08, video_delay_s=0.55)
        for r in (fast, slow_video):
            self.assertEqual(r["state"], "done")
            self.assertLessEqual(r["yaw_reversals"], 3)


class DriftAssistSimTests(unittest.TestCase):
    """Drift assist in the closed loop: noisy rendered camera, 0.45 s latency, 25 degrees off at the start."""

    def test_h_off_sends_no_roll_at_all(self):
        r = run_station(0, drift=0.08)
        self.assertEqual(r["max_roll_sent"], 0.0)
        self.assertEqual(r["assist"], {"enabled": False, "active": False, "roll": 0.0, "disabled_reason": None,
                                       "suggested_trim_roll": None})

    def test_h_on_cuts_the_sideways_offset_at_the_default_drift(self):
        """Without the assist the same seeds end 0.48 to 0.75 m beside the sign (mean 0.60 m)."""
        results = [run_station(seed, drift=0.08 if seed % 3 else -0.08, assist=True) for seed in range(4)]
        for r in results:
            with self.subTest(seed=r["seed"]):
                self.assertEqual((r["state"], r["reason"]), ("done", None))
                self.assertEqual(r["toggles"], 1)
                self.assertLess(abs(r["lateral_offset_m"]), 0.30)
                self.assertGreater(r["min_wall_distance_m"], 0.45)
                self.assertLessEqual(r["max_roll_sent"], 0.15 + 1e-9)
                self.assertEqual(r["max_throttle_sent"], 0.0)
                self.assertLessEqual(r["yaw_reversals"], 3)
                self.assertEqual(r["last_sent"], NEUTRAL)
                self.assertIsNone(r["assist"]["disabled_reason"])
                self.assertIsNotNone(r["assist"]["suggested_trim_roll"])
                self.assertEqual(r["closing_detail"]["suggested_trim_roll"], r["assist"]["suggested_trim_roll"])
                self.assertNotIn("drift_assist_disabled", r["closing_detail"])
        mean = sum(abs(r["lateral_offset_m"]) for r in results) / len(results)
        self.assertLess(mean, 0.20)
        for r in results:      # the suggestion points against the drift and is no larger than the bound
            drift = 0.08 if r["seed"] % 3 else -0.08
            self.assertLess(r["assist"]["suggested_trim_roll"] * drift, 0.0)
            self.assertLessEqual(abs(r["assist"]["suggested_trim_roll"]), 0.15)

    def test_h_on_does_not_disturb_a_drone_that_does_not_drift(self):
        for seed in (0, 1):
            r = run_station(seed, drift=0.0, assist=True)
            self.assertEqual(r["state"], "done")
            self.assertLess(abs(r["lateral_offset_m"]), 0.15)
            self.assertIsNone(r["assist"]["disabled_reason"])
            self.assertLessEqual(r["max_roll_sent"], 0.15 + 1e-9)

    def test_h_strong_drift_with_the_assist_stays_bounded_and_away_from_the_wall(self):
        """0.20 m/s is more than 0.15 of roll can cancel: the roll sits at its bound, nothing more."""
        for seed in (0, 1, 2):
            r = run_station(seed, drift=0.20, assist=True)
            with self.subTest(seed=seed):
                self.assertIn(r["state"], ("done", "aborted"))
                self.assertLessEqual(r["max_roll_sent"], 0.15 + 1e-9)
                self.assertEqual(r["max_throttle_sent"], 0.0)
                self.assertGreater(r["min_wall_distance_m"], 0.40)
                self.assertEqual(r["toggles"], 1 if r["state"] == "done" else 0)
                self.assertEqual(r["last_sent"], NEUTRAL)

    def test_i_wrong_roll_sign_makes_the_assist_switch_itself_off(self):
        """The simulated drone answers roll the other way round (lateral_gain -1)."""
        for seed, drift in ((0, 0.08), (1, 0.08), (0, 0.20), (1, 0.20)):
            r = run_station(seed, drift=drift, assist=True, lateral_gain=-1.0)
            with self.subTest(seed=seed, drift=drift):
                self.assertEqual(r["assist"]["disabled_reason"], "off_axis_worsening")
                self.assertIs(r["assist"]["enabled"], True, "only this run: the switch stays on")
                self.assertIsNone(r["assist"]["suggested_trim_roll"])
                self.assertIs(r["closing_detail"]["drift_assist_disabled"], True)
                self.assertIs(r["trace_assist"]["drift_assist_disabled"], True)
                self.assertEqual(r["trace_assist"]["disabled_reason"], "off_axis_worsening")
                self.assertLessEqual(r["max_roll_sent"], 0.15 + 1e-9)
                self.assertGreater(r["min_wall_distance_m"], 0.40)
                self.assertIn(r["state"], ("done", "aborted"))
                if r["state"] == "aborted":
                    self.assertEqual(r["toggles"], 0, "an abort never sends the toggle")
                self.assertEqual(r["last_sent"], NEUTRAL)


class SettleDescentGuardTests(unittest.TestCase):
    """The drone starts to land by itself during the settle, slowly enough that the marker stays in view."""

    def settle_then_sink(self, runner_config=None, descent_m_s=0.4, start_after_s=0.0, land=True):
        """`start_after_s`: how far into the settle the drone starts to sink (the run is already settling)."""
        harness = make_harness(drift=0.0, heading=0.0, runner_config=runner_config)
        self.addCleanup(harness.close)
        harness.runner.set_land_on_arrival(land)
        harness.runner.start(True, None)
        self.assertTrue(harness.run_until_state("arrived", 40.0))
        self.assertEqual(harness.sim.toggle_count, 0)
        seen_before = len(harness.observations)
        if start_after_s:
            harness.run(start_after_s)
            self.assertEqual(harness.runner.state, "arrived")
        harness.sim.force_auto_land(descent_m_s=descent_m_s)   # sinks slowly instead of dropping out of view
        harness.run_until_state(("landing", "done", "aborted"), 5.0)
        in_settle = harness.observations[seen_before:]
        return harness, in_settle

    def test_e_auto_land_during_the_settle_aborts_with_unexpected_descent_and_does_not_toggle(self):
        for descent_m_s in (0.4, 0.25, 0.15):
            with self.subTest(descent_m_s=descent_m_s):
                harness, in_settle = self.settle_then_sink(descent_m_s=descent_m_s)
                self.assertEqual((harness.runner.state, harness.runner.reason), ("aborted", "unexpected_descent"))
                self.assertEqual(harness.sim.toggle_count, 0, "the toggle would launch the landing drone again")
                self.assertGreater(len(in_settle), 3)
                self.assertTrue(all(obs.marker is not None for obs in in_settle), "the marker never left the picture")
                # sign convention: the sinking camera sees the marker move UP the picture (cy smaller)
                self.assertLess(in_settle[-1].marker.cy, in_settle[0].marker.cy - 0.08)
                detail = harness.store.events(1)[0]["detail"]
                self.assertEqual((detail["reason"], detail["settle_descent"]), ("unexpected_descent", True))
                harness.run(1.0 / descent_m_s + 1.0)
                self.assertEqual(harness.sim.pose()["phase"], "ground", "it finished its own landing")
                self.assertEqual(harness.sim.toggle_count, 0)
                self.assertEqual(harness.last_sent(), NEUTRAL)
                events = [e["type"] for e in reversed(harness.store.events(10))]
                self.assertEqual(events, ["run_started", "run_aborted"])

    def test_e_auto_land_starting_late_in_the_settle_still_never_toggles(self):
        """0.35 s of video delay: with a 0.6 s settle, a descent starting 0.3 s in got the toggle."""
        for descent_m_s in (0.4, 0.25, 0.15):
            for start_after_s in (0.3, 0.6):
                with self.subTest(descent_m_s=descent_m_s, start_after_s=start_after_s):
                    harness, in_settle = self.settle_then_sink(descent_m_s=descent_m_s, start_after_s=start_after_s)
                    self.assertEqual((harness.runner.state, harness.runner.reason), ("aborted", "unexpected_descent"))
                    self.assertEqual(harness.sim.toggle_count, 0, "the toggle would launch the landing drone again")
                    harness.run(1.0 / descent_m_s + 1.0)
                    self.assertEqual(harness.sim.pose()["phase"], "ground", "it finished its own landing")
                    self.assertEqual(harness.sim.toggle_count, 0)
                    self.assertEqual(harness.last_sent(), NEUTRAL)
                    events = [e["type"] for e in reversed(harness.store.events(10))]
                    self.assertEqual(events, ["run_started", "run_aborted"])

    def test_e_auto_land_during_the_settle_with_land_on_arrival_off_ends_done_without_a_toggle(self):
        """The guard only protects the toggle: with land on arrival off the arrival stands."""
        for descent_m_s, start_after_s in ((0.25, 0.0), (0.15, 0.0), (0.4, 0.3)):
            with self.subTest(descent_m_s=descent_m_s, start_after_s=start_after_s):
                harness, in_settle = self.settle_then_sink(descent_m_s=descent_m_s, start_after_s=start_after_s,
                                                           land=False)
                self.assertEqual((harness.runner.state, harness.runner.reason), ("done", None))
                self.assertEqual(harness.sim.toggle_count, 0)
                closing = harness.store.events(1)[0]
                self.assertEqual(closing["type"], "arrived_at_station")
                self.assertIs(closing["detail"]["landing"], False)
                harness.run(1.0 / descent_m_s + 1.0)
                self.assertEqual(harness.sim.pose()["phase"], "ground", "it finished its own landing")
                self.assertEqual(harness.sim.toggle_count, 0)
                self.assertEqual(harness.last_sent(), NEUTRAL)

    def test_e_without_the_guard_the_same_scene_would_have_sent_the_toggle(self):
        """The reason for the guard: the marker is still in view and fresh, so nothing else stops it."""
        # 0.15 m/s keeps the marker in view for the whole 1.2 s settle (faster sinks leave the top of the
        # picture by its end and are stopped by the marker-fresh check instead)
        harness, in_settle = self.settle_then_sink(RunnerConfig(settle_descent_frac=0.0), descent_m_s=0.15)
        self.assertEqual(harness.runner.state, "landing")
        self.assertEqual(harness.sim.toggle_count, 1)
        self.assertTrue(all(obs.marker is not None for obs in in_settle))
        sunk_to = harness.sim.pose()["altitude_m"]
        self.assertLess(sunk_to, 0.85)
        harness.run(1.5)
        pose = harness.sim.pose()
        self.assertIn(pose["phase"], ("taking_off", "airborne"), "the toggle launched the sinking drone again")
        self.assertGreater(pose["altitude_m"], sunk_to)

    def test_e_normal_hover_bob_during_the_settle_does_not_trip_the_guard(self):
        for seed in SEEDS:
            with self.subTest(seed=seed):
                harness = make_harness(seed=seed, drift=0.0, heading=0.0)
                self.addCleanup(harness.close)
                harness.runner.set_land_on_arrival(True)
                harness.runner.start(True, None)
                self.assertTrue(harness.run_until_state(("done", "aborted"), 60.0))
                self.assertEqual((harness.runner.state, harness.runner.reason, harness.sim.toggle_count),
                                 ("done", None, 1))


class FailsafeTests(unittest.TestCase):
    def start_approach(self, seconds=5.0, **kwargs):
        harness = make_harness(**kwargs)
        self.addCleanup(harness.close)
        started, blockers = harness.runner.start(True, "d1")
        self.assertTrue(started, blockers)
        harness.run(seconds)
        self.assertEqual(harness.runner.state, "approaching")
        self.assertGreater(harness.last_sent()[2], 0.1, "should be flying forward by now")
        return harness

    def assert_safe_abort(self, harness, reason):
        self.assertEqual((harness.runner.state, harness.runner.reason), ("aborted", reason))
        self.assertEqual(harness.sim.toggle_count, 0, "an abort must never send the toggle")
        harness.run(0.5)
        self.assertEqual(harness.last_sent(), NEUTRAL)
        events = [e["type"] for e in reversed(harness.store.events(10))]
        self.assertEqual(events, ["run_started", "run_aborted"])

    def test_c_marker_hidden_mid_approach_aborts_with_marker_lost(self):
        harness = self.start_approach()
        harness.sim.drop_marker(True)
        hidden_at = harness.clock.t
        self.assertTrue(harness.run_until_state("aborted", 10.0))
        self.assert_safe_abort(harness, "marker_lost")
        # hidden frames arrive after the video delay, then 0.6 s hold + 2.0 s creep search
        self.assertAlmostEqual(harness.clock.t - 0.5 - hidden_at, 0.35 + 2.6, delta=0.35)

    def test_d_video_freeze_goes_neutral_within_half_a_second_then_aborts(self):
        harness = self.start_approach()
        harness.sim.freeze_video(True)
        frozen_at = harness.clock.t
        self.assertTrue(harness.run(2.0, until=lambda h: h.last_sent() == NEUTRAL))
        neutral_after = harness.clock.t - frozen_at
        self.assertLessEqual(neutral_after, 0.5)
        self.assertTrue(harness.run_until_state("aborted", 3.0))
        self.assertAlmostEqual(harness.clock.t - frozen_at, 1.5, delta=0.15)
        sent_while_frozen = [axes for t, axes in harness.sent if t > frozen_at + 0.5]
        self.assertTrue(all(axes == NEUTRAL for axes in sent_while_frozen))
        self.assert_safe_abort(harness, "video_stale")

    def test_d_mixer_alone_forces_neutral_on_stale_video(self):
        """Even if something kept issuing fresh mission commands, the mixer's own video check stops them."""
        harness = make_harness(heading=0.0)
        self.addCleanup(harness.close)
        harness.sim.freeze_video(True)
        frozen_at = harness.clock.t
        neutral_at = None
        while harness.clock.t - frozen_at < 1.0:
            harness.mixer.mission_command(0.1, 0.2)
            harness.step()
            if neutral_at is None and harness.clock.t - frozen_at > 0.1 and harness.last_sent() == NEUTRAL:
                neutral_at = harness.clock.t - frozen_at
        self.assertIsNotNone(neutral_at)
        self.assertLessEqual(neutral_at, 0.56)       # 0.5 s frame age plus one 20 Hz control tick
        self.assertEqual(harness.last_sent(), NEUTRAL)

    def test_e_auto_land_mid_approach_never_reports_arrival_and_never_toggles(self):
        harness = self.start_approach()
        harness.sim.force_auto_land()
        harness.run(3.0)
        self.assertEqual(harness.sim.pose()["phase"], "ground")
        harness.run_until_state(("done", "aborted"), 50.0)
        self.assertEqual(harness.runner.state, "aborted")
        self.assertIn(harness.runner.reason, ("marker_lost", "timeout"))
        self.assertEqual(harness.sim.toggle_count, 0, "the toggle would launch the landed drone")
        self.assertEqual(harness.sim.pose()["phase"], "ground")
        events = [e["type"] for e in reversed(harness.store.events(10))]
        self.assertNotIn("arrived_at_station", events)
        self.assertEqual(events[-1], "run_aborted")
        harness.run(0.5)
        self.assertEqual(harness.last_sent(), NEUTRAL)

    def test_e_auto_land_just_before_arrival_never_toggles(self):
        """Land when the marker is already almost at the arrive width: the tightest case."""
        harness = make_harness(drift=0.0, heading=0.0)
        self.addCleanup(harness.close)
        harness.runner.start(True, None)
        harness.run(30.0, until=lambda h: h.observations[-1].marker is not None
                    and h.observations[-1].marker.width >= 0.14)
        self.assertEqual(harness.runner.state, "approaching")
        harness.sim.force_auto_land()
        harness.run_until_state(("done", "aborted"), 50.0)
        self.assertEqual(harness.runner.state, "aborted")
        self.assertEqual(harness.sim.toggle_count, 0)
        self.assertEqual(harness.sim.pose()["phase"], "ground")

    def test_e_low_battery_telemetry_aborts_with_battery_low(self):
        harness = self.start_approach()
        harness.settings.battery_low_raw = 35          # the check is off by default (SPEC 10.2)
        harness.sim.force_auto_land(drop_battery=True)
        self.assertTrue(harness.run_until_state("aborted", 5.0))
        self.assert_safe_abort(harness, "battery_low")

    def test_e_low_battery_byte_is_ignored_while_the_check_is_disabled(self):
        harness = self.start_approach()
        self.assertFalse(harness.settings.battery_check_enabled)
        harness.sim.set_battery_raw(0)
        harness.run(2.0)
        self.assertEqual(harness.sim.telemetry().battery_raw, 0)
        self.assertEqual(harness.runner.state, "approaching")
        self.assertNotIn("battery_low", harness.runner.blockers())

    def test_e_stale_low_battery_telemetry_makes_no_decision(self):
        """The MCU stopped reporting: the last (low) byte is older than 3.0 s and decides nothing."""
        harness = self.start_approach()
        harness.settings.battery_low_raw = 35
        last = harness.sim.telemetry()
        frozen = type(last)(last.fly_state_raw, 30, last.flags_raw, harness.clock.t - 3.5)
        harness.sim.telemetry = lambda: frozen         # instance attribute: only this harness's link
        harness.run(2.0)
        self.assertEqual(harness.runner.state, "approaching")
        harness.sim.telemetry = lambda: type(last)(last.fly_state_raw, 30, last.flags_raw, harness.clock.t)
        self.assertTrue(harness.run_until_state("aborted", 1.0))
        self.assert_safe_abort(harness, "battery_low")

    def test_drone_on_the_ground_from_the_start_never_arrives(self):
        harness = make_harness(airborne=False, heading=0.0, distance=1.2)
        self.addCleanup(harness.close)
        started, _ = harness.runner.start(True, None)     # the pilot wrongly confirmed "airborne"
        self.assertTrue(started)
        harness.run_until_state(("done", "aborted"), 50.0)
        self.assertEqual(harness.runner.state, "aborted")
        self.assertEqual(harness.sim.toggle_count, 0)
        self.assertEqual(harness.sim.pose()["phase"], "ground")

    def test_f_pilot_input_mid_run_aborts_with_pilot_took_over(self):
        harness = self.start_approach()
        for _ in range(12):                                # the pilot holds "back" for 0.6 s
            harness.mixer.pilot_axes(0.0, 0.0, -1.0, 0.0)
            harness.run(0.05)
        self.assertEqual((harness.runner.state, harness.runner.reason), ("aborted", "pilot_took_over"))
        self.assertLess(harness.last_sent()[2], -0.3, "the pilot's stick is what reaches the drone")
        harness.mixer.pilot_axes(0.0, 0.0, 0.0, 0.0)
        harness.run(1.0)
        self.assert_safe_abort(harness, "pilot_took_over")

    def test_f_pilot_disconnect_zeroes_pilot_axes_at_once(self):
        harness = make_harness(heading=0.0)
        self.addCleanup(harness.close)
        for _ in range(10):
            harness.mixer.pilot_axes(0.0, 0.0, 1.0, 0.0)
            harness.run(0.05)
        self.assertGreater(harness.last_sent()[2], 0.4)
        harness.mixer.pilot_disconnect()
        harness.run(0.06)
        self.assertEqual(harness.last_sent(), NEUTRAL)

    def test_person_in_view_aborts(self):
        from medhop.vision.person import PersonStatus

        harness = self.start_approach()
        harness.person = PersonStatus(enabled=True, detected=True, count=1, ts=harness.clock.t)
        self.assertTrue(harness.run_until_state("aborted", 1.0))
        self.assert_safe_abort(harness, "person_in_view")

    def test_marker_not_found_when_facing_away(self):
        harness = make_harness(heading=0.0)
        self.addCleanup(harness.close)
        harness.sim.drop_marker(True)
        harness.run(1.0)
        started, blockers = harness.runner.start(True, None)
        self.assertTrue(started, blockers)
        self.assertEqual(harness.runner.state, "searching")
        heading_before = harness.sim.pose()["heading_deg"]
        self.assertTrue(harness.run_until_state("aborted", 14.0))
        self.assertGreater(harness.sim.pose()["heading_deg"] - heading_before, 150.0)   # 0.12 * 150 deg/s * 12 s
        self.assert_safe_abort(harness, "marker_not_found")

    def test_search_turns_until_the_marker_is_found_then_arrives(self):
        harness = make_harness(drift=0.0, heading=-70.0, distance=2.0)
        self.addCleanup(harness.close)
        self.assertIsNone(harness.observations[-1].marker)
        harness.runner.set_land_on_arrival(True)
        harness.runner.start(True, None)
        self.assertEqual(harness.runner.state, "searching")
        self.assertTrue(harness.run_until_state(("done", "aborted"), 60.0))
        self.assertEqual(harness.runner.state, "done")
        self.assertEqual(harness.sim.toggle_count, 1)


class HoverTestSimTests(unittest.TestCase):
    def hover(self, drift, seed=0):
        harness = make_harness(seed=seed, drift=drift, heading=0.0)
        self.addCleanup(harness.close)
        x_before = harness.sim.pose()["x_m"]
        started, problems = harness.runner.start_hover_test()
        self.assertTrue(started, problems)
        self.assertTrue(harness.run(12.0, until=lambda h: h.runner.state == "idle"))
        result = harness.runner.hover_snapshot()["result"]
        self.assertTrue(all(axes == NEUTRAL for _t, axes in harness.sent[-190:]), "hover test sends neutral")
        return result, harness.sim.pose()["x_m"] - x_before

    def test_g_drift_estimate_is_within_30_percent_of_truth(self):
        for seed in (0, 1, 2):
            result, true_drift = self.hover(0.08, seed)
            self.assertAlmostEqual(true_drift, 0.8, delta=0.12)
            self.assertAlmostEqual(result["drift_m_estimate"], true_drift, delta=0.30 * true_drift)
            self.assertFalse(result["pass"])                      # 0.8 m in 10 s is more than 0.5 m
            self.assertGreaterEqual(result["visible_pct"], 95.0)

    def test_g_small_drift_passes(self):
        result, true_drift = self.hover(0.03)
        self.assertAlmostEqual(result["drift_m_estimate"], true_drift, delta=0.1)
        self.assertTrue(result["pass"])

    def test_g_steady_hover_passes_on_the_peak_excursion(self):
        result, true_drift = self.hover(0.0)
        self.assertLess(abs(true_drift), 0.1)
        self.assertLessEqual(result["peak_excursion_m"], result["limit_m"])
        self.assertEqual(result["limit_m"], 0.5)
        self.assertTrue(result["pass"])

    def test_g_drifting_out_and_back_fails_on_the_peak_excursion(self):
        """0.12 m/s one way for 5 s, then back: start and end nearly agree, the peak does not."""
        harness = make_harness(seed=0, drift=0.12, heading=0.0)
        self.addCleanup(harness.close)
        x_before = harness.sim.pose()["x_m"]
        xs = []
        self.assertTrue(harness.runner.start_hover_test()[0])
        harness.run(5.0, until=lambda h: xs.append(h.sim.pose()["x_m"]) and False)
        harness.sim.set_drift(-0.12)
        self.assertTrue(harness.run(7.0, until=lambda h: xs.append(h.sim.pose()["x_m"]) or h.runner.state == "idle"))
        result = harness.runner.hover_snapshot()["result"]
        true_peak = max(xs) - min(xs)
        self.assertGreater(true_peak, 0.5)
        self.assertLess(abs(harness.sim.pose()["x_m"] - x_before), 0.25, "it came back")
        self.assertLess(abs(result["drift_m_estimate"]), 0.3, "start versus end alone would have passed")
        self.assertAlmostEqual(result["peak_excursion_m"], true_peak, delta=0.30 * true_peak)
        self.assertGreater(result["peak_excursion_m"], result["limit_m"])
        self.assertFalse(result["pass"])

    def test_g_drift_direction_has_the_right_sign(self):
        result, true_drift = self.hover(-0.04)
        self.assertLess(true_drift, 0.0)
        self.assertLess(result["drift_m_estimate"], 0.0)


class SimulatorTests(unittest.TestCase):
    def test_command_to_video_latency_is_about_0_45_s(self):
        harness = make_harness(drift=0.0, heading=0.0, noise_yaw_deg=0.0, noise_velocity=0.0)
        self.addCleanup(harness.close)
        cx_before = harness.observations[-1].marker.cx
        t0 = harness.clock.t
        seen_at = None
        while harness.clock.t - t0 < 2.0 and seen_at is None:
            harness.mixer.pilot_axes(0.0, 1.0, 0.0, 0.0)       # yaw right: the marker moves left
            harness.step()
            marker = harness.observations[-1].marker
            if marker is not None and cx_before - marker.cx > 0.01:
                seen_at = harness.clock.t - t0
        self.assertIsNotNone(seen_at)
        self.assertGreater(seen_at, 0.40)
        self.assertLess(seen_at, 0.70)

    def test_toggle_takes_off_in_about_1_5_s_and_lands_in_the_air(self):
        harness = make_harness(airborne=False, heading=0.0)
        self.addCleanup(harness.close)
        self.assertEqual(harness.sim.pose()["phase"], "ground")
        harness.mixer.pilot_toggle()
        harness.run(1.2)
        self.assertFalse(harness.sim.pose()["airborne"])
        harness.run(0.6)
        self.assertTrue(harness.sim.pose()["airborne"])
        harness.mixer.pilot_toggle()
        harness.run(2.0)
        self.assertEqual(harness.sim.pose()["phase"], "ground")
        self.assertEqual(harness.sim.toggle_count, 2)

    def test_sticks_do_nothing_on_the_ground_and_estop_drops_the_drone(self):
        harness = make_harness(airborne=False, heading=0.0, drift=0.08)
        self.addCleanup(harness.close)
        before = harness.sim.pose()
        for _ in range(20):
            harness.mixer.pilot_axes(0.0, 1.0, 1.0, 1.0)
            harness.run(0.05)
        after = harness.sim.pose()
        self.assertEqual((before["x_m"], before["distance_m"], before["heading_deg"]),
                         (after["x_m"], after["distance_m"], after["heading_deg"]))
        harness.sim.set_pose(airborne=True)
        harness.run(0.5)
        harness.mixer.pilot_estop()
        harness.run(0.3)
        self.assertEqual(harness.sim.pose()["phase"], "ground")
        self.assertGreaterEqual(harness.sim.estop_count, 1, "the latched stop is asserted on every tick (SPEC 10.1)")
        self.assertEqual(harness.last_sent(), NEUTRAL)
        harness.run(1.0)
        self.assertEqual(harness.sim.pose()["phase"], "ground", "it stays down while the stop is latched")

    def test_telemetry_is_simulated_and_frames_arrive_at_about_15_fps(self):
        harness = make_harness(heading=0.0)
        self.addCleanup(harness.close)
        first = harness.sim.latest_frame().seq
        harness.run(2.0)
        self.assertAlmostEqual((harness.sim.latest_frame().seq - first) / 2.0, 15.0, delta=1.0)
        telemetry = harness.sim.telemetry()
        self.assertEqual((telemetry.fly_state_raw, telemetry.battery_raw, telemetry.flags_raw), (1, 42, 16))


if __name__ == "__main__":
    unittest.main()
