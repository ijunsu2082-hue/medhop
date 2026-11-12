"""TurbodroneLink: glue to the third-party turbodrone backend for the real drone (SPEC section 3).

turbodrone (Apache-2.0, https://github.com/marshallrichards/turbodrone) is NOT part of this repo. It is
imported from the checkout named by MEDHOP_TURBODRONE_BACKEND (its `backend/` directory, inserted at
sys.path[0], because turbodrone uses top-level imports such as `models`, `services`, `protocols`).
Its `web_server` is never imported and nothing in the checkout is modified.

Everything reported about the drone here is raw: the units and meanings of the status bytes are NOT
verified.
"""
from __future__ import annotations

import logging
import os
import queue
import sys
import threading
import time
from typing import Callable, Optional

from medhop.drone.base import Frame, Telemetry, clamp

logger = logging.getLogger("medhop.drone.turbodrone")

CONTROL_PORT = 8800
VARIANT = "fld"
SHARED_SOCKET_TIMEOUT_S = 10.0
SPEED_INDEX_FULL = 2           # the app's speed tier with scale 1.0
DRONE_SEEN_TIMEOUT_S = 10.0    # warn when nothing has come back from the drone after this long
COMMAND_LOG_REPEAT_S = 1.0     # a repeated command result is logged again only after this pause
CONTROL_SOURCE = "frontend"    # the only source the library never suppresses


class TurbodroneLink:
    mode = "real"

    def __init__(
        self,
        backend_path: Optional[str],
        drone_ip: str,
        control_rate: float = 20.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not backend_path:
            raise RuntimeError("MEDHOP_DRONE=real needs MEDHOP_TURBODRONE_BACKEND (path to turbodrone's backend/)")
        self._backend_path = os.path.abspath(os.path.expanduser(backend_path))
        if not os.path.isfile(os.path.join(self._backend_path, "services", "flight_controller.py")):
            raise RuntimeError(f"{self._backend_path} does not look like turbodrone's backend/ directory")
        self._drone_ip = drone_ip
        self._control_rate = float(control_rate)
        self._clock = clock
        self._lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._consumer: Optional[threading.Thread] = None
        self._started = False

        self._model = None
        self._rc = None
        self._receiver = None
        self._fc = None
        self._direct_strategy_cls = None

        self._frame: Optional[Frame] = None
        self._seq = 0
        self._telemetry: Optional[Telemetry] = None
        self._drone_seen = False
        self._seen_timer: Optional[threading.Timer] = None
        self._estop_logged: Optional[bool] = None   # last logged motor-cut result
        self._estop_called_at = 0.0

    # ------------------------------------------------------------------ #
    # life cycle
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._started:
            return
        if self._backend_path not in sys.path[:1]:
            sys.path.insert(0, self._backend_path)
        # Imported here, after the path insert. Never import turbodrone's web_server.
        from control.strategies import DirectStrategy
        from models.wifi_uav_rc import WifiUavRcModel
        from protocols.wifi_uav_rc_protocol_adapter import WifiUavRcProtocolAdapter
        from protocols.wifi_uav_video_protocol import WifiUavVideoProtocolAdapter
        from services.flight_controller import FlightController
        from services.video_receiver import VideoReceiverService
        from utils.dropping_queue import DroppingQueue

        link = self
        self._drone_seen = False

        class TelemetryVideoAdapter(WifiUavVideoProtocolAdapter):
            def _on_mcu_message(self, message: bytes) -> None:
                super()._on_mcu_message(message)
                link._on_status_message(message)

        self._direct_strategy_cls = DirectStrategy
        self._model = WifiUavRcModel()
        self._assert_direct_control(initial=True)
        self._rc = WifiUavRcProtocolAdapter(self._drone_ip, CONTROL_PORT, variant=VARIANT)
        self._receiver = VideoReceiverService(
            protocol_adapter_class=TelemetryVideoAdapter,
            protocol_adapter_args={
                "drone_ip": self._drone_ip,
                "control_port": CONTROL_PORT,
                "video_port": CONTROL_PORT,
                "variant": VARIANT,
                "debug": False,
            },
            frame_queue=DroppingQueue(maxsize=1),
            rc_adapter=self._rc,
        )
        logger.info("connecting to the drone at %s:%d", self._drone_ip, CONTROL_PORT)
        self._receiver.start()

        # The flight controller must send from the video adapter's socket, so wait until the library
        # has handed that socket to the RC adapter. This happens as soon as the adapter object exists,
        # before any packet is received: it says nothing about whether a drone is there (see
        # _check_drone_seen for that).
        deadline = time.monotonic() + SHARED_SOCKET_TIMEOUT_S
        while not getattr(self._rc, "_is_shared_sock", False):
            if time.monotonic() >= deadline:
                self._receiver.stop()
                raise RuntimeError("turbodrone did not hand its UDP socket to the RC adapter within 10 s")
            time.sleep(0.02)

        self._fc = FlightController(self._model, self._rc, self._control_rate)
        self._fc.set_axes_from(CONTROL_SOURCE, 0.0, 0.0, 0.0, 0.0)
        self._fc.start()

        self._stop_evt.clear()
        self._consumer = threading.Thread(target=self._consume_frames, name="medhop-frames", daemon=True)
        self._consumer.start()
        self._started = True
        # Do not block the server start on the drone answering; check once, later.
        self._seen_timer = threading.Timer(DRONE_SEEN_TIMEOUT_S, self._check_drone_seen)
        self._seen_timer.daemon = True
        self._seen_timer.start()
        logger.info("real drone link started (control rate %.0f Hz); waiting for the drone at %s to reply",
                    self._control_rate, self._drone_ip)

    def _check_drone_seen(self) -> None:
        if self._started and not self._stop_evt.is_set() and not self.drone_seen():
            logger.warning(
                "no video frame or status message from the drone at %s within %.0f s: check the laptop "
                "is on the drone's Wi-Fi (FLOW_...) and the drone is switched on",
                self._drone_ip, DRONE_SEEN_TIMEOUT_S,
            )

    def stop(self) -> None:
        """Neutral axes, wait two control periods, then stop. Never sends the toggle."""
        fc, receiver = self._fc, self._receiver
        if self._seen_timer is not None:
            self._seen_timer.cancel()
            self._seen_timer = None
        if fc is not None:
            try:
                fc.set_axes_from(CONTROL_SOURCE, 0.0, 0.0, 0.0, 0.0)
                time.sleep(2.0 / self._control_rate)
            except Exception:
                logger.exception("could not send neutral axes on stop")
        self._stop_evt.set()
        if fc is not None:
            try:
                fc.stop()
            except Exception:
                logger.exception("flight controller did not stop cleanly")
        if receiver is not None:
            try:
                receiver.stop()
            except Exception:
                logger.exception("video receiver did not stop cleanly")
        if self._consumer and self._consumer.is_alive():
            self._consumer.join(timeout=1.0)
        self._consumer = None
        self._fc = None
        self._receiver = None
        self._started = False
        logger.info("real drone link stopped")

    # ------------------------------------------------------------------ #
    # control
    # ------------------------------------------------------------------ #
    def _assert_direct_control(self, initial: bool = False) -> None:
        """Stick fractions must map straight to stick bytes: direct strategy, no expo, full speed tier.

        The library's model starts with an incremental strategy and expo 0.5, so this sets them once at
        start and then re-asserts them on every control tick in case anything changed them.
        """
        model = self._model
        if model is None or self._direct_strategy_cls is None:
            return
        log = logger.debug if initial else logger.warning
        if type(getattr(model, "strategy", None)) is not self._direct_strategy_cls:
            model.set_strategy(self._direct_strategy_cls())
            log("control strategy set to DirectStrategy")
        if getattr(model, "expo_factor", 0.0) != 0.0:
            model.expo_factor = 0.0
            log("expo set to 0.0")
        if getattr(model, "speed_index", SPEED_INDEX_FULL) != SPEED_INDEX_FULL:
            model.set_speed_index(SPEED_INDEX_FULL)
            log("speed tier set to index %d", SPEED_INDEX_FULL)

    def set_axes(self, throttle: float, yaw: float, pitch: float, roll: float) -> None:
        fc = self._fc
        if fc is None:
            return
        self._assert_direct_control()
        fc.set_axes_from(CONTROL_SOURCE, clamp(throttle), clamp(yaw), clamp(pitch), clamp(roll))
        # No re-assert of the motor cut here: the mixer calls emergency_stop() on every tick while its
        # e-stop is latched, which also covers a press the library's control thread clears in the
        # same instant.

    def control_up(self) -> bool:
        """False while the library's shared UDP socket is closed (it closes it after 4 s without video
        and reopens it about 5 s later) or the receiver has no protocol: sends are swallowed then."""
        rc, receiver = self._rc, self._receiver
        if rc is None or receiver is None or getattr(receiver, "protocol", None) is None:
            return False
        sock = getattr(rc, "sock", None)
        if sock is None:
            return False
        try:
            return sock.fileno() != -1
        except (OSError, ValueError):
            return False

    def drone_seen(self) -> bool:
        """True once a video frame or an MCU message has arrived from the drone."""
        with self._lock:
            return self._drone_seen

    def takeoff_land_toggle(self) -> bool:
        if self._model is None:
            return False
        if not self.control_up():
            # Not even queued: the library would hold the bit for 0.15 s and it might or might not go
            # out when the socket comes back. A one-bit toggle must never be ambiguous.
            logger.warning("takeoff/land toggle NOT sent: drone link down (reconnecting)")
            return False
        # The library has ONE shared bit (0x01) for takeoff and land. Sent once, never repeated:
        # a second toggle would undo the first.
        self._model.takeoff()
        logger.info("takeoff/land toggle queued on the open control socket")
        return True

    def emergency_stop(self) -> bool:
        """Motor cut. The mixer calls this on every tick while its e-stop is latched; it is idempotent.
        Returns False while the control socket is down (the cut is still requested from the library,
        in case the socket reopens within its 0.15 s hold)."""
        if self._model is None:
            return False
        now = time.monotonic()
        self._model.emergency_stop()
        up = self.control_up()
        if up != self._estop_logged or now - self._estop_called_at > COMMAND_LOG_REPEAT_S:
            if up:
                logger.warning("motor-cut command sent to the drone")
            else:
                logger.warning("motor-cut command NOT sent: drone link down (reconnecting); re-sending each tick")
            self._estop_logged = up
        self._estop_called_at = now
        return up

    def calibrate(self) -> None:
        if self._model is None:
            return
        self._model.calibrate_gyro()
        logger.info("gyro calibration sent")

    # ------------------------------------------------------------------ #
    # video and telemetry
    # ------------------------------------------------------------------ #
    def _consume_frames(self) -> None:
        frames = self._receiver.get_frame_queue()
        while not self._stop_evt.is_set():
            try:
                item = frames.get(timeout=0.2)
            except queue.Empty:
                continue
            data = getattr(item, "data", item)
            if not data:
                continue
            with self._lock:
                self._drone_seen = True
                self._seq += 1
                self._frame = Frame(jpeg=bytes(data), timestamp=self._clock(), seq=self._seq)

    def _on_status_message(self, message: bytes) -> None:
        """Called on the library's receive thread for every MCU message. Keeps raw bytes only."""
        with self._lock:
            self._drone_seen = True
        if len(message) >= 5 and message[:2] == b"\x88\x00" and message[-1] == 0x55:
            telemetry = Telemetry(
                fly_state_raw=message[2],
                battery_raw=message[3],
                flags_raw=message[4],
                timestamp=self._clock(),
            )
            with self._lock:
                self._telemetry = telemetry

    def latest_frame(self) -> Optional[Frame]:
        with self._lock:
            return self._frame

    def telemetry(self) -> Optional[Telemetry]:
        with self._lock:
            return self._telemetry
