"""API contract tests (SPEC section 7) with FastAPI's TestClient against the simulator in real time."""
import shutil
import threading
import time
import unittest

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from medhop.config import Settings
from medhop.drone.sim import SimConfig, SimLink
from medhop.server import MedHopCore, create_app
from tests.harness import make_temp_dir

TOP_KEYS = {"server_time", "mode", "link", "telemetry", "trim", "pilot", "vision", "mission", "hover_test", "care"}
LINK_KEYS = {"video_live", "frame_age_s", "fps", "control_up", "drone_seen", "sticks_blocked"}
TELEMETRY_KEYS = {"simulated", "age_s", "fly_state_raw", "battery_raw", "flags_raw", "battery_low",
                  "battery_check_enabled"}
TRIM_KEYS = {"roll", "pitch"}
PILOT_KEYS = {"manual_active", "max_stick", "estop_active", "estop_delivered"}
VISION_KEYS = {"marker", "person", "brightness", "dark"}
MARKER_KEYS = {"id", "cx", "cy", "width", "age_s"}
PERSON_KEYS = {"enabled", "detected", "count", "age_s"}
MISSION_KEYS = {"state", "reason", "run_id", "dose_id", "elapsed_s", "command", "arrive_width",
                "land_on_arrival", "drift_assist", "can_start", "blockers", "last_landing"}
COMMAND_KEYS = {"yaw", "pitch"}
DRIFT_ASSIST_KEYS = {"enabled", "active", "roll", "disabled_reason", "suggested_trim_roll"}
HH_MM = r"^([01]\d|2[0-3]):[0-5]\d$"
HOVER_KEYS = {"running", "elapsed_s", "result"}
CARE_KEYS = {"now_local", "date_local", "doses", "next_due_id"}
DOSE_STATUS_KEYS = {"id", "time", "label", "notes", "status", "arrived_at", "acknowledged_at", "arrived_mode"}
DOSE_KEYS = {"id", "time", "label", "notes"}
EVENT_KEYS = {"ts", "time_local", "type", "dose_id", "run_id", "detail"}
STATUSES = {"upcoming", "due", "arrived", "acknowledged", "needs_attention"}
HELLO = {"type": "hello", "pilot": True}


def make_core(data_dir, **sim):
    settings = Settings(data_dir=data_dir, person_check="off")
    config = SimConfig(seed=5, lateral_drift=0.0, **sim)
    return MedHopCore(settings, link=SimLink(config))


def wait_for(predicate, timeout=5.0, step=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return predicate()


class ApiTestCase(unittest.TestCase):
    sim_kwargs = {"start_airborne": True, "start_distance_m": 2.0}

    @classmethod
    def setUpClass(cls):
        cls.dir = make_temp_dir()
        cls.core = make_core(cls.dir, **cls.sim_kwargs)
        cls._client_cm = TestClient(create_app(core=cls.core))
        cls.client = cls._client_cm.__enter__()
        assert wait_for(lambda: cls.client.get("/api/status").json()["link"]["video_live"], 5.0)

    @classmethod
    def tearDownClass(cls):
        cls._client_cm.__exit__(None, None, None)
        shutil.rmtree(cls.dir, ignore_errors=True)

    def status(self):
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def pilot(self):
        """A connected pilot control socket (a run may only start while one is connected)."""
        return self.client.websocket_connect("/ws/control")

    def reset_sim(self, distance=2.0, heading=0.0, airborne=True):
        self.client.post("/api/mission/abort")
        self.core.mixer.estop_reset()
        self.core.link.drop_marker(False)
        self.core.link.set_pose(distance_m=distance, x_m=0.0, heading_deg=heading, airborne=airborne)
        time.sleep(0.7)   # let the delayed video catch up with the new pose


class StatusTests(ApiTestCase):
    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "mode": "sim"})

    def test_status_has_exactly_the_spec_keys(self):
        self.reset_sim()
        status = wait_for(lambda: (lambda s: s if s["vision"]["marker"] and s["telemetry"] else None)(self.status()))
        self.assertIsNotNone(status, "marker and telemetry should be present in the simulator")
        self.assertEqual(set(status), TOP_KEYS)
        self.assertEqual(status["mode"], "sim")
        self.assertIsInstance(status["server_time"], float)
        self.assertEqual(set(status["link"]), LINK_KEYS)
        self.assertEqual(set(status["telemetry"]), TELEMETRY_KEYS)
        self.assertEqual(set(status["trim"]), TRIM_KEYS)
        self.assertEqual(set(status["pilot"]), PILOT_KEYS)
        self.assertEqual(set(status["vision"]), VISION_KEYS)
        self.assertEqual(set(status["vision"]["marker"]), MARKER_KEYS)
        self.assertEqual(set(status["vision"]["person"]), PERSON_KEYS)
        self.assertEqual(set(status["mission"]), MISSION_KEYS)
        self.assertEqual(set(status["mission"]["command"]), COMMAND_KEYS)
        self.assertEqual(set(status["mission"]["drift_assist"]), DRIFT_ASSIST_KEYS)
        self.assertNotIn("vision_fps", status["link"])
        self.assertEqual(set(status["care"]), CARE_KEYS)
        for dose in status["care"]["doses"]:
            self.assertEqual(set(dose), DOSE_STATUS_KEYS)
            self.assertIn(dose["status"], STATUSES)

    def test_status_values_in_sim_mode(self):
        self.reset_sim()
        status = wait_for(lambda: (lambda s: s if s["vision"]["marker"] else None)(self.status()))
        self.assertTrue(status["link"]["video_live"])
        self.assertLess(status["link"]["frame_age_s"], 0.5)
        # nominally 15; a busy machine makes the real-time simulator skip frames
        self.assertGreater(status["link"]["fps"], 5.0)
        self.assertLess(status["link"]["fps"], 18.0)
        self.assertIs(status["telemetry"]["simulated"], True)
        self.assertIs(status["telemetry"]["battery_low"], False)
        self.assertEqual(status["telemetry"]["battery_raw"], 42)
        self.assertEqual(status["pilot"], {"manual_active": False, "max_stick": 0.5, "estop_active": False,
                                           "estop_delivered": False})
        self.assertEqual({k: status["link"][k] for k in ("control_up", "drone_seen", "sticks_blocked")},
                         {"control_up": True, "drone_seen": True, "sticks_blocked": False})
        self.assertEqual(status["vision"]["marker"]["id"], 7)
        self.assertAlmostEqual(status["vision"]["marker"]["cx"], 0.5, delta=0.05)
        self.assertAlmostEqual(status["vision"]["marker"]["width"], 0.064, delta=0.008)
        self.assertEqual(status["vision"]["person"], {"enabled": False, "detected": False, "count": 0, "age_s": None})
        self.assertFalse(status["vision"]["dark"])
        self.assertGreater(status["vision"]["brightness"], 60.0)
        mission = status["mission"]
        self.assertEqual((mission["state"], mission["reason"], mission["run_id"], mission["dose_id"]),
                         ("idle", None, None, None))
        self.assertEqual(mission["command"], {"yaw": 0.0, "pitch": 0.0})
        self.assertEqual(mission["arrive_width"], 0.16)
        self.assertIs(mission["land_on_arrival"], False)        # Revision 3 default
        self.assertEqual(mission["drift_assist"], {"enabled": False, "active": False, "roll": 0.0,
                                                   "disabled_reason": None, "suggested_trim_roll": None})
        # no pilot control socket is connected: that alone blocks a start
        self.assertIs(mission["can_start"], False)
        self.assertEqual(mission["blockers"], ["no_pilot_link"])
        with self.pilot():
            mission = wait_for(lambda: (lambda m: m if m["can_start"] else None)(self.status()["mission"]), 2.0)
            self.assertIsNotNone(mission)
            self.assertEqual(mission["blockers"], [])
        self.assertIsNone(status["hover_test"])
        self.assertRegex(status["care"]["now_local"], r"^\d\d:\d\d$")
        self.assertRegex(status["care"]["date_local"], r"^\d{4}-\d\d-\d\d$")
        self.assertEqual([d["label"] for d in status["care"]["doses"]],
                         ["Morning dose (demo)", "Midday dose (demo)", "Evening dose (demo)"])

    def test_marker_is_null_when_not_visible(self):
        self.reset_sim()
        self.core.link.drop_marker(True)
        self.assertTrue(wait_for(lambda: self.status()["vision"]["marker"] is None, 4.0))
        self.core.link.drop_marker(False)

    def test_ws_status_pushes_the_same_object_about_five_times_a_second(self):
        with self.client.websocket_connect("/ws/status") as ws:
            first = ws.receive_json()
            started = time.monotonic()
            for _ in range(5):
                message = ws.receive_json()
            elapsed = time.monotonic() - started
        self.assertEqual(set(first), TOP_KEYS)
        self.assertEqual(set(message["mission"]), MISSION_KEYS)
        self.assertAlmostEqual(elapsed, 1.0, delta=0.35)

    def test_cors_allows_only_the_frontend_origins(self):
        for origin in ("http://localhost:5180", "http://127.0.0.1:5180"):
            response = self.client.get("/api/health", headers={"Origin": origin})
            self.assertEqual(response.headers.get("access-control-allow-origin"), origin)
        response = self.client.get("/api/health", headers={"Origin": "http://localhost:5173"})
        self.assertNotIn("access-control-allow-origin", response.headers)
        preflight = self.client.options("/api/trim", headers={
            "Origin": "http://localhost:5180", "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(preflight.status_code, 200)
        self.assertIn("PUT", preflight.headers.get("access-control-allow-methods", ""))


class TrimTests(ApiTestCase):
    def test_get_put_clamp_and_persist(self):
        self.assertEqual(self.client.get("/api/trim").json(), {"roll": 0.0, "pitch": 0.0})
        response = self.client.put("/api/trim", json={"roll": 0.02, "pitch": -0.01})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"roll": 0.02, "pitch": -0.01})
        self.assertEqual(self.client.get("/api/trim").json(), {"roll": 0.02, "pitch": -0.01})
        self.assertEqual(self.status()["trim"], {"roll": 0.02, "pitch": -0.01})
        self.assertEqual(self.client.put("/api/trim", json={"roll": 0.9, "pitch": -0.9}).json(),
                         {"roll": 0.3, "pitch": -0.3})
        self.assertEqual(self.client.put("/api/trim", json={"pitch": 0.05}).json(), {"roll": 0.3, "pitch": 0.05})
        self.assertEqual(self.client.put("/api/trim", json={"roll": "left"}).status_code, 422)
        # a new backend on the same data directory starts with the stored trim
        again = make_core(self.dir)
        self.assertEqual(again.mixer.trim(), (0.3, 0.05))
        self.assertEqual(self.client.put("/api/trim", json={"roll": 0.0, "pitch": 0.0}).json(),
                         {"roll": 0.0, "pitch": 0.0})

    def test_trim_reaches_the_drone(self):
        self.client.put("/api/trim", json={"roll": 0.04, "pitch": -0.03})
        self.assertTrue(wait_for(lambda: self.core.link.last_axes_sent == (0.0, 0.0, -0.03, 0.04), 1.0))
        self.client.put("/api/trim", json={"roll": 0.0, "pitch": 0.0})
        self.assertTrue(wait_for(lambda: self.core.link.last_axes_sent == (0.0, 0.0, 0.0, 0.0), 1.0))


class MissionApiTests(ApiTestCase):
    def test_start_is_refused_without_confirm_airborne(self):
        self.reset_sim()
        with self.pilot():
            self.assertTrue(wait_for(lambda: self.status()["mission"]["can_start"], 3.0))
            for body in ({"confirm_airborne": False, "dose_id": None}, {}):
                response = self.client.post("/api/mission/start", json=body)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json(), {"blockers": ["confirm_airborne_required"]})
        self.assertNotIn(self.status()["mission"]["state"], ("searching", "approaching", "arrived", "landing"))
        self.assertEqual(self.core.link.toggle_count, 0)

    def test_start_with_unknown_dose_is_404(self):
        response = self.client.post("/api/mission/start", json={"confirm_airborne": True, "dose_id": "nope"})
        self.assertEqual(response.status_code, 404)

    def test_start_abort_and_blockers(self):
        self.reset_sim()
        with self.pilot():
            response = self.client.post("/api/mission/start", json={"confirm_airborne": True, "dose_id": "d2"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["run_id"].startswith("run-"))
            mission = self.status()["mission"]
            self.assertIn(mission["state"], ("searching", "approaching"))
            self.assertEqual(mission["dose_id"], "d2")
            self.assertFalse(mission["can_start"])
            self.assertEqual(mission["blockers"], ["already_running"])
            again = self.client.post("/api/mission/start", json={"confirm_airborne": True})
            self.assertEqual((again.status_code, again.json()), (409, {"blockers": ["already_running"]}))
            hover = self.client.post("/api/hover-test/start")
            self.assertEqual((hover.status_code, hover.json()), (409, {"blockers": ["already_running"]}))
            calibrate = self.client.post("/api/mission/calibrate-arrival")
            self.assertEqual((calibrate.status_code, calibrate.json()), (409, {"blockers": ["already_running"]}))
            aborted = self.client.post("/api/mission/abort")
            self.assertEqual(aborted.status_code, 200)
            self.assertIs(aborted.json()["aborted"], True)
            mission = self.status()["mission"]
            self.assertEqual((mission["state"], mission["reason"]), ("aborted", "pilot_took_over"))
            self.assertEqual(self.core.link.toggle_count, 0)
            newest = self.client.get("/api/events?limit=2").json()["events"]
            self.assertEqual([e["type"] for e in newest], ["run_aborted", "run_started"])
            self.assertEqual(newest[0]["detail"]["reason"], "pilot_took_over")
            self.assertIs(self.client.post("/api/mission/abort").json()["aborted"], False)

    def test_start_and_hover_test_are_refused_without_a_pilot_control_socket(self):
        self.reset_sim()
        self.assertTrue(wait_for(lambda: self.status()["vision"]["marker"] is not None, 4.0))
        self.assertEqual(self.status()["mission"]["blockers"], ["no_pilot_link"])
        response = self.client.post("/api/mission/start", json={"confirm_airborne": True})
        self.assertEqual((response.status_code, response.json()), (409, {"blockers": ["no_pilot_link"]}))
        hover = self.client.post("/api/hover-test/start")
        self.assertEqual((hover.status_code, hover.json()), (409, {"blockers": ["no_pilot_link"]}))
        self.assertEqual(self.status()["mission"]["state"] in ("searching", "approaching", "hover_test"), False)
        self.assertEqual(self.core.link.toggle_count, 0)

    def test_losing_the_pilot_control_socket_aborts_a_run_with_pilot_link_lost(self):
        self.reset_sim()
        toggles = self.core.link.toggle_count
        with self.pilot():
            self.assertTrue(wait_for(lambda: self.status()["mission"]["can_start"], 3.0), self.status()["mission"])
            response = self.client.post("/api/mission/start", json={"confirm_airborne": True})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(wait_for(lambda: self.core.link.last_axes_sent[2] > 0.05, 4.0), "should be flying forward")
            self.assertEqual(self.status()["mission"]["state"], "approaching")
        # the socket is closed (tab closed, browser crash, network drop) in the middle of the approach
        self.assertTrue(wait_for(lambda: self.status()["mission"]["state"] == "aborted", 1.0))
        mission = self.status()["mission"]
        self.assertEqual((mission["state"], mission["reason"]), ("aborted", "pilot_link_lost"))
        self.assertTrue(wait_for(lambda: self.core.link.last_axes_sent == (0.0, 0.0, 0.0, 0.0), 1.0))
        self.assertEqual(self.core.link.toggle_count, toggles, "an abort never sends the toggle")
        newest = wait_for(lambda: (lambda e: e if e[0]["type"] == "run_aborted" else None)(
            self.client.get("/api/events?limit=2").json()["events"]), 2.0)
        self.assertEqual(newest[0]["detail"]["reason"], "pilot_link_lost")
        self.assertEqual(self.status()["mission"]["blockers"], ["no_pilot_link"])

    def test_losing_the_pilot_control_socket_cancels_a_hover_test(self):
        self.reset_sim()
        with self.pilot():
            self.assertTrue(wait_for(lambda: self.status()["vision"]["marker"] is not None, 4.0))
            self.assertEqual(self.client.post("/api/hover-test/start").status_code, 200)
            self.assertEqual(self.status()["mission"]["state"], "hover_test")
        self.assertTrue(wait_for(lambda: self.status()["mission"]["state"] == "idle", 1.0))
        self.assertIs(self.status()["hover_test"]["running"], False)
        newest = wait_for(lambda: (lambda e: e if e and e[0]["type"] == "hover_test" else None)(
            self.client.get("/api/events?limit=1").json()["events"]), 2.0)
        self.assertEqual(newest[0]["detail"], {"cancelled": "pilot_link_lost"})

    def test_estop_blocks_start(self):
        self.reset_sim()
        with self.pilot():
            self.core.mixer.pilot_estop()
            self.assertTrue(self.status()["pilot"]["estop_active"])
            response = self.client.post("/api/mission/start", json={"confirm_airborne": True})
            self.assertEqual((response.status_code, response.json()), (409, {"blockers": ["estop_active"]}))
            self.core.mixer.estop_reset()

    def test_settings(self):
        put = lambda body: self.client.put("/api/mission/settings", json=body)
        # land_on_arrival alone
        response = put({"land_on_arrival": False})
        self.assertEqual((response.status_code, response.json()),
                         (200, {"land_on_arrival": False, "drift_assist": False}))
        self.assertIs(self.status()["mission"]["land_on_arrival"], False)
        # drift_assist alone: the other setting is left as it was
        response = put({"drift_assist": True})
        self.assertEqual((response.status_code, response.json()),
                         (200, {"land_on_arrival": False, "drift_assist": True}))
        self.assertIs(self.status()["mission"]["drift_assist"]["enabled"], True)
        # both together
        response = put({"land_on_arrival": True, "drift_assist": False})
        self.assertEqual((response.status_code, response.json()),
                         (200, {"land_on_arrival": True, "drift_assist": False}))
        self.assertIs(self.status()["mission"]["land_on_arrival"], True)
        self.assertIs(self.status()["mission"]["drift_assist"]["enabled"], False)
        self.assertEqual(put({}).status_code, 422)
        self.assertEqual(put({"drift_assist": "sometimes"}).status_code, 422)
        self.assertEqual(put({"drift_assist": None}).status_code, 422)

    def test_drift_assist_setting_survives_a_restart(self):
        self.assertIs(make_core(self.dir).runner.snapshot()["drift_assist"]["enabled"], False, "off by default")
        self.client.put("/api/mission/settings", json={"drift_assist": True})
        self.assertIs(make_core(self.dir).runner.snapshot()["drift_assist"]["enabled"], True)
        self.client.put("/api/mission/settings", json={"drift_assist": False})
        self.assertIs(make_core(self.dir).runner.snapshot()["drift_assist"]["enabled"], False)

    def test_calibrate_arrival(self):
        self.reset_sim(distance=1.0)
        wait_for(lambda: (self.status()["vision"]["marker"] or {}).get("width", 0) > 0.11)
        response = self.client.post("/api/mission/calibrate-arrival")
        self.assertEqual(response.status_code, 200, response.text)
        width = response.json()["arrive_width"]
        self.assertAlmostEqual(width, 0.128, delta=0.012)
        self.assertEqual(self.status()["mission"]["arrive_width"], width)
        # the hovering marker's width wobbles around the stored value from frame to frame
        self.assertTrue(wait_for(lambda: "marker_too_close" in self.status()["mission"]["blockers"], 3.0, 0.02),
                        self.status()["mission"])
        self.assertAlmostEqual(self.core.store.load_arrive_width(), width, places=3)
        self.core.link.drop_marker(True)
        self.assertTrue(wait_for(lambda: self.status()["vision"]["marker"] is None, 4.0))
        refused = self.client.post("/api/mission/calibrate-arrival")
        self.assertEqual((refused.status_code, refused.json()), (409, {"blockers": ["marker_not_visible"]}))
        self.core.link.drop_marker(False)
        # put the default back for the other tests
        self.core.runner._arrive_width = 0.16
        self.core.store.save_arrive_width(0.16)

    def test_hover_test_start_and_shape(self):
        self.reset_sim()
        with self.pilot():
            self.core.link.drop_marker(True)
            self.assertTrue(wait_for(lambda: self.status()["vision"]["marker"] is None, 4.0))
            refused = self.client.post("/api/hover-test/start")
            self.assertEqual((refused.status_code, refused.json()), (409, {"blockers": ["marker_not_visible"]}))
            self.core.link.drop_marker(False)
            self.assertTrue(wait_for(lambda: self.status()["vision"]["marker"] is not None, 4.0))
            response = self.client.post("/api/hover-test/start")
            self.assertEqual(response.status_code, 200, response.text)
            time.sleep(0.3)
            status = self.status()
            self.assertEqual(status["mission"]["state"], "hover_test")
            self.assertEqual(set(status["hover_test"]), HOVER_KEYS)
            self.assertIs(status["hover_test"]["running"], True)
            self.assertIsNone(status["hover_test"]["result"])
            self.assertGreater(status["hover_test"]["elapsed_s"], 0.1)
            self.assertEqual(self.client.post("/api/mission/start", json={"confirm_airborne": True}).json(),
                             {"blockers": ["already_running"]})
            self.client.post("/api/mission/abort")
            status = self.status()
            self.assertEqual(status["mission"]["state"], "idle")
            self.assertIs(status["hover_test"]["running"], False)


class CareApiTests(ApiTestCase):
    def test_schedule_crud(self):
        listing = self.client.get("/api/schedule").json()
        self.assertEqual(set(listing), {"doses"})
        self.assertEqual([d["id"] for d in listing["doses"]], ["d1", "d2", "d3"])
        self.assertEqual(set(listing["doses"][0]), DOSE_KEYS)

        created = self.client.post("/api/schedule", json={"time": "09:30", "label": "Extra dose (demo)", "notes": "n"})
        self.assertEqual(created.status_code, 200, created.text)
        dose = created.json()
        self.assertEqual(dose, {"id": "d4", "time": "09:30", "label": "Extra dose (demo)", "notes": "n"})

        updated = self.client.put("/api/schedule/d4", json={"time": "10:00", "label": "Renamed (demo)", "notes": ""})
        self.assertEqual(updated.json(), {"id": "d4", "time": "10:00", "label": "Renamed (demo)", "notes": ""})
        partial = self.client.put("/api/schedule/d4", json={"notes": "only notes"})
        self.assertEqual(partial.json()["time"], "10:00")
        self.assertEqual(partial.json()["notes"], "only notes")
        self.assertIn("d4", [d["id"] for d in self.status()["care"]["doses"]])

        for bad in ({"time": "25:00", "label": "x"}, {"time": "9:30", "label": "x"}, {"time": "09:30", "label": " "},
                    {"label": "no time"}):
            self.assertEqual(self.client.post("/api/schedule", json=bad).status_code, 422, bad)
        self.assertEqual(self.client.put("/api/schedule/d4", json={"time": "noon"}).status_code, 422)
        self.assertEqual(self.client.put("/api/schedule/nope", json={"label": "x"}).status_code, 404)

        deleted = self.client.delete("/api/schedule/d4")
        self.assertEqual((deleted.status_code, deleted.json()), (200, {"ok": True}))
        self.assertEqual(self.client.delete("/api/schedule/d4").status_code, 404)
        self.assertEqual([d["id"] for d in self.client.get("/api/schedule").json()["doses"]], ["d1", "d2", "d3"])

    def test_acknowledge_and_events(self):
        response = self.client.post("/api/doses/d3/acknowledge")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIs(response.json()["ok"], True)
        self.assertIs(response.json()["already_acknowledged"], False)
        self.assertEqual(set(response.json()), {"ok", "dose_id", "acknowledged_at", "already_acknowledged"})
        self.assertEqual(response.json()["dose_id"], "d3")
        self.assertRegex(response.json()["acknowledged_at"], HH_MM)
        dose = next(d for d in self.status()["care"]["doses"] if d["id"] == "d3")
        self.assertEqual(dose["status"], "acknowledged")
        self.assertEqual(dose["acknowledged_at"], response.json()["acknowledged_at"])
        again = self.client.post("/api/doses/d3/acknowledge")
        self.assertIs(again.json()["already_acknowledged"], True)
        self.assertEqual(again.json()["acknowledged_at"], response.json()["acknowledged_at"])
        self.assertEqual(self.client.post("/api/doses/nope/acknowledge").status_code, 404)

        events = self.client.get("/api/events?limit=50").json()
        self.assertEqual(set(events), {"events"})
        acks = [e for e in events["events"] if e["type"] == "pickup_acknowledged" and e["dose_id"] == "d3"]
        self.assertEqual(len(acks), 1, "acknowledging twice records one event")
        self.assertEqual(set(acks[0]), EVENT_KEYS)
        self.assertEqual(acks[0]["detail"], {"self_reported": True})
        self.assertRegex(acks[0]["time_local"], r"^\d\d:\d\d$")
        stamps = [e["ts"] for e in events["events"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True), "newest first")
        self.assertEqual(len(self.client.get("/api/events?limit=1").json()["events"]), 1)
        self.assertEqual(self.client.get("/api/events").status_code, 200)
        self.assertEqual(self.client.get("/api/events?limit=0").status_code, 422)

    def test_no_event_or_status_says_delivered(self):
        """Honest scope (SPEC section 1): nothing the API says claims a hand-over, calls the advisory
        person check a safety system or an interlock, or calls marker detection AI."""
        self.client.put("/api/mission/settings", json={"drift_assist": True})
        texts = [
            self.client.get("/api/events?limit=500").text,
            self.client.get("/api/status").text,
            self.client.get("/api/schedule").text,
            self.client.put("/api/mission/settings", json={"drift_assist": False}).text,
            self.client.post("/api/mission/start", json={"confirm_airborne": True}).text,
            self.client.post("/api/hover-test/start").text,
            self.client.post("/api/doses/d2/acknowledge").text,
            self.client.get("/api/health").text,
        ]
        # SPEC 10.4 names one status key after the emergency stop's motor-cut command (not medicine):
        # it is the only exception.
        text = " ".join(texts).lower().replace('"estop_delivered":', "")
        for word in ("deliver", "interlock", "safety system", "safety-system", "artificial intelligence"):
            self.assertNotIn(word, text)
        self.assertNotRegex(" ".join(texts), r"\bAI\b")


class ControlSocketTests(ApiTestCase):
    def test_messages_are_acknowledged_or_rejected(self):
        self.reset_sim(airborne=False)
        toggles = self.core.link.toggle_count
        with self.client.websocket_connect("/ws/control") as ws:
            self.assertEqual(ws.receive_json(), HELLO)
            ws.send_json({"type": "max_stick", "value": 0.8})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "max_stick"})
            self.assertEqual(self.status()["pilot"]["max_stick"], 0.8)
            ws.send_json({"type": "max_stick", "value": 0.1})
            reply = ws.receive_json()
            self.assertEqual((reply["type"], reply["of"], reply["code"]), ("error", "max_stick", "bad_request"))
            self.assertIsInstance(reply["message"], str)
            ws.send_json({"type": "max_stick", "value": 0.5})
            ws.receive_json()

            ws.send_json({"type": "calibrate"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "calibrate"})
            self.assertEqual(self.core.link.calibrate_count, 1)

            ws.send_json({"type": "takeoff_land"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "takeoff_land"})
            self.assertEqual(self.core.link.toggle_count, toggles + 1)

            ws.send_json({"type": "estop"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "estop", "delivered": True})
            self.assertTrue(self.status()["pilot"]["estop_active"])
            self.assertTrue(wait_for(lambda: self.status()["pilot"]["estop_delivered"], 2.0))
            self.assertEqual(self.status()["mission"]["blockers"][:1] and "estop_active" in
                             self.status()["mission"]["blockers"], True)
            ws.send_json({"type": "takeoff_land"})
            reply = ws.receive_json()
            self.assertEqual((reply["type"], reply["of"], reply["code"]), ("error", "takeoff_land", "estop_active"))
            self.assertIn("emergency stop", reply["message"])
            ws.send_json({"type": "calibrate"})
            self.assertEqual(ws.receive_json()["code"], "estop_active")
            self.assertEqual(self.core.link.toggle_count, toggles + 1)
            ws.send_json({"type": "estop_reset"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "estop_reset"})
            self.assertFalse(self.status()["pilot"]["estop_active"])
            self.assertFalse(self.status()["pilot"]["estop_delivered"])

            ws.send_json({"type": "warp_speed"})
            self.assertEqual(ws.receive_json(), {"type": "error", "of": "warp_speed", "code": "bad_request",
                                                 "message": "unknown message type 'warp_speed'"})
            ws.send_text("not json")
            self.assertEqual(ws.receive_json(), {"type": "error", "of": None, "code": "bad_request",
                                                 "message": "invalid JSON"})
            ws.send_json({"type": "axes", "throttle": "up", "yaw": 0, "pitch": 0, "roll": 0})
            reply = ws.receive_json()
            self.assertEqual((reply["type"], reply["of"], reply["code"]), ("error", "axes", "bad_request"))

    def test_axes_reach_the_drone_and_disconnect_zeroes_them(self):
        self.reset_sim()
        with self.client.websocket_connect("/ws/control") as ws:
            for _ in range(8):
                ws.send_json({"type": "axes", "throttle": 0, "yaw": 1, "pitch": 0, "roll": 0})
                time.sleep(0.05)
            status = self.status()
            self.assertTrue(status["pilot"]["manual_active"])
            self.assertAlmostEqual(self.core.link.last_axes_sent[1], 0.5, delta=0.01)   # 1.0 x max_stick 0.5
            ws.send_json({"type": "axes", "throttle": 0, "yaw": 1, "pitch": 0, "roll": 0})
        # the socket is closed while yaw is still held
        self.assertTrue(wait_for(lambda: self.core.link.last_axes_sent == (0.0, 0.0, 0.0, 0.0), 0.5, 0.01))
        self.assertFalse(self.status()["pilot"]["manual_active"])

    def test_second_pilot_is_refused_with_close_code_4001(self):
        with self.client.websocket_connect("/ws/control") as first:
            self.assertEqual(first.receive_json(), HELLO)
            with self.assertRaises(WebSocketDisconnect) as caught:
                with self.client.websocket_connect("/ws/control") as second:
                    second.receive_json()          # the refused socket never gets "hello"
            self.assertEqual(caught.exception.code, 4001)
            first.send_json({"type": "max_stick", "value": 0.5})
            self.assertEqual(first.receive_json(), {"type": "ack", "of": "max_stick"})
        # once the first pilot has gone, a new one is welcome
        time.sleep(0.1)
        with self.client.websocket_connect("/ws/control") as third:
            self.assertEqual(third.receive_json(), HELLO)
            third.send_json({"type": "max_stick", "value": 0.5})
            self.assertEqual(third.receive_json(), {"type": "ack", "of": "max_stick"})

    def test_estop_sent_before_hello_is_read_is_latched(self):
        """The frontend may send estop on an open socket before it has seen "hello": never dropped."""
        self.reset_sim()
        with self.client.websocket_connect("/ws/control") as ws:
            ws.send_json({"type": "estop"})          # nothing received yet
            self.assertEqual(ws.receive_json(), HELLO)
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "estop", "delivered": True})
            self.assertTrue(self.status()["pilot"]["estop_active"])
            ws.send_json({"type": "estop_reset"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "estop_reset"})

    def test_toggle_refusal_codes_reach_the_socket(self):
        self.reset_sim()
        with self.client.websocket_connect("/ws/control") as ws:
            self.assertEqual(ws.receive_json(), HELLO)
            time.sleep(1.1)                                        # clear of any earlier toggle
            self.core.mixer.mission_command(0.0, 0.0)              # as the runner does on arrival...
            self.assertTrue(self.core.mixer.mission_toggle())     # ...then its landing toggle
            ws.send_json({"type": "takeoff_land"})
            reply = ws.receive_json()
            self.assertEqual((reply["type"], reply["of"], reply["code"]), ("error", "takeoff_land", "landing_in_progress"))
            self.assertIn("landing in progress", reply["message"])
            self.core.link.set_pose(airborne=True)
            time.sleep(4.1)
            self.core.link.control_up = lambda: False             # the drone link drops
            try:
                ws.send_json({"type": "takeoff_land"})
                reply = ws.receive_json()
                self.assertEqual((reply["of"], reply["code"]), ("takeoff_land", "drone_link_down"))
                self.assertIs(self.status()["link"]["control_up"], False)
            finally:
                del self.core.link.control_up
            ws.send_json({"type": "takeoff_land"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "takeoff_land"})
            ws.send_json({"type": "takeoff_land"})
            reply = ws.receive_json()
            self.assertEqual((reply["of"], reply["code"]), ("takeoff_land", "toggle_guard"))
        time.sleep(1.1)
        self.core.link.set_pose(airborne=True)

    def test_battery_low_needs_the_check_enabled_and_fresh_telemetry(self):
        from medhop.drone.base import Telemetry

        real = self.core.link.telemetry
        settings = self.core.settings
        old = settings.battery_low_raw
        now = time.monotonic()
        try:
            for threshold, age, low, enabled in ((35, 0.5, True, True), (35, 3.5, False, True),
                                                 (-1, 0.5, False, False)):
                object.__setattr__(settings, "battery_low_raw", threshold)
                self.core.link.telemetry = lambda age=age: Telemetry(1, 20, 16, now - age)
                telemetry = self.status()["telemetry"]
                self.assertEqual((telemetry["battery_low"], telemetry["battery_check_enabled"]), (low, enabled),
                                 (threshold, age))
                self.assertEqual(telemetry["battery_raw"], 20)    # the last byte is still shown
        finally:
            object.__setattr__(settings, "battery_low_raw", old)
            self.core.link.telemetry = real

    def test_pilot_input_aborts_a_running_mission(self):
        self.reset_sim()
        with self.client.websocket_connect("/ws/control") as ws:
            self.assertTrue(wait_for(lambda: self.status()["mission"]["can_start"], 3.0), self.status()["mission"])
            self.assertEqual(self.client.post("/api/mission/start", json={"confirm_airborne": True}).status_code, 200)
            ws.send_json({"type": "axes", "throttle": 0, "yaw": 0, "pitch": -0.5, "roll": 0})
            self.assertTrue(wait_for(lambda: self.status()["mission"]["state"] == "aborted", 1.0))
            self.assertEqual(self.status()["mission"]["reason"], "pilot_took_over")
        self.assertEqual(self.status()["mission"]["reason"], "pilot_took_over", "closing the socket later changes nothing")


class FullRunApiTests(ApiTestCase):
    sim_kwargs = {"start_airborne": False, "start_distance_m": 1.3, "start_heading_deg": 8.0}

    def test_station_run_through_the_api_ends_done_with_an_arrival_event(self):
        self.assertFalse(self.core.link.pose()["airborne"])
        # A dose whose time has not come yet today (the run will arrive early for it).
        late = self.client.post("/api/schedule", json={"time": "23:59", "label": "Late dose (demo)"}).json()["id"]
        self.assertTrue(self.client.put("/api/mission/settings", json={"drift_assist": True}).json()["drift_assist"])
        # Revision 3: land_on_arrival defaults to False; this test is about the landing run
        self.assertTrue(self.client.put("/api/mission/settings", json={"land_on_arrival": True}).json()["land_on_arrival"])
        self.addCleanup(self.client.put, "/api/mission/settings", json={"land_on_arrival": False})
        with self.client.websocket_connect("/ws/control") as ws:
            self.assertEqual(ws.receive_json(), HELLO)
            ws.send_json({"type": "takeoff_land"})
            self.assertEqual(ws.receive_json(), {"type": "ack", "of": "takeoff_land"})
            self.assertTrue(wait_for(lambda: self.core.link.pose()["airborne"], 6.0))  # takeoff is 1.6 s of sim time; slack for a loaded machine
            self.assertTrue(wait_for(lambda: self.status()["mission"]["can_start"], 3.0), self.status()["mission"])
            response = self.client.post("/api/mission/start", json={"confirm_airborne": True, "dose_id": late})
            self.assertEqual(response.status_code, 200, response.text)
            run_id = response.json()["run_id"]
            seen = set()

            def finished():
                state = self.status()["mission"]["state"]
                seen.add(state)
                return state in ("done", "aborted")

            self.assertTrue(wait_for(finished, 30.0, 0.1))
        mission = self.status()["mission"]
        self.assertEqual((mission["state"], mission["reason"], mission["run_id"]), ("done", None, run_id))
        self.assertTrue({"approaching", "landing", "done"} <= seen, seen)
        self.assertEqual(self.core.link.toggle_count, 2)        # the pilot's takeoff and the run's landing
        self.assertTrue(wait_for(lambda: self.core.link.pose()["phase"] == "ground", 3.0))
        events = self.client.get("/api/events?limit=10").json()["events"]
        mine = [e for e in events if e["run_id"] == run_id]
        self.assertEqual([e["type"] for e in mine], ["arrived_at_station", "run_started"])
        self.assertEqual(mine[0]["dose_id"], late)
        self.assertEqual(mine[0]["detail"]["mode"], "sim")
        self.assertIn("suggested_trim_roll", mine[0]["detail"])
        self.assertIs(mine[1]["detail"]["drift_assist"], True)
        self.assertEqual(set(mission["drift_assist"]), DRIFT_ASSIST_KEYS)
        self.assertEqual(mission["drift_assist"]["suggested_trim_roll"], mine[0]["detail"]["suggested_trim_roll"])
        self.assertEqual((mission["drift_assist"]["active"], mission["drift_assist"]["roll"]), (False, 0.0))
        self.assertTrue((self.dir / "runs" / f"{run_id}.json").exists())
        # dose times in status are local "HH:MM" strings, not unix seconds
        care = self.status()["care"]
        dose = next(d for d in care["doses"] if d["id"] == late)
        self.assertRegex(dose["arrived_at"], HH_MM)
        self.assertEqual(dose["arrived_at"], mine[0]["time_local"])
        self.assertIsNone(dose["acknowledged_at"])
        if care["now_local"] < "23:58":
            # the run arrived before the dose time: it is "arrived", and nothing says it is due yet
            self.assertEqual(dose["status"], "arrived")
            time.sleep(2.5)                                      # the care monitor ticks once a second
            events = self.client.get("/api/events?limit=100").json()["events"]
            self.assertEqual([e["type"] for e in events if e["dose_id"] == late],
                             ["arrived_at_station", "run_started"], "no reminder_due before the dose time")
        self.client.delete(f"/api/schedule/{late}")
        self.client.put("/api/mission/settings", json={"drift_assist": False})


class VideoStreamTests(unittest.TestCase):
    def fetch(self, core):
        with TestClient(create_app(core=core)) as client:
            time.sleep(1.0)
            # The stream is endless; ending it is what a server shutdown does.
            timer = threading.Timer(0.6, core.stopping.set)
            timer.start()
            response = client.get("/video.mjpg")
            timer.join()
        return response

    def parts(self, body):
        return [chunk for chunk in body.split(b"--frame\r\n") if chunk]

    def test_stream_is_multipart_jpeg_of_the_annotated_video(self):
        directory = make_temp_dir()
        self.addCleanup(shutil.rmtree, directory, True)
        response = self.fetch(make_core(directory, start_airborne=True))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "multipart/x-mixed-replace; boundary=frame")
        parts = self.parts(response.content)
        self.assertGreaterEqual(len(parts), 4)
        for part in parts[:3]:
            header, _, jpeg = part.partition(b"\r\n\r\n")
            self.assertIn(b"Content-Type: image/jpeg", header)
            self.assertEqual(jpeg[:3], b"\xff\xd8\xff")
            self.assertEqual(jpeg.rstrip(b"\r\n")[-2:], b"\xff\xd9")

    def test_no_video_card_is_served_before_any_frame(self):
        from tests.harness import RecordingLink

        directory = make_temp_dir()
        self.addCleanup(shutil.rmtree, directory, True)
        core = MedHopCore(Settings(data_dir=directory, person_check="off"), link=RecordingLink())
        response = self.fetch(core)
        parts = self.parts(response.content)
        self.assertGreaterEqual(len(parts), 1)
        _header, _, jpeg = parts[0].partition(b"\r\n\r\n")
        self.assertEqual(jpeg[:3], b"\xff\xd8\xff")
        self.assertEqual(jpeg, core.vision.annotated_jpeg()[1] + b"\r\n")


if __name__ == "__main__":
    unittest.main()
