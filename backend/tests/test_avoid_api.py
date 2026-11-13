"""API for the experimental obstacle avoidance (SPEC section 11): the `avoid` mission setting, the
simulator scenario endpoint and the new status fields. Real-time simulator, like tests/test_api.py."""
import shutil
import unittest

from medhop.config import Settings
from medhop.server import MedHopCore
from tests.harness import RecordingLink, make_temp_dir
from tests.test_api import ApiTestCase, wait_for

AVOID_KEYS = {"mode", "state", "kind", "distance_m", "held_s"}
OBSTACLE_KEYS = {"kind", "box", "distance_m", "lateral_m", "in_lane"}
ACTOR_KEYS = {"kind", "x_m", "distance_m", "width_m", "depth_m", "height_m"}
SIM_KEYS = {"scenario", "actors", "pose"}
POSE_KEYS = {"x_m", "distance_m", "heading_deg", "altitude_m", "airborne"}


class AvoidApiTests(ApiTestCase):
    def tearDown(self):
        self.client.post("/api/sim/scenario", json={"name": "empty"})
        self.client.put("/api/mission/settings", json={"avoid": "off"})

    def test_the_avoid_setting(self):
        put = lambda body: self.client.put("/api/mission/settings", json=body)
        self.assertEqual(put({"avoid": "pass"}).status_code, 422, "going round is not a mode")
        response = put({"avoid": "hold"})
        self.assertEqual((response.status_code, response.json()["avoid"]), (200, "hold"))
        self.assertEqual(self.status()["mission"]["avoid"]["mode"], "hold")
        self.assertEqual(set(self.status()["mission"]["avoid"]), AVOID_KEYS)
        self.assertEqual(put({"avoid": "hold", "drift_assist": False}).json()["avoid"], "hold")
        self.assertEqual(put({"avoid": "sideways"}).status_code, 422)
        self.assertEqual(put({"avoid": None}).status_code, 422)
        self.assertEqual(put({"land_on_arrival": False}).json()["avoid"], "hold", "other settings leave it alone")

    def test_the_scenario_endpoint_and_the_status(self):
        self.reset_sim(distance=3.0)
        status = self.status()
        self.assertEqual(set(status["sim"]), SIM_KEYS)
        self.assertEqual((status["sim"]["scenario"], status["sim"]["actors"]), ("empty", []))
        # where the simulated drone is now (simulator truth, for a plan view)
        pose = status["sim"]["pose"]
        self.assertEqual(set(pose), POSE_KEYS)
        self.assertAlmostEqual(pose["distance_m"], 3.0, delta=0.1)
        self.assertAlmostEqual(pose["x_m"], 0.0, delta=0.1)
        self.assertIs(pose["airborne"], True)
        self.assertAlmostEqual(pose["altitude_m"], 1.0, delta=0.05)
        self.assertEqual(pose["x_m"], round(pose["x_m"], 3))
        self.assertEqual(pose["heading_deg"], round(pose["heading_deg"], 1))
        self.assertEqual(status["vision"]["obstacles"], [])
        response = self.client.post("/api/sim/scenario", json={"name": "cart"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"ok"} | SIM_KEYS)
        self.assertEqual((body["ok"], body["scenario"]), (True, "cart"))
        self.assertEqual([set(a) for a in body["actors"]], [ACTOR_KEYS])
        self.assertEqual(body["actors"][0]["kind"], "object")
        obstacles = wait_for(lambda: self.status()["vision"]["obstacles"], 3.0)
        self.assertTrue(obstacles, "the cart is in the picture")
        self.assertEqual(set(obstacles[0]), OBSTACLE_KEYS)
        self.assertEqual(obstacles[0]["kind"], "object")
        self.assertEqual(len(obstacles[0]["box"]), 4)
        self.assertEqual(self.status()["sim"]["scenario"], "cart")
        self.assertEqual(self.client.post("/api/sim/scenario", json={"name": "party"}).status_code, 422)
        # never take off with something in the lane: both kinds of start are refused
        run_before = self.status()["mission"]["run_id"]
        with self.pilot():
            self.assertTrue(wait_for(lambda: self.status()["mission"]["blockers"] == ["obstacle_in_view"], 3.0),
                            self.status()["mission"]["blockers"])
            for body in ({"confirm_airborne": True}, {"automatic": True}):
                response = self.client.post("/api/mission/start", json=body)
                self.assertEqual(response.status_code, 409)
                self.assertIn("obstacle_in_view", response.json()["blockers"])
        self.assertEqual(self.status()["mission"]["run_id"], run_before, "no run started")

    def test_the_scenario_cannot_change_during_a_run(self):
        self.reset_sim()
        with self.pilot():
            self.assertTrue(wait_for(lambda: self.status()["mission"]["can_start"], 3.0), self.status()["mission"])
            self.assertEqual(self.client.post("/api/mission/start", json={"confirm_airborne": True}).status_code, 200)
            response = self.client.post("/api/sim/scenario", json={"name": "standing"})
            self.assertEqual((response.status_code, response.json()), (409, {"blockers": ["already_running"]}))
            self.client.post("/api/mission/abort")
        self.assertEqual(self.status()["sim"]["scenario"], "empty")


class RealDroneTests(unittest.TestCase):
    def test_no_scenarios_and_no_sim_status_on_the_real_drone(self):
        directory = make_temp_dir()
        try:
            link = RecordingLink()
            link.mode = "real"
            core = MedHopCore(Settings(data_dir=directory, person_check="off"), link=link)
            self.assertEqual(core.set_scenario("cart"), ["not_simulator"])
            self.assertIsNone(core.sim_snapshot())
            self.assertEqual(core.runner.avoid_mode, "off")
        finally:
            shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
