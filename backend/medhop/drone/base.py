"""DroneLink interface (SPEC section 3).

All stick values are true stick fractions in [-1, 1].
Signs: +throttle up, +yaw turn right, +pitch forward, +roll right.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable


@dataclass(frozen=True)
class Frame:
    jpeg: bytes
    timestamp: float  # time.monotonic() domain of the link's clock
    seq: int


@dataclass(frozen=True)
class Telemetry:
    """Raw status bytes. Units and meanings are NOT verified."""

    fly_state_raw: int
    battery_raw: int
    flags_raw: int
    timestamp: float


@runtime_checkable
class DroneLink(Protocol):
    mode: str  # "sim" or "real"

    def start(self) -> None: ...

    def stop(self) -> None:
        """Must send neutral axes first. Never sends the toggle."""

    def set_axes(self, throttle: float, yaw: float, pitch: float, roll: float) -> None:
        """Only ControlMixer may call this."""

    def takeoff_land_toggle(self) -> bool:
        """ONE shared toggle: takes off on the ground, lands in the air.

        Returns True when the command went onto an open socket, False when the link was down."""

    def emergency_stop(self) -> bool:
        """Motor cut. The drone falls.

        Returns True when the command went onto an open socket, False when the link was down."""

    def control_up(self) -> bool:
        """True while commands can reach the drone (the control socket is open)."""

    def drone_seen(self) -> bool:
        """True once anything (a video frame or an MCU message) has been received from the drone."""

    def calibrate(self) -> None:
        """Gyro calibrate, flat ground only."""

    def latest_frame(self) -> Optional[Frame]: ...

    def telemetry(self) -> Optional[Telemetry]: ...


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    """Clamp to [low, high]. A value that is not a finite number counts as 0.0 (never a full stick)."""
    value = float(value)
    if not math.isfinite(value):
        value = 0.0
    return max(low, min(high, value))
