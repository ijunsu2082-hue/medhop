"""Settings read from MEDHOP_* environment variables (SPEC section 4)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

# <repo>/backend/medhop/config.py -> <repo>
REPO_ROOT = Path(__file__).resolve().parents[2]

DRONE_MODES = ("sim", "real")
PERSON_CHECK_MODES = ("auto", "on", "off")

BACKEND_PORT = 8010
FRONTEND_ORIGINS = ("http://localhost:5180", "http://127.0.0.1:5180")


@dataclass
class Settings:
    drone: str = "sim"
    turbodrone_backend: Optional[str] = None
    drone_ip: str = "192.168.169.1"
    control_rate: float = 20.0
    data_dir: Path = field(default_factory=lambda: REPO_ROOT / "data")
    marker_id: int = 7
    marker_size_m: float = 0.18
    arrive_width: float = 0.16
    person_check: str = "auto"
    yolo_weights: Optional[str] = None
    # Raw battery byte treated as low. -1 (the default) disables the check: the byte's meaning is
    # unverified (SPEC 10.2). When >= 0 it only applies to telemetry younger than telemetry_fresh_s.
    battery_low_raw: int = -1
    telemetry_fresh_s: float = 3.0     # telemetry older than this is treated as absent for decisions
    hover_max_excursion_m: float = 0.5  # hover test passes when the peak sideways excursion is <= this
    grace_min: int = 15
    host: str = "127.0.0.1"
    port: int = BACKEND_PORT

    def __post_init__(self) -> None:
        self.drone = str(self.drone).strip().lower()
        self.person_check = str(self.person_check).strip().lower()
        self.data_dir = Path(self.data_dir)
        if self.drone not in DRONE_MODES:
            raise ValueError(f"MEDHOP_DRONE must be one of {DRONE_MODES}, got {self.drone!r}")
        if self.person_check not in PERSON_CHECK_MODES:
            raise ValueError(
                f"MEDHOP_PERSON_CHECK must be one of {PERSON_CHECK_MODES}, got {self.person_check!r}"
            )
        if not 1.0 <= self.control_rate <= 100.0:
            raise ValueError("MEDHOP_CONTROL_RATE must be between 1 and 100")
        if not 0 <= self.marker_id < 50:
            raise ValueError("MEDHOP_MARKER_ID must be 0..49 (ArUco DICT_4X4_50)")
        if not 0.02 <= self.marker_size_m <= 1.0:
            raise ValueError("MEDHOP_MARKER_SIZE_M must be between 0.02 and 1.0")
        if not 0.03 <= self.arrive_width <= 0.8:
            raise ValueError("MEDHOP_ARRIVE_WIDTH must be between 0.03 and 0.8")
        if self.grace_min < 0:
            raise ValueError("MEDHOP_GRACE_MIN must be >= 0")
        if not 0.05 <= self.hover_max_excursion_m <= 5.0:
            raise ValueError("MEDHOP_HOVER_MAX_EXCURSION_M must be between 0.05 and 5.0")

    @property
    def battery_check_enabled(self) -> bool:
        return self.battery_low_raw >= 0

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Settings":
        env = os.environ if env is None else env

        def get(name: str) -> Optional[str]:
            value = env.get(name)
            if value is None or not str(value).strip():
                return None
            return str(value).strip()

        kwargs: dict = {}
        for name, key, cast in (
            ("MEDHOP_DRONE", "drone", str),
            ("MEDHOP_TURBODRONE_BACKEND", "turbodrone_backend", str),
            ("MEDHOP_DRONE_IP", "drone_ip", str),
            ("MEDHOP_CONTROL_RATE", "control_rate", float),
            ("MEDHOP_DATA_DIR", "data_dir", Path),
            ("MEDHOP_MARKER_ID", "marker_id", int),
            ("MEDHOP_MARKER_SIZE_M", "marker_size_m", float),
            ("MEDHOP_ARRIVE_WIDTH", "arrive_width", float),
            ("MEDHOP_PERSON_CHECK", "person_check", str),
            ("MEDHOP_YOLO_WEIGHTS", "yolo_weights", str),
            ("MEDHOP_BATTERY_LOW_RAW", "battery_low_raw", int),
            ("MEDHOP_HOVER_MAX_EXCURSION_M", "hover_max_excursion_m", float),
            ("MEDHOP_GRACE_MIN", "grace_min", int),
            ("MEDHOP_HOST", "host", str),
        ):
            raw = get(name)
            if raw is None:
                continue
            try:
                kwargs[key] = cast(raw)
            except ValueError as exc:
                raise ValueError(f"{name}={raw!r} is not a valid {cast.__name__}") from exc
        return cls(**kwargs)
