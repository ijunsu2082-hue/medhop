#!/usr/bin/env python3
"""Record reference cases from the Python care loop, for the TypeScript port in frontend/src/engine/care.

    python tools/parity_care.py              # rewrite both fixture files
    python tools/parity_care.py --check      # compare with the committed files, write nothing

Groups: care_status (medhop/care/status.py: dose_statuses, next_due_id, time_has_come, day_bounds,
care_snapshot and CareMonitor.tick, the last two on a real CareStore), care_store (medhop/care/store.py:
validators, doses, ids, the event log, trim, calibration, mission settings and run traces, with the
files the store leaves behind after every step).

Each group writes frontend/src/engine/care/__fixtures__/<group>.json; the vitest suites next to it
replay every recorded step through the TypeScript port. tests/test_parity_care_fixtures.py regenerates
both groups and compares them with the committed files.

Time zones: the store and the status code work in local wall-clock time, so a fixture must not hold a
unix timestamp (it would only be right in the time zone it was made in). Every time is written as local
calendar components [year, month, day, hour, minute, second] (the second may have a fraction), and
both this tool and the TypeScript test build the timestamp from those components in the local zone of
the machine they run on. Timestamps the code produces are written back as components the same way, and
a timestamp inside a stored file's text is written in a template as {{2026,11,11,8,0,0}}. The days used
(November and the turn of the year) have no daylight-saving change in common time zones.

Files: the store's data directory is listed after every step that changed it. Names are logical
("schedule", "events", "mission", "trim", "calibration", "runs/<run id>", and "<name>.corrupt@<local
time>" for a file set aside), contents are parsed JSON ({"$raw": text} when the text is not JSON), and
the event log is a list of its lines. Output is deterministic: fixed seeds and scripted clocks only.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import random
import re
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from medhop.care import status as status_module  # noqa: E402
from medhop.care import store as store_module  # noqa: E402
from medhop.care.status import (  # noqa: E402
    CareMonitor, care_snapshot, day_bounds, dose_statuses, next_due_id, time_has_come,
)
from medhop.care.store import CareStore, validate_label, validate_notes, validate_time  # noqa: E402

FIXTURE_DIR = BACKEND_DIR.parent / "frontend" / "src" / "engine" / "care" / "__fixtures__"
GRACE = 15
DAY = (2026, 11, 11)
NEXT_DAY = (2026, 11, 12)


# ---------------------------------------------------------------------------------------------- #
# local time

def at(*fields: float) -> List[float]:
    """Local calendar components, as written to the fixture: at(2026, 11, 11, 8, 0, 0)."""
    return list(fields)


def on(day: Sequence[int], hour: int, minute: int = 0, second: float = 0) -> List[float]:
    return [day[0], day[1], day[2], hour, minute, second]


def to_datetime(fields: Sequence[float]) -> datetime:
    year, month, day = (int(v) for v in fields[:3])
    rest = list(fields[3:]) + [0] * (3 - len(fields[3:]))
    hour, minute, second = int(rest[0]), int(rest[1]), float(rest[2])
    whole = math.floor(second)
    micro = round((second - whole) * 1_000_000)
    return datetime(year, month, day, hour, minute, int(whole), micro)


def ts_of(fields: Sequence[float]) -> float:
    return to_datetime(fields).timestamp()


def fields_of(ts: float) -> List[float]:
    """A timestamp as local components (the inverse of ts_of)."""
    d = datetime.fromtimestamp(ts)
    second: float = d.second if not d.microsecond else d.second + d.microsecond / 1e6
    return [d.year, d.month, d.day, d.hour, d.minute, second]


def stamp(seconds: int) -> str:
    """The local time of a whole-second timestamp, for the names of files set aside."""
    return datetime.fromtimestamp(seconds).strftime("%Y-%m-%dT%H:%M:%S")


TEMPLATE = re.compile(r"\{\{([^{}]*)\}\}")


def fill(text: str) -> str:
    """Replace each {{y,m,d,h,mi,s}} with repr() of that local time's timestamp."""
    return TEMPLATE.sub(lambda m: repr(ts_of([float(v) for v in m.group(1).split(",")])), text)


# ---------------------------------------------------------------------------------------------- #
# encoding and writing (the conventions of tools/parity_traces.py)

def encode(value: Any) -> Any:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return {"$float": "nan"}
        if math.isinf(value):
            return {"$float": "inf" if value > 0 else "-inf"}
        return value
    if isinstance(value, dict):
        return {str(k): encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    raise TypeError(f"cannot encode {type(value).__name__}")


def render(value: Any, indent: int = 0, width: int = 118) -> str:
    """Compact JSON, broken into one item per line wherever a line would get long (diff-friendly)."""
    flat = json.dumps(value, separators=(",", ":"), allow_nan=False)
    if len(flat) + indent <= width or not isinstance(value, (list, dict)) or not value:
        return flat
    pad = " " * (indent + 1)
    if isinstance(value, list):
        inner = ",\n".join(pad + render(item, indent + 1, width) for item in value)
        return "[\n" + inner + "\n" + " " * indent + "]"
    inner = ",\n".join(pad + json.dumps(key) + ":" + render(item, indent + 1, width) for key, item in value.items())
    return "{\n" + inner + "\n" + " " * indent + "}"


def public_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """An event as returned by the store, with its timestamp as local components."""
    return {**event, "ts": fields_of(event["ts"])}


@contextmanager
def quiet() -> Iterator[None]:
    """The store logs every corrupt file and skipped line; the cases here make many on purpose."""
    logger = logging.getLogger("medhop.care")
    old_level, old_propagate = logger.level, logger.propagate
    logger.setLevel(logging.CRITICAL + 1)
    logger.propagate = False
    try:
        yield
    finally:
        logger.setLevel(old_level)
        logger.propagate = old_propagate


# ---------------------------------------------------------------------------------------------- #
# the data directory, listed with logical names

FILE_NAMES = {"schedule.json": "schedule", "events.jsonl": "events", "mission.json": "mission",
              "trim.json": "trim", "calibration.json": "calibration"}
LOGICAL_FILES = {name: file for file, name in FILE_NAMES.items()}
ASIDE = re.compile(r"^(?P<file>.+)\.corrupt-(?P<n>-?\d+)$")


UNIX_TIME = re.compile(r"\d{9,11}(?:\.\d+)?")


def untemplate(text: str) -> str:
    """Raw text with every unix-time-like number written back as {{y,m,d,h,mi,s}} (local components)."""
    def local(match: "re.Match[str]") -> str:
        return "{{" + ",".join(repr(v) if isinstance(v, float) else str(v) for v in fields_of(float(match.group(0)))) + "}}"
    return UNIX_TIME.sub(local, text)


def raw(text: str) -> Dict[str, str]:
    return {"$raw": untemplate(text)}


def parse_json_text(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return raw(text)


def ts_field(value: Any) -> Any:
    """The "ts" of a stored event line as local components (a numeric string is marked as text)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return fields_of(float(value))
    if isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return value
        if math.isfinite(number):
            return {"$ts_text": fields_of(number)}
    return value


def event_lines(text: str, summary: bool) -> Dict[str, Any]:
    trailing = text.endswith("\n")
    lines = text.split("\n")
    if trailing:
        lines.pop()
    out: List[Any] = []
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            out.append(raw(line))
            continue
        if isinstance(item, dict) and "ts" in item:
            item = {**item, "ts": ts_field(item["ts"])}
        out.append(item)
    if summary:
        return {"count": len(out), "first": out[0] if out else None, "last": out[-1] if out else None,
                "trailing_newline": trailing}
    return {"lines": out, "trailing_newline": trailing}


def listing(data_dir: Path, summary: bool = False) -> Dict[str, Any]:
    """Every file the store left, by logical name."""
    out: Dict[str, Any] = {}
    # the store writes files in the data directory and in runs/ only (os.scandir: much faster than rglob)
    found = []
    for folder, prefix in ((data_dir, ""), (data_dir / "runs", "runs/")):
        if folder.is_dir():
            with os.scandir(folder) as entries:
                found += [(prefix + e.name, Path(e.path)) for e in entries if e.is_file()]
    for relative, path in sorted(found):
        text = path.read_bytes().decode("utf-8")
        if relative.startswith("runs/") and relative.endswith(".json"):
            out[relative[: -len(".json")]] = parse_json_text(text)
            continue
        aside = ASIDE.match(relative)
        if aside:
            name = FILE_NAMES[aside.group("file")]
            out[f"{name}.corrupt@{stamp(int(aside.group('n')))}"] = (
                event_lines(text, False) if name == "events" else parse_json_text(text))
            continue
        name = FILE_NAMES[relative]
        out[name] = event_lines(text, summary) if name == "events" else parse_json_text(text)
    return out


# ---------------------------------------------------------------------------------------------- #
# care_status: pure cases

STATUS_TYPES = ("arrived_at_station", "pickup_acknowledged", "reminder_due", "needs_attention", "run_started",
                "hover_test")
DETAILS: List[Optional[Dict[str, Any]]] = [None, {}, {"mode": "sim"}, {"mode": "real"}, {"mode": None},
                                           {"mode": "SIM"}, {"marker_width": 0.16}, {"mode": "sim", "run": 2}]

DOSES3 = [
    {"id": "d1", "time": "08:00", "label": "Morning dose (demo)", "notes": ""},
    {"id": "d2", "time": "13:00", "label": "Midday dose (demo)", "notes": ""},
    {"id": "d3", "time": "20:00", "label": "Evening dose (demo)", "notes": ""},
]


def ev(kind: str, dose_id: Optional[str], when: List[float], detail: Optional[Dict[str, Any]] = None,
       run_id: Optional[str] = None, with_detail: bool = True) -> Dict[str, Any]:
    event: Dict[str, Any] = {"type": kind, "dose_id": dose_id, "run_id": run_id, "at": when}
    if with_detail:
        event["detail"] = {} if detail is None else detail
    return event


def pure_case(name: str, doses: List[Dict[str, Any]], events: List[Dict[str, Any]], now: List[float],
              grace: float = GRACE) -> Dict[str, Any]:
    py_events = []
    for e in events:
        item = {k: v for k, v in e.items() if k != "at"}
        item["ts"] = ts_of(e["at"])
        py_events.append(item)
    moment = to_datetime(now)
    statuses = dose_statuses(doses, py_events, moment, grace)
    start, end = day_bounds(moment)
    return {
        "name": name, "doses": doses, "events": events, "now": now, "grace_min": grace,
        "out": {
            "statuses": statuses,
            "next_due_id": next_due_id(statuses, moment),
            "time_has_come": [time_has_come(d, moment) for d in statuses],
            "day_bounds": [fields_of(start), fields_of(end)],
        },
    }


def scripted_pure_cases() -> List[Dict[str, Any]]:
    d = DAY
    cases = []
    add = cases.append
    add(pure_case("upcoming_before_time", DOSES3, [], on(d, 7, 59, 59)))
    add(pure_case("due_at_time", DOSES3, [], on(d, 8, 0, 0)))
    add(pure_case("due_half_second_before", DOSES3, [], on(d, 7, 59, 59.5)))
    add(pure_case("arrived", DOSES3, [ev("arrived_at_station", "d1", on(d, 8, 2), {"mode": "sim"}, "r1")],
                  on(d, 8, 3)))
    add(pure_case("acknowledged_after_arrival", DOSES3,
                  [ev("arrived_at_station", "d1", on(d, 8, 2)), ev("pickup_acknowledged", "d1", on(d, 8, 5))],
                  on(d, 9, 30)))
    add(pure_case("acknowledged_without_run", DOSES3, [ev("pickup_acknowledged", "d1", on(d, 8, 5))],
                  on(d, 12, 0)))
    add(pure_case("grace_exact_boundary", DOSES3, [], on(d, 8, 15, 0)))
    add(pure_case("grace_half_second_past", DOSES3, [], on(d, 8, 15, 0.5)))
    add(pure_case("grace_one_second_past", DOSES3, [], on(d, 8, 15, 1)))
    add(pure_case("needs_attention_keeps_arrival", DOSES3,
                  [ev("arrived_at_station", "d1", on(d, 8, 2), {"mode": "real"})], on(d, 8, 20)))
    add(pure_case("grace_30", DOSES3, [], on(d, 8, 20), grace=30))
    add(pure_case("grace_0", DOSES3, [], on(d, 8, 0, 1), grace=0))
    add(pure_case("grace_0_at_time", DOSES3, [], on(d, 8, 0, 0), grace=0))
    add(pure_case("grace_half_minute", DOSES3, [], on(d, 8, 0, 31), grace=0.5))
    five = DOSES3 + [{"id": "d4", "time": "09:00", "label": "x", "notes": ""},
                     {"id": "d5", "time": "09:10", "label": "y", "notes": ""},
                     {"id": "d6", "time": "09:12", "label": "z", "notes": ""}]
    add(pure_case("all_five_statuses", five, [ev("pickup_acknowledged", "d4", on(d, 9, 1)),
                                              ev("arrived_at_station", "d5", on(d, 9, 11))], on(d, 9, 12)))
    add(pure_case("unsorted_input", list(reversed(DOSES3)), [], on(d, 7, 0)))
    arrival = [ev("arrived_at_station", "d1", on(d, 7, 50), {"mode": "real"})]
    for label, now in (("early", on(d, 7, 55)), ("after_time", on(d, 8, 5)), ("late", on(d, 8, 16))):
        add(pure_case(f"early_arrival_{label}", DOSES3, arrival, now))
    add(pure_case("early_arrival_then_ack", DOSES3, arrival + [ev("pickup_acknowledged", "d1", on(d, 8, 30))],
                  on(d, 9, 0)))
    for i, detail in enumerate(DETAILS):
        add(pure_case(f"arrival_detail_{i}", DOSES3,
                      [ev("arrived_at_station", "d1", on(d, 8, 2), detail, with_detail=detail is not None)],
                      on(d, 8, 3)))
    add(pure_case("latest_arrival_wins", DOSES3,
                  [ev("arrived_at_station", "d1", on(d, 8, 9), {"mode": "real"}),
                   ev("arrived_at_station", "d1", on(d, 8, 2), {"mode": "sim"}),
                   ev("arrived_at_station", "d1", on(d, 8, 12), with_detail=False)], on(d, 8, 13)))
    add(pure_case("equal_arrival_times_later_event_wins", DOSES3,
                  [ev("arrived_at_station", "d1", on(d, 8, 9), {"mode": "real"}),
                   ev("arrived_at_station", "d1", on(d, 8, 9), {"mode": "sim"})], on(d, 8, 10)))
    add(pure_case("several_acknowledgements_latest_kept", DOSES3,
                  [ev("pickup_acknowledged", "d1", on(d, 8, 30)), ev("pickup_acknowledged", "d1", on(d, 8, 5)),
                   ev("pickup_acknowledged", "d1", on(d, 8, 59, 59.5))], on(d, 10, 0)))
    add(pure_case("another_doses_arrival", DOSES3, [ev("arrived_at_station", "d2", on(d, 8, 2), {"mode": "sim"})],
                  on(d, 8, 3)))
    add(pure_case("events_without_dose_or_unknown", DOSES3,
                  [ev("arrived_at_station", None, on(d, 8, 2)), ev("pickup_acknowledged", "", on(d, 8, 3)),
                   ev("pickup_acknowledged", "d99", on(d, 8, 4)), ev("reminder_due", "d1", on(d, 8, 0)),
                   ev("needs_attention", "d1", on(d, 8, 16)), ev("run_started", "d1", on(d, 8, 1), run_id="r9")],
                  on(d, 8, 20)))
    # next_due_id
    add(pure_case("next_earliest_pending", DOSES3, [], on(d, 13, 5)))
    add(pure_case("next_upcoming", DOSES3, [ev("pickup_acknowledged", "d1", on(d, 8, 5))], on(d, 9, 0)))
    add(pure_case("next_none_all_acknowledged", DOSES3,
                  [ev("pickup_acknowledged", x["id"], on(d, 21, 0)) for x in DOSES3], on(d, 22, 0)))
    add(pure_case("next_none_no_doses", [], [], on(d, 8, 0)))
    add(pure_case("next_early_arrival_behind_due", DOSES3,
                  [ev("pickup_acknowledged", "d1", on(d, 8, 5)), ev("arrived_at_station", "d3", on(d, 13, 2))],
                  on(d, 13, 5)))
    add(pure_case("next_early_arrival_behind_upcoming", DOSES3,
                  [ev("pickup_acknowledged", "d1", on(d, 8, 5)), ev("arrived_at_station", "d3", on(d, 11, 0))],
                  on(d, 12, 0)))
    early3 = [ev("pickup_acknowledged", "d1", on(d, 8, 5)), ev("pickup_acknowledged", "d2", on(d, 13, 5)),
              ev("arrived_at_station", "d3", on(d, 17, 5))]
    add(pure_case("next_early_arrival_alone", DOSES3, early3, on(d, 17, 6)))
    add(pure_case("next_early_arrival_at_time", DOSES3, early3, on(d, 20, 0)))
    add(pure_case("next_early_arrival_earliest", DOSES3, [ev("arrived_at_station", "d1", on(d, 7, 50))],
                  on(d, 7, 55)))
    late = [ev("arrived_at_station", "d3", on(d, 17, 5))]
    for label, now in (("1", on(d, 17, 5, 30)), ("2", on(d, 19, 59)), ("3", on(d, 20, 0)), ("4", on(d, 20, 15)),
                       ("5", on(d, 20, 16))):
        add(pure_case(f"evening_early_arrival_{label}", DOSES3, late, now))
    edge = [{"id": "m", "time": "00:00", "label": "Midnight (demo)", "notes": ""},
            {"id": "late", "time": "23:59", "label": "Late (demo)", "notes": "after the news"},
            {"id": "e", "time": "23:50", "label": "Evening (demo)"}]
    for label, now in (("00", on(d, 0, 0, 0)), ("23_49", on(d, 23, 49)), ("23_59_59", on(d, 23, 59, 59.5))):
        add(pure_case(f"edge_times_{label}", edge, [], now))
    # Python orders strings by code point; JavaScript's < by UTF-16 unit
    order = [{"id": "\U0001f600", "time": "09:00", "label": "astral id", "notes": ""},
             {"id": "\uff10", "time": "09:00", "label": "full-width id", "notes": ""},
             {"id": "d10", "time": "09:00", "label": "d10", "notes": ""},
             {"id": "d9", "time": "09:00", "label": "d9", "notes": ""},
             {"id": "u", "time": "0\u0668:3\u0660", "label": "Arabic-Indic digits in the time", "notes": ""},
             {"id": "v", "time": "08:30", "label": "ASCII", "notes": ""}]
    add(pure_case("code_point_order_and_unicode_digits", order, [ev("pickup_acknowledged", "\U0001f600", on(d, 9, 1))],
                  on(d, 8, 30)))
    add(pure_case("unicode_digit_time_due", order, [], on(d, 8, 45, 59)))
    return cases


def random_pure_cases(seed: int, count: int) -> List[Dict[str, Any]]:
    rng = random.Random(seed)
    cases = []
    specials = ["00:00", "23:59", "23:50", "12:00", "08:00"]
    for index in range(count):
        n = rng.randint(1, 4)
        ids = rng.sample(["d1", "d2", "d3", "d4", "d10", "x"], n)
        doses = []
        for dose_id in ids:
            time = rng.choice(specials) if rng.random() < 0.25 else f"{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}"
            doses.append({"id": dose_id, "time": time, "label": f"Dose {dose_id} (demo)", "notes": rng.choice(["", "x"])})
        grace = rng.choice([0, 1, 15, 15, 30, 90])
        dose = rng.choice(doses)
        hour, minute = (int(v) for v in dose["time"].split(":"))
        base = datetime(*DAY, hour, minute)
        pick = rng.random()
        if pick < 0.2:
            moment = base
        elif pick < 0.4:
            moment = base + timedelta(minutes=grace, seconds=rng.choice([0, 0.5, 1]))
        else:
            moment = datetime(*DAY) + timedelta(seconds=rng.randrange(0, 86400 * 2) / 2)
        moment = min(moment, datetime(*DAY, 23, 59, 59))
        now = [moment.year, moment.month, moment.day, moment.hour, moment.minute,
               moment.second + (0.5 if moment.microsecond else 0)]
        events = []
        for _ in range(rng.randint(0, 6)):
            when = datetime(*DAY) + timedelta(seconds=rng.randrange(0, 86400))
            detail = rng.choice(DETAILS)
            events.append(ev(rng.choice(STATUS_TYPES), rng.choice(ids + [None, "d99"]),
                             [when.year, when.month, when.day, when.hour, when.minute, when.second],
                             detail, with_detail=detail is not None))
        cases.append(pure_case(f"random_{index}", doses, events, now, grace))
    return cases


# ---------------------------------------------------------------------------------------------- #
# store-backed runs: care_snapshot and CareMonitor.tick on a real CareStore

class Run:
    """A CareStore in a temporary directory with a scripted wall clock, and the steps applied to it."""

    def __init__(self, data_dir: Path, clock: List[float], grace: float = GRACE) -> None:
        self.data_dir = data_dir
        self.now = ts_of(clock)
        self.grace = grace
        self.open()

    def open(self) -> None:
        self.store = CareStore(self.data_dir, wall_clock=lambda: self.now)
        self.monitor = CareMonitor(self.store, self.grace)


def status_step(run: Run, step: Dict[str, Any]) -> Any:
    op = step["op"]
    if "at" in step:
        run.now = ts_of(step["at"])
    if op == "reopen":
        run.open()
        return None
    if op == "add_dose":
        return run.store.add_dose(*step["args"])
    if op == "update_dose":
        return run.store.update_dose(*step["args"])
    if op == "delete_dose":
        return run.store.delete_dose(*step["args"])
    if op == "event":
        return public_event(run.store.add_event(step["type"], dose_id=step.get("dose_id"), run_id=step.get("run_id"),
                                                detail=step.get("detail"), ts=ts_of(step["at"])))
    if op == "snapshot":
        return care_snapshot(run.store, to_datetime(step["at"]), run.grace)
    if op == "tick":
        return [public_event(e) for e in run.monitor.tick(to_datetime(step["at"]))]
    if op == "ticks":
        start, end = to_datetime(step["from"]), to_datetime(step["to"])
        every = timedelta(seconds=step["every_s"])
        out = []
        k = 0
        moment = start
        while moment <= end:
            written = run.monitor.tick(moment)
            if written:
                out.append([k, [public_event(e) for e in written]])
            k += 1
            moment = start + every * k
        run.now = moment.timestamp()
        return out
    raise ValueError(f"unknown status step {op!r}")


def status_run(name: str, steps: List[Dict[str, Any]], grace: float = GRACE) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="medhop-parity-") as tmp:
        first = next((s.get("at") or s.get("from")) for s in steps if s.get("at") or s.get("from"))
        run = Run(Path(tmp), first, grace)
        for step in steps:
            step["out"] = encode(status_step(run, step))
    return {"name": name, "grace_min": grace, "steps": steps}


def S(op: str, **kw: Any) -> Dict[str, Any]:
    return {"op": op, **kw}


def ticks(start: List[float], end: List[float], every_s: float = 60) -> Dict[str, Any]:
    return {"op": "ticks", "from": start, "to": end, "every_s": every_s}


def status_runs() -> List[Dict[str, Any]]:
    d, n = DAY, NEXT_DAY
    runs = []
    runs.append(status_run("a_day_with_the_demo_doses", [
        ticks(on(d, 7, 0), on(d, 8, 0), 30),
        S("event", type="arrived_at_station", dose_id="d1", run_id="r1", detail={"mode": "sim"}, at=on(d, 8, 2)),
        S("snapshot", at=on(d, 8, 3)),
        S("event", type="pickup_acknowledged", dose_id="d1", detail={"self_reported": True}, at=on(d, 8, 5)),
        ticks(on(d, 8, 5), on(d, 13, 20), 60),
        S("snapshot", at=on(d, 13, 20)),
        S("event", type="run_started", dose_id="d3", run_id="r2", at=on(d, 17, 4)),
        S("event", type="arrived_at_station", dose_id="d3", run_id="r2", detail={"mode": "real"}, at=on(d, 17, 5)),
        S("snapshot", at=on(d, 17, 6)),
        ticks(on(d, 17, 5), on(d, 20, 20), 60),
        S("snapshot", at=on(d, 20, 30)),
        ticks(on(d, 23, 58), on(n, 0, 10), 60),
        S("snapshot", at=on(n, 0, 0, 0)),
        ticks(on(n, 7, 59), on(n, 8, 1), 20),
        S("snapshot", at=on(n, 8, 1)),
    ]))
    runs.append(status_run("late_dose_across_midnight", [
        S("add_dose", args=["23:50", "Late dose (demo)"], at=on(d, 23, 0)),
        S("event", type="arrived_at_station", dose_id="d4", detail={"mode": "sim"}, at=on(d, 23, 51)),
        ticks(on(d, 23, 49), on(n, 0, 30), 30),
        S("snapshot", at=on(d, 23, 59, 59)),
        S("snapshot", at=on(n, 0, 0, 0)),
        S("snapshot", at=on(n, 0, 5, 1)),
        S("snapshot", at=on(n, 0, 30)),
    ]))
    runs.append(status_run("doses_edited_and_added_during_the_day", [
        ticks(on(d, 7, 59), on(d, 8, 0), 30),
        S("update_dose", args=["d1", "09:00", None, None], at=on(d, 8, 30)),
        S("snapshot", at=on(d, 8, 30)),
        ticks(on(d, 8, 31), on(d, 9, 20), 60),
        S("add_dose", args=["09:30", "Added late (demo)", "past its time"], at=on(d, 10, 0)),
        S("tick", at=on(d, 10, 0)),
        S("add_dose", args=["10:05", "Added early (demo)"], at=on(d, 10, 1)),
        S("snapshot", at=on(d, 10, 1)),
        ticks(on(d, 10, 1), on(d, 10, 21), 60),
        S("delete_dose", args=["d2"], at=on(d, 12, 0)),
        S("update_dose", args=["d3", None, "Evening, renamed (demo)", None], at=on(d, 12, 1)),
        ticks(on(d, 12, 0), on(d, 20, 0), 300),
        S("add_dose", args=["21:00", "After a delete (demo)"], at=on(d, 20, 1)),
        S("snapshot", at=on(d, 21, 0)),
        S("update_dose", args=["d6", "20:59", None, None], at=on(d, 21, 0)),
        S("tick", at=on(d, 21, 0)),
    ]))
    runs.append(status_run("acknowledged_before_its_time", [
        S("event", type="pickup_acknowledged", dose_id="d1", at=on(d, 7, 55)),
        S("event", type="arrived_at_station", dose_id="d3", at=on(d, 17, 5)),
        S("event", type="pickup_acknowledged", dose_id="d3", at=on(d, 17, 30)),
        S("tick", at=on(d, 9, 0)),
        S("tick", at=on(d, 20, 0)),
        S("snapshot", at=on(d, 20, 0)),
        S("tick", at=on(d, 21, 0)),
    ]))
    runs.append(status_run("midnight_boundaries", [
        S("event", type="arrived_at_station", dose_id="d1", at=on((2026, 11, 10), 8, 2)),
        S("event", type="pickup_acknowledged", dose_id="d1", at=on((2026, 11, 10), 23, 59, 59.5)),
        S("snapshot", at=on(d, 8, 5)),
        S("event", type="pickup_acknowledged", dose_id="d2", at=on(d, 0, 0, 0)),
        S("snapshot", at=on(d, 0, 0, 1)),
        S("snapshot", at=on((2026, 11, 10), 23, 59, 59)),
        S("add_dose", args=["00:00", "Midnight dose (demo)"], at=on(d, 0, 0, 2)),
        S("snapshot", at=on(n, 0, 0, 0)),
        S("tick", at=on(n, 0, 0, 0)),
        S("tick", at=on(n, 0, 15, 0.5)),
    ]))
    runs.append(status_run("backend_started_late", [
        S("tick", at=on(d, 21, 0)),
        S("tick", at=on(d, 21, 1)),
        S("reopen", at=on(d, 21, 2)),
        S("tick", at=on(d, 21, 2)),
        S("snapshot", at=on(d, 21, 3)),
    ]))
    runs.append(status_run("grace_zero", [
        ticks(on(d, 7, 59, 30), on(d, 8, 1), 0.5),
        S("snapshot", at=on(d, 8, 0, 0.5)),
    ], grace=0))
    runs.append(status_run("grace_thirty_with_arrival", [
        S("event", type="arrived_at_station", dose_id="d2", detail={"mode": "real"}, at=on(d, 13, 10)),
        ticks(on(d, 12, 59), on(d, 13, 31), 60),
        S("snapshot", at=on(d, 13, 31)),
    ], grace=30))
    runs.append(status_run("fractional_seconds", [
        S("tick", at=on(d, 8, 0, 0.5)),
        S("event", type="pickup_acknowledged", dose_id="d2", at=on(d, 13, 14, 59.5)),
        S("tick", at=on(d, 13, 15, 0.5)),
        S("snapshot", at=on(d, 13, 15, 0.5)),
        S("tick", at=on(d, 20, 15, 0.5)),
        S("tick", at=on(d, 20, 15, 1)),
    ]))
    runs.append(status_run("turn_of_the_month", [
        ticks(on((2026, 11, 30), 19, 59), on((2026, 12, 1), 8, 1), 600),
        S("snapshot", at=on((2026, 11, 30), 23, 59, 59)),
        S("snapshot", at=on((2026, 12, 1), 0, 0, 0)),
    ]))
    runs.append(status_run("turn_of_the_year", [
        S("event", type="pickup_acknowledged", dose_id="d3", at=on((2026, 12, 31), 20, 5)),
        S("snapshot", at=on((2026, 12, 31), 23, 55)),
        ticks(on((2026, 12, 31), 23, 55), on((2027, 1, 1), 8, 0), 900),
        S("snapshot", at=on((2027, 1, 1), 0, 5)),
    ]))
    return runs


def build_care_status() -> dict:
    return {
        "constants": {
            "statuses": list(status_module.STATUSES),
            "pending": list(status_module._PENDING),
            "upcoming": status_module.UPCOMING, "due": status_module.DUE, "arrived": status_module.ARRIVED,
            "acknowledged": status_module.ACKNOWLEDGED, "needs_attention": status_module.NEEDS_ATTENTION,
        },
        "pure": scripted_pure_cases() + random_pure_cases(20261111, 40),
        "runs": status_runs(),
    }


# ---------------------------------------------------------------------------------------------- #
# care_store: operation sequences

class StoreRun:
    def __init__(self, data_dir: Path, clock: List[float], summary: bool) -> None:
        self.data_dir = data_dir
        self.now = ts_of(clock)
        self.summary = summary
        self.store: Optional[CareStore] = None

    def open(self) -> None:
        self.store = CareStore(self.data_dir, wall_clock=lambda: self.now)


STORE_CALLS: Dict[str, Callable[..., Any]] = {
    "list_doses": lambda s: s.list_doses(),
    "get_dose": lambda s, dose_id: s.get_dose(dose_id),
    "add_dose": lambda s, *args: s.add_dose(*args),
    "update_dose": lambda s, *args: s.update_dose(*args),
    "delete_dose": lambda s, dose_id: s.delete_dose(dose_id),
    "load_trim": lambda s: list(s.load_trim()),
    "save_trim": lambda s, roll, pitch: s.save_trim(roll, pitch),
    "load_arrive_width": lambda s: s.load_arrive_width(),
    "save_arrive_width": lambda s, width: s.save_arrive_width(width),
    "load_drift_assist": lambda s: s.load_drift_assist(),
    "save_drift_assist": lambda s, enabled: s.save_drift_assist(enabled),
    "load_land_on_arrival": lambda s: s.load_land_on_arrival(),
    "save_land_on_arrival": lambda s, enabled: s.save_land_on_arrival(enabled),
    "load_auto_fly": lambda s: s.load_auto_fly(),
    "save_auto_fly": lambda s, enabled: s.save_auto_fly(enabled),
    "load_avoid": lambda s: s.load_avoid(),
    "save_avoid": lambda s, mode: s.save_avoid(mode),
}
VALIDATORS = {"validate_time": validate_time, "validate_label": validate_label, "validate_notes": validate_notes}


def store_step(run: StoreRun, step: Dict[str, Any]) -> Any:
    op = step["op"]
    args = step.get("args", [])
    if op == "clock":
        run.now = ts_of(step["at"])
        return None
    if op in ("open", "reopen"):
        run.open()
        return None
    if op == "write_raw":
        path = run.data_dir / LOGICAL_FILES[step["name"]]
        path.write_bytes(fill(step["text"]).encode("utf-8"))
        return None
    if op == "append_raw":
        with open(run.data_dir / LOGICAL_FILES[step["name"]], "ab") as handle:
            handle.write(fill(step["text"]).encode("utf-8"))
        return None
    if op == "delete_raw":
        (run.data_dir / LOGICAL_FILES[step["name"]]).unlink()
        return None
    if op == "write_event_lines":
        # `count` events one second apart, as add_event writes them (written at once: much faster)
        base = ts_of(step["at"])
        lines = [json.dumps({"ts": base + i, "type": step["type"], "dose_id": None, "run_id": None, "detail": {}})
                 for i in range(step["count"])]
        (run.data_dir / LOGICAL_FILES["events"]).write_bytes("".join(line + "\n" for line in lines).encode("utf-8"))
        return None
    if op in VALIDATORS:
        return VALIDATORS[op](*args)
    store = run.store
    assert store is not None
    if op == "add_event":
        ts = ts_of(step["at"]) if "at" in step else None
        return public_event(store.add_event(step["type"], dose_id=step.get("dose_id"), run_id=step.get("run_id"),
                                            detail=step.get("detail"), ts=ts))
    if op == "events":
        return [public_event(e) for e in store.events(*args)]
    if op == "events_summary":
        got = store.events(*args)
        return {"count": len(got), "first": public_event(got[0]), "last": public_event(got[-1])}
    if op == "events_between":
        return [public_event(e) for e in store.events_between(ts_of(step["start"]), ts_of(step["end"]))]
    if op == "write_run_trace":
        path = store.write_run_trace(step["run_id"], step["trace"])
        return path.relative_to(run.data_dir).as_posix()[: -len(".json")]
    if op in STORE_CALLS:
        return STORE_CALLS[op](store, *args)
    raise ValueError(f"unknown store step {op!r}")


def store_scenario(name: str, steps: List[Dict[str, Any]], clock: Optional[List[float]] = None,
                   summary: bool = False) -> Dict[str, Any]:
    """Apply the steps; record each result (or error) and the directory listing when it changed."""
    clock = clock or on(DAY, 9, 0)
    with tempfile.TemporaryDirectory(prefix="medhop-parity-") as tmp:
        run = StoreRun(Path(tmp), clock, summary)
        previous: Any = None
        for step in steps:
            try:
                out = encode(store_step(run, step))
            except (ValueError, KeyError) as exc:
                out = {"error": type(exc).__name__, "message": str(exc)}
            step["out"] = out
            files = encode(listing(run.data_dir, summary))
            if files != previous:
                step["files"] = files
                previous = files
    return {"name": name, "clock": clock, "summarize_events": summary, "steps": steps}


def O(op: str, *args: Any, **kw: Any) -> Dict[str, Any]:
    step: Dict[str, Any] = {"op": op}
    if args:
        step["args"] = list(args)
    step.update(kw)
    return step


TIMES = ["08:00", " 08:00 ", "8:00", "24:00", "23:59", "00:00", "12:60", "12:5", "", None, 800, 8.0, True,
         ["08:00"], "noon", "08:00:00", "08-00", "08:00\n", "\u0085 08:00\u001f\u3000", "\ufeff08:00",
         "0\u0668:3\u0660", "1\u0669:00", "\uff10\uff18:\uff10\uff10", "2\u0663:59", "\U0001d7ce8:00"]
LABELS = ["Morning", "  x  ", "", "   ", None, 5, False, "x" * 80, "x" * 81, " " + "x" * 80 + " ",
          "\U0001f48a" * 80, "\U0001f48a" * 81, "\xe9" * 80, "\xe9" * 81, "\u001fx\u001f", "\ufeffx",
          "\u0085\u2003x\xa0", "\u200bx"]
NOTES = [None, "", " a ", 5, ["x"], "x" * 300, "x" * 301, "x" * 299 + "  ", " " * 300, "\U0001f48a" * 300,
         "\U0001f48a" * 301, "line one\nline two", "\u001ftrim me\u001f"]


def store_scenarios() -> List[Dict[str, Any]]:
    d = DAY
    sc = []
    sc.append(store_scenario("validators", [O("validate_time", v) for v in TIMES]
                             + [O("validate_label", v) for v in LABELS] + [O("validate_notes", v) for v in NOTES]))
    sc.append(store_scenario("first_open_seeds_the_demo_doses", [
        O("open"), O("list_doses"), O("get_dose", "d1"), O("get_dose", "nope"), O("reopen"), O("list_doses"),
        O("events"),
    ]))
    sc.append(store_scenario("add_update_delete", [
        O("open"),
        O("add_dose", "09:30", "Extra dose (demo)", "with water"),
        O("update_dose", "d4", "10:15", None, ""),
        O("delete_dose", "d2"), O("delete_dose", "d2"),
        O("reopen"), O("list_doses"), O("get_dose", "d4"), O("get_dose", "d2"),
        O("add_dose", "06:00", "Early (demo)"),
        O("add_dose", " 07:15 ", "  Padded (demo)  ", "  padded notes  "),
        O("update_dose", "d1"),
        O("update_dose", "d1", None, None, "a note"),
        O("update_dose", "d1", None, "Renamed (demo)"),
        O("list_doses"),
    ]))
    sc.append(store_scenario("errors_change_nothing", [
        O("open"),
        O("add_dose", "8:00", "x"), O("add_dose", "08:00", "   "), O("add_dose", "08:00", "x" * 81),
        O("add_dose", "bad", ""), O("add_dose", "08:00", "", 5), O("add_dose", "08:00", "ok", 5),
        O("add_dose", "08:00", "ok", "n" * 301), O("add_dose", None, "ok"),
        O("add_dose", "08:00", "No notes (demo)", None),
        O("update_dose", "nope", None, "x"), O("update_dose", "nope", "bad"), O("update_dose", "", "08:00"),
        O("update_dose", "d1", "25:00"), O("update_dose", "d1", "09:00", ""),
        O("update_dose", "d1", "09:00", "fine", 7), O("get_dose", "d1"),
        O("update_dose", "d1", "", None, None),
        O("delete_dose", "nope"), O("delete_dose", ""),
        O("list_doses"),
    ]))
    sc.append(store_scenario("ids_are_never_reused", [
        O("open"),
        O("delete_dose", "d3"), O("add_dose", "21:00", "Later (demo)"),
        O("add_event", type="pickup_acknowledged", dose_id="d4", at=on(d, 21, 5)),
        O("delete_dose", "d4"), O("add_dose", "22:00", "Latest (demo)"),
        O("delete_dose", "d1"), O("delete_dose", "d2"), O("delete_dose", "d5"),
        O("reopen"), O("list_doses"), O("add_dose", "07:00", "After emptying (demo)"),
        O("add_event", type="reminder_due", dose_id="d40", at=on(d, 21, 6)),
        O("add_event", type="hover_test", dose_id="x7", at=on(d, 21, 7)),
        O("add_dose", "07:30", "After an event for d40 (demo)"),
        O("reopen"), O("add_dose", "07:45", "After reopening (demo)"),
    ]))
    sc.append(store_scenario("ids_from_a_hand_edited_schedule", [
        O("write_raw", name="schedule", text=json.dumps({"doses": [
            {"id": "d\u0669\u0669", "time": "08:00", "label": "Arabic-Indic id (demo)", "notes": ""},
            {"id": "d007", "time": "09:00", "label": "Leading zeros (demo)", "notes": ""}], "next_id": 3})),
        O("open"), O("list_doses"), O("add_dose", "10:00", "Next (demo)"),
        O("write_raw", name="schedule", text=json.dumps({"doses": [], "next_id": 10 ** 20})),
        O("reopen"), O("add_dose", "10:00", "Large next id (demo)"),
    ]))
    next_ids: List[Any] = ["12", " 0_9 ", 3.9, -4, None, True, "x", [], "\u0664\u0662", 0, "+7", "7.0", {"n": 1}]
    steps = [O("clock", at=on(d, 9, 0))]
    for value in next_ids:
        steps += [O("write_raw", name="schedule", text=json.dumps({"doses": [], "next_id": value})), O("reopen"),
                  O("add_dose", "10:00", "Probe (demo)")]
    steps += [O("write_raw", name="schedule", text='{"doses": []}'), O("reopen"), O("add_dose", "10:00", "Probe (demo)")]
    sc.append(store_scenario("next_id_values", steps))
    sc.append(store_scenario("invalid_doses_are_skipped_without_rewriting", [
        O("write_raw", name="schedule", text=json.dumps({"doses": [
            {"id": "d1", "time": "08:00", "label": "Morning (demo)", "notes": ""},
            {"id": "d7", "time": "25:00", "label": "Hand edited (demo)"},
            {"id": "d2", "time": "09:00"},
            {"time": "09:30", "label": "No id (demo)"},
            {"id": "d3", "time": "10:00", "label": "Notes a number (demo)", "notes": 5},
            {"id": None, "time": "10:30", "label": "Id None (demo)"},
            {"id": 12, "time": "11:00", "label": "Id a number (demo)", "notes": None},
            {"id": True, "time": "11:30", "label": "Id True (demo)"},
            {"id": ["d9"], "time": "11:45", "label": "Id a list (demo)"},
            "d5", None, ["d6", "12:00", "x"],
            {"id": "d8", "time": " 12:00 ", "label": "  Padded (demo)  ", "notes": "  n  "},
            {"id": "d9", "time": "13:00", "label": "x" * 81},
            {"id": "d10", "time": "14:00", "label": "Long notes (demo)", "notes": "n" * 301},
            {"id": "d1", "time": "15:00", "label": "Duplicate id (demo)", "notes": ""},
        ], "next_id": 8}, ensure_ascii=False)),
        O("open"), O("list_doses"), O("get_dose", "d1"), O("get_dose", "None"), O("get_dose", "12"),
        O("get_dose", "['d9']"),
        O("update_dose", "d1", "07:00", None, None), O("delete_dose", "d1"),
        O("add_dose", "09:00", "New (demo)"), O("list_doses"),
    ]))
    for label, text in (("not_json", "{not json"), ("a_list", "[]"), ("doses_not_a_list", '{"doses": "d1"}'),
                        ("null", "null"), ("a_string", '"schedule"'), ("doses_null", '{"doses": null}'),
                        ("empty", ""), ("byte_order_mark", '\ufeff{"doses": [], "next_id": 4}')):
        sc.append(store_scenario(f"schedule_{label}_is_set_aside", [
            O("write_raw", name="schedule", text=text), O("open"), O("list_doses"), O("add_dose", "09:00", "New (demo)"),
        ]))
    sc.append(store_scenario("corrupt_twice_in_one_second", [
        O("write_raw", name="schedule", text="{first"), O("open"),
        O("write_raw", name="schedule", text="[second]"), O("reopen"),
        O("clock", at=on(d, 9, 0, 1)), O("write_raw", name="schedule", text="third"), O("reopen"),
        O("list_doses"),
    ]))
    sc.append(store_scenario("event_types_and_order", [
        O("open"),
        O("add_event", type="bogus"), O("add_event", type=""), O("add_event", type="Reminder_due"),
        *[O("add_event", type=t, dose_id="d1", run_id="r1", detail={"n": i}, at=on(d, 8, i))
          for i, t in enumerate(store_module.EVENT_TYPES)],
        O("add_event", type="hover_test", detail={"pass": True, "drift_m_estimate": 0.12}, at=on(d, 7, 30)),
        O("add_event", type="hover_test", at=on(d, 7, 30)),
        O("clock", at=on(d, 9, 30, 0.5)),
        O("add_event", type="run_aborted", run_id="r2", detail={"reason": "marker_lost"}),
        O("add_event", type="auto_run_skipped", dose_id="d2", detail={"blockers": ["not_ready", "stale_due"]}),
        O("add_event", type="pickup_acknowledged", dose_id="d2", detail=None, at=on(d, 9, 30, 0.5)),
        O("events"), O("reopen"), O("events", 4),
        O("events_between", start=on(d, 7, 30), end=on(d, 8, 3)),
        O("events_between", start=on(d, 8, 0, 0.5), end=on(d, 8, 0, 0.5)),
        O("events_between", start=on(d, 0, 0), end=on(NEXT_DAY, 0, 0)),
        O("events_between", start=on(d, 10, 0), end=on(d, 11, 0)),
    ]))
    sc.append(store_scenario("event_limit_is_capped", [
        O("write_event_lines", type="hover_test", count=503, at=on(d, 8, 0)),
        O("open"),
        O("events_summary"), O("events_summary", 3), O("events_summary", 0), O("events_summary", -5),
        O("events_summary", 2.7), O("events_summary", 500), O("events_summary", 501), O("events_summary", 10_000),
        O("events_summary", True),
        O("add_event", type="pickup_acknowledged", dose_id="d2", at=on(d, 7, 0)),
        O("add_event", type="run_started", dose_id="d2", run_id="r1", at=on(d, 9, 0)),
        O("events_summary", 2), O("events_between", start=on(d, 6, 0), end=on(d, 8, 0, 1)),
        O("reopen"), O("events_summary", 1000), O("events_summary", 500),
    ], summary=True))
    sc.append(store_scenario("damaged_event_log", [
        O("write_raw", name="events", text="".join([
            '{"ts": {{2026,11,11,8,0,0}}, "type": "reminder_due", "dose_id": "d1", "run_id": null, "detail": {"time": "08:00"}}\n',
            "garbage\n",
            "\n",
            "   \n",
            "[1, 2]\n",
            "null\n",
            "5\n",
            '{"ts": {{2026,11,11,8,5,0}}, "type": "hover_test", "detail": "x"}\n',
            '{"ts": {{2026,11,11,8,6,0}}, "type": "hover_test", "detail": [1]}\n',
            '{"ts": {{2026,11,11,8,7,0}}, "type": "hover_test", "detail": []}\n',
            '{"ts": {{2026,11,11,8,8,0}}, "type": "hover_test", "detail": 0}\n',
            '{"ts": {{2026,11,11,8,9,0}}, "type": "hover_test", "detail": null}\n',
            '{"ts": {{2026,11,11,8,10,0}}, "type": "hover_test"}\n',
            '{"type": "hover_test", "detail": {}}\n',
            '{"ts": {{2026,11,11,8,11,0}}, "detail": {}}\n',
            '{"ts": null, "type": "hover_test"}\n',
            '{"ts": "soon", "type": "hover_test"}\n',
            '{"ts": " {{2026,11,11,8,12,0}} ", "type": "hover_test", "detail": {"ts": "as text"}}\n',
            '{"ts": {{2026,11,11,8,13,0}}, "type": 5, "dose_id": "d2"}\n',
            '{"ts": {{2026,11,11,8,14,0}}, "type": null, "run_id": "r3"}\n',
            '{"ts": {{2026,11,11,7,0,0}}, "type": "pickup_acknowledged", "dose_id": "d3", "detail": {"self_reported": true}}\r\n',
            '\u0085{"ts": {{2026,11,11,7,1,0}}, "type": "arrived_at_station", "dose_id": "d3"}\u001f\r',
            '{"ts": {{2026,11,11,7,2,0}}, "type": "run_started", "dose_id": "d3", "run_id": "r1"}\n',
            '{"ts": {{2026,11,11,7,3,0}}, "type": "run_sta',
        ])),
        O("open"), O("events", 100),
        O("add_event", type="pickup_acknowledged", dose_id="d1", at=on(d, 8, 20)),
        O("reopen"), O("events", 100),
        O("add_event", type="hover_test", at=on(d, 8, 21)),
    ]))
    sc.append(store_scenario("event_log_endings", [
        O("write_raw", name="events", text=""), O("open"), O("add_event", type="hover_test", at=on(d, 8, 0)),
        O("append_raw", name="events", text='{"ts": {{2026,11,11,8,1,0}}, "type": "hover_test"}'),
        O("add_event", type="hover_test", at=on(d, 8, 2)),
        O("append_raw", name="events", text="tail\r"),
        O("add_event", type="hover_test", at=on(d, 8, 3)),
        O("reopen"), O("events"),
        O("delete_raw", name="events"), O("add_event", type="hover_test", at=on(d, 8, 4)), O("events"),
        O("reopen"), O("events"),
    ]))
    sc.append(store_scenario("mission_settings", [
        O("open"),
        O("load_drift_assist"), O("load_land_on_arrival"), O("load_auto_fly"), O("load_avoid"),
        O("save_drift_assist", True), O("load_drift_assist"),
        O("save_land_on_arrival", True), O("save_auto_fly", True),
        O("save_avoid", "hold"), O("load_avoid"), O("save_avoid", "off"), O("load_avoid"),
        O("save_avoid", "sideways"), O("save_avoid", None), O("save_avoid", "HOLD"), O("save_avoid", 5),
        O("load_avoid"),
        O("save_drift_assist", False), O("reopen"),
        O("load_drift_assist"), O("load_land_on_arrival"), O("load_auto_fly"), O("load_avoid"),
        O("save_land_on_arrival", 0), O("save_auto_fly", 1), O("save_drift_assist", "yes"),
        O("write_raw", name="mission", text='{"drift_assist": "yes", "land_on_arrival": 1, "extra": 5, "avoid": "sideways"}'),
        O("load_drift_assist"), O("load_land_on_arrival"), O("load_auto_fly"), O("load_avoid"),
        O("save_auto_fly", True),
        O("write_raw", name="mission", text='{"avoid": "hold", "auto_fly": true, "drift_assist": null}'),
        O("load_avoid"), O("load_auto_fly"), O("save_land_on_arrival", True),
        O("write_raw", name="mission", text="{not json"), O("load_auto_fly"), O("load_avoid"),
        O("clock", at=on(d, 9, 0, 2)),
        O("write_raw", name="mission", text="{still not json"), O("save_land_on_arrival", True),
        O("write_raw", name="mission", text="[]"), O("load_drift_assist"), O("save_avoid", "off"),
        O("write_raw", name="mission", text='"true"'), O("load_drift_assist"),
        O("write_raw", name="mission", text="null"), O("load_avoid"),
    ]))
    sc.append(store_scenario("trim_and_calibration", [
        O("open"),
        O("load_trim"), O("save_trim", 0.02, -0.01), O("load_trim"), O("reopen"), O("load_trim"),
        O("save_trim", 0, 1), O("load_trim"),
        *[step for text in ('{"roll": "0.5", "pitch": " -1_0e-2 "}', '{"roll": true, "pitch": false}',
                            '{"roll": 0.1}', "[0.1, 0.2]", '{"roll": null, "pitch": 0}', '{"roll": "x", "pitch": 0}',
                            '{"roll": "inf", "pitch": "-Infinity"}', '{"roll": "nan", "pitch": ".5"}',
                            '{"roll": "1_0", "pitch": "\u0661.\u0665"}', '{"roll": 3, "pitch": 4, "yaw": 5}',
                            "{bad")
          for step in (O("write_raw", name="trim", text=text), O("load_trim"))],
        O("load_arrive_width"), O("save_arrive_width", 0.21), O("load_arrive_width"),
        O("save_arrive_width", 5.0), O("load_arrive_width"),
        O("save_arrive_width", 0.03), O("load_arrive_width"), O("save_arrive_width", 0.8), O("load_arrive_width"),
        O("save_arrive_width", 0.0299), O("load_arrive_width"), O("save_arrive_width", 0.8001), O("load_arrive_width"),
        *[step for text in ('{"arrive_width": "0.5"}', '{"arrive_width": "nan"}', '{"arrive_width": true}',
                            '{"arrive_width": null}', '{"width": 0.2}', '{"arrive_width": [0.2]}', "0.2", "{oops")
          for step in (O("write_raw", name="calibration", text=text), O("load_arrive_width"))],
    ]))
    sc.append(store_scenario("run_traces", [
        O("open"),
        O("write_run_trace", run_id="run-x", trace={"run_id": "run-x", "samples": [], "ok": True}),
        O("write_run_trace", run_id="run-y", trace={"run_id": "run-y", "samples": [{"t": 0.05, "state": "searching"}]}),
        O("write_run_trace", run_id="run-x", trace={"run_id": "run-x", "samples": [1, 2], "note": "again"}),
    ]))
    return sc


def build_care_store() -> dict:
    return {
        "constants": {
            "event_types": list(store_module.EVENT_TYPES),
            "seed_doses": [dict(s) for s in store_module.SEED_DOSES],
            "label_max": store_module.LABEL_MAX,
            "notes_max": store_module.NOTES_MAX,
            "avoid_modes": list(store_module.AVOID_MODES),
        },
        "scenarios": store_scenarios(),
    }


# ---------------------------------------------------------------------------------------------- #
# command line

GROUPS: Dict[str, Callable[[], dict]] = {"care_status": build_care_status, "care_store": build_care_store}


def fixture_path(name: str, out_dir: Path = FIXTURE_DIR) -> Path:
    return out_dir / f"{name}.json"


def build_group(name: str) -> dict:
    with quiet():
        return encode({"group": name, "generator": f"backend/tools/parity_care.py {name}", **GROUPS[name]()})


def render_group(data: dict) -> str:
    return render(data) + "\n"


def load_fixture(name: str, out_dir: Path = FIXTURE_DIR) -> dict:
    """A committed fixture file, parsed (the {"$float": ...} tags are left as they are)."""
    return json.loads(fixture_path(name, out_dir).read_bytes().decode("utf-8"))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("groups", nargs="*", help=f"fixture groups ({', '.join(GROUPS)}) or all; default all")
    parser.add_argument("--check", action="store_true", help="compare with the files instead of writing them")
    parser.add_argument("--out-dir", type=Path, default=FIXTURE_DIR)
    args = parser.parse_args(argv)
    names = list(GROUPS) if "all" in args.groups or not args.groups else list(dict.fromkeys(args.groups))
    unknown = [name for name in names if name not in GROUPS]
    if unknown:
        parser.error(f"unknown group(s) {', '.join(unknown)}; choose from {', '.join(GROUPS)} or all")
    stale = []
    for name in names:
        text = render_group(build_group(name))
        path = fixture_path(name, args.out_dir)
        if args.check:
            same = path.exists() and path.read_bytes().decode("utf-8") == text
            print(f"{'ok   ' if same else 'STALE'} {path} ({len(text)} bytes)")
            if not same:
                stale.append(name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
        print(f"wrote {path} ({len(text)} bytes)")
    if stale:
        print(f"regenerate with: python tools/parity_care.py {' '.join(stale)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
