import json
import shutil
import unittest

from medhop.care.store import CareStore, validate_time
from tests.harness import make_temp_dir


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = make_temp_dir()
        self.now = 1_794_000_000.0
        self.store = CareStore(self.dir, wall_clock=lambda: self.now)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def reopen(self):
        return CareStore(self.dir, wall_clock=lambda: self.now)


class ScheduleTests(StoreTestCase):
    def test_first_run_seeds_three_clearly_demo_doses(self):
        doses = self.store.list_doses()
        self.assertEqual([(d["id"], d["time"]) for d in doses], [("d1", "08:00"), ("d2", "13:00"), ("d3", "20:00")])
        self.assertTrue(all("(demo)" in d["label"] for d in doses))
        self.assertTrue((self.dir / "schedule.json").exists())
        self.assertTrue((self.dir / "runs").is_dir())

    def test_seed_happens_only_once(self):
        self.store.delete_dose("d1")
        self.store.delete_dose("d2")
        self.store.delete_dose("d3")
        self.assertEqual(self.reopen().list_doses(), [])

    def test_add_update_delete_persist_across_reopen(self):
        added = self.store.add_dose("09:30", "Extra dose (demo)", "with water")
        self.assertEqual(added, {"id": "d4", "time": "09:30", "label": "Extra dose (demo)", "notes": "with water"})
        updated = self.store.update_dose("d4", time_str="10:15", notes="")
        self.assertEqual(updated["time"], "10:15")
        self.assertEqual(updated["label"], "Extra dose (demo)")
        self.assertTrue(self.store.delete_dose("d2"))
        self.assertFalse(self.store.delete_dose("d2"))
        again = self.reopen()
        self.assertEqual([d["id"] for d in again.list_doses()], ["d1", "d4", "d3"])
        self.assertEqual(again.get_dose("d4")["time"], "10:15")
        self.assertIsNone(again.get_dose("d2"))

    def test_doses_are_listed_in_time_order(self):
        self.store.add_dose("06:00", "Early (demo)")
        self.assertEqual([d["time"] for d in self.store.list_doses()], ["06:00", "08:00", "13:00", "20:00"])

    def test_ids_are_not_reused(self):
        self.store.delete_dose("d3")
        self.assertEqual(self.store.add_dose("21:00", "Later (demo)")["id"], "d4")
        self.store.add_event("pickup_acknowledged", dose_id="d4")
        self.store.delete_dose("d4")
        self.assertEqual(self.store.add_dose("22:00", "Latest (demo)")["id"], "d5")

    def test_validation(self):
        for bad in ("8:00", "24:00", "12:60", "noon", "", None, 800, "12:5"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                validate_time(bad)
        self.assertEqual(validate_time("00:00"), "00:00")
        self.assertEqual(validate_time("23:59"), "23:59")
        with self.assertRaises(ValueError):
            self.store.add_dose("08:00", "   ")
        with self.assertRaises(ValueError):
            self.store.add_dose("08:00", "x" * 81)
        with self.assertRaises(ValueError):
            self.store.update_dose("d1", time_str="25:00")
        with self.assertRaises(KeyError):
            self.store.update_dose("nope", label="x")
        self.assertEqual(self.store.get_dose("d1")["time"], "08:00")

    def test_corrupt_schedule_is_set_aside_not_lost(self):
        (self.dir / "schedule.json").write_text("{not json", encoding="utf-8")
        again = self.reopen()
        self.assertEqual(len(again.list_doses()), 3)
        self.assertEqual(len(list(self.dir.glob("schedule.json.corrupt-*"))), 1)

    def test_wrong_shape_schedule_is_set_aside_not_lost(self):
        for content in ("[]", '{"doses": "d1"}', "null", '"schedule"'):
            (self.dir / "schedule.json").write_text(content, encoding="utf-8")
            for old in self.dir.glob("schedule.json.corrupt-*"):
                old.unlink()
            again = self.reopen()
            self.assertEqual(len(again.list_doses()), 3, content)
            asides = list(self.dir.glob("schedule.json.corrupt-*"))
            self.assertEqual([p.name for p in asides], [f"schedule.json.corrupt-{int(self.now)}"], content)
            self.assertEqual(asides[0].read_text(encoding="utf-8"), content)

    def test_one_invalid_dose_is_skipped_without_rewriting_the_file(self):
        raw = ('{"doses": [{"id": "d1", "time": "08:00", "label": "Morning (demo)", "notes": ""},'
               ' {"id": "d7", "time": "25:00", "label": "Hand edited (demo)"}], "next_id": 8}')
        (self.dir / "schedule.json").write_text(raw, encoding="utf-8")
        again = self.reopen()
        self.assertEqual([d["id"] for d in again.list_doses()], ["d1"])
        self.assertEqual((self.dir / "schedule.json").read_text(encoding="utf-8"), raw, "loading does not rewrite")
        self.assertEqual(list(self.dir.glob("schedule.json.corrupt-*")), [])
        self.assertEqual(again.add_dose("09:00", "New (demo)")["id"], "d8", "next_id from the file is kept")

    def test_files_use_lf_line_endings(self):
        self.store.add_event("hover_test", detail={"pass": True})
        for name in ("schedule.json", "events.jsonl"):
            self.assertNotIn(b"\r", (self.dir / name).read_bytes())


class EventTests(StoreTestCase):
    def test_events_are_newest_first_with_local_time(self):
        self.store.add_event("run_started", dose_id="d1", run_id="r1", ts=self.now)
        self.store.add_event("arrived_at_station", dose_id="d1", run_id="r1", detail={"marker_width": 0.16},
                             ts=self.now + 60)
        events = self.store.events()
        self.assertEqual([e["type"] for e in events], ["arrived_at_station", "run_started"])
        self.assertEqual(set(events[0]), {"ts", "time_local", "type", "dose_id", "run_id", "detail"})
        self.assertRegex(events[0]["time_local"], r"^\d\d:\d\d$")
        self.assertEqual(events[0]["detail"], {"marker_width": 0.16})

    def test_limit(self):
        for i in range(7):
            self.store.add_event("hover_test", ts=self.now + i)
        self.assertEqual(len(self.store.events(3)), 3)
        self.assertEqual(self.store.events(3)[0]["ts"], self.now + 6)
        self.assertEqual(len(self.store.events(0)), 1)

    def test_events_persist_as_json_lines(self):
        self.store.add_event("pickup_acknowledged", dose_id="d2", ts=self.now)
        self.store.add_event("needs_attention", dose_id="d1", ts=self.now + 1)
        lines = (self.dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0])["type"], "pickup_acknowledged")
        self.assertEqual([e["type"] for e in self.reopen().events()], ["needs_attention", "pickup_acknowledged"])

    def test_unreadable_lines_are_skipped(self):
        self.store.add_event("hover_test", ts=self.now)
        with open(self.dir / "events.jsonl", "a", encoding="utf-8") as handle:
            handle.write("garbage\n")
        self.assertEqual(len(self.reopen().events()), 1)

    def test_event_after_a_truncated_last_line_survives_a_restart(self):
        self.store.add_event("reminder_due", dose_id="d1", ts=self.now)
        with open(self.dir / "events.jsonl", "a", encoding="utf-8") as handle:
            handle.write('{"ts": 1794000001.0, "type": "run_sta')        # crash mid-write, no newline
        crashed = self.reopen()
        crashed.add_event("pickup_acknowledged", dose_id="d1", ts=self.now + 2)
        again = self.reopen()
        self.assertEqual([e["type"] for e in again.events()], ["pickup_acknowledged", "reminder_due"])
        lines = (self.dir / "events.jsonl").read_text(encoding="utf-8").split("\n")
        self.assertEqual(lines[-1], "", "the log still ends in a newline")
        self.assertEqual(len(lines), 4)

    def test_no_blank_line_is_added_when_the_log_ends_cleanly(self):
        self.store.add_event("hover_test", ts=self.now)
        self.store.add_event("hover_test", ts=self.now + 1)
        self.assertNotIn(b"\n\n", (self.dir / "events.jsonl").read_bytes())
        (self.dir / "events.jsonl").write_bytes(b"")
        self.store.add_event("hover_test", ts=self.now + 2)
        self.assertFalse((self.dir / "events.jsonl").read_bytes().startswith(b"\n"))

    def test_invalid_utf8_in_the_log_does_not_block_loading(self):
        self.store.add_event("pickup_acknowledged", dose_id="d1", ts=self.now, detail={"label": "Morgen \u00e9"})
        with open(self.dir / "events.jsonl", "ab") as handle:
            handle.write(b"\xff\xfe not json at all\n")
            handle.write(b'{"ts": 1794000005.0, "type": "hover_test", "detail": {"note": "bad \xc3"}}\n')
            handle.write('{"ts": 1794000003.0, "type": "reminder_due", "dose_id": "d1"}\n'.encode())
            handle.write(b'{"ts": 1794000009.0, "type": "hover_test", "detail": "x"}\n')
            handle.write(b"[1, 2]\n")
            handle.write("{\"ts\": 1794000010.0, \"type\": \"run_aborted\", \"detail\": {\"why\": \"\u00e9\"}}".encode()[:-4])
        again = self.reopen()
        types = [e["type"] for e in again.events()]
        self.assertEqual(types, ["hover_test", "reminder_due", "pickup_acknowledged"])
        self.assertEqual(again.events()[2]["detail"], {"label": "Morgen \u00e9"})
        self.assertIn("\ufffd", again.events()[0]["detail"]["note"], "a bad byte inside a string is replaced")

    def test_unknown_event_type_is_rejected(self):
        with self.assertRaises(ValueError):
            self.store.add_event("delivered")

    def test_events_between(self):
        for i in range(5):
            self.store.add_event("hover_test", ts=self.now + i * 10)
        got = self.store.events_between(self.now + 10, self.now + 30)
        self.assertEqual([e["ts"] for e in got], [self.now + 10, self.now + 20])


class TrimAndCalibrationTests(StoreTestCase):
    def test_trim_defaults_to_zero_and_persists(self):
        self.assertEqual(self.store.load_trim(), (0.0, 0.0))
        self.store.save_trim(0.02, -0.01)
        self.assertEqual(self.reopen().load_trim(), (0.02, -0.01))

    def test_arrive_width_persists_and_rejects_nonsense(self):
        self.assertIsNone(self.store.load_arrive_width())
        self.store.save_arrive_width(0.21)
        self.assertEqual(self.reopen().load_arrive_width(), 0.21)
        self.store.save_arrive_width(5.0)
        self.assertIsNone(self.reopen().load_arrive_width())

    def test_drift_assist_is_off_by_default_and_persists(self):
        self.assertIs(self.store.load_drift_assist(), False)
        self.store.save_drift_assist(True)
        self.assertIs(CareStore(self.dir).load_drift_assist(), True)
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()), {"drift_assist": True})
        (self.dir / "mission.json").write_text('{"drift_assist": "yes"}')
        self.assertIs(CareStore(self.dir).load_drift_assist(), False, "anything but true is off")
        self.store.save_drift_assist(False)
        self.assertIs(CareStore(self.dir).load_drift_assist(), False)

    def test_land_on_arrival_is_off_by_default_and_persists(self):
        self.assertIs(self.store.load_land_on_arrival(), False)
        self.store.save_land_on_arrival(True)
        self.assertIs(self.reopen().load_land_on_arrival(), True)
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()), {"land_on_arrival": True})
        self.store.save_land_on_arrival(False)
        self.assertIs(self.reopen().load_land_on_arrival(), False)
        (self.dir / "mission.json").write_text('{"land_on_arrival": 1}')
        self.assertIs(self.reopen().load_land_on_arrival(), False, "anything but true is off")

    def test_saving_one_mission_switch_keeps_the_other(self):
        self.store.save_drift_assist(True)
        self.store.save_land_on_arrival(True)
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()),
                         {"drift_assist": True, "land_on_arrival": True})
        self.store.save_drift_assist(False)
        again = self.reopen()
        self.assertIs(again.load_drift_assist(), False)
        self.assertIs(again.load_land_on_arrival(), True, "saving drift_assist kept land_on_arrival")
        self.store.save_drift_assist(True)
        self.store.save_land_on_arrival(False)
        again = self.reopen()
        self.assertIs(again.load_land_on_arrival(), False)
        self.assertIs(again.load_drift_assist(), True, "saving land_on_arrival kept drift_assist")

    def test_malformed_mission_file_falls_back_to_defaults(self):
        for content in ("{not json", "[]", '"true"', '{"drift_assist": "yes", "land_on_arrival": null}'):
            (self.dir / "mission.json").write_text(content)
            again = self.reopen()
            self.assertIs(again.load_drift_assist(), False, content)
            self.assertIs(again.load_land_on_arrival(), False, content)
        (self.dir / "mission.json").write_text("{not json")
        self.store.save_land_on_arrival(True)
        self.assertEqual(json.loads((self.dir / "mission.json").read_text()), {"land_on_arrival": True})
        self.assertTrue(list(self.dir.glob("mission.json.corrupt-*")), "unparseable file was set aside")

    def test_run_trace_is_written_under_runs(self):
        path = self.store.write_run_trace("run-x", {"run_id": "run-x", "samples": []})
        self.assertEqual(path, self.dir / "runs" / "run-x.json")
        self.assertEqual(json.loads(path.read_text())["run_id"], "run-x")


if __name__ == "__main__":
    unittest.main()
