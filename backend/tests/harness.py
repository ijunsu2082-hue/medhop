"""Test helpers: a fake clock, a recording fake link, and a closed-loop simulator harness.

The harness runs SimLink, the vision step, the mission runner and the mixer in simulated time on
one thread: no sleeping, fully repeatable for a given seed.
"""
from __future__ import annotations

import random
import shutil
import tempfile
from pathlib import Path
from typing import Callable, List, Optional, Tuple

import cv2
import numpy as np

from medhop.care.store import CareStore
from medhop.config import Settings
from medhop.drone.base import Frame, Telemetry
from medhop.drone.sim import SimConfig, SimLink
from medhop.mission.runner import MissionRunner, RunnerConfig
from medhop.mission.steering import DriftAssistConfig, SteeringConfig
from medhop.mixer import ControlMixer
from medhop.vision.marker import MarkerDetector, Observation
from medhop.vision.person import PersonStatus

WALL_EPOCH = 1_794_000_000.0   # an arbitrary wall-clock origin for simulated runs


class FakeClock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = float(t)

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> float:
        self.t += dt
        return self.t


class RecordingLink:
    """A DroneLink that records every call. Tests set `frame` and `tel` directly, and `control`
    (control_up), `seen` (drone_seen) and `mode` ("real" to test real-drone rules)."""

    mode = "sim"

    def __init__(self, clock: Optional[Callable[[], float]] = None) -> None:
        self._clock = clock
        self.axes: List[Tuple[float, float, float, float]] = []
        self.toggles = 0
        self.estops = 0
        self.calibrations = 0
        self.frame: Optional[Frame] = None
        self.tel: Optional[Telemetry] = None
        self.started = False
        self.stopped = False
        self._seq = 0
        self.control = True                    # what control_up() reports
        self.seen = True                       # what drone_seen() reports
        self.estop_results: List[bool] = []    # what each emergency_stop() call returned

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.set_axes(0.0, 0.0, 0.0, 0.0)
        self.stopped = True

    def set_axes(self, throttle: float, yaw: float, pitch: float, roll: float) -> None:
        self.axes.append((throttle, yaw, pitch, roll))

    def takeoff_land_toggle(self) -> bool:
        self.toggles += 1
        return self.control

    def emergency_stop(self) -> bool:
        self.estops += 1
        self.estop_results.append(self.control)
        return self.control

    def control_up(self) -> bool:
        return self.control

    def drone_seen(self) -> bool:
        return self.seen

    def calibrate(self) -> None:
        self.calibrations += 1

    def latest_frame(self) -> Optional[Frame]:
        return self.frame

    def telemetry(self) -> Optional[Telemetry]:
        return self.tel

    def new_frame(self, now: float, jpeg: bytes = b"") -> Frame:
        self._seq += 1
        self.frame = Frame(jpeg=jpeg, timestamp=now, seq=self._seq)
        return self.frame

    @property
    def last(self) -> Tuple[float, float, float, float]:
        return self.axes[-1]


def make_temp_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="medhop-test-"))


class SimHarness:
    PHYSICS_DT = 1.0 / 60.0
    CONTROL_DT = 1.0 / 20.0

    def __init__(
        self,
        sim_config: Optional[SimConfig] = None,
        settings: Optional[Settings] = None,
        steering_config: Optional[SteeringConfig] = None,
        runner_config: Optional[RunnerConfig] = None,
        drift_assist_config: Optional[DriftAssistConfig] = None,
        marker_dropout: float = 0.0,
        dropout_seed: int = 0,
    ) -> None:
        """`marker_dropout`: the probability that a frame's detection is thrown away (the detector
        missing the marker), drawn from a random generator seeded with `dropout_seed`."""
        self.clock = FakeClock()
        self.marker_dropout = float(marker_dropout)
        self._dropout_rng = random.Random(dropout_seed)
        self.data_dir = make_temp_dir()
        self.settings = settings or Settings(data_dir=self.data_dir, person_check="off")
        self.sim = SimLink(sim_config or SimConfig(seed=0), clock=self.clock, realtime=False)
        self.store = CareStore(self.data_dir, wall_clock=self.wall)
        self.person = PersonStatus()
        self.mixer = ControlMixer(self.sim, rate_hz=20.0, clock=self.clock)
        self.runner = MissionRunner(
            self.sim, self.mixer, self.store, self.settings,
            clock=self.clock, wall_clock=self.wall,
            person_status=lambda: self.person,
            steering_config=steering_config, config=runner_config,
            drift_assist_config=drift_assist_config,
        )
        self.mixer.on_pilot_input = (
            lambda kind: self.runner.abort("estop" if kind == "estop" else "pilot_took_over")
        )
        self.detector = MarkerDetector(self.settings.marker_id)
        self.sent: List[Tuple[float, Tuple[float, float, float, float]]] = []
        self.observations: List[Observation] = []
        self._last_seq = 0
        self._next_tick = self.clock.t
        self._last_runner_step = self.clock.t

    def wall(self) -> float:
        return WALL_EPOCH + self.clock.t

    def close(self) -> None:
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def step(self) -> None:
        now = self.clock.advance(self.PHYSICS_DT)
        self.sim.advance_to(now)
        frame = self.sim.latest_frame()
        if frame is not None and frame.seq != self._last_seq:
            self._last_seq = frame.seq
            image = cv2.imdecode(np.frombuffer(frame.jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
            marker = self.detector.detect(image, ts=frame.timestamp)
            if self.marker_dropout > 0 and self._dropout_rng.random() < self.marker_dropout:
                marker = None
            obs = Observation(ts=frame.timestamp, seq=frame.seq, marker=marker,
                              brightness=float(image.mean()))
            self.observations.append(obs)
            self.runner.step(obs, now)
            self._last_runner_step = now
        elif now - self._last_runner_step >= 0.05:
            self.runner.step(None, now)
            self._last_runner_step = now
        if now + 1e-9 >= self._next_tick:
            self.sent.append((now, self.mixer.tick(now)))
            self._next_tick += self.CONTROL_DT

    def run(self, seconds: float, until: Optional[Callable[["SimHarness"], bool]] = None) -> bool:
        """Advance simulated time. Returns True when `until` became true."""
        end = self.clock.t + seconds
        while self.clock.t < end:
            self.step()
            if until is not None and until(self):
                return True
        return False

    def run_until_state(self, states, seconds: float = 60.0) -> bool:
        states = (states,) if isinstance(states, str) else tuple(states)
        return self.run(seconds, until=lambda h: h.runner.state in states)

    def warm_up(self, seconds: float = 1.0) -> None:
        """Let the first frames arrive before a run is started."""
        self.run(seconds)

    def last_sent(self) -> Tuple[float, float, float, float]:
        return self.sent[-1][1]
