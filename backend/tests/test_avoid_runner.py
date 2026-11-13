"""Obstacle avoidance in the mission runner, the simulator's actors, the settings and the API
(experimental, SPEC section 11). Synthetic observations and a fake clock, except the API tests, which
run the real-time simulator like tests/test_api.py."""
import json
import math
import shutil
import unittest

import cv2
import numpy as np

from medhop.care.store import CareStore
from medhop.config import Settings
from medhop.drone.sim import SimConfig, SimLink
from medhop.drone.sim_actors import SCENARIO_NAMES, SCENARIOS, Actor, actor_box, footprint_distance
from medhop.mission.avoid import focal_fh, focal_fw, AvoidConfig
from medhop.mission.runner import ABORT_REASONS, SAFE_LANDING_REASONS, MissionRunner, RunnerConfig
from medhop.vision.marker import MarkerDetector, Observation, Obstacle
from medhop.vision.person import PersonStatus
from tests.harness import FakeClock, RecordingLink, make_temp_dir
from tests.test_runner import DT, RunnerTestCase, marker

CFG = AvoidConfig()


def person_box(distance, lateral=0.0, width=0.45, height=1.7):
    f, fh = focal_fw(CFG), focal_fh(CFG)
    box = (0.5 + (lateral - width / 2) * f / distance, 0.5 - (height - 1.0) * fh / distance,
           0.5 + (lateral + width / 2) * f / distance, 0.5 + 1.0 * fh / distance)
    return tuple(max(0.0, min(1.0, v)) for v in box)


class AvoidRunnerTestCase(RunnerTestCase):
    mode = "hold"

    def make_runner(self):
        return MissionRunner(self.link, self.mixer, self.store, self.settings, clock=self.clock,
                             config=RunnerConfig(align_enabled=False, avoid=self.mode),
                             wall_clock=lambda: 1_794_000_000.0 + self.clock.t,
                             person_status=lambda: self.person,
                             pilot_connected=lambda: self.pilot_window)

    def feed_obs(self, seen=None, boxes=(), dt=DT):
        """One frame with the marker (or not) and simulator obstacle boxes [(kind, box)]."""
        self.clock.advance(dt)
        self.seq += 1
        self.link.new_frame(self.clock.t)
        if seen is not None:
            seen = type(seen)(id=seen.id, cx=seen.cx, cy=seen.cy, width=seen.width, corners=seen.corners,
                              ts=self.clock.t, height=seen.height)
        obstacles = tuple(Obstacle(kind, box, self.clock.t) for kind, box in boxes)
        self.runner.step(Observation(ts=self.clock.t, seq=self.seq, marker=seen, brightness=100.0,
                                     obstacles=obstacles), self.clock.t)
        return self.mixer.tick(self.clock.t)


class ModeAndBlockerTests(AvoidRunnerTestCase):
    def test_the_new_reason_is_a_safe_landing_reason(self):
        self.assertIn("path_blocked", ABORT_REASONS)
        self.assertIn("path_blocked", SAFE_LANDING_REASONS)

    def test_never_starts_with_a_person_in_view_in_any_mode(self):
        for mode in ("off", "hold", "pass"):
            with self.subTest(mode=mode):
                self.runner.set_avoid(mode)
                self.feed_obs(marker(width=0.05), boxes=[("person", person_box(3.0))])
                self.assertIn("person_in_view", self.runner.blockers())
                self.assertFalse(self.runner.start(True, None)[0])
                self.feed_obs(marker(width=0.05), boxes=[("object", person_box(3.0))])
                self.assertNotIn("person_in_view", self.runner.blockers(), "an object does not block a start")

    def test_a_person_in_view_during_the_countdown_still_stops_an_automatic_run(self):
        self.runner.set_avoid("pass")
        self.runner = self.make_runner()
        self.assertTrue(self.runner.start(False, None, automatic=True)[0])
        self.feed_obs(None, boxes=[("person", person_box(3.0))])
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "person_in_view"))
        self.assertEqual(self.link.toggles, 0)

    def test_off_aborts_on_a_person_in_flight_as_before(self):
        self.runner.set_avoid("off")
        self.runner = self.make_runner()
        self.start()
        self.feed(marker(width=0.06))
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t)
        self.feed(marker(width=0.06))
        self.assert_aborted("person_in_view")

    def test_off_also_aborts_on_a_simulated_person(self):
        self.runner.set_avoid("off")
        self.runner = self.make_runner()
        self.start()
        self.feed_obs(marker(width=0.06), boxes=[("person", person_box(3.0, lateral=1.0))])
        self.assert_aborted("person_in_view")

    def test_hold_does_not_abort_on_a_person_and_holds_instead(self):
        self.start()
        for _ in range(5):
            self.feed_obs(marker(width=0.06))
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t,
                                   boxes=(person_box(2.0),))
        for _ in range(10):
            self.feed_obs(marker(width=0.06))
        self.assertEqual(self.runner.state, "approaching")
        snap = self.runner.snapshot()
        self.assertEqual(snap["avoid"]["state"], "hold")
        self.assertEqual(snap["avoid"]["kind"], "person")
        self.assertLessEqual(snap["command"]["pitch"], 0.0, "no forward stick while holding")

    def test_a_stale_person_check_is_no_evidence(self):
        self.start()
        self.person = PersonStatus(enabled=True, detected=True, count=1, ts=self.clock.t - 5.0,
                                   boxes=(person_box(2.0),))
        for _ in range(5):
            self.feed_obs(marker(width=0.06))
        self.assertEqual(self.runner.snapshot()["avoid"]["state"], "clear")

    def test_settings_persist_and_are_validated(self):
        self.assertEqual(self.runner.settings()["avoid"], "hold")
        self.runner.set_avoid("pass")
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()), {"avoid": "pass"})
        self.assertEqual(self.make_runner().avoid_mode, "pass")
        self.runner.set_drift_assist(True)
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()), {"avoid": "pass", "drift_assist": True})
        with self.assertRaises(ValueError):
            self.runner.set_avoid("maybe")

    def test_a_run_keeps_the_mode_it_started_with(self):
        self.start()
        self.runner.set_avoid("off")
        self.feed_obs(marker(width=0.06), boxes=[("person", person_box(2.0))])
        self.assertEqual(self.runner.state, "approaching", "still holding, not aborted")


class HiddenSignTests(AvoidRunnerTestCase):
    def test_a_sign_hidden_by_someone_is_not_lost(self):
        self.start()
        for _ in range(10):
            self.feed_obs(marker(width=0.06))
        # someone steps in front: the sign is gone for 10 s (marker_lost would come after 2.6 s)
        for _ in range(int(10.0 / DT)):
            axes = self.feed_obs(None, boxes=[("person", person_box(2.0))])
            self.assertLessEqual(axes[2], 0.0, "never forward while hidden")
        self.assertEqual(self.runner.state, "approaching")
        self.assertEqual(self.runner.snapshot()["avoid"]["state"], "hold")
        # they leave and the sign is back: the run goes on
        for _ in range(int(1.5 / DT)):
            self.feed_obs(marker(width=0.06))
        self.assertEqual(self.runner.snapshot()["avoid"]["state"], "clear")
        self.assertEqual(self.runner.state, "approaching")

    def test_a_box_over_where_the_sign_was_hides_it_even_when_out_of_the_lane(self):
        self.start()
        for _ in range(10):
            self.feed_obs(marker(width=0.06, cx=0.8))
        self.runner._last_marker_box = (0.75, 0.45, 0.85, 0.55)   # synthetic corners carry no position
        for _ in range(int(5.0 / DT)):
            self.feed_obs(None, boxes=[("person", (0.7, 0.3, 0.95, 0.7))])
        self.assertEqual(self.runner.state, "approaching")

    def test_way_clear_but_sign_still_missing_searches_again_at_most_twice(self):
        self.start()
        for _ in range(10):
            self.feed_obs(marker(width=0.06, cx=0.3))
        for attempt in range(3):
            for _ in range(int(2.0 / DT)):
                self.feed_obs(None, boxes=[("person", person_box(2.0))])
            for _ in range(int(2.0 / DT)):
                self.feed_obs(None)
            if attempt < 2:
                self.assertEqual(self.runner.state, "searching", attempt)
                self.assertLess(self.runner.snapshot()["command"]["yaw"], 0.0, "turns toward where it was seen")
                for _ in range(4):
                    self.feed_obs(marker(width=0.06, cx=0.3))
                self.assertEqual(self.runner.state, "approaching")
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "marker_not_found"))


class TimeoutAndBlockedTests(AvoidRunnerTestCase):
    def test_time_held_does_not_count_against_the_run_timeout_and_ends_path_blocked(self):
        self.start()
        for _ in range(int(30.0 / DT)):
            self.feed_obs(marker(width=0.06))
        for _ in range(int(24.0 / DT)):
            self.feed_obs(marker(width=0.06), boxes=[("person", person_box(2.0))])
        self.assertEqual(self.runner.state, "approaching", "54 s in, but 24 s of it holding")
        for _ in range(int(2.0 / DT)):
            self.feed_obs(marker(width=0.06), boxes=[("person", person_box(2.0))])
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "path_blocked"))
        self.runner.step(None, self.clock.t)
        event = self.store.events(1)[0]
        self.assertEqual(event["detail"]["reason"], "path_blocked")
        self.assertEqual(event["detail"]["blocked_by"], "timeout")
        self.assertEqual(event["detail"]["obstacle_kind"], "person")
        self.assertEqual(event["detail"]["avoid"]["mode"], "hold")
        self.assertEqual(self.link.toggles, 0, "a manual run never toggles on an abort")
        trace = json.loads((self.dir / "runs" / f"{self.runner.snapshot()['run_id']}.json").read_text())
        self.assertEqual(trace["avoid"]["blocked_reason"], "timeout")
        self.assertEqual([e["state"] for e in trace["avoid"]["events"]], ["hold", "blocked"])
        self.assertIn("avoid_state", trace["samples"][-1])

    def automatic_into_hold(self, cy=0.5):
        self.runner.set_avoid("hold")
        self.runner = self.make_runner()
        self.assertTrue(self.runner.start(False, None, automatic=True)[0])
        for _ in range(int(5.0 / DT) + 2 + int(4.0 / DT) + 2):
            self.feed_obs(marker(width=0.05))
        width = 0.05
        while width < 0.08:
            self.feed_obs(marker(width=width))
            width += 0.003
        self.assertTrue(self.runner.snapshot()["flight_confirmed"])

    def test_an_automatic_run_lands_on_path_blocked_with_the_obstacle_as_evidence(self):
        self.automatic_into_hold()
        box = person_box(2.0)          # base below the picture: very close, so it holds (and backs off)
        for _ in range(int(26.0 / DT)):
            if self.runner.state != "approaching":
                break
            self.feed_obs(None, boxes=[("person", box)])
        self.assertEqual((self.runner.state, self.runner.reason), ("aborted", "path_blocked"))
        self.assertEqual(self.link.toggles, 2, "takeoff and the landing where it is")
        self.assertEqual(self.runner.snapshot()["last_landing"], "safe_landing")

    def test_no_landing_when_the_obstacle_rises_in_the_picture(self):
        """A sinking camera sees everything move up: no toggle on that evidence."""
        self.automatic_into_hold()
        x1, y1, x2, y2 = person_box(2.0)
        frames = int(26.0 / DT)
        for i in range(frames):
            if self.runner.state != "approaching":
                break
            rise = max(0.0, (i - (frames - 40)) * 0.006)
            self.feed_obs(None, boxes=[("person", (x1, y1 - rise, x2, y2 - rise))])
        self.assertEqual(self.runner.reason, "path_blocked")
        self.assertEqual(self.link.toggles, 1)
        self.assertTrue(self.runner.snapshot()["needs_pilot"])


class StatusTests(AvoidRunnerTestCase):
    def test_status_shapes(self):
        snap = self.runner.snapshot()
        self.assertEqual(snap["avoid"], {"mode": "hold", "state": None, "kind": None, "distance_m": None,
                                         "side": None, "held_s": 0.0})
        self.start()
        self.feed_obs(marker(width=0.06), boxes=[("person", person_box(3.2, lateral=0.2)),
                                                  ("object", person_box(2.0, lateral=-1.5, height=0.9))])
        obstacles = self.runner.obstacles_snapshot()
        self.assertEqual([set(o) for o in obstacles], [{"kind", "box", "distance_m", "lateral_m", "in_lane"}] * 2)
        self.assertAlmostEqual(obstacles[0]["distance_m"], 3.2, places=2)
        self.assertAlmostEqual(obstacles[0]["lateral_m"], 0.2, places=2)
        self.assertIs(obstacles[0]["in_lane"], True)
        self.assertIsNone(obstacles[1]["distance_m"], "base out of the picture: very close")
        self.assertIs(obstacles[1]["in_lane"], True)
        self.assertEqual(set(self.runner.snapshot()["avoid"]), {"mode", "state", "kind", "distance_m", "side", "held_s"})


class SimActorTests(unittest.TestCase):
    def test_actor_motion(self):
        a = Actor("person", x_m=-3.0, distance_m=1.4, vx_m_s=1.0, move_from_s=2.0, move_until_s=5.0)
        self.assertEqual(a.at(None).x_m, -3.0)
        self.assertEqual(a.at(1.0).x_m, -3.0)
        self.assertAlmostEqual(a.at(3.5).x_m, -1.5)
        self.assertAlmostEqual(a.at(9.0).x_m, 0.0)
        with self.assertRaises(ValueError):
            Actor("ghost")

    def test_box_projection_matches_the_pinhole_camera(self):
        sim = SimLink(SimConfig(seed=0), realtime=False)
        cam = np.array([0.0, 1.04, -4.2])
        rot = np.array([[1.0, 0, 0], [0, -1.0, 0], [0, 0, 1.0]])
        box = actor_box(Actor("person", x_m=0.0, distance_m=1.4), cam, rot, sim._K, 640, 360)
        f = 320.0 / math.tan(math.radians(35.0))
        depth = 4.2 - 1.55
        self.assertAlmostEqual(box[2], 0.5 + 0.225 * f / depth / 640, places=4)
        self.assertAlmostEqual(box[1], 0.5 - 0.66 * f / depth / 360, places=4)
        self.assertAlmostEqual(box[3], min(1.0, 0.5 + 1.04 * f / depth / 360), places=4)
        self.assertIsNone(actor_box(Actor("person", x_m=6.0, distance_m=1.4), cam, rot, sim._K, 640, 360))
        behind = np.array([0.0, 1.04, -1.0])                 # the actor is behind the camera
        self.assertIsNone(actor_box(Actor("person", x_m=0.0, distance_m=1.4), behind, rot, sim._K, 640, 360))
        clipped = actor_box(Actor("object", x_m=0.0, distance_m=1.2, width_m=2.0), np.array([0.0, 1.04, -1.5]),
                            rot, sim._K, 640, 360)
        self.assertEqual((clipped[0], clipped[2], clipped[3]), (0.0, 1.0, 1.0))

    def test_an_actor_between_camera_and_sign_hides_the_marker_in_both_scenes(self):
        detector = MarkerDetector(7)
        for factory in (SimConfig, SimConfig.high_quality):
            with self.subTest(scene=factory.__name__):
                plain = SimLink(factory(seed=1), realtime=False)
                hidden = SimLink(factory(seed=1, actors=(Actor("person", x_m=0.0, distance_m=1.4),)), realtime=False)
                for link, expected in ((plain, True), (hidden, False)):
                    jpeg = link.render_test_frame(3.5)
                    image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
                    self.assertEqual(detector.detect(image) is not None, expected)

    def test_frames_carry_the_boxes_and_the_clock_starts_at_takeoff(self):
        clock = FakeClock(0.0)
        sim = SimLink(SimConfig(seed=0, start_distance_m=4.2,
                                actors=SCENARIOS["crossing"].actors), clock=clock, realtime=False)
        for _ in range(60):
            sim.advance_to(clock.advance(1 / 60))
        self.assertEqual(sim.actors_now()[0].x_m, -3.6, "on the ground: not moving")
        sim.takeoff_land_toggle()
        for _ in range(int(10.0 * 60)):
            sim.advance_to(clock.advance(1 / 60))
        self.assertGreater(sim.actors_now()[0].x_m, -3.6)
        frame = sim.latest_frame()
        self.assertEqual(frame.obstacles[0][0], "person")
        self.assertEqual(len(frame.obstacles[0][1]), 4)
        self.assertIsNotNone(sim.clearance_m())

    def test_scenarios(self):
        self.assertEqual(SCENARIO_NAMES, ("empty", "crossing", "standing", "cart", "blocked"))
        clock = FakeClock(0.0)
        sim = SimLink(SimConfig(seed=0), clock=clock, realtime=False)
        sim.advance_to(clock.advance(0.1))
        sim.set_scenario("cart")
        self.assertEqual((sim.scenario, len(sim.actors_now())), ("cart", 1))
        self.assertEqual(sim.pose()["distance_m"], 4.2)
        sim.set_scenario("empty")
        self.assertEqual((sim.scenario, sim.actors_now()), ("empty", []))
        self.assertEqual(sim.pose()["distance_m"], 2.5)
        with self.assertRaises(KeyError):
            sim.set_scenario("party")

    def test_footprint_distance(self):
        a = Actor("object", x_m=0.0, distance_m=1.5, width_m=0.6, depth_m=0.4)
        self.assertEqual(footprint_distance(a, 0.0, 1.5), 0.0)
        self.assertAlmostEqual(footprint_distance(a, 1.3, 1.5), 1.0)
        self.assertAlmostEqual(footprint_distance(a, 0.0, 0.3), 1.0)


class SettingsEnvTests(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(Settings().avoid, "off")
        self.assertEqual(RunnerConfig().avoid, "off")
        self.assertEqual(Settings.from_env({"MEDHOP_DRONE": "real"}).avoid, "off")
        self.assertEqual(Settings.from_env({"MEDHOP_AVOID": "pass"}).avoid, "pass")
        self.assertEqual(Settings.from_env({"MEDHOP_DRONE": "real", "MEDHOP_AVOID": "hold"}).avoid, "hold")
        with self.assertRaises(ValueError):
            Settings(avoid="dodge")

    def test_the_simulator_default(self):
        self.assertEqual(Settings.from_env({}).avoid, "hold")

    def test_a_stored_mode_wins(self):
        directory = make_temp_dir()
        try:
            store = CareStore(directory)
            self.assertIsNone(store.load_avoid())
            store.save_avoid("pass")
            store.save_land_on_arrival(True)
            self.assertEqual(CareStore(directory).load_avoid(), "pass")
            runner = MissionRunner(RecordingLink(), None, CareStore(directory), Settings(data_dir=directory, avoid="hold"))
            self.assertEqual(runner.avoid_mode, "pass")
            (directory / "mission.json").write_text('{"avoid": "sideways"}')
            self.assertIsNone(CareStore(directory).load_avoid())
        finally:
            shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
