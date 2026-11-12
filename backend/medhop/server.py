"""FastAPI app: REST, WebSockets and the annotated MJPEG stream (SPEC section 7).

Threads: one control thread (ControlMixer), one vision thread (VisionWorker, which also steps the
mission runner), an optional person-check thread, a 1 Hz housekeeping thread for the care events, and
whatever the drone link runs. Handlers only read snapshots and set requests. REST handlers are plain
functions (FastAPI runs them in its thread pool); the async handlers never do file or network I/O.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Callable, Dict, Optional

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from medhop.care.status import CareMonitor, care_snapshot
from medhop.care.store import CareStore, time_local
from medhop.config import FRONTEND_ORIGINS, Settings
from medhop.drone.base import DroneLink
from medhop.mission.runner import MissionRunner
from medhop.mixer import ControlMixer
from medhop.vision.marker import MarkerDetector
from medhop.vision.person import PersonChecker
from medhop.vision.worker import VisionWorker

logger = logging.getLogger("medhop.server")

STATUS_PUSH_S = 0.2            # /ws/status pushes 5 times a second
PILOT_BUSY_CLOSE_CODE = 4001
PERSON_FRESH_S = 2.0
BAD_REQUEST = "bad_request"    # error code for a malformed control message
MJPEG_BOUNDARY = "frame"


def build_link(settings: Settings) -> DroneLink:
    if settings.drone == "real":
        from medhop.drone.turbodrone import TurbodroneLink

        return TurbodroneLink(
            backend_path=settings.turbodrone_backend,
            drone_ip=settings.drone_ip,
            control_rate=settings.control_rate,
        )
    from medhop.drone.sim import SimConfig, SimLink

    return SimLink(SimConfig(marker_id=settings.marker_id, marker_size_m=settings.marker_size_m,
                             reset_pose_on_takeoff=True))


def _round(value: Optional[float], digits: int = 3) -> Optional[float]:
    return None if value is None else round(float(value), digits)


class MedHopCore:
    """Owns every long-lived object and builds the status snapshot."""

    def __init__(
        self,
        settings: Optional[Settings] = None,
        link: Optional[DroneLink] = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings or Settings.from_env()
        self._clock = clock
        self._wall_clock = wall_clock
        self.store = CareStore(self.settings.data_dir, wall_clock=wall_clock)
        self.link = link if link is not None else build_link(self.settings)
        self.mixer = ControlMixer(
            self.link,
            rate_hz=self.settings.control_rate,
            clock=clock,
            trim=self.store.load_trim(),
            on_pilot_input=self._on_pilot_input,
        )
        self.person = PersonChecker(self.settings.person_check, self.settings.yolo_weights, clock=clock)
        self.runner = MissionRunner(
            self.link, self.mixer, self.store, self.settings,
            clock=clock, wall_clock=wall_clock, person_status=self.person.status,
            pilot_connected=self.pilot_connected,
        )
        self.vision = VisionWorker(
            self.link, MarkerDetector(self.settings.marker_id), self.person,
            on_observation=self.runner.step, banner=self._banner, clock=clock,
        )
        self.care_monitor = CareMonitor(self.store, self.settings.grace_min)
        self.stopping = threading.Event()
        self._housekeeping: Optional[threading.Thread] = None
        self._pilot_lock = threading.Lock()
        self._pilot_connected = False
        self._started = False

    # ------------------------------------------------------------------ #
    # life cycle
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._started:
            return
        self.stopping.clear()
        try:
            self.link.start()
            self.mixer.start()
            self.vision.start()
            self._housekeeping = threading.Thread(target=self._housekeeping_loop, name="medhop-care", daemon=True)
            self._housekeeping.start()
            self._started = True
        except Exception:
            logger.exception("startup failed; shutting the link down")
            self.stop()
            raise
        logger.info("MedHop backend started in %s mode", self.link.mode)

    @property
    def started(self) -> bool:
        return self._started

    def stop(self) -> None:
        """Clean shutdown: stop steering, send neutral, never the toggle."""
        self.stopping.set()
        self.vision.stop()
        try:
            self.runner.abort("pilot_took_over")
            self.runner.flush()
        except Exception:
            logger.exception("could not stop the mission runner cleanly")
        self.mixer.stop()
        try:
            self.link.stop()
        except Exception:
            logger.exception("could not stop the drone link cleanly")
        if self._housekeeping and self._housekeeping.is_alive():
            self._housekeeping.join(timeout=2.0)
        self._housekeeping = None
        self._started = False
        logger.info("MedHop backend stopped")

    def _housekeeping_loop(self) -> None:
        while not self.stopping.wait(1.0):
            try:
                self.care_monitor.tick(self.now_local())
            except Exception:
                logger.exception("care monitor failed")

    def now_local(self) -> datetime:
        return datetime.fromtimestamp(self._wall_clock())

    # ------------------------------------------------------------------ #
    # pilot
    # ------------------------------------------------------------------ #
    def _on_pilot_input(self, kind: str) -> None:
        self.runner.abort("estop" if kind == "estop" else "pilot_took_over")

    def claim_pilot(self) -> bool:
        with self._pilot_lock:
            if self._pilot_connected:
                return False
            self._pilot_connected = True
            return True

    def pilot_connected(self) -> bool:
        with self._pilot_lock:
            return self._pilot_connected

    def release_pilot(self) -> None:
        """The pilot's control socket is gone (tab closed, browser crash, network drop): zero the
        pilot axes and stop anything that is flying itself, because nobody can press stop any more.
        Neutral sticks, never the toggle."""
        self.mixer.pilot_disconnect()
        with self._pilot_lock:
            self._pilot_connected = False
        if self.runner.abort("pilot_link_lost"):
            logger.warning("pilot control link lost while the drone was flying itself: stopped")

    def handle_control(self, message: Any) -> Optional[Dict[str, Any]]:
        """One /ws/control message. In-memory only; returns the reply to send, if any.
        Every ack and error carries `of` (the command type); errors carry `code` and `message`."""
        if not isinstance(message, dict):
            return _control_error(None, BAD_REQUEST, "expected a JSON object")
        kind = message.get("type")
        of = kind if isinstance(kind, str) else None
        try:
            if kind == "axes":
                values = []
                for name in ("throttle", "yaw", "pitch", "roll"):
                    value = message.get(name, 0)
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        return _control_error(of, BAD_REQUEST, f"axes.{name} must be a number in [-1, 1]")
                    values.append(float(value))
                self.mixer.pilot_axes(*values)
                return None
            if kind == "takeoff_land":
                result = self.mixer.pilot_toggle()
                return {"type": "ack", "of": kind} if result.ok else _control_error(of, result.code, result.message)
            if kind == "estop":
                return {"type": "ack", "of": "estop", "delivered": self.mixer.pilot_estop() is True}
            if kind == "estop_reset":
                self.mixer.estop_reset()
                return {"type": "ack", "of": kind}
            if kind == "calibrate":
                ok, why = self.mixer.calibrate()
                return {"type": "ack", "of": kind} if ok else _control_error(of, "estop_active", why)
            if kind == "max_stick":
                value = message.get("value")
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    return _control_error(of, BAD_REQUEST, "max_stick.value must be a number from 0.2 to 1.0")
                self.mixer.set_max_stick(value)
                return {"type": "ack", "of": kind}
        except ValueError as exc:
            return _control_error(of, BAD_REQUEST, str(exc))
        return _control_error(of, BAD_REQUEST, f"unknown message type {kind!r}")

    # ------------------------------------------------------------------ #
    # status
    # ------------------------------------------------------------------ #
    def _banner(self) -> str:
        mission = self.runner.state
        reason = self.runner.reason
        text = f"{self.link.mode.upper()} | {mission}"
        if reason:
            text += f" ({reason})"
        if self.mixer.estop_active:
            text += " | E-STOP"
        return text

    def status(self) -> Dict[str, Any]:
        now = self._clock()
        vision = self.vision.snapshot(now)
        mixer = self.mixer.snapshot(now)
        telemetry = self.link.telemetry()
        person = self.vision.person_status()

        telemetry_out = None
        if telemetry is not None:
            age = max(0.0, now - telemetry.timestamp)
            check_enabled = bool(self.settings.battery_check_enabled)
            telemetry_out = {
                "simulated": self.link.mode == "sim",
                "age_s": _round(age, 2),
                "fly_state_raw": int(telemetry.fly_state_raw),
                "battery_raw": int(telemetry.battery_raw),
                "flags_raw": int(telemetry.flags_raw),
                # Only a fresh reading counts, and only when the check is on (the byte is unverified).
                "battery_low": bool(check_enabled and age < self.settings.telemetry_fresh_s
                                    and telemetry.battery_raw <= self.settings.battery_low_raw),
                "battery_check_enabled": check_enabled,
            }

        marker_out = None
        if vision.marker is not None:
            marker_out = {
                "id": vision.marker.id,
                "cx": _round(vision.marker.cx, 4),
                "cy": _round(vision.marker.cy, 4),
                "width": _round(vision.marker.width, 4),
                "age_s": _round(vision.marker_age_s, 2),
            }

        person_age = None if person.ts is None else max(0.0, now - person.ts)
        person_fresh = person_age is not None and person_age <= PERSON_FRESH_S
        return {
            "server_time": self._wall_clock(),
            "mode": self.link.mode,
            "link": {
                "video_live": vision.video_live,
                "frame_age_s": _round(vision.frame_age_s, 2),
                "fps": _round(vision.fps, 1),
                "control_up": bool(self.link.control_up()),
                "drone_seen": bool(self.link.drone_seen()),
                "sticks_blocked": mixer.sticks_blocked,
            },
            "telemetry": telemetry_out,
            "trim": {"roll": _round(mixer.trim_roll, 4), "pitch": _round(mixer.trim_pitch, 4)},
            "pilot": {
                "manual_active": mixer.manual_active,
                "max_stick": _round(mixer.max_stick, 3),
                "estop_active": mixer.estop_active,
                "estop_delivered": mixer.estop_confirmed,   # the motor cut, SPEC 10.4
            },
            "vision": {
                "marker": marker_out,
                "person": {
                    "enabled": bool(person.enabled),
                    "detected": bool(person.enabled and person.detected and person_fresh),
                    "count": int(person.count) if (person.enabled and person_fresh) else 0,
                    "age_s": _round(person_age, 2) if person.enabled else None,
                },
                "brightness": _round(vision.brightness, 1),
                "dark": vision.dark,
            },
            "mission": self.runner.snapshot(now),
            "hover_test": self.runner.hover_snapshot(now),
            "care": care_snapshot(self.store, self.now_local(), self.settings.grace_min),
        }


# ---------------------------------------------------------------------- #
# request bodies
# ---------------------------------------------------------------------- #
class TrimBody(BaseModel):
    roll: Optional[float] = None
    pitch: Optional[float] = None


class MissionStartBody(BaseModel):
    confirm_airborne: bool = False
    dose_id: Optional[str] = None


class MissionSettingsBody(BaseModel):
    land_on_arrival: Optional[bool] = None
    drift_assist: Optional[bool] = None


class DoseBody(BaseModel):
    time: str
    label: str
    notes: str = ""


class DosePatchBody(BaseModel):
    time: Optional[str] = None
    label: Optional[str] = None
    notes: Optional[str] = None


def _control_error(of: Optional[str], code: Optional[str], message: str) -> Dict[str, Any]:
    return {"type": "error", "of": of, "code": code, "message": message}


def _error(status_code: int, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail})


def create_app(settings: Optional[Settings] = None, core: Optional[MedHopCore] = None) -> FastAPI:
    core = core or MedHopCore(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await asyncio.to_thread(core.start)
        try:
            yield
        finally:
            await asyncio.to_thread(core.stop)

    app = FastAPI(title="MedHop", version="0.1.0", lifespan=lifespan)
    app.state.core = core
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(FRONTEND_ORIGINS),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------ status ------------------------------ #
    @app.get("/api/health")
    def health() -> Dict[str, Any]:
        return {"ok": True, "mode": core.link.mode}

    @app.get("/api/status")
    def status() -> Dict[str, Any]:
        return core.status()

    @app.websocket("/ws/status")
    async def ws_status(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while not core.stopping.is_set():
                await ws.send_json(await asyncio.to_thread(core.status))
                await asyncio.sleep(STATUS_PUSH_S)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            logger.debug("status socket closed", exc_info=True)

    # ------------------------------ control ----------------------------- #
    @app.websocket("/ws/control")
    async def ws_control(ws: WebSocket) -> None:
        # Accepted first so the refusal carries close code 4001 (a close before accept reaches the
        # browser as a failed handshake without the code). A refused client never gets "hello", and
        # the client treats the link as open only after "hello".
        await ws.accept()
        if not core.claim_pilot():
            await ws.close(code=PILOT_BUSY_CLOSE_CODE, reason="another pilot is connected")
            return
        logger.info("pilot connected")
        try:
            await ws.send_json({"type": "hello", "pilot": True})
            while True:
                text = await ws.receive_text()
                try:
                    message = json.loads(text)
                except ValueError:
                    await ws.send_json(_control_error(None, BAD_REQUEST, "invalid JSON"))
                    continue
                reply = core.handle_control(message)
                if reply is not None:
                    await ws.send_json(reply)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            core.release_pilot()   # zeroes the pilot axes at once
            logger.info("pilot disconnected; pilot axes zeroed")

    # ------------------------------ video ------------------------------- #
    @app.get("/video.mjpg")
    async def video() -> StreamingResponse:
        async def frames():
            last_seq: Optional[int] = None
            last_sent = 0.0
            while not core.stopping.is_set():
                seq, jpeg = core.vision.annotated_jpeg()
                now = time.monotonic()
                if seq != last_seq or now - last_sent >= 1.0:
                    last_seq, last_sent = seq, now
                    yield (
                        f"--{MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\n"
                        f"Content-Length: {len(jpeg)}\r\n\r\n"
                    ).encode("ascii") + jpeg + b"\r\n"
                await asyncio.sleep(0.03)

        return StreamingResponse(
            frames(),
            media_type=f"multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY}",
            headers={"Cache-Control": "no-store"},
        )

    # ------------------------------ trim -------------------------------- #
    @app.get("/api/trim")
    def get_trim() -> Dict[str, float]:
        roll, pitch = core.mixer.trim()
        return {"roll": roll, "pitch": pitch}

    @app.put("/api/trim")
    def put_trim(body: TrimBody):
        roll, pitch = core.mixer.trim()
        try:
            roll, pitch = core.mixer.set_trim(
                roll if body.roll is None else body.roll,
                pitch if body.pitch is None else body.pitch,
            )
        except ValueError as exc:
            return _error(422, str(exc))
        core.store.save_trim(roll, pitch)
        return {"roll": roll, "pitch": pitch}

    # ------------------------------ mission ----------------------------- #
    @app.post("/api/mission/start")
    def mission_start(body: MissionStartBody):
        if body.dose_id is not None and core.store.get_dose(body.dose_id) is None:
            return _error(404, f"unknown dose {body.dose_id!r}")
        started, blockers = core.runner.start(body.confirm_airborne, body.dose_id)
        if not started:
            return JSONResponse(status_code=409, content={"blockers": blockers})
        snapshot = core.runner.snapshot()
        return {"ok": True, "run_id": snapshot["run_id"], "state": snapshot["state"]}

    @app.post("/api/mission/abort")
    def mission_abort() -> Dict[str, Any]:
        aborted = core.runner.abort("pilot_took_over")
        core.runner.flush()
        return {"ok": True, "aborted": aborted, "state": core.runner.state}

    @app.post("/api/mission/calibrate-arrival")
    def mission_calibrate():
        width, blockers = core.runner.calibrate_arrival()
        if width is None:
            return JSONResponse(status_code=409, content={"blockers": blockers})
        return {"ok": True, "arrive_width": round(width, 4)}

    @app.put("/api/mission/settings")
    def mission_settings(body: MissionSettingsBody):
        if body.land_on_arrival is None and body.drift_assist is None:
            return _error(422, "give land_on_arrival, drift_assist or both")
        if body.land_on_arrival is not None:
            core.runner.set_land_on_arrival(body.land_on_arrival)
        if body.drift_assist is not None:
            core.runner.set_drift_assist(body.drift_assist)
        return core.runner.settings()

    @app.post("/api/hover-test/start")
    def hover_start():
        started, blockers = core.runner.start_hover_test()
        if not started:
            return JSONResponse(status_code=409, content={"blockers": blockers})
        return {"ok": True}

    # ------------------------------ care -------------------------------- #
    @app.get("/api/schedule")
    def schedule_list() -> Dict[str, Any]:
        return {"doses": core.store.list_doses()}

    @app.post("/api/schedule")
    def schedule_add(body: DoseBody):
        try:
            return core.store.add_dose(body.time, body.label, body.notes)
        except ValueError as exc:
            return _error(422, str(exc))

    @app.put("/api/schedule/{dose_id}")
    def schedule_update(dose_id: str, body: DosePatchBody):
        try:
            return core.store.update_dose(dose_id, body.time, body.label, body.notes)
        except KeyError:
            return _error(404, f"unknown dose {dose_id!r}")
        except ValueError as exc:
            return _error(422, str(exc))

    @app.delete("/api/schedule/{dose_id}")
    def schedule_delete(dose_id: str):
        if not core.store.delete_dose(dose_id):
            return _error(404, f"unknown dose {dose_id!r}")
        return {"ok": True}

    @app.post("/api/doses/{dose_id}/acknowledge")
    def dose_acknowledge(dose_id: str):
        if core.store.get_dose(dose_id) is None:
            return _error(404, f"unknown dose {dose_id!r}")
        snapshot = care_snapshot(core.store, core.now_local(), core.settings.grace_min)
        current = next((d for d in snapshot["doses"] if d["id"] == dose_id), None)
        if current is not None and current["acknowledged_at"] is not None:
            return {"ok": True, "dose_id": dose_id, "acknowledged_at": current["acknowledged_at"],
                    "already_acknowledged": True}
        event = core.store.add_event("pickup_acknowledged", dose_id=dose_id, detail={"self_reported": True})
        return {"ok": True, "dose_id": dose_id, "acknowledged_at": time_local(event["ts"]),
                "already_acknowledged": False}

    @app.get("/api/events")
    def events(limit: int = Query(50, ge=1, le=500)) -> Dict[str, Any]:
        return {"events": core.store.events(limit)}

    return app
