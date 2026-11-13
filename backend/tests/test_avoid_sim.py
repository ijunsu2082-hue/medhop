"""Closed-loop simulator tests of the experimental obstacle avoidance (SPEC section 11).

Automatic runs from the ground (countdown, takeoff, search, approach) in the drone-like camera profile,
with the named scenarios' simulated people and objects. Every scenario runs on 10 seeds (sideways drift
+-0.08 m/s and a 5 degree heading error, alternating). Clearance is simulator truth: the smallest
horizontal distance between the drone and any actor's footprint while the drone is in the air.

Going round ("pass") is NOT reliable: on 20 seeds it ended done on 1 run with a person standing in the
lane and on none with the cart (SPEC 11.7). Those two "done on at least 9 of 10" tests are marked as
expected failures so the suite says so instead of hiding it; the safety properties that do hold for
them (clearance, landing only on evidence) are asserted normally.
"""
import logging
import unittest

from medhop.drone.sim import SimConfig
from medhop.drone.sim_actors import SCENARIOS
from medhop.mission.runner import RunnerConfig
from medhop.vision.person import PersonStatus
from tests.harness import SimHarness

SEEDS = range(10)
CLEARANCE_M = 0.5
_CACHE = {}


def setUpModule():
    logging.disable(logging.WARNING)


def tearDownModule():
    logging.disable(logging.NOTSET)


def make(seed, scenario, mode, actors=None):
    sc = SCENARIOS[scenario]
    config = SimConfig(seed=seed, start_airborne=False, start_distance_m=sc.start_distance_m or 2.5,
                       start_heading_deg=5.0 if seed % 3 == 0 else -5.0,
                       lateral_drift=0.08 if seed % 2 == 0 else -0.08,
                       actors=sc.actors if actors is None else actors)
    harness = SimHarness(config, runner_config=RunnerConfig(avoid=mode))
    harness.warm_up(1.0)
    return harness


def fly(seed, scenario, mode, limit_s=150.0, person_at=None):
    """One automatic run. `person_at`: (seconds after start, PersonStatus) to inject a person-check result."""
    harness = make(seed, scenario, mode)
    try:
        started, blockers = harness.runner.start(False, "d1", automatic=True)
        assert started, blockers
        t0 = harness.clock.t
        info = {"clearance": float("inf"), "hidden_s": 0.0, "missing_since": None}

        def watch(h):
            clearance = h.sim.clearance_m()
            if clearance is not None and h.sim.pose()["altitude_m"] > 0.2:
                info["clearance"] = min(info["clearance"], clearance)
            if person_at is not None and h.clock.t - t0 >= person_at[0]:
                h.person = person_at[1]._replace(ts=h.clock.t) if hasattr(person_at[1], "_replace") else \
                    PersonStatus(enabled=True, detected=True, count=1, ts=h.clock.t)
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
            "x_m": pose["x_m"], "distance_m": pose["distance_m"], "airborne": pose["airborne"],
            "toggles": harness.sim.toggle_count, "last_landing": snapshot["last_landing"],
            "needs_pilot": snapshot["needs_pilot"], "avoid": snapshot["avoid"],
            "closing": closing[0]["detail"] if closing else {},
            "aligned": (snapshot["last_arrival"] or {}).get("aligned"),
        }
    finally:
        harness.close()


def results(scenario, mode):
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
        self.assertEqual(r["toggles"], 2, "takeoff and the landing where it is")
        self.assertEqual(r["last_landing"], "safe_landing")
        self.assertFalse(r["airborne"])
        self.assertFalse(r["needs_pilot"])


class CrossingTests(AvoidSimTestCase):
    def check(self, mode):
        """Done on at least 9 of 10 seeds. Seed 3 (both modes) resumes 3.4 m out, overshoots the landing
        distance (0.37 m when the line-up starts) and the line-up stops with not_lined_up, then lands where
        it is: the existing approach's overshoot (tests/test_sim_closed_loop.py allows 0.31 m), met here
        because the hold changed the timing; without actors the same seeds all end done."""
        rows = results("crossing", mode)
        self.assert_clearance(rows)
        self.assertGreaterEqual(sum(1 for r in rows if r["state"] == "done"), 9,
                                [(r["seed"], r["reason"]) for r in rows])
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assertGreaterEqual(r["avoid"]["held_s"], 1.0, "it held while the person crossed")
                self.assertEqual(r["closing"]["avoid"]["passes"], 0, "nobody to go round")
                if r["state"] == "done":
                    self.assert_landed_at_the_station(r)
                else:
                    self.assertIn(r["reason"], ("not_lined_up", "off_axis"))
                    self.assertEqual((r["toggles"], r["last_landing"]), (2, "safe_landing"))

    def test_hold_holds_resumes_and_lands(self):
        self.check("hold")

    def test_pass_holds_resumes_and_lands(self):
        self.check("pass")


class StandingTests(AvoidSimTestCase):
    def test_hold_ends_path_blocked_and_lands_where_it_is(self):
        rows = results("standing", "hold")
        self.assert_clearance(rows)
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assert_landed_where_it_was(r)
                self.assertEqual(r["closing"]["blocked_by"], "timeout")

    def test_a_person_hiding_the_sign_is_not_marker_lost(self):
        for r in results("standing", "hold"):
            with self.subTest(seed=r["seed"]):
                # marker_lost comes after 0.6 + 2.0 s without the sign; it was hidden longer than that
                # (4.8 to 25 s; it peeks out past the person now and then as the drone drifts)
                self.assertGreater(r["hidden_s"], 2.6 + 1.0)
                self.assertNotEqual(r["reason"], "marker_lost")

    def test_pass_keeps_its_distance_and_never_lands_without_evidence(self):
        rows = results("standing", "pass")
        self.assert_clearance(rows)
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assertIn((r["state"], r["reason"]), {("done", None), ("aborted", "path_blocked"),
                                                          ("aborted", "off_axis"), ("aborted", "marker_not_found")})
                if r["state"] == "done":
                    self.assert_landed_at_the_station(r)
                elif r["toggles"] == 2:
                    self.assertEqual(r["last_landing"], "safe_landing")
                else:
                    self.assertTrue(r["needs_pilot"], "no landing evidence: it says a pilot is needed")

    @unittest.expectedFailure
    def test_pass_goes_round_and_arrives_on_nine_of_ten_seeds(self):
        """Not met: see the module docstring and SPEC 11.7."""
        done = sum(1 for r in results("standing", "pass") if r["state"] == "done")
        self.assertGreaterEqual(done, 9)


class CartTests(AvoidSimTestCase):
    def test_pass_keeps_its_distance_and_never_lands_without_evidence(self):
        rows = results("cart", "pass")
        self.assert_clearance(rows)
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assertIn((r["state"], r["reason"]), {("done", None), ("aborted", "path_blocked"),
                                                          ("aborted", "off_axis"), ("aborted", "marker_not_found")})
                if r["state"] == "done":
                    self.assert_landed_at_the_station(r)
                elif r["toggles"] == 2:
                    self.assertEqual(r["last_landing"], "safe_landing")
                else:
                    self.assertTrue(r["needs_pilot"])

    @unittest.expectedFailure
    def test_pass_goes_round_and_arrives_on_nine_of_ten_seeds(self):
        """Not met: see the module docstring and SPEC 11.7."""
        done = sum(1 for r in results("cart", "pass") if r["state"] == "done")
        self.assertGreaterEqual(done, 9)


class BlockedTests(AvoidSimTestCase):
    def check(self, mode):
        rows = results("blocked", mode)
        self.assert_clearance(rows)
        for r in rows:
            with self.subTest(seed=r["seed"]):
                self.assert_landed_where_it_was(r)

    def test_hold_ends_path_blocked_and_lands(self):
        self.check("hold")

    def test_pass_finds_no_way_round_and_lands(self):
        self.check("pass")
        self.assertTrue(all(r["closing"]["blocked_by"] in ("no_way_round", "timeout") for r in results("blocked", "pass")))


class OffTests(AvoidSimTestCase):
    def test_off_stops_the_run_for_a_person_as_before(self):
        for seed in (0, 1):
            with self.subTest(seed=seed, source="person check"):
                r = fly(seed, "empty", "off", person_at=(13.0, None))
                self.assertEqual((r["state"], r["reason"]), ("aborted", "person_in_view"))
            with self.subTest(seed=seed, source="simulated person"):
                r = fly(seed, "crossing", "off")
                self.assertEqual((r["state"], r["reason"]), ("aborted", "person_in_view"))
                self.assertNotIn("avoid", r["closing"])


class SameCommandsTests(unittest.TestCase):
    """With nothing in the corridor, "pass" sends exactly what "off" sends, step for step."""

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

    def test_pass_with_no_actors_sends_the_same_commands_as_off(self):
        for automatic in (True, False):
            for seed in (0, 1):
                with self.subTest(automatic=automatic, seed=seed):
                    off, off_state = self.sent("off", seed, automatic)
                    on, on_state = self.sent("pass", seed, automatic)
                    self.assertEqual(off_state, "done")
                    self.assertEqual(on_state, off_state)
                    self.assertEqual(len(on), len(off))
                    self.assertEqual(on, off)


if __name__ == "__main__":
    unittest.main()
