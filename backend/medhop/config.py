"""Settings read from MEDHOP_* environment variables (SPEC section 4)."""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

# <repo>/backend/medhop/config.py -> <repo>
REPO_ROOT = Path(__file__).resolve().parents[2]

DRONE_MODES = ("sim", "real")
PERSON_CHECK_MODES = ("auto", "on", "off")
# Simulator camera profile: "high" is the display profile (a rendered room at 1280x720), "drone" the
# drone-like profile (640x360, blur, noise, JPEG quality 50) that the automated tests use.
SIM_CAMERA_MODES = ("high", "drone")
AVOID_MODES = ("off", "hold", "pass")    # obstacle avoidance (experimental), SPEC section 11

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
    # Marker width (fraction of the frame width) that counts as arrived. None (the default): derived
    # from land_distance_m, the marker size and camera_hfov_deg. An explicit MEDHOP_ARRIVE_WIDTH wins.
    arrive_width: Optional[float] = None
    # Landing distance from the sign, in the program's own metre scale (camera_hfov_deg geometry). The
    # real lens differs, so the real distance differs: measure it with a ruler.
    land_distance_m: float = 0.45
    person_check: str = "auto"
    yolo_weights: Optional[str] = None
    # Raw battery byte treated as low. -1 (the default) disables the check: the byte's meaning is
    # unverified (SPEC 10.2). When >= 0 it only applies to telemetry younger than telemetry_fresh_s.
    battery_low_raw: int = -1
    telemetry_fresh_s: float = 3.0     # telemetry older than this is treated as absent for decisions
    hover_max_excursion_m: float = 0.5  # hover test passes when the peak sideways excursion is <= this
    grace_min: int = 15
    # Horizontal field of view of the drone camera. Only used to turn marker size into an estimated
    # distance for display. 70 matches the simulator; the real drone's lens is unmeasured.
    camera_hfov_deg: float = 70.0
    host: str = "127.0.0.1"
    port: int = BACKEND_PORT
    # Simulator only: which camera profile the interactive simulator renders (SIM_CAMERA_MODES).
    sim_camera: str = "high"
    # Obstacle avoidance (experimental, simulator-tested only; SPEC section 11): "off", "hold" or "pass".
    # "off" here; from_env defaults it to "hold" in simulator mode and "off" on the real drone. A mode
    # stored with the mission settings (PUT /api/mission/settings) wins over this.
    avoid: str = "off"

    def __post_init__(self) -> None:
        self.drone = str(self.drone).strip().lower()
        self.person_check = str(self.person_check).strip().lower()
        self.sim_camera = str(self.sim_camera).strip().lower()
        self.avoid = str(self.avoid).strip().lower()
        if self.avoid not in AVOID_MODES:
            raise ValueError(f"MEDHOP_AVOID must be one of {AVOID_MODES}, got {self.avoid!r}")
        self.data_dir = Path(self.data_dir)
        if self.drone not in DRONE_MODES:
            raise ValueError(f"MEDHOP_DRONE must be one of {DRONE_MODES}, got {self.drone!r}")
        if self.person_check not in PERSON_CHECK_MODES:
            raise ValueError(
                f"MEDHOP_PERSON_CHECK must be one of {PERSON_CHECK_MODES}, got {self.person_check!r}"
            )
        if self.sim_camera not in SIM_CAMERA_MODES:
            raise ValueError(
                f"MEDHOP_SIM_CAMERA must be one of {SIM_CAMERA_MODES}, got {self.sim_camera!r}"
            )
        if not 1.0 <= self.control_rate <= 100.0:
            raise ValueError("MEDHOP_CONTROL_RATE must be between 1 and 100")
        if not 0 <= self.marker_id < 50:
            raise ValueError("MEDHOP_MARKER_ID must be 0..49 (ArUco DICT_4X4_50)")
        if not 0.02 <= self.marker_size_m <= 1.0:
            raise ValueError("MEDHOP_MARKER_SIZE_M must be between 0.02 and 1.0")
        if self.grace_min < 0:
            raise ValueError("MEDHOP_GRACE_MIN must be >= 0")
        if not 0.05 <= self.hover_max_excursion_m <= 5.0:
            raise ValueError("MEDHOP_HOVER_MAX_EXCURSION_M must be between 0.05 and 5.0")
        if not 30.0 <= self.camera_hfov_deg <= 150.0:
            raise ValueError("MEDHOP_CAMERA_HFOV_DEG must be between 30 and 150")
        # After the lens check: the derived arrive width uses camera_hfov_deg.
        if not 0.35 <= self.land_distance_m <= 3.0:
            raise ValueError("MEDHOP_LAND_DISTANCE_M must be between 0.35 and 3.0")
        derived = self.arrive_width is None
        if derived:
            half = math.radians(self.camera_hfov_deg) / 2.0
            self.arrive_width = self.marker_size_m / (2.0 * math.tan(half) * self.land_distance_m)
        if not 0.03 <= self.arrive_width <= 0.8:
            if derived:
                raise ValueError(
                    f"MEDHOP_LAND_DISTANCE_M={self.land_distance_m} gives an arrive width of "
                    f"{self.arrive_width:.3f}, outside 0.03..0.8 for this marker size and lens"
                )
            raise ValueError("MEDHOP_ARRIVE_WIDTH must be between 0.03 and 0.8")

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
            ("MEDHOP_LAND_DISTANCE_M", "land_distance_m", float),
            ("MEDHOP_PERSON_CHECK", "person_check", str),
            ("MEDHOP_YOLO_WEIGHTS", "yolo_weights", str),
            ("MEDHOP_BATTERY_LOW_RAW", "battery_low_raw", int),
            ("MEDHOP_HOVER_MAX_EXCURSION_M", "hover_max_excursion_m", float),
            ("MEDHOP_GRACE_MIN", "grace_min", int),
            ("MEDHOP_CAMERA_HFOV_DEG", "camera_hfov_deg", float),
            ("MEDHOP_HOST", "host", str),
            ("MEDHOP_SIM_CAMERA", "sim_camera", str),
            ("MEDHOP_AVOID", "avoid", str),
        ):
            raw = get(name)
            if raw is None:
                continue
            try:
                kwargs[key] = cast(raw)
            except ValueError as exc:
                raise ValueError(f"{name}={raw!r} is not a valid {cast.__name__}") from exc
        if "avoid" not in kwargs:
            # Unset: on in the simulator, off on the real drone (where only people can be seen, and only
            # with the optional person check). "hold", not "pass": going round ended done on 1 of 20
            # simulator runs with a person and 0 of 20 with a cart (SPEC section 11.7).
            kwargs["avoid"] = "hold" if str(kwargs.get("drone", "sim")).strip().lower() == "sim" else "off"
        return cls(**kwargs)
