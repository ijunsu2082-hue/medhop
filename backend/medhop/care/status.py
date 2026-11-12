"""Per-dose status for today (SPEC section 7).

  upcoming         before the dose time
  due              from the dose time
  arrived          a station run for this dose logged `arrived_at_station` today
  acknowledged     pickup acknowledged today (self-reported; nothing proves a dose was taken)
  needs_attention  not acknowledged and now is later than dose time + grace (arrived_at is kept)

`arrived_at` and `acknowledged_at` are local "HH:MM" strings (or None). `arrived_at` is kept in
every status, including `acknowledged` and `needs_attention`. `arrived_mode` is "sim", "real" or
None, copied from `detail.mode` of the latest `arrived_at_station` event today for the dose.

A station run may arrive before the dose time. The dose is then `arrived` straight away and keeps
that status, but it is not due yet: the `reminder_due` event is written only when the clock reaches
the dose time, and `next_due_id` does not point at it while anything else is waiting (see
`next_due_id`).

"Today" is the local calendar day, so every status starts again at midnight. This is a known limit,
not carried over: at 00:00 every dose becomes `upcoming` again, yesterday's events stop counting,
and a dose whose time + grace falls after midnight (for example 23:50 with 15 minutes of grace)
never reaches `needs_attention`, so CareMonitor never logs `needs_attention` for it.
"""
from __future__ import annotations

import logging
from datetime import datetime, time as dtime, timedelta
from typing import Any, Dict, Iterable, List, Optional

from medhop.care.store import CareStore, time_local

logger = logging.getLogger("medhop.care.status")

UPCOMING = "upcoming"
DUE = "due"
ARRIVED = "arrived"
ACKNOWLEDGED = "acknowledged"
NEEDS_ATTENTION = "needs_attention"
STATUSES = (UPCOMING, DUE, ARRIVED, ACKNOWLEDGED, NEEDS_ATTENTION)
_PENDING = (DUE, ARRIVED, NEEDS_ATTENTION)


def day_bounds(now: datetime) -> tuple:
    start = datetime.combine(now.date(), dtime.min)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def dose_time_today(dose: Dict[str, str], now: datetime) -> datetime:
    hour, minute = dose["time"].split(":")
    return datetime.combine(now.date(), dtime(int(hour), int(minute)))


def dose_statuses(doses: Iterable[Dict[str, str]], events_today: Iterable[Dict[str, Any]],
                  now: datetime, grace_min: int) -> List[Dict[str, Any]]:
    """Pure function. `events_today` must only contain events from now's local calendar day."""
    arrived: Dict[str, float] = {}
    arrived_mode: Dict[str, Optional[str]] = {}
    acknowledged: Dict[str, float] = {}
    for event in events_today:
        dose_id = event.get("dose_id")
        if not dose_id:
            continue
        if event["type"] == "arrived_at_station":
            if event["ts"] >= arrived.get(dose_id, 0.0):
                arrived[dose_id] = event["ts"]
                detail = event.get("detail")
                mode = detail.get("mode") if isinstance(detail, dict) else None
                arrived_mode[dose_id] = mode if mode in ("sim", "real") else None
        elif event["type"] == "pickup_acknowledged":
            acknowledged[dose_id] = max(acknowledged.get(dose_id, 0.0), event["ts"])

    out: List[Dict[str, Any]] = []
    for dose in sorted(doses, key=lambda d: (d["time"], d["id"])):
        at = dose_time_today(dose, now)
        arrived_at = arrived.get(dose["id"])
        acknowledged_at = acknowledged.get(dose["id"])
        if acknowledged_at is not None:
            status = ACKNOWLEDGED
        elif now > at + timedelta(minutes=grace_min):
            status = NEEDS_ATTENTION
        elif arrived_at is not None:
            status = ARRIVED
        elif now >= at:
            status = DUE
        else:
            status = UPCOMING
        out.append({
            "id": dose["id"],
            "time": dose["time"],
            "label": dose["label"],
            "notes": dose.get("notes", ""),
            "status": status,
            "arrived_at": None if arrived_at is None else time_local(arrived_at),
            "arrived_mode": arrived_mode.get(dose["id"]),
            "acknowledged_at": None if acknowledged_at is None else time_local(acknowledged_at),
        })
    return out


def time_has_come(dose: Dict[str, Any], now: datetime) -> bool:
    """True from the dose time on (today)."""
    return now >= dose_time_today(dose, now)


def next_due_id(statuses: List[Dict[str, Any]], now: datetime) -> Optional[str]:
    """The dose to show first. `statuses` is the time-ordered output of `dose_statuses` for `now`.

    The rule, in order:
      1. the earliest dose that is waiting for pickup (due, arrived or needs_attention) AND whose
         time has come;
      2. else the earliest dose whose time has not come yet and that is not acknowledged: an
         upcoming one, or one whose station run arrived early. Among these the order is by dose
         time, so an early arrival for the evening does not jump ahead of the midday dose;
      3. else None (everything today is acknowledged, or there are no doses).

    So `next_due_id` points at a dose whose time has not come only when nothing else is due.
    """
    for dose in statuses:
        if dose["status"] in _PENDING and time_has_come(dose, now):
            return dose["id"]
    for dose in statuses:
        if dose["status"] in (UPCOMING, ARRIVED) and not time_has_come(dose, now):
            return dose["id"]
    return None


def care_snapshot(store: CareStore, now: datetime, grace_min: int) -> Dict[str, Any]:
    start_ts, end_ts = day_bounds(now)
    statuses = dose_statuses(store.list_doses(), store.events_between(start_ts, end_ts), now, grace_min)
    return {
        "now_local": now.strftime("%H:%M"),
        "date_local": now.strftime("%Y-%m-%d"),
        "doses": statuses,
        "next_due_id": next_due_id(statuses, now),
    }


class CareMonitor:
    """Writes `reminder_due` and `needs_attention` events, at most once per dose per day.

    `reminder_due` is written when the clock reaches the dose time, never because a station run
    arrived early, and not at all for a dose that was acknowledged before its time.
    """

    def __init__(self, store: CareStore, grace_min: int) -> None:
        self._store = store
        self._grace_min = grace_min

    def tick(self, now: datetime) -> List[Dict[str, Any]]:
        start_ts, end_ts = day_bounds(now)
        events = self._store.events_between(start_ts, end_ts)
        logged = {(e["type"], e.get("dose_id")) for e in events}
        written: List[Dict[str, Any]] = []
        for dose in dose_statuses(self._store.list_doses(), events, now, self._grace_min):
            if dose["status"] in (UPCOMING, ACKNOWLEDGED) or not time_has_come(dose, now):
                continue
            if ("reminder_due", dose["id"]) not in logged:
                written.append(self._store.add_event(
                    "reminder_due", dose_id=dose["id"], ts=now.timestamp(),
                    detail={"time": dose["time"], "label": dose["label"]},
                ))
            if dose["status"] == NEEDS_ATTENTION and ("needs_attention", dose["id"]) not in logged:
                written.append(self._store.add_event(
                    "needs_attention", dose_id=dose["id"], ts=now.timestamp(),
                    detail={"time": dose["time"], "label": dose["label"], "grace_min": self._grace_min},
                ))
        return written
