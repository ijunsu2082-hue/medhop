import shutil
import unittest
from datetime import datetime

from medhop.care.status import (
    CareMonitor,
    care_snapshot,
    day_bounds,
    dose_statuses,
    next_due_id,
)
from medhop.care.store import CareStore
from tests.harness import make_temp_dir

DOSES = [
    {"id": "d1", "time": "08:00", "label": "Morning dose (demo)", "notes": ""},
    {"id": "d2", "time": "13:00", "label": "Midday dose (demo)", "notes": ""},
    {"id": "d3", "time": "20:00", "label": "Evening dose (demo)", "notes": ""},
]
GRACE = 15


def at(hour, minute=0, second=0, day=11):
    return datetime(2026, 11, day, hour, minute, second)


def event(kind, dose_id, when, detail=None):
    return {"type": kind, "dose_id": dose_id, "ts": when.timestamp(), "run_id": None, "detail": detail or {}}


def status_of(dose_id, events, now, doses=DOSES, grace=GRACE):
    return next(d for d in dose_statuses(doses, events, now, grace) if d["id"] == dose_id)


class DoseStatusTests(unittest.TestCase):
    def test_upcoming_before_its_time(self):
        dose = status_of("d1", [], at(7, 59, 59))
        self.assertEqual(dose["status"], "upcoming")
        self.assertIsNone(dose["arrived_at"])
        self.assertIsNone(dose["acknowledged_at"])

    def test_due_from_its_time(self):
        self.assertEqual(status_of("d1", [], at(8, 0, 0))["status"], "due")
        self.assertEqual(status_of("d1", [], at(8, 1))["status"], "due")

    def test_arrived_once_a_run_logged_arrival_today(self):
        arrived = at(8, 2)
        dose = status_of("d1", [event("arrived_at_station", "d1", arrived)], at(8, 3))
        self.assertEqual(dose["status"], "arrived")
        self.assertEqual(dose["arrived_at"], "08:02")
        self.assertEqual(status_of("d2", [event("arrived_at_station", "d1", arrived)], at(8, 3))["status"],
                         "upcoming")

    def test_acknowledged_once_acknowledged_today(self):
        events = [event("arrived_at_station", "d1", at(8, 2)), event("pickup_acknowledged", "d1", at(8, 5))]
        dose = status_of("d1", events, at(9, 30))
        self.assertEqual(dose["status"], "acknowledged")
        self.assertEqual(dose["acknowledged_at"], "08:05")
        self.assertEqual(dose["arrived_at"], "08:02")

    def test_acknowledged_without_any_run(self):
        dose = status_of("d1", [event("pickup_acknowledged", "d1", at(8, 5))], at(12, 0))
        self.assertEqual(dose["status"], "acknowledged")
        self.assertIsNone(dose["arrived_at"])

    def test_needs_attention_after_the_grace_window(self):
        self.assertEqual(status_of("d1", [], at(8, 15, 0))["status"], "due")          # exactly time + grace
        self.assertEqual(status_of("d1", [], at(8, 15, 1))["status"], "needs_attention")
        self.assertEqual(status_of("d1", [], at(19, 0))["status"], "needs_attention")

    def test_needs_attention_keeps_arrived_at(self):
        arrived = at(8, 2)
        dose = status_of("d1", [event("arrived_at_station", "d1", arrived)], at(8, 20))
        self.assertEqual(dose["status"], "needs_attention")
        self.assertEqual(dose["arrived_at"], "08:02")

    def test_grace_window_is_configurable(self):
        self.assertEqual(status_of("d1", [], at(8, 20), grace=30)["status"], "due")
        self.assertEqual(status_of("d1", [], at(8, 0, 1), grace=0)["status"], "needs_attention")

    def test_all_five_statuses_in_one_day(self):
        doses = DOSES + [
            {"id": "d4", "time": "09:00", "label": "x", "notes": ""},
            {"id": "d5", "time": "09:10", "label": "y", "notes": ""},
        ]
        events = [
            event("pickup_acknowledged", "d4", at(9, 1)),
            event("arrived_at_station", "d5", at(9, 11)),
        ]
        now = at(9, 12)
        got = {d["id"]: d["status"] for d in dose_statuses(doses, events, now, GRACE)}
        self.assertEqual(got, {
            "d1": "needs_attention", "d4": "acknowledged", "d5": "arrived",
            "d2": "upcoming", "d3": "upcoming",
        })
        doses.append({"id": "d6", "time": "09:12", "label": "z", "notes": ""})
        self.assertEqual(status_of("d6", events, now, doses=doses)["status"], "due")

    def test_output_is_sorted_by_time_and_has_the_spec_keys(self):
        out = dose_statuses(list(reversed(DOSES)), [], at(7, 0), GRACE)
        self.assertEqual([d["id"] for d in out], ["d1", "d2", "d3"])
        self.assertEqual(set(out[0]), {"id", "time", "label", "notes", "status", "arrived_at", "arrived_mode",
                                       "acknowledged_at"})


class ArrivalKeptAndModeTests(unittest.TestCase):
    def test_arrived_at_and_mode_are_kept_in_every_status(self):
        arrival = [event("arrived_at_station", "d1", at(7, 50), {"mode": "real"})]
        ack = arrival + [event("pickup_acknowledged", "d1", at(8, 30))]
        cases = [
            ("arrived", arrival, at(7, 55)),        # early arrival, before the dose time
            ("arrived", arrival, at(8, 5)),
            ("needs_attention", arrival, at(8, 16)),
            ("acknowledged", ack, at(9, 0)),
        ]
        for expected, events, now in cases:
            dose = status_of("d1", events, now)
            self.assertEqual((dose["status"], dose["arrived_at"], dose["arrived_mode"]),
                             (expected, "07:50", "real"), now)

    def test_arrived_mode_is_null_without_an_arrival(self):
        for events, now in (([], at(7, 0)), ([], at(8, 5)), ([], at(9, 0)),
                            ([event("pickup_acknowledged", "d1", at(8, 5))], at(9, 0))):
            dose = status_of("d1", events, now)
            self.assertIsNone(dose["arrived_at"], dose)
            self.assertIsNone(dose["arrived_mode"], dose)

    def test_arrived_mode_is_copied_from_the_arrival_event(self):
        for mode in ("sim", "real"):
            dose = status_of("d1", [event("arrived_at_station", "d1", at(8, 2), {"mode": mode})], at(8, 3))
            self.assertEqual(dose["arrived_mode"], mode)

    def test_arrived_mode_is_null_when_the_event_has_no_mode(self):
        for detail in ({}, {"marker_width": 0.16}, {"mode": None}, {"mode": "delivered"}):
            dose = status_of("d1", [event("arrived_at_station", "d1", at(8, 2), detail)], at(8, 3))
            self.assertEqual((dose["status"], dose["arrived_at"], dose["arrived_mode"]), ("arrived", "08:02", None),
                             detail)
        no_detail = {"type": "arrived_at_station", "dose_id": "d1", "ts": at(8, 2).timestamp(), "run_id": None}
        self.assertIsNone(status_of("d1", [no_detail], at(8, 3))["arrived_mode"])

    def test_the_latest_arrival_sets_time_and_mode(self):
        events = [event("arrived_at_station", "d1", at(8, 9), {"mode": "real"}),
                  event("arrived_at_station", "d1", at(8, 2), {"mode": "sim"})]
        dose = status_of("d1", events, at(8, 10))
        self.assertEqual((dose["arrived_at"], dose["arrived_mode"]), ("08:09", "real"))
        events.append(event("arrived_at_station", "d1", at(8, 12)))
        dose = status_of("d1", events, at(8, 13))
        self.assertEqual((dose["arrived_at"], dose["arrived_mode"]), ("08:12", None))

    def test_another_doses_arrival_does_not_set_the_mode(self):
        events = [event("arrived_at_station", "d2", at(8, 2), {"mode": "sim"})]
        self.assertIsNone(status_of("d1", events, at(8, 3))["arrived_mode"])
        self.assertEqual(status_of("d2", events, at(8, 3))["arrived_mode"], "sim")


class NextDueTests(unittest.TestCase):
    def next_due(self, events, now):
        return next_due_id(dose_statuses(DOSES, events, now, GRACE), now)

    def test_earliest_pending_dose_wins(self):
        self.assertEqual(self.next_due([], at(13, 5)), "d1")       # needs attention since the morning

    def test_next_upcoming_when_nothing_is_pending(self):
        events = [event("pickup_acknowledged", "d1", at(8, 5))]
        self.assertEqual(self.next_due(events, at(9, 0)), "d2")

    def test_none_when_everything_is_acknowledged(self):
        events = [event("pickup_acknowledged", d["id"], at(21, 0)) for d in DOSES]
        self.assertIsNone(self.next_due(events, at(22, 0)))
        self.assertIsNone(next_due_id([], at(8, 0)))

    def test_an_early_arrival_does_not_jump_ahead_of_a_dose_that_is_due(self):
        """The evening run arrived at 13:02; the midday dose is due: midday comes first."""
        events = [event("pickup_acknowledged", "d1", at(8, 5)), event("arrived_at_station", "d3", at(13, 2))]
        self.assertEqual(self.next_due(events, at(13, 5)), "d2")

    def test_an_early_arrival_does_not_jump_ahead_of_an_earlier_upcoming_dose(self):
        """Nothing is due at 12:00. The evening run has arrived, but midday is the next one by time."""
        events = [event("pickup_acknowledged", "d1", at(8, 5)), event("arrived_at_station", "d3", at(11, 0))]
        self.assertEqual(self.next_due(events, at(12, 0)), "d2")

    def test_an_early_arrival_is_next_only_when_nothing_else_is_due_or_earlier(self):
        """17:05, morning and midday acknowledged, the 20:00 run has arrived: it is what comes next."""
        events = [event("pickup_acknowledged", "d1", at(8, 5)), event("pickup_acknowledged", "d2", at(13, 5)),
                  event("arrived_at_station", "d3", at(17, 5))]
        self.assertEqual(self.next_due(events, at(17, 6)), "d3")
        # and once its time has come it is simply the pending dose
        self.assertEqual(self.next_due(events, at(20, 0)), "d3")

    def test_an_early_arrival_for_the_earliest_dose_is_still_the_next_one(self):
        events = [event("arrived_at_station", "d1", at(7, 50))]
        self.assertEqual(self.next_due(events, at(7, 55)), "d1")    # earliest by time, not yet due
        self.assertEqual(self.next_due(events, at(8, 1)), "d1")


class EarlyArrivalTests(unittest.TestCase):
    """A station run that arrives before the dose time (seen live: arrived 17:05 for the 20:00 dose)."""

    EVENTS = [event("arrived_at_station", "d3", at(17, 5))]

    def test_status_is_arrived_with_the_arrival_time_before_and_after_the_dose_time(self):
        for now in (at(17, 5, 30), at(19, 59), at(20, 0), at(20, 15)):
            dose = status_of("d3", self.EVENTS, now)
            self.assertEqual((dose["status"], dose["arrived_at"], dose["acknowledged_at"]), ("arrived", "17:05", None))
        late = status_of("d3", self.EVENTS, at(20, 16))
        self.assertEqual((late["status"], late["arrived_at"]), ("needs_attention", "17:05"))

    def test_times_are_local_hh_mm_strings_or_none(self):
        events = self.EVENTS + [event("pickup_acknowledged", "d3", at(20, 7, 59))]
        for dose in dose_statuses(DOSES, events, at(21, 0), GRACE):
            for key in ("arrived_at", "acknowledged_at"):
                self.assertTrue(dose[key] is None or (isinstance(dose[key], str) and len(dose[key]) == 5), dose)
        d3 = status_of("d3", events, at(21, 0))
        self.assertEqual((d3["arrived_at"], d3["acknowledged_at"]), ("17:05", "20:07"))


class StoreBackedTests(unittest.TestCase):
    def setUp(self):
        self.dir = make_temp_dir()
        self.store = CareStore(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_day_bounds_are_local_midnights(self):
        start, end = day_bounds(at(15, 30))
        self.assertEqual(start, at(0, 0).timestamp())
        self.assertEqual(end, at(0, 0, day=12).timestamp())

    def test_yesterdays_events_do_not_count_today(self):
        self.store.add_event("arrived_at_station", dose_id="d1", ts=at(8, 2, day=10).timestamp())
        self.store.add_event("pickup_acknowledged", dose_id="d1", ts=at(23, 59, 59, day=10).timestamp())
        snapshot = care_snapshot(self.store, at(8, 5), GRACE)
        d1 = snapshot["doses"][0]
        self.assertEqual(d1["status"], "due")
        self.assertIsNone(d1["arrived_at"])
        self.assertIsNone(d1["acknowledged_at"])

    def test_event_at_exactly_midnight_belongs_to_the_new_day(self):
        self.store.add_event("pickup_acknowledged", dose_id="d1", ts=at(0, 0, 0).timestamp())
        self.assertEqual(care_snapshot(self.store, at(0, 0, 1), GRACE)["doses"][0]["status"], "acknowledged")
        self.assertEqual(care_snapshot(self.store, at(23, 59, 59, day=10), GRACE)["doses"][0]["status"],
                         "needs_attention")

    def test_statuses_start_again_at_midnight(self):
        self.store.add_dose("23:50", "Late dose (demo)")
        late = lambda snap: next(d for d in snap["doses"] if d["time"] == "23:50")
        self.assertEqual(late(care_snapshot(self.store, at(23, 49), GRACE))["status"], "upcoming")
        self.assertEqual(late(care_snapshot(self.store, at(23, 59, 59), GRACE))["status"], "due")
        after_midnight = care_snapshot(self.store, at(0, 0, 0, day=12), GRACE)
        self.assertEqual(late(after_midnight)["status"], "upcoming")
        self.assertEqual(after_midnight["date_local"], "2026-11-12")
        self.assertEqual({d["status"] for d in after_midnight["doses"]}, {"upcoming"})

    def test_a_grace_window_that_crosses_midnight_never_reaches_needs_attention(self):
        """Pins the documented limit: status is per calendar day, nothing is carried over midnight."""
        dose = self.store.add_dose("23:50", "Late dose (demo)")
        self.store.add_event("arrived_at_station", dose_id=dose["id"], detail={"mode": "sim"},
                             ts=at(23, 51).timestamp())
        monitor = CareMonitor(self.store, GRACE)
        late = lambda now: next(d for d in care_snapshot(self.store, now, GRACE)["doses"] if d["id"] == dose["id"])
        written = []
        for now in (at(23, 50), at(23, 55), at(23, 59, 59), at(0, 0, 0, day=12), at(0, 5, 1, day=12),
                    at(0, 30, day=12)):
            written += monitor.tick(now)
        self.assertEqual(late(at(23, 59, 59))["status"], "arrived")
        self.assertEqual((late(at(0, 5, 1, day=12))["status"], late(at(0, 5, 1, day=12))["arrived_at"]),
                         ("upcoming", None), "after midnight yesterday's arrival no longer counts")
        late_events = [e["type"] for e in written if e["dose_id"] == dose["id"]]
        self.assertEqual(late_events, ["reminder_due"], "no needs_attention is ever logged for the 23:50 dose")
        self.assertIn(("needs_attention", "d1"), {(e["type"], e["dose_id"]) for e in written})
        self.assertEqual(care_snapshot(self.store, at(0, 30, day=12), GRACE)["doses"][0]["status"], "upcoming",
                         "a dose that needed attention yesterday is upcoming again after midnight")

    def test_dose_at_midnight_is_due_at_midnight(self):
        self.store.add_dose("00:00", "Midnight dose (demo)")
        first = care_snapshot(self.store, at(0, 0, 0), GRACE)["doses"][0]
        self.assertEqual((first["time"], first["status"]), ("00:00", "due"))

    def test_snapshot_shape(self):
        snapshot = care_snapshot(self.store, at(8, 1), GRACE)
        self.assertEqual(set(snapshot), {"now_local", "date_local", "doses", "next_due_id"})
        self.assertEqual(snapshot["now_local"], "08:01")
        self.assertEqual(snapshot["date_local"], "2026-11-11")
        self.assertEqual(snapshot["next_due_id"], "d1")
        self.assertEqual(snapshot["doses"][0]["label"], "Morning dose (demo)")

    def test_monitor_writes_each_event_once_per_dose_per_day(self):
        monitor = CareMonitor(self.store, GRACE)
        self.assertEqual(monitor.tick(at(7, 0)), [])
        written = monitor.tick(at(8, 0))
        self.assertEqual([(e["type"], e["dose_id"]) for e in written], [("reminder_due", "d1")])
        self.assertEqual(monitor.tick(at(8, 10)), [])
        written = monitor.tick(at(8, 16))
        self.assertEqual([(e["type"], e["dose_id"]) for e in written], [("needs_attention", "d1")])
        self.assertEqual(monitor.tick(at(8, 30)), [])
        self.assertEqual(monitor.tick(at(12, 59)), [])
        # the next day starts again
        written = monitor.tick(at(8, 0, day=12))
        self.assertEqual([(e["type"], e["dose_id"]) for e in written], [("reminder_due", "d1")])

    def test_monitor_does_not_log_reminder_due_when_a_run_arrives_early(self):
        """`reminder_due` is logged when the clock reaches the dose time, never because of an arrival."""
        self.store.add_event("pickup_acknowledged", dose_id="d1", ts=at(8, 5).timestamp())
        self.store.add_event("pickup_acknowledged", dose_id="d2", ts=at(13, 5).timestamp())
        monitor = CareMonitor(self.store, GRACE)
        self.assertEqual(monitor.tick(at(17, 4)), [])
        self.store.add_event("arrived_at_station", dose_id="d3", run_id="r1", ts=at(17, 5).timestamp())
        self.assertEqual(monitor.tick(at(17, 5, 1)), [], "no reminder at 17:05 for the 20:00 dose")
        self.assertEqual(monitor.tick(at(19, 59, 59)), [])
        snapshot = care_snapshot(self.store, at(17, 6), GRACE)
        d3 = next(d for d in snapshot["doses"] if d["id"] == "d3")
        self.assertEqual((d3["status"], d3["arrived_at"]), ("arrived", "17:05"))
        self.assertEqual(snapshot["next_due_id"], "d3")
        written = monitor.tick(at(20, 0))
        self.assertEqual([(e["type"], e["dose_id"], e["time_local"]) for e in written], [("reminder_due", "d3", "20:00")])
        self.assertEqual(monitor.tick(at(20, 1)), [])
        written = monitor.tick(at(20, 16))
        self.assertEqual([(e["type"], e["dose_id"]) for e in written], [("needs_attention", "d3")])
        types = [e["type"] for e in self.store.events(50) if e["dose_id"] == "d3"]
        self.assertEqual(types.count("reminder_due"), 1)

    def test_monitor_does_not_remind_for_a_dose_acknowledged_before_its_time(self):
        self.store.add_event("arrived_at_station", dose_id="d3", ts=at(17, 5).timestamp())
        self.store.add_event("pickup_acknowledged", dose_id="d3", ts=at(17, 30).timestamp())
        monitor = CareMonitor(self.store, GRACE)
        self.assertEqual([e for e in monitor.tick(at(20, 0)) if e["dose_id"] == "d3"], [])

    def test_monitor_does_not_remind_for_an_acknowledged_dose(self):
        self.store.add_event("pickup_acknowledged", dose_id="d1", ts=at(7, 55).timestamp())
        self.assertEqual(CareMonitor(self.store, GRACE).tick(at(9, 0)), [])


if __name__ == "__main__":
    unittest.main()
