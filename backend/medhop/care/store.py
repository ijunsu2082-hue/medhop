"""Schedule, event log, trim and calibration files under the data directory.

Files (all local, demo data only):
  schedule.json      {"doses": [{"id", "time", "label", "notes"}], "next_id": n}
  events.jsonl       one JSON object per line: {"ts", "type", "dose_id", "run_id", "detail"}
  trim.json          {"roll", "pitch"}
  calibration.json   {"arrive_width"}
  mission.json       {"drift_assist", "land_on_arrival", "auto_fly", "avoid"}
  runs/<run_id>.json per-run trace written by the mission runner
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from medhop.config import AVOID_MODES

logger = logging.getLogger("medhop.care.store")

EVENT_TYPES = (
    "reminder_due",
    "run_started",
    "arrived_at_station",
    "run_aborted",
    "pickup_acknowledged",
    "needs_attention",
    "hover_test",
    "auto_run_skipped",   # a dose came due with automatic flights on, but the run could not start
)

SEED_DOSES = (
    {"time": "08:00", "label": "Morning dose (demo)", "notes": ""},
    {"time": "13:00", "label": "Midday dose (demo)", "notes": ""},
    {"time": "20:00", "label": "Evening dose (demo)", "notes": ""},
)

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
LABEL_MAX = 80
NOTES_MAX = 300


def validate_time(value: Any) -> str:
    if not isinstance(value, str) or not _TIME_RE.match(value.strip()):
        raise ValueError("time must be 24-hour HH:MM")
    return value.strip()


def validate_label(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("label must not be empty")
    if len(value.strip()) > LABEL_MAX:
        raise ValueError(f"label must be at most {LABEL_MAX} characters")
    return value.strip()


def validate_notes(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("notes must be text")
    if len(value) > NOTES_MAX:
        raise ValueError(f"notes must be at most {NOTES_MAX} characters")
    return value.strip()


def time_local(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M")


class CareStore:
    def __init__(self, data_dir: Path, wall_clock: Callable[[], float] = time.time) -> None:
        self.data_dir = Path(data_dir)
        self._wall_clock = wall_clock
        self._lock = threading.RLock()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.runs_dir = self.data_dir / "runs"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self._schedule_path = self.data_dir / "schedule.json"
        self._events_path = self.data_dir / "events.jsonl"
        self._trim_path = self.data_dir / "trim.json"
        self._calibration_path = self.data_dir / "calibration.json"
        self._mission_path = self.data_dir / "mission.json"
        self._next_number = 1
        self._doses: List[Dict[str, str]] = self._load_schedule()
        self._events: List[Dict[str, Any]] = self._load_events()

    # ------------------------------------------------------------------ #
    # files
    # ------------------------------------------------------------------ #
    def _write_json(self, path: Path, payload: Any) -> None:
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp, path)

    def _read_json(self, path: Path) -> Optional[Any]:
        """Parsed content, or None when the file is missing. A corrupt file is set aside, not overwritten."""
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError) as exc:
            self._move_aside(path, f"could not read {path} ({exc})")
            return None

    def _move_aside(self, path: Path, reason: str) -> None:
        """Rename a bad file to `<name>.corrupt-<unix time>` so nothing is overwritten."""
        aside = path.with_name(f"{path.name}.corrupt-{int(self._wall_clock())}")
        logger.error("%s; moving it to %s", reason, aside.name)
        try:
            os.replace(path, aside)
        except OSError:
            logger.exception("could not move the corrupt file aside")

    # ------------------------------------------------------------------ #
    # schedule
    # ------------------------------------------------------------------ #
    def _load_schedule(self) -> List[Dict[str, str]]:
        """Invalid doses are left out of memory but the file is not rewritten until the schedule is edited."""
        raw = self._read_json(self._schedule_path)
        doses: List[Dict[str, str]] = []
        if isinstance(raw, dict) and isinstance(raw.get("doses"), list):
            for item in raw["doses"]:
                try:
                    doses.append({
                        "id": str(item["id"]),
                        "time": validate_time(item["time"]),
                        "label": validate_label(item["label"]),
                        "notes": validate_notes(item.get("notes", "")),
                    })
                except (KeyError, TypeError, ValueError) as exc:
                    logger.warning("skipping an invalid dose in schedule.json: %s", exc)
            try:
                self._next_number = max(1, int(raw.get("next_id", 1)))
            except (TypeError, ValueError):
                self._next_number = 1
            return doses
        if self._schedule_path.exists():
            self._move_aside(self._schedule_path, f"{self._schedule_path} does not hold a doses list")
        # first run (or unreadable or wrong-shape file): seed clearly labelled demo doses
        for index, seed in enumerate(SEED_DOSES, start=1):
            doses.append({"id": f"d{index}", **seed})
        self._next_number = len(doses) + 1
        self._write_json(self._schedule_path, {"doses": doses, "next_id": self._next_number})
        logger.info("seeded %d demo doses in %s", len(doses), self._schedule_path)
        return doses

    def _save_schedule(self) -> None:
        self._write_json(self._schedule_path, {"doses": self._doses, "next_id": self._next_number})

    def _next_id(self) -> str:
        """Ids are never reused, so a new dose can not inherit the events of a deleted one."""
        highest = self._next_number - 1
        for dose in self._doses:
            match = re.fullmatch(r"d(\d+)", dose["id"])
            if match:
                highest = max(highest, int(match.group(1)))
        for event in self._events:
            match = re.fullmatch(r"d(\d+)", str(event.get("dose_id") or ""))
            if match:
                highest = max(highest, int(match.group(1)))
        self._next_number = highest + 2
        return f"d{highest + 1}"

    def list_doses(self) -> List[Dict[str, str]]:
        with self._lock:
            return sorted((dict(d) for d in self._doses), key=lambda d: (d["time"], d["id"]))

    def get_dose(self, dose_id: str) -> Optional[Dict[str, str]]:
        with self._lock:
            for dose in self._doses:
                if dose["id"] == dose_id:
                    return dict(dose)
        return None

    def add_dose(self, time_str: Any, label: Any, notes: Any = "") -> Dict[str, str]:
        dose = {"time": validate_time(time_str), "label": validate_label(label), "notes": validate_notes(notes)}
        with self._lock:
            dose = {"id": self._next_id(), **dose}
            self._doses.append(dose)
            self._save_schedule()
            return dict(dose)

    def update_dose(self, dose_id: str, time_str: Any = None, label: Any = None,
                    notes: Any = None) -> Dict[str, str]:
        """Update the given fields. Raises KeyError for an unknown id, ValueError for bad values."""
        with self._lock:
            for dose in self._doses:
                if dose["id"] != dose_id:
                    continue
                updated = dict(dose)
                if time_str is not None:
                    updated["time"] = validate_time(time_str)
                if label is not None:
                    updated["label"] = validate_label(label)
                if notes is not None:
                    updated["notes"] = validate_notes(notes)
                dose.update(updated)
                self._save_schedule()
                return dict(dose)
        raise KeyError(dose_id)

    def delete_dose(self, dose_id: str) -> bool:
        with self._lock:
            before = len(self._doses)
            self._doses = [d for d in self._doses if d["id"] != dose_id]
            if len(self._doses) == before:
                return False
            self._save_schedule()
            return True

    # ------------------------------------------------------------------ #
    # events
    # ------------------------------------------------------------------ #
    def _load_events(self) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        if not self._events_path.exists():
            return events
        # errors="replace": a damaged byte spoils at most its own line, never the whole startup
        with open(self._events_path, "r", encoding="utf-8", errors="replace") as handle:
            for number, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                    detail = item.get("detail") or {}
                    if not isinstance(detail, dict):
                        raise TypeError("detail is not an object")
                    events.append({
                        "ts": float(item["ts"]),
                        "type": str(item["type"]),
                        "dose_id": item.get("dose_id"),
                        "run_id": item.get("run_id"),
                        "detail": detail,
                    })
                except (ValueError, KeyError, TypeError, AttributeError):
                    logger.warning("skipping unreadable line %d of events.jsonl", number)
        events.sort(key=lambda e: e["ts"])
        return events

    def add_event(self, event_type: str, dose_id: Optional[str] = None, run_id: Optional[str] = None,
                  detail: Optional[Dict[str, Any]] = None, ts: Optional[float] = None) -> Dict[str, Any]:
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unknown event type {event_type!r}")
        event = {
            "ts": float(self._wall_clock() if ts is None else ts),
            "type": event_type,
            "dose_id": dose_id,
            "run_id": run_id,
            "detail": dict(detail or {}),
        }
        with self._lock:
            # a crash can leave a truncated last line; start on a fresh line so this event is not glued to it
            prefix = "" if self._log_ends_cleanly() else "\n"
            with open(self._events_path, "a", encoding="utf-8", newline="\n") as handle:
                handle.write(prefix + json.dumps(event, ensure_ascii=False) + "\n")
            self._events.append(event)
            if len(self._events) > 1 and self._events[-2]["ts"] > event["ts"]:
                self._events.sort(key=lambda e: e["ts"])
        return self._public(event)

    def _log_ends_cleanly(self) -> bool:
        """True when the event log is missing, empty, or ends in a newline."""
        try:
            with open(self._events_path, "rb") as handle:
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    return True
                handle.seek(-1, os.SEEK_END)
                return handle.read(1) == b"\n"
        except FileNotFoundError:
            return True

    @staticmethod
    def _public(event: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ts": event["ts"],
            "time_local": time_local(event["ts"]),
            "type": event["type"],
            "dose_id": event["dose_id"],
            "run_id": event["run_id"],
            "detail": dict(event["detail"]),
        }

    def events(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Newest first."""
        limit = max(1, min(500, int(limit)))
        with self._lock:
            return [self._public(e) for e in reversed(self._events[-limit:])]

    def events_between(self, start_ts: float, end_ts: float) -> List[Dict[str, Any]]:
        """Events with start_ts <= ts < end_ts, oldest first."""
        out: List[Dict[str, Any]] = []
        with self._lock:
            for event in reversed(self._events):
                if event["ts"] < start_ts:
                    break
                if event["ts"] < end_ts:
                    out.append(dict(event))
        out.reverse()
        return out

    # ------------------------------------------------------------------ #
    # trim and calibration
    # ------------------------------------------------------------------ #
    def load_trim(self) -> Tuple[float, float]:
        with self._lock:
            raw = self._read_json(self._trim_path)
        try:
            return float(raw["roll"]), float(raw["pitch"])
        except (TypeError, KeyError, ValueError):
            return 0.0, 0.0

    def save_trim(self, roll: float, pitch: float) -> None:
        with self._lock:
            self._write_json(self._trim_path, {"roll": float(roll), "pitch": float(pitch)})

    def load_arrive_width(self) -> Optional[float]:
        with self._lock:
            raw = self._read_json(self._calibration_path)
        try:
            value = float(raw["arrive_width"])
        except (TypeError, KeyError, ValueError):
            return None
        return value if 0.03 <= value <= 0.8 else None

    def save_arrive_width(self, width: float) -> None:
        with self._lock:
            self._write_json(self._calibration_path, {"arrive_width": float(width)})

    def load_drift_assist(self) -> bool:
        """The stored drift-assist switch. Off unless the file says exactly `true`."""
        with self._lock:
            raw = self._read_json(self._mission_path)
        return isinstance(raw, dict) and raw.get("drift_assist") is True

    def save_drift_assist(self, enabled: bool) -> None:
        self._save_mission_setting("drift_assist", bool(enabled))

    def load_land_on_arrival(self) -> bool:
        """The stored land-on-arrival switch. Off unless the file says exactly `true`."""
        with self._lock:
            raw = self._read_json(self._mission_path)
        return isinstance(raw, dict) and raw.get("land_on_arrival") is True

    def save_land_on_arrival(self, enabled: bool) -> None:
        self._save_mission_setting("land_on_arrival", bool(enabled))

    def load_auto_fly(self) -> bool:
        """The stored automatic-flights switch. Off unless the file says exactly `true`."""
        with self._lock:
            raw = self._read_json(self._mission_path)
        return isinstance(raw, dict) and raw.get("auto_fly") is True

    def save_auto_fly(self, enabled: bool) -> None:
        self._save_mission_setting("auto_fly", bool(enabled))

    def load_avoid(self) -> Optional[str]:
        """The stored obstacle-avoidance mode ("off", "hold" or "pass"), or None when none is stored
        (or the stored value is not one of those): the settings' default applies then."""
        with self._lock:
            raw = self._read_json(self._mission_path)
        value = raw.get("avoid") if isinstance(raw, dict) else None
        return value if value in AVOID_MODES else None

    def save_avoid(self, mode: str) -> None:
        if mode not in AVOID_MODES:
            raise ValueError(f"avoid must be one of {AVOID_MODES}")
        self._save_mission_setting("avoid", mode)

    def _save_mission_setting(self, key: str, value: Any) -> None:
        """Read-modify-write of mission.json, so saving one setting keeps the others."""
        with self._lock:
            raw = self._read_json(self._mission_path)
            settings: Dict[str, Any] = {name: raw.get(name) is True
                                        for name in ("drift_assist", "land_on_arrival", "auto_fly")
                                        if isinstance(raw, dict) and name in raw}
            if isinstance(raw, dict) and raw.get("avoid") in AVOID_MODES:
                settings["avoid"] = raw["avoid"]
            settings[key] = value
            self._write_json(self._mission_path, settings)

    def write_run_trace(self, run_id: str, trace: Dict[str, Any]) -> Path:
        path = self.runs_dir / f"{run_id}.json"
        with self._lock:
            self._write_json(path, trace)
        return path
