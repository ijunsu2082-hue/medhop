"""SimLink: 2-D kinematic drone simulator with a rendered camera (SPEC section 3).

World frame: the station wall is the plane z = 0, x runs along the wall (positive to the right when
facing it), y is up. The drone flies at z < 0, so its distance to the wall is -z. Heading 0 faces the
wall; positive heading is a turn to the right.

The simulator can run on its own thread against a real clock (the default, used by the server) or be
stepped by a test with an injected clock (`realtime=False`, call `advance_to(now)`).

Two camera profiles. The `SimConfig()` defaults are the drone-like profile: a plain wall and floor at
640x360, blurred, noisy and JPEG quality 50, close to what the toy drone's camera gives. The existing
closed-loop, marker and vision tests and every published simulator figure use it. `SimConfig.high_quality()`
is the display profile the interactive app uses by default: a rendered room (sim_scene.py) at 1280x720
and 15 fps. tests/test_sim_high_quality.py covers it, and a test that builds the app from default
`Settings` also gets it. Marker detection in that profile runs on a cleaner picture than the real camera
gives.
"""
from __future__ import annotations

import logging
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, replace
from typing import Callable, Deque, List, Optional, Tuple

import cv2
import numpy as np

from medhop.drone.base import Frame, Telemetry, clamp
from medhop.vision.marker import A4_WIDTH_M, SIGN_TOP_MARGIN_M, station_sign

logger = logging.getLogger("medhop.drone.sim")

PHYSICS_STEP_S = 1.0 / 60.0

GROUND = "ground"
TAKING_OFF = "taking_off"
AIRBORNE = "airborne"
LANDING = "landing"


@dataclass
class SimConfig:
    # dynamics
    forward_gain: float = 1.0          # m/s at full pitch stick
    lateral_gain: float = 1.0          # m/s at full roll stick
    yaw_gain_deg: float = 150.0        # deg/s at full yaw stick
    climb_gain: float = 0.5            # m/s at full throttle stick
    velocity_lag_s: float = 0.25       # first-order lag of the velocities
    yaw_lag_s: float = 0.12
    lateral_drift: float = 0.08        # constant body-frame drift, m/s, + is to the drone's right
    noise_velocity: float = 0.02       # m/s, slowly varying
    noise_yaw_deg: float = 1.0         # deg/s, slowly varying
    # camera
    width: int = 640
    height: int = 360
    fps: float = 15.0
    hfov_deg: float = 70.0
    jpeg_quality: int = 50
    sensor_noise: float = 6.0          # sigma, grey levels
    blur_sigma: float = 0.8
    light: float = 1.0                 # scene brightness gain; mean grey falls under the vision worker's
                                       # "dark" level (40) below about 0.25 on the ground and 0.2 in the
                                       # air, in either scene (at 0.35 it is still 55 to 68)
    scene: str = "plain"               # "plain" (drone-like wall and floor) or "room" (sim_scene.py)
    supersample: int = 1               # room scene: render this many times larger, then scale down
    vignette: float = 0.0              # room scene: darkening toward the corners (0 = none)
    # transport: command delay + video delay = command-to-video latency (about 0.45 s)
    command_delay_s: float = 0.10
    video_delay_s: float = 0.35
    # world
    marker_id: int = 7
    marker_size_m: float = 0.18
    marker_height_m: float = 1.0       # height of the marker centre on the wall
    hover_height_m: float = 1.0
    takeoff_s: float = 1.5
    land_s: float = 1.2
    # start pose
    start_distance_m: float = 2.5
    start_x_m: float = 0.0
    start_heading_deg: float = 0.0
    start_airborne: bool = False
    # Put the drone back at the start pose on every takeoff from the ground, like carrying it back to
    # the takeoff spot. The interactive simulator turns this on so repeated demo runs start the same way.
    reset_pose_on_takeoff: bool = False
    seed: Optional[int] = None

    @classmethod
    def high_quality(cls, **overrides) -> "SimConfig":
        """The display camera profile: a rendered room at 1280x720, 15 fps, a clean picture.

        The interactive simulator uses it by default (tests/test_sim_high_quality.py covers it). The
        existing closed-loop and marker tests and the published simulator figures use the drone-like
        defaults, which are much closer to the real toy camera.
        """
        base = cls(width=1280, height=720, fps=15.0, jpeg_quality=92, sensor_noise=1.2, blur_sigma=0.0,
                   scene="room", supersample=2, vignette=0.16)
        return replace(base, **overrides)


class SimLink:
    """DroneLink implementation backed by the simulator. Telemetry values are simulated."""

    mode = "sim"

    def __init__(
        self,
        config: Optional[SimConfig] = None,
        clock: Callable[[], float] = time.monotonic,
        realtime: bool = True,
    ) -> None:
        self.cfg = config or SimConfig()
        self._clock = clock
        self._realtime = realtime
        self._rng = np.random.default_rng(self.cfg.seed)
        self._lock = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()

        c = self.cfg
        # pose and motion state
        self._x = c.start_x_m
        self._z = -abs(c.start_distance_m)
        self._heading = math.radians(c.start_heading_deg)
        self._phase = AIRBORNE if c.start_airborne else GROUND
        self._alt = c.hover_height_m if c.start_airborne else 0.0
        self._v_fwd = 0.0
        self._v_lat = 0.0
        self._v_yaw = 0.0
        self._n_fwd = 0.0
        self._n_lat = 0.0
        self._n_yaw = 0.0
        self._axes = (0.0, 0.0, 0.0, 0.0)  # throttle, yaw, pitch, roll currently acting on the drone
        self._inbox: Deque[Tuple[float, str, tuple]] = deque()
        self._flight_time = 0.0
        self._battery_raw = 42

        # clocks
        self._t: Optional[float] = None
        self._next_frame_t = 0.0
        self._next_telemetry_t = 0.0

        # video
        self._pending: Deque[Tuple[float, bytes]] = deque()
        self._frame: Optional[Frame] = None
        self._seq = 0
        self._video_frozen = False
        self._marker_hidden = False
        self._land_rate: Optional[float] = None   # m/s for a forced landing; None uses cfg.land_s
        self._telemetry: Optional[Telemetry] = None

        # counters for tests
        self.toggle_count = 0
        self.estop_count = 0
        self.calibrate_count = 0
        self.last_axes_sent = (0.0, 0.0, 0.0, 0.0)

        self._build_scene()

    # ------------------------------------------------------------------ #
    # DroneLink API
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if not self._realtime or (self._thread and self._thread.is_alive()):
            return
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._run, name="medhop-sim", daemon=True)
        self._thread.start()
        logger.info("simulator started (drift %.2f m/s, latency %.2f s)",
                    self.cfg.lateral_drift, self.cfg.command_delay_s + self.cfg.video_delay_s)

    def stop(self) -> None:
        self.set_axes(0.0, 0.0, 0.0, 0.0)
        self._stop_evt.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None

    def set_axes(self, throttle: float, yaw: float, pitch: float, roll: float) -> None:
        axes = (clamp(throttle), clamp(yaw), clamp(pitch), clamp(roll))
        with self._lock:
            self.last_axes_sent = axes
            self._inbox.append((self._clock(), "axes", axes))

    def takeoff_land_toggle(self) -> bool:
        with self._lock:
            self.toggle_count += 1
            self._inbox.append((self._clock(), "toggle", ()))
        return True

    def emergency_stop(self) -> bool:
        with self._lock:
            self.estop_count += 1
            self._inbox.append((self._clock(), "estop", ()))
        return True

    def control_up(self) -> bool:
        return True

    def drone_seen(self) -> bool:
        return True

    def calibrate(self) -> None:
        with self._lock:
            self.calibrate_count += 1

    def latest_frame(self) -> Optional[Frame]:
        with self._lock:
            return self._frame

    def telemetry(self) -> Optional[Telemetry]:
        with self._lock:
            return self._telemetry

    # ------------------------------------------------------------------ #
    # test hooks
    # ------------------------------------------------------------------ #
    def force_auto_land(self, drop_battery: bool = False, descent_m_s: Optional[float] = None) -> None:
        """Simulate the drone landing by itself (as it does on low battery).

        `descent_m_s` gives a slower sink than the normal landing, so the marker stays in the picture
        for a while (the case the settle descent guard exists for).
        """
        with self._lock:
            if self._phase in (AIRBORNE, TAKING_OFF):
                self._phase = LANDING
                self._land_rate = None if descent_m_s is None else abs(float(descent_m_s))
            if drop_battery:
                self._battery_raw = 30

    def freeze_video(self, frozen: bool = True) -> None:
        with self._lock:
            self._video_frozen = bool(frozen)

    def drop_marker(self, hidden: bool = True) -> None:
        with self._lock:
            self._marker_hidden = bool(hidden)

    def set_pose(
        self,
        distance_m: Optional[float] = None,
        x_m: Optional[float] = None,
        heading_deg: Optional[float] = None,
        airborne: Optional[bool] = None,
    ) -> None:
        with self._lock:
            if distance_m is not None:
                self._z = -abs(float(distance_m))
            if x_m is not None:
                self._x = float(x_m)
            if heading_deg is not None:
                self._heading = math.radians(float(heading_deg))
            if airborne is not None:
                self._phase = AIRBORNE if airborne else GROUND
                self._alt = self.cfg.hover_height_m if airborne else 0.0
                # A toggle or motor cut still travelling to the drone must not undo the forced state.
                self._inbox = deque(item for item in self._inbox if item[1] == "axes")
            self._v_fwd = self._v_lat = self._v_yaw = 0.0

    def set_drift(self, lateral_m_s: float) -> None:
        with self._lock:
            self.cfg.lateral_drift = float(lateral_m_s)

    def set_battery_raw(self, value: int) -> None:
        with self._lock:
            self._battery_raw = int(value)

    def pose(self) -> dict:
        with self._lock:
            return {
                "x_m": self._x,
                "distance_m": -self._z,
                "heading_deg": math.degrees(self._heading),
                "altitude_m": self._alt,
                "phase": self._phase,
                "airborne": self._phase == AIRBORNE,
            }

    # ------------------------------------------------------------------ #
    # stepping
    # ------------------------------------------------------------------ #
    def _run(self) -> None:
        while not self._stop_evt.is_set():
            try:
                self.advance_to(self._clock())
            except Exception:  # keep the simulator alive; a rendering bug must not kill the thread
                logger.exception("simulator step failed")
            self._stop_evt.wait(0.004)

    def advance_to(self, now: float) -> None:
        """Advance physics, capture due frames and release frames whose transport delay has passed."""
        captures: List[Tuple[float, dict]] = []
        with self._lock:
            if self._t is None:
                self._t = now
                self._next_frame_t = now
                self._next_telemetry_t = now
            if now - self._t > 0.5 and self._realtime:
                self._t = now - 0.5  # the process was paused; do not replay the gap
                self._next_frame_t = max(self._next_frame_t, self._t)
            while self._t + PHYSICS_STEP_S <= now + 1e-9:
                self._physics(PHYSICS_STEP_S)
                self._t += PHYSICS_STEP_S
                if self._t + 1e-9 >= self._next_frame_t:
                    captures.append((self._t, self._snapshot()))
                    self._next_frame_t += 1.0 / self.cfg.fps
                if self._t + 1e-9 >= self._next_telemetry_t:
                    self._telemetry = Telemetry(
                        fly_state_raw=1 if self._alt > 0.15 else 0,
                        battery_raw=self._battery_raw,
                        flags_raw=16,
                        timestamp=self._t,
                    )
                    self._next_telemetry_t += 0.5
        if self._realtime and len(captures) > 1:
            # Running late (a busy machine, a slow frame): render only the newest capture. The frame
            # rate drops for a moment instead of a burst of stale frames being released.
            captures = captures[-1:]
        rendered = [(t + self.cfg.video_delay_s, self._render_jpeg(snap)) for t, snap in captures]
        with self._lock:
            self._pending.extend(rendered)
            while self._pending and self._pending[0][0] <= now + 1e-9:
                release_t, jpeg = self._pending.popleft()
                if self._video_frozen:
                    continue
                self._seq += 1
                self._frame = Frame(jpeg=jpeg, timestamp=release_t, seq=self._seq)

    def _physics(self, dt: float) -> None:
        c = self.cfg
        # commands take effect after the command delay
        while self._inbox and self._inbox[0][0] <= self._t - c.command_delay_s + 1e-9:
            _t, kind, payload = self._inbox.popleft()
            if kind == "axes":
                self._axes = payload
            elif kind == "toggle":
                if self._phase in (GROUND, LANDING):
                    if self._phase == GROUND and c.reset_pose_on_takeoff:
                        self._x = c.start_x_m
                        self._z = -abs(c.start_distance_m)
                        self._heading = math.radians(c.start_heading_deg)
                    self._phase = TAKING_OFF
                else:
                    self._phase = LANDING
                    self._land_rate = None
            elif kind == "estop":
                self._phase = GROUND
                self._alt = 0.0

        throttle, yaw, pitch, roll = self._axes
        if self._phase == TAKING_OFF:
            self._alt += c.hover_height_m / c.takeoff_s * dt
            if self._alt >= c.hover_height_m:
                self._alt = c.hover_height_m
                self._phase = AIRBORNE
        elif self._phase == LANDING:
            rate = c.hover_height_m / c.land_s if self._land_rate is None else self._land_rate
            self._alt -= rate * dt
            if self._alt <= 0.0:
                self._alt = 0.0
                self._phase = GROUND
        elif self._phase == AIRBORNE:
            self._alt = min(1.9, max(0.3, self._alt + throttle * c.climb_gain * dt))

        flying = self._alt > 0.15
        if not flying:
            self._v_fwd = self._v_lat = self._v_yaw = 0.0
            return

        self._flight_time += dt
        if self._flight_time >= 60.0:
            self._flight_time -= 60.0
            self._battery_raw = max(0, self._battery_raw - 1)

        # slowly varying disturbances (Ornstein-Uhlenbeck, 1 s correlation time)
        k = math.sqrt(2.0 * dt)
        self._n_fwd += -self._n_fwd * dt + c.noise_velocity * k * self._rng.standard_normal()
        self._n_lat += -self._n_lat * dt + c.noise_velocity * k * self._rng.standard_normal()
        self._n_yaw += -self._n_yaw * dt + math.radians(c.noise_yaw_deg) * k * self._rng.standard_normal()

        a_v = 1.0 - math.exp(-dt / max(1e-3, c.velocity_lag_s))
        a_y = 1.0 - math.exp(-dt / max(1e-3, c.yaw_lag_s))
        self._v_fwd += (pitch * c.forward_gain - self._v_fwd) * a_v
        self._v_lat += (roll * c.lateral_gain + c.lateral_drift - self._v_lat) * a_v
        self._v_yaw += (yaw * math.radians(c.yaw_gain_deg) - self._v_yaw) * a_y

        v_fwd = self._v_fwd + self._n_fwd
        v_lat = self._v_lat + self._n_lat
        self._heading += (self._v_yaw + self._n_yaw) * dt
        sin_h, cos_h = math.sin(self._heading), math.cos(self._heading)
        self._x += (v_fwd * sin_h + v_lat * cos_h) * dt
        self._z += (v_fwd * cos_h - v_lat * sin_h) * dt
        self._z = min(self._z, -0.15)       # cannot pass through the wall
        self._z = max(self._z, -7.5)
        self._x = min(4.5, max(-4.5, self._x))

    def _snapshot(self) -> dict:
        bob = 0.015 * math.sin(2.0 * math.pi * 0.7 * (self._t or 0.0)) if self._alt > 0.15 else 0.0
        return {
            "x": self._x,
            "z": self._z,
            "heading": self._heading,
            "cam_y": self._alt + 0.04 + bob,
            "marker_hidden": self._marker_hidden,
        }

    # ------------------------------------------------------------------ #
    # scene and camera
    # ------------------------------------------------------------------ #
    def _build_scene(self) -> None:
        if self.cfg.scene == "room":
            self._build_room_scene()
        elif self.cfg.scene == "plain":
            self._build_plain_scene()
        else:
            raise ValueError(f"SimConfig.scene must be 'plain' or 'room', got {self.cfg.scene!r}")

    def _build_room_scene(self) -> None:
        from medhop.drone.sim_scene import RoomRenderer

        c = self.cfg
        self._focal = (c.width / 2.0) / math.tan(math.radians(c.hfov_deg) / 2.0)
        self._K = np.array([[self._focal, 0.0, c.width / 2.0],
                            [0.0, self._focal, c.height / 2.0],
                            [0.0, 0.0, 1.0]])
        self._sign_levels = []
        ppm = 2000.0
        while ppm > 100.0:
            sheet, _rect = station_sign(c.marker_id, c.marker_size_m, ppm)
            self._sign_levels.append((ppm, cv2.cvtColor(sheet, cv2.COLOR_GRAY2BGR)))
            ppm /= math.sqrt(2.0)
        self._sign_left_x = -A4_WIDTH_M / 2.0
        self._sign_top_y = c.marker_height_m + c.marker_size_m / 2.0 + SIGN_TOP_MARGIN_M
        self._room = RoomRenderer(c, self._focal, self._sign_levels, self._sign_left_x, self._sign_top_y,
                                  self._rng)

    def _build_plain_scene(self) -> None:
        c = self.cfg
        rng = np.random.default_rng(1234)  # the room looks the same in every run
        self._focal = (c.width / 2.0) / math.tan(math.radians(c.hfov_deg) / 2.0)
        self._K = np.array([[self._focal, 0.0, c.width / 2.0],
                            [0.0, self._focal, c.height / 2.0],
                            [0.0, 0.0, 1.0]])

        # wall: x in [-5, 5], y in [0, 2.6], 100 px per metre
        self._wall_ppm = 100.0
        wall = np.empty((260, 1000, 3), np.uint8)
        wall[:] = (206, 214, 218)
        shade = cv2.GaussianBlur(rng.normal(0.0, 30.0, (260, 1000)).astype(np.float32), (0, 0), 25)
        grain = rng.normal(0.0, 2.0, (260, 1000)).astype(np.float32)
        wall = np.clip(wall.astype(np.float32) + (shade + grain)[..., None], 0, 255).astype(np.uint8)
        for x_m in range(-4, 5):                                  # faint panel joints
            px = int((x_m + 5.0) * self._wall_ppm)
            cv2.line(wall, (px, 0), (px, 259), (186, 194, 198), 1)
        cv2.rectangle(wall, (0, 250), (999, 259), (92, 104, 112), -1)                     # skirting board
        cv2.rectangle(wall, (620, 60), (710, 259), (70, 96, 128), -1)                     # a door
        cv2.rectangle(wall, (626, 66), (704, 150), (84, 112, 146), -1)
        cv2.circle(wall, (700, 165), 3, (40, 40, 40), -1)
        cv2.rectangle(wall, (320, 90), (380, 140), (40, 44, 48), -1)                      # a framed picture
        cv2.rectangle(wall, (326, 96), (374, 134), (150, 170, 120), -1)
        cv2.rectangle(wall, (340, 104), (360, 126), (60, 60, 160), -1)
        self._wall_tex = wall

        # floor: x in [-5, 5], z in [-8, 0], 50 px per metre, 0.4 m tiles
        self._floor_ppm = 50.0
        floor = np.empty((400, 500, 3), np.uint8)
        yy, xx = np.mgrid[0:400, 0:500]
        tiles = ((xx // 20) + (yy // 20)) % 2
        floor[:] = (118, 140, 160)
        floor[tiles == 1] = (104, 126, 148)
        floor[(xx % 20 == 0) | (yy % 20 == 0)] = (80, 96, 112)
        self._floor_tex = floor

        # background: what is seen past the ends of the wall and above it
        rows = np.linspace(150.0, 110.0, c.height, dtype=np.float32)[:, None, None]
        self._background = np.broadcast_to(rows, (c.height, c.width, 3)).astype(np.uint8).copy()

        # station sign as a small resolution pyramid so a far-away marker is not aliased
        self._sign_levels: List[Tuple[float, np.ndarray]] = []
        ppm = 2000.0
        while ppm > 100.0:
            sheet, _rect = station_sign(c.marker_id, c.marker_size_m, ppm)
            self._sign_levels.append((ppm, cv2.cvtColor(sheet, cv2.COLOR_GRAY2BGR)))
            ppm /= math.sqrt(2.0)
        self._sign_left_x = -A4_WIDTH_M / 2.0
        self._sign_top_y = c.marker_height_m + c.marker_size_m / 2.0 + SIGN_TOP_MARGIN_M

        self._col_offsets = np.arange(c.width, dtype=np.float64) - c.width / 2.0
        self._noise_pool = [
            self._rng.normal(0.0, c.sensor_noise, (c.height, c.width, 3)).astype(np.int16)
            for _ in range(6)
        ] if c.sensor_noise > 0 else []

    def _render_bgr(self, snap: dict) -> np.ndarray:
        if self.cfg.scene == "room":
            return self._room.render(snap, self._rng)
        return self._render_plain(snap)

    def _render_plain(self, snap: dict) -> np.ndarray:
        c = self.cfg
        heading = snap["heading"]
        sin_h, cos_h = math.sin(heading), math.cos(heading)
        cam = np.array([snap["x"], snap["cam_y"], snap["z"]])
        rot = np.array([[cos_h, 0.0, -sin_h],     # camera right
                        [0.0, -1.0, 0.0],         # image down
                        [sin_h, 0.0, cos_h]])     # camera forward
        kr = self._K @ rot
        size = (c.width, c.height)
        horizon = c.height // 2

        canvas = self._background.copy()

        # floor (only below the horizon: the camera is level)
        s = 1.0 / self._floor_ppm
        h_floor = kr @ np.column_stack([[s, 0.0, 0.0], [0.0, 0.0, -s], np.array([-5.0, 0.0, 0.0]) - cam])
        layer = canvas.copy()
        cv2.warpPerspective(self._floor_tex, h_floor, size, dst=layer, flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_TRANSPARENT)
        canvas[horizon + 1:] = layer[horizon + 1:]

        # wall and sign (only on rays that actually travel toward the wall)
        toward_wall = (-self._col_offsets * sin_h + self._focal * cos_h) > 1e-3 * self._focal
        if toward_wall.any():
            s = 1.0 / self._wall_ppm
            h_wall = kr @ np.column_stack([[s, 0.0, 0.0], [0.0, -s, 0.0], np.array([-5.0, 2.6, 0.0]) - cam])
            layer = canvas.copy()
            cv2.warpPerspective(self._wall_tex, h_wall, size, dst=layer, flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_TRANSPARENT)
            if not snap["marker_hidden"]:
                centre = np.array([0.0, c.marker_height_m, 0.0]) - cam
                depth = float(rot[2] @ centre)
                if depth > 0.05:
                    wanted = self._focal / depth * 1.25
                    ppm, sheet = self._sign_levels[0]
                    for level_ppm, level in self._sign_levels:
                        if level_ppm >= wanted:
                            ppm, sheet = level_ppm, level
                    s = 1.0 / ppm
                    origin = np.array([self._sign_left_x, self._sign_top_y, 0.0]) - cam
                    h_sign = kr @ np.column_stack([[s, 0.0, 0.0], [0.0, -s, 0.0], origin])
                    cv2.warpPerspective(sheet, h_sign, size, dst=layer, flags=cv2.INTER_LINEAR,
                                        borderMode=cv2.BORDER_TRANSPARENT)
            # The rays that reach the wall are one unbroken run of columns (the test is linear in the
            # column), so a plain slice does the job of a boolean column mask at a fraction of the cost.
            columns = np.flatnonzero(toward_wall)
            canvas[:, columns[0]:columns[-1] + 1] = layer[:, columns[0]:columns[-1] + 1]

        if c.blur_sigma > 0:
            canvas = cv2.GaussianBlur(canvas, (0, 0), c.blur_sigma)
        work = canvas.astype(np.int16)
        if c.light != 1.0:
            work = (work.astype(np.float32) * c.light).astype(np.int16)
        if self._noise_pool:
            noise = self._noise_pool[int(self._rng.integers(len(self._noise_pool)))]
            shift = (int(self._rng.integers(c.height)), int(self._rng.integers(c.width)))
            work = work + np.roll(noise, shift, axis=(0, 1))
        return np.clip(work, 0, 255).astype(np.uint8)

    def _render_jpeg(self, snap: dict) -> bytes:
        ok, encoded = cv2.imencode(".jpg", self._render_bgr(snap),
                                   [cv2.IMWRITE_JPEG_QUALITY, int(self.cfg.jpeg_quality)])
        if not ok:
            raise RuntimeError("JPEG encoding failed")
        return encoded.tobytes()

    def render_test_frame(self, distance_m: float, x_m: float = 0.0, heading_deg: float = 0.0) -> bytes:
        """Render one camera JPEG from an arbitrary hovering pose (for detection tests)."""
        return self._render_jpeg({
            "x": float(x_m),
            "z": -abs(float(distance_m)),
            "heading": math.radians(float(heading_deg)),
            "cam_y": self.cfg.hover_height_m + 0.04,
            "marker_hidden": False,
        })
