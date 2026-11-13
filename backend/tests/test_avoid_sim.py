"""Closed-loop simulator tests of the experimental obstacle avoidance ("hold", SPEC section 11).

Automatic runs from the ground (countdown, takeoff, search, approach) in the drone-like camera
profile, with the named scenarios' simulated people and objects, sideways drift +-0.08 m/s and a 5
degree heading error alternating with the seed. Clearance is simulator truth: the smallest horizontal
distance between the drone and any actor's footprint while the drone is in the air.

By default each scenario runs on the first few seeds (a quick check that keeps the suite short). Set
MEDHOP_LONG_TESTS=1 for the full counts the acceptance figures in SPEC 11.7 come from: 20 seeds each
for crossing, standing and blocked.
"""
import logging
import os
import unittest

from medhop.drone.sim import SimConfig
from medhop.drone.sim_actors import SCENARIOS
from medhop.mission.runner import RunnerConfig
from medhop.vision.person import PersonStatus
from tests.harness import SimHarness

LONG = os.environ.get("MEDHOP_LONG_TESTS", "").strip() == "1"
SEEDS = range(20) if LONG else range(3)
SAME_COMMAND_SEEDS = (0, 1) if LONG else (0,)
CLEARANCE_M = 0.5
_CACHE = {}


def setUpModule():
    logging.disable(logging.WARNING)


def tearDownModule():
    logging.disable(logging.NOTSET)


def make(seed, scenario, mode):
    sc = SCENARIOS[scenario]
    config = SimConfig(seed=seed, start_airborne=False, start_distance_m=sc.start_distance_m or 2.5,
                       start_heading_deg=5.0 if seed % 3 == 0 else -5.0,
                       lateral_drift=0.08 if seed % 2 == 0 else -0.08, actors=sc.actors)
    harness = SimHarness(config, runner_config=RunnerConfig(avoid=mode))
    harness.warm_up(1.0)
    return harness


def fly(seed, scenario, mode, limit_s=150.0, person_at_s=None):
    """One automatic run. `person_at_s`: from this many seconds after the start the person check
    reports someone (a fresh result every step)."""
    harness = make(seed, scenario, mode)
    try:
        started, blockers = harness.runner.start(False, "d1", automatic=True)
        assert started, blockers
        t0 = harness.clock.t
        info = {"clearance": float("inf"), "hidden_s": 0.0, "missing_since": None, "min_wall": float("inf")}

        def watch(h):
            pose = h.sim.pose()
            if pose["altitude_m"] > 0.2:
                info["min_wall"] = min(info["min_wall"], pose["distance_m"])
                clearance = h.sim.clearance_m()
                if clearance is not None:
                    info["clearance"] = min(info["clearance"], clearance)
            if person_at_s is not None and h.clock.t - t0 >= person_at_s:
                h.person = PersonStatus(enabled=True, detected=True, count=1, ts=h.clock.t)
            if h.observations and h.runner.state == "approaching":
                obs = h.observations[-1]
                if obs.marker is None:
                    info["missing_since"] = info["missing_since"] or obs.ts
                    info["hidden_s"] = max(info["hidden_s"], obs.ts - info["missing_since"])
                else:
                    info["missing_since"] = None
            return h.runner.state in ("done", "aborted")

        harness.run(limit_s, until=watch)
        duration = harness.clock.t - t0
        snapshot = harness.runner.snapshot()
        harness.run(3.0)                       # let a landing finish
        pose = harness.sim.pose()
        closing = [e for e in harness.store.events(20) if e["type"] in ("arrived_at_station", "run_aborted")]
        return {
            "seed": seed, "state": harness.runner.state, "reason": harness.runner.reason,
            "duration_s": duration, "clearance_m": info["clearance"], "hidden_s": info["hidden_s"],
            "min_wall_m": info["min_wall"], "x_m": pose["x_m"], "distance_m": pose["distance_m"],
            "airborne": pose["airborne"], "toggles": harness.sim.toggle_count,
            "last_landing": snapshot["last_landing"], "needs_pilot": snapshot["needs_pilot"],
            "avoid": snapshot["avoid"], "closing": closing[0]["detail"] if closing else {},
        }
    finally:
        harness.close()


def results(scenario, mode="hold"):
    key = (scenario, mode)
    if key not in _CACHE:
        _CACHE[key] = [fly(seed, scenario, mode) for seed in SEEDS]
    return _CACHE[key]


class AvoidSimTestCase(unittest.TestCase):
    def assert_clearance(self, rows):
        for r in rows:
            self.assertGreater(r["clearance_m"], CLEARANCE_M, (r["seed"], r["clearance_m"]))

    def assert_landed_at_the_station(self, r):
        self.assertEqual((r["state"], r["reason"]), ("done", None), r)
        self.assertEqual(r["toggles"], 2, "takeoff and the landing")
        self.assertFalse(r["airborne"])
        self.assertGreater(r["distance_m"], 0.33)
        self.assertLess(r["distance_m"], 0.6)
        self.assertLess(abs(r["x_m"]), 0.08, "on the sign's centre line")

    def assert_landed_where_it_was(self, r):
        self.assertEqual((r["state"], r["reason"]), ("aborted", "path_blocked"), r)
        self.assertEqual(r["closing"]["blocked_by"], "timeout")
        self.assertEqual(r["toggles"], 2, "takeoff and the landing where it is")
        self.assertEqual(r["last_landing"], "safe_landing")
        self.assertFalse(r["airborne"])
        self.assertFalse(r["needs_pilot"])


class CrossingTests(AvoidSimTestCase):
    def test_holds_resumes_and_lands_at_the_station(self):
        """At least 19 of 20 seeds in the long run; every seed of the short run."""
        rows = results("crossing")
        self.assert_clearance(rows)
        done = [r for r in rows if r["state"] == "done"]
        self.assertGreaterEqual(len(done), 19 if LONG else len(rows), [(r["seed"], r["reason"]) for r in rows])
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assertGreaterEqual(r["avoid"]["held_s"], 1.0, "it held while the person crossed")
                if r["state"] == "done":
                    self.assert_landed_at_the_station(r)
                else:
                    self.assertEqual((r["toggles"], r["last_landing"]), (2, "safe_landing"), r)


class StandingTests(AvoidSimTestCase):
    def test_ends_path_blocked_and_always_lands_where_it_is(self):
        rows = results("standing")
        self.assert_clearance(rows)
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assert_landed_where_it_was(r)

    def test_a_person_hiding_the_sign_is_not_marker_lost(self):
        """Without "hidden", marker_lost comes after lost_hold_s + lost_creep_s (0.6 + 2.0 s) without the
        sign. In every run the sign was hidden longer than that at a stretch (2.9 to 25 s; it peeks out
        past the person now and then) and the run never ended marker_lost."""
        cfg = RunnerConfig()
        for r in results("standing"):
            with self.subTest(seed=r["seed"]):
                self.assertGreater(r["hidden_s"], cfg.lost_hold_s + cfg.lost_creep_s)
                self.assertNotEqual(r["reason"], "marker_lost")


class BlockedTests(AvoidSimTestCase):
    def test_ends_path_blocked_and_always_lands_where_it_is(self):
        rows = results("blocked")
        self.assert_clearance(rows)
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assert_landed_where_it_was(r)


class CartTests(unittest.TestCase):
    def test_a_cart_in_the_lane_refuses_the_start_before_takeoff(self):
        for mode in ("off", "hold"):
            with self.subTest(mode=mode):
                harness = make(0, "cart", mode)
                try:
                    blockers = harness.runner.blockers()
                    self.assertIn("obstacle_in_view", blockers)
                    self.assertNotIn("person_in_view", blockers)
                    self.assertEqual(harness.runner.start(False, "d1", automatic=True),
                                     (False, ["obstacle_in_view"]))
                    self.assertEqual(harness.runner.start(True, "d1"), (False, ["obstacle_in_view"]))
                    harness.run(2.0)
                    self.assertEqual(harness.runner.state, "idle")
                    self.assertEqual(harness.sim.toggle_count, 0, "never took off")
                    self.assertFalse(harness.sim.pose()["airborne"])
                finally:
                    harness.close()


class OffTests(AvoidSimTestCase):
    def test_off_stops_the_run_for_a_person_as_before(self):
        with self.subTest(source="person check"):
            r = fly(0, "empty", "off", person_at_s=13.0)
            self.assertEqual((r["state"], r["reason"]), ("aborted", "person_in_view"))
        with self.subTest(source="simulated person"):
            r = fly(1, "crossing", "off")
            self.assertEqual((r["state"], r["reason"]), ("aborted", "person_in_view"))
            self.assertNotIn("avoid", r["closing"])


class SameCommandsTests(unittest.TestCase):
    """With nothing in the corridor, "hold" sends exactly what "off" sends, step for step."""

    def sent(self, mode, seed, automatic):
        harness = make(seed, "empty", mode) if automatic else SimHarness(
            SimConfig(seed=seed, start_heading_deg=20.0, start_airborne=True), runner_config=RunnerConfig(avoid=mode))
        try:
            if not automatic:
                harness.warm_up(1.0)
            harness.runner.set_land_on_arrival(True)
            assert harness.runner.start(not automatic, "d1", automatic=automatic)[0]
            harness.run(70.0, until=lambda h: h.runner.state in ("done", "aborted"))
            harness.run(1.0)
            return harness.sent, harness.runner.state
        finally:
            harness.close()

    def test_hold_with_no_actors_sends_the_same_commands_as_off(self):
        for automatic in (True, False):
            for seed in SAME_COMMAND_SEEDS:
                with self.subTest(automatic=automatic, seed=seed):
                    off, off_state = self.sent("off", seed, automatic)
                    on, on_state = self.sent("hold", seed, automatic)
                    self.assertEqual(off_state, "done")
                    self.assertEqual(on_state, off_state)
                    self.assertEqual(len(on), len(off))
                    self.assertEqual(on, off)


if __name__ == "__main__":
    unittest.main()
