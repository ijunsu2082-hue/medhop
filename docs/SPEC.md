# MedHop build spec

MedHop is a medication-reminder "care loop" for older adults, with one experimental transport leg: a
toy camera drone that flies a short, supervised, empty-corridor hop to a marked station. This file is
the contract between the backend and the frontend. Started 2026-11-11.

## 1. Honest scope (do not exceed in code, UI text or docs)

- The product is the care loop: schedule, reminder, station-run arrival log, pickup acknowledgement,
  caregiver status. It must be fully usable with no drone at all.
- The drone leg is experimental. It never carries real medicine, is never flown near people, and a
  human pilot holds manual control and the emergency stop throughout every flight. The emergency stop
  works only while the control link (browser to backend) and the drone link (backend to drone) are up;
  see 10.1.
- Never write "delivered". The log says "arrived at station". Pickup is "acknowledged (self-reported)".
  Nothing in MedHop proves that a dose was taken.
- Marker detection is ArUco (classical computer vision). Never call it AI. The only AI model is the
  pretrained YOLO person detector, used as an ADVISORY pre-flight and in-flight person check. Never
  call it a safety system or interlock.
- Schedule data is demo data. No real names, no real medicines, no external services, no accounts.
- Browser text-to-speech (Web Speech API) is not AI.

## 2. Architecture

```
medhop/
  backend/medhop/          Python package (FastAPI). All new code.
    config.py              settings from env (MEDHOP_*)
    drone/base.py          DroneLink interface
    drone/sim.py           SimLink: kinematic simulator + camera renderer (default mode)
    drone/turbodrone.py    TurbodroneLink: glue to the third-party turbodrone backend (real drone)
    mixer.py               ControlMixer: the single authority that sends axes to the link
    vision/marker.py       ArUco station-marker detection
    vision/person.py       YOLO person check (optional, lazy)
    vision/worker.py       vision thread: frames -> observations, annotated JPEG
    mission/steering.py    pure steering maths (no I/O)
    mission/runner.py      station-run state machine, failsafes, hover test
    care/store.py          schedule + event log (JSON / JSONL in data/)
    care/status.py         per-dose status for today
    server.py              FastAPI app: REST, WebSockets, MJPEG
  backend/tests/           unit tests + closed-loop simulator tests
  backend/tools/           make_marker.py (printable station sign), fake_wifi_uav.py (loopback test double)
  frontend/                Vite + React + TypeScript single-page app
  docs/                    SPEC.md, SAFETY.md, PROVENANCE.md, FLIGHT_CHECKLIST.md
  data/                    runtime data (gitignored except data/README.md)
```

Third-party dependency: turbodrone (Apache-2.0, https://github.com/marshallrichards/turbodrone) is NOT
copied into this repo. `TurbodroneLink` imports it from the path in `MEDHOP_TURBODRONE_BACKEND`
(a checkout's `backend/` directory, inserted at `sys.path[0]`). MedHop's own package is named `medhop`
and must not define top-level packages named models, services, protocols, plugins, utils or control.

Ports: backend 8010, frontend dev server 5180 (so they never collide with turbodrone's 8000/5173).

## 3. Drone link interface (`drone/base.py`)

All stick values are true stick fractions in [-1, 1]. Signs: +throttle up, +yaw turn right,
+pitch forward, +roll right.

```python
class DroneLink(Protocol):
    mode: str                                  # "sim" or "real"
    def start(self) -> None
    def stop(self) -> None                     # must send neutral axes first
    def set_axes(self, throttle: float, yaw: float, pitch: float, roll: float) -> None
    def takeoff_land_toggle(self) -> None      # ONE shared toggle: takes off on the ground, lands in the air
    def emergency_stop(self) -> None           # motor cut. The drone falls.
    def calibrate(self) -> None                # gyro calibrate, flat ground only
    def latest_frame(self) -> Frame | None     # Frame(jpeg: bytes, timestamp: float (time.monotonic), seq: int)
    def telemetry(self) -> Telemetry | None    # Telemetry(fly_state_raw, battery_raw, flags_raw, timestamp)
```

Only `ControlMixer` may call `set_axes`. Only the mixer (on pilot request) and the mission runner
(on confirmed arrival, section 6) may call `takeoff_land_toggle`.

### TurbodroneLink rules (real drone)
- Recipe: `WifiUavRcModel()`; `WifiUavRcProtocolAdapter(drone_ip, 8800, variant="fld")`;
  `VideoReceiverService(protocol_adapter_class=<subclass of WifiUavVideoProtocolAdapter>,
  protocol_adapter_args={drone_ip, control_port, video_port, variant, debug}, frame_queue=DroppingQueue(maxsize=1),
  rc_adapter=rc)`; `receiver.start()`; wait (max 10 s) until `rc._is_shared_sock` is True;
  `FlightController(model, rc, control_rate)`; `fc.start()`. Control rate default 20 Hz (`MEDHOP_CONTROL_RATE`).
- Never import turbodrone's `web_server`. Do not edit any file under the turbodrone checkout.
- Use `DirectStrategy`, `model.expo_factor = 0.0`, `model.set_speed_index(2)` (scale 1.0), and re-assert
  these if they change. Send axes with `fc.set_axes_from("frontend", throttle, yaw, pitch, roll)`.
- Telemetry: subclass the video adapter and override `_on_mcu_message(self, message)` (call super).
  A status message starts `88 00` and ends `0x55`: `message[2]` fly-state, `[3]` battery, `[4]` flags.
  Units and meanings are NOT verified. Expose raw values only.
- One consumer thread drains the receiver's frame queue and keeps the latest frame.
- `stop()`: neutral axes, wait two control periods, then `fc.stop()`, `receiver.stop()`. Never send the toggle on stop.
- Known hazard: after 4 s without video the library closes the socket and control is lost for 5-9 s.
  The mixer therefore sends neutral axes as soon as video is stale (section 5).
- Default `MEDHOP_DRONE=sim`. The real link is used only when `MEDHOP_DRONE=real`. Automated tests and
  development never use 192.168.169.1; loopback only (`MEDHOP_DRONE_IP=127.0.0.1` with `tools/fake_wifi_uav.py`).

### SimLink rules
- 2-D kinematic model: position (x, y) in metres, heading, airborne flag. Stick fractions map to
  velocities through configurable gains (defaults: forward 1.0 m/s, lateral 1.0 m/s, yaw 150 deg/s at full stick),
  with first-order lag, configurable constant lateral drift (default 0.08 m/s), and small noise.
- Camera: 640x360, 15 fps, horizontal FOV 70 deg (configurable), JPEG quality 50, added sensor noise and
  mild blur, and a transport delay so command-to-video latency is about 0.45 s.
- World: one wall with the station marker (ArUco DICT_4X4_50, id 7, default printed size 0.18 m) plus
  simple wall/floor texture. The marker is rendered by perspective projection of its corners.
- Toggle: on the ground it takes off (airborne after about 1.5 s); in the air it lands. Supports test
  hooks: force auto-land (simulates low battery), freeze video, drop marker, set pose.
- Telemetry is simulated and its values are labelled as simulated in status (`telemetry.simulated: true`).

## 4. Configuration (env, all optional)

| Variable | Default | Meaning |
|---|---|---|
| MEDHOP_DRONE | sim | `sim` or `real` |
| MEDHOP_TURBODRONE_BACKEND | (none) | path to turbodrone `backend/` (required for real) |
| MEDHOP_DRONE_IP | 192.168.169.1 | drone address (real mode) |
| MEDHOP_CONTROL_RATE | 20 | control packets per second |
| MEDHOP_DATA_DIR | ./data | schedule, events, trim, calibration |
| MEDHOP_MARKER_ID | 7 | ArUco id of the station sign |
| MEDHOP_MARKER_SIZE_M | 0.18 | printed marker edge, metres (only used for drift estimates) |
| MEDHOP_ARRIVE_WIDTH | 0.16 | marker width as a fraction of frame width that counts as arrived |
| MEDHOP_PERSON_CHECK | auto | `auto` (on if ultralytics and weights are available), `on`, `off` |
| MEDHOP_YOLO_WEIGHTS | (none) | local path to yolo11n.pt (no download at flight time: the laptop has no internet on the drone's Wi-Fi) |
| MEDHOP_BATTERY_LOW_RAW | -1 | raw battery byte treated as low; -1 disables the check (the byte's meaning is UNVERIFIED; see 10.2) |
| MEDHOP_GRACE_MIN | 15 | minutes after a dose time before it is `needs_attention` |

## 5. ControlMixer (`mixer.py`)

Runs at the control rate. Each tick it computes the axes to send:

1. If emergency stop was pressed: neutral forever until the server restarts or the pilot presses "Reset emergency stop" (`estop_reset`).
2. Else if the pilot is active (a manual `axes` message with any non-zero value arrived in the last 0.4 s):
   pilot axes x `pilot.max_stick`.
3. Else if the mission runner has a fresh command (younger than 0.5 s): mission axes (yaw and pitch, plus a
   small bounded roll when drift assist is on; never throttle).
4. Else neutral.

Then, unless emergency stop is active, add trim (roll, pitch) and clamp to [-1, 1].

Video failsafe: if the latest frame is older than 0.5 s, mission axes are forced to neutral (pilot axes
still pass, the pilot can see the room). Pilot non-zero axes or a pilot toggle abort a running mission
with reason `pilot_took_over`; a pilot emergency stop aborts it with reason `estop` (Revision 2). A pilot WebSocket disconnect zeroes pilot axes at once.

Pilot axes are ramped toward their target at 4.0 per second so key taps do not jerk the drone.

## 6. Station run (`mission/runner.py`)

States: `idle`, `searching`, `approaching`, `arrived`, `landing`, `done`, `aborted`, `hover_test`.

Start requires `confirm_airborne: true` from the pilot (the runner never takes off). Blockers that
refuse a start: `no_video`, `estop_active`, `already_running`, `person_in_view` (when the person check is on),
`battery_low` (when telemetry is available), `marker_too_close` (marker already at or above arrive width).

- searching: marker not visible. Yaw at a slow fixed rate (default 0.12) for at most 12 s, then abort `marker_not_found`.
- approaching: pursuit guidance. Yaw to centre the marker, with compensation for command-to-video latency
  (default 0.45 s; do not steer on the stale position alone). Fly forward only when the marker is within
  0.15 frame-widths of centre. Forward stick is capped (default 0.22) and tapers as the marker grows
  (default 0.10 near arrival). Commands rise at most 1.0 per second; reductions are immediate.
- Marker lost: hold neutral for up to 0.6 s, then creep-search toward the side it was last seen for up to
  2.0 s, then abort `marker_lost`.
- arrived: marker width >= arrive width on 3 consecutive detections AND the marker has grown by at
  least 15 % since it was first seen in this run (evidence the drone really moved, so it is airborne).
  Neutral sticks, settle 1.2 s (`settle_s`, see 10.2).
- landing: send `takeoff_land_toggle()` exactly once, wait 4 s, then `done`. Config `land_on_arrival`
  (default false, persisted; see 10.2); when false, go straight to `done` and the pilot lands. With it on,
  the toggle waits for the settle descent guard (10.2).
- Aborts: `marker_not_found`, `marker_lost`, `off_axis` (Revision 2), `video_stale` (frame older than 1.5 s),
  `timeout` (45 s), `pilot_took_over`, `person_in_view`, `battery_low`, `estop`, `pilot_link_lost` (Revision 2),
  `unexpected_descent` (10.2). On ANY abort: neutral sticks, state `aborted`
  with the reason, and NEVER send the toggle (if the drone has already auto-landed the toggle would launch it).
  The pilot lands by hand.
- Every run writes events: `run_started`, then `arrived_at_station` or `run_aborted` (with reason), plus a
  per-run JSON trace (timestamps, marker cx/width, commands, raw telemetry) under `data/runs/`.

### Revision 2 (2026-11-11, after the first build and judge pass)

Accepted from the first build:
- Arrival, taper, `marker_too_close` and calibration use a viewing-angle-corrected marker width, because a
  marker seen from the side looks narrower. `vision.marker.width` in status stays the literal figure.
- Extra abort reason `off_axis`: marker width/height ratio under 0.70 on 3 detections (about 45 degrees off
  the wall normal).
- Emergency stop aborts a run with reason `estop`. Other pilot input aborts with `pilot_took_over`.
- Extra blocker strings: `confirm_airborne_required` (start), `marker_not_visible` (hover test, calibrate).
- Toggle guards: refused while emergency stop is latched; a second toggle within 1.0 s is ignored.
- Settle: abort `marker_lost` (no toggle) if the marker was not seen in the last 0.3 s of the settle.
- The runner holds neutral after 0.25 s without a new frame, ahead of the mixer's 0.5 s rule.

New requirements:
- Settle descent guard: SUPERSEDED by 10.2. (Revision 2 aborted `marker_lost` when the marker moved more
  than 0.08 of frame height in either direction during the settle. 10.2 replaces this: one direction only,
  3 consecutive detections, abort reason `unexpected_descent`, and only when `land_on_arrival` is on.)
- Drift assist (experimental, default OFF, persisted, `PUT /api/mission/settings {"drift_assist": true}`):
  while approaching, add a roll command that cancels sideways drift, estimated only from what the camera
  shows. Bounded to |roll| <= 0.15, anti-windup, not fooled by the initial heading error, and it must
  switch itself off for the rest of the run (event detail `drift_assist_disabled: true`) if the off-axis
  measure keeps getting worse while it is active (for example the roll sign is wrong on this drone).
  After a completed run, report `suggested_trim_roll` (current trim + mean assist roll near the end,
  rounded to 0.01) in status and in the `arrived_at_station` event detail.
- Pilot link: if the pilot control WebSocket disconnects during a station run or hover test, abort with
  reason `pilot_link_lost` (neutral sticks, no toggle). A run or hover test can only start while a pilot
  control socket is connected (blocker `no_pilot_link`).
- `reminder_due` is logged only when the clock reaches the dose time, never because a run arrived early.
- Dose `arrived_at` and `acknowledged_at` in status are local `"HH:MM"` strings or null.

Hover test (`hover_test`): pilot hovers facing the marker; for 10 s the runner sends neutral (trim still
applies) and records marker centre and width. Result: horizontal drift in frame-widths and an estimate in
metres (using marker size as the scale), width change in percent, `pass` when |drift| <= 0.5 m and the
marker stayed visible >= 80 % of the time. Label the metres figure as an estimate.

Arrival calibration: `POST /api/mission/calibrate-arrival` stores the currently observed marker width as
the arrive width (the pilot holds the drone by hand at the wanted stopping distance; no FOV needed).

## 7. HTTP and WebSocket API (JSON, base `http://localhost:8010`)

CORS: allow `http://localhost:5180` and `http://127.0.0.1:5180`.

### Status snapshot
`GET /api/status` returns the object below. `WS /ws/status` pushes the same object 5 times a second.

```jsonc
{
  "server_time": 1731360000.0,
  "mode": "sim",                               // "sim" | "real"
  "link": { "video_live": true, "frame_age_s": 0.07, "fps": 14.8 },
  "telemetry": {                               // null until the first status message
    "simulated": true, "age_s": 0.4,
    "fly_state_raw": 1, "battery_raw": 42, "flags_raw": 16,
    "battery_low": false
  },
  "trim": { "roll": 0.0, "pitch": 0.0 },
  "pilot": { "manual_active": false, "max_stick": 0.5, "estop_active": false },
  "vision": {
    "marker": { "id": 7, "cx": 0.52, "cy": 0.44, "width": 0.11, "age_s": 0.05 },   // or null
    "person": { "enabled": true, "detected": false, "count": 0, "age_s": 0.2 },
    "brightness": 96.0, "dark": false
  },
  "mission": {
    "state": "idle", "reason": null, "run_id": null, "dose_id": null,
    "elapsed_s": 0.0, "command": { "yaw": 0.0, "pitch": 0.0 },
    "arrive_width": 0.16, "land_on_arrival": false,
    "drift_assist": { "enabled": false, "active": false, "roll": 0.0, "disabled_reason": null, "suggested_trim_roll": null },
    "can_start": true, "blockers": []
  },
  "hover_test": null,      // or { "running": bool, "elapsed_s": n, "result": null | { "pass": bool, "drift_frame_widths": n, "drift_m_estimate": n, "width_change_pct": n, "visible_pct": n } }
  "care": {
    "now_local": "08:01", "date_local": "2026-11-11",
    "doses": [
      { "id": "d1", "time": "08:00", "label": "Morning dose (demo)", "notes": "",
        "status": "due",                       // upcoming | due | arrived | acknowledged | needs_attention
        "arrived_at": null, "acknowledged_at": null }
    ],
    "next_due_id": "d1"
  }
}
```

Dose status for today: `upcoming` before its time; `due` from its time; `arrived` once a station run for
that dose logged `arrived_at_station` today; `acknowledged` once acknowledged today; `needs_attention`
when not acknowledged and now is later than time + grace (keep `arrived_at` if set).

### Control WebSocket `WS /ws/control` (one pilot at a time; a second connection is refused with close code 4001)
Client to server:
- `{"type":"axes","throttle":0,"yaw":0,"pitch":0,"roll":0}` each in [-1,1]; send at 10 Hz or faster while any key is held, and once with zeros on release
- `{"type":"takeoff_land"}`
- `{"type":"estop"}`
- `{"type":"estop_reset"}`
- `{"type":"calibrate"}`
- `{"type":"max_stick","value":0.5}` (0.2 to 1.0)

Server to client: `{"type":"ack","of":"takeoff_land"}` and `{"type":"error","message":"..."}`.

### REST
- `GET /video.mjpg` multipart MJPEG, annotated (marker outline, person boxes, state text).
- `GET /api/trim`, `PUT /api/trim` body `{"roll":0.02,"pitch":-0.01}` (each clamped to [-0.3, 0.3]; persisted).
- `POST /api/mission/start` body `{"confirm_airborne":true,"dose_id":"d1"|null}`; 409 with `{"blockers":[...]}` when refused.
- `POST /api/mission/abort`
- `POST /api/mission/calibrate-arrival`; 409 when no marker is visible.
- `PUT /api/mission/settings` body with either or both of `{"land_on_arrival":true,"drift_assist":false}`; returns the current settings.
- Response shapes: schedule POST/PUT return the dose object; DELETE returns `{"ok":true}`; acknowledge returns
  `{"ok":true,"dose_id":"d1","acknowledged_at":"08:05","already_acknowledged":false}`; mission start returns
  `{"ok":true,"run_id":"...","state":"searching"|"approaching"}`; abort returns `{"ok":true,"aborted":bool,"state":"..."}`.
  Abort reasons: `marker_not_found`, `marker_lost`, `off_axis`, `video_stale`, `timeout`, `pilot_took_over`,
  `person_in_view`, `battery_low`, `estop`, `unexpected_descent`, `pilot_link_lost`.
- `POST /api/hover-test/start`; 409 when no marker is visible or a run is active.
- `GET /api/schedule` -> `{"doses":[{id,time,label,notes}]}`; `POST /api/schedule` body `{time,label,notes}`;
  `PUT /api/schedule/{id}`; `DELETE /api/schedule/{id}`. `time` is 24-hour `HH:MM`.
- `POST /api/doses/{id}/acknowledge` (records `pickup_acknowledged`, self-reported).
- `GET /api/events?limit=50` -> newest first: `{"events":[{"ts": unix, "time_local":"08:02", "type":"arrived_at_station", "dose_id":"d1", "run_id":"...", "detail":{...}}]}`.
  Event types: `reminder_due`, `run_started`, `arrived_at_station`, `run_aborted`, `pickup_acknowledged`, `needs_attention`, `hover_test`.
- `GET /api/health` -> `{"ok":true,"mode":"sim"}`

## 8. Frontend pages

- `/` Pilot: annotated video, keyboard and on-screen controls, big always-visible EMERGENCY STOP, takeoff/land,
  battery (raw, labelled unverified), trim nudges, pre-flight checklist driven by status, station-run start
  (with an explicit hovering confirmation: "The drone is hovering and the corridor is empty"), abort, hover test, arrival calibration, live mission state.
- `/care` Older-adult view: very large type, the next or due dose, spoken reminder (Web Speech API, with a
  mute button), one large "I picked it up" button. No drone controls.
- `/caregiver` Caregiver view: today's doses with status, last events, schedule editor, drone state summary.

Pilot also has: "Calibrate level" (sends `calibrate`; hold-to-confirm; only on flat ground with motors off),
and a "Drift assist (experimental)" switch with the live assist roll and, after a run, the suggested roll trim
with an "Apply as trim" button.

Keyboard on Pilot: W/S pitch forward/back, A/D roll left/right, arrow up/down throttle, arrow left/right yaw,
T takeoff/land, Space emergency stop. Keys are ignored while focus is in a text field.

## 9. Engineering rules

- LF line endings. Python 3.11+ compatible. No new heavy dependencies beyond fastapi, uvicorn, numpy,
  opencv-python (with aruco), and optionally ultralytics.
- Everything safety-relevant in sections 5 and 6 must have a unit test or a closed-loop simulator test.
- Third-party code and models are credited in the README. AI coding assistance is disclosed there too.

## 10. Revision 3 (2026-11-11, after the Fable + Opus council review)

Note for executors: the Revision 2 backend pass does NOT implement this section. Revision 3 is built by
separate fix executors after it. Where this section disagrees with an earlier one, this section wins.
The full findings are in the council report; each item below is the accepted fix.

### 10.1 Emergency stop and drone-link state (mixer, TurbodroneLink, server)
- `DroneLink` gains `control_up() -> bool` and `drone_seen() -> bool`. SimLink returns True for both.
  TurbodroneLink: `control_up` is False when the shared RC socket is closed (`fileno() == -1`) or the
  receiver has no protocol; `drone_seen` turns True on the first video frame or MCU message.
- `takeoff_land_toggle()` and `emergency_stop()` return a bool: True when the command went onto an open
  socket, False when the link was down.
- While the mixer's e-stop is latched it asserts the motor cut on EVERY tick (idempotent), not for 0.5 s.
  `estop_delivered` is True once the stop bit has been sent for 0.5 s of socket-open time since the
  latch was set; it resets on `estop_reset`.
- Pilot axes: in real mode, once the newest frame is older than 3.0 s (before the library's 4 s stall
  cut), the mixer sends neutral instead of pilot axes (`link.sticks_blocked = true`). E-stop and the
  toggle stay available. This makes "the last packets before the blackout are neutral" true.
- Toggle rules in the mixer: a pilot toggle is refused for `land_wait_s` (4 s) after a mission toggle
  (`landing_in_progress`); a pilot toggle while `control_up` is False is refused (`drone_link_down`);
  a mission toggle is refused when any pilot input (axes, toggle, e-stop) arrived since the runner's
  last `mission_command`.
- `clamp()` returns 0.0 for non-finite input; `mission_command` rejects non-finite yaw/pitch.
- Real-mode start: if no frame or MCU message arrives within 10 s, log a WARNING naming the drone IP
  and Wi-Fi; `drone_seen` stays False.
- Telemetry older than 3.0 s is treated as absent for decisions; status still shows the last byte and its age.

### 10.2 Station run and vision (runner, marker, config)
- Settle descent guard: the reference `cy` is the median of the first 3 settle detections after the
  0.25 s neutral. Abort only when 3 consecutive detections show the marker more than 0.08 frame-heights
  ABOVE the reference (`cy` decreasing means the drone is going down). Abort reason is the new
  `unexpected_descent` (no toggle sent).
- `land_on_arrival` defaults to False and is persisted like `drift_assist`.
- `MEDHOP_BATTERY_LOW_RAW` defaults to -1 (check disabled; the byte's meaning is unverified). When set to
  a value >= 0 it works as before, but only on telemetry younger than 3.0 s.
  Status `telemetry.battery_low` is false when the check is disabled; add `telemetry.battery_check_enabled`.
- Hover test: judge PEAK sideways excursion (max minus min of marker `cx`, converted to metres with the
  known sign size), not start versus end. Result gains `peak_excursion_m` and `limit_m`; the limit comes
  from `MEDHOP_HOVER_MAX_EXCURSION_M` (default 0.5).
- Marker detector: `minMarkerPerimeterRate` 0.07, `polygonalApproxAccuracyRate` 0.03, ignore detections
  narrower than 0.025 of frame width. SEARCHING moves to APPROACHING only after 3 consecutive id-7
  detections whose centres agree within 0.1 frame-widths. Log the detect time with the rate log.

Orchestrator decisions (added after the Revision 3 fix pass; these win over earlier text):
- `settle_s` defaults to 1.2 s (was 0.6 s), so a descent that starts late in the settle is still seen by
  the descent guard.
- With `land_on_arrival` ON, the landing toggle waits for the settle descent guard to clear. If the guard
  has not cleared by `settle_s` + 1.0 s, the toggle is skipped: the run ends `done` (not `aborted`) and the
  event detail carries `landing_skipped: "settle_guard_undecided"`. The pilot lands by hand.
- With `land_on_arrival` OFF, the descent guard neither holds the run nor aborts it (no toggle is sent
  anyway).
- The 3-consecutive-agreeing-detections rule for leaving the marker search also applies at `start()`:
  a marker already in view at start does not skip straight to APPROACHING on a single detection.
- Detection range in the simulator now ends at about 4.7 m, because a marker narrower than 0.025 of the
  frame width is ignored.
- Pilot-quiet rule: the mixer also refuses a mission toggle when any pilot input (axes, toggle or
  emergency stop) arrived in the last 0.4 s (`MISSION_TOGGLE_PILOT_QUIET_S`), even if a `mission_command`
  came after it. When the mixer refuses the landing toggle for any reason, the run still ends `done` and
  the event detail carries `landing_skipped: "refused_by_mixer"` (with `landing: false`). The pilot lands
  by hand.
- The runner records how each run ended its arrival in `mission.last_landing` (see 10.4): `"sent"`,
  `"skipped_settle_guard_undecided"`, `"refused_by_mixer"` or `"off"`. It is reset to null at each
  `start()`, and stays null for a run that never arrived. A run can therefore end `done` without the
  landing toggle in three ways: guard undecided, refused by the mixer, or `land_on_arrival` OFF.
- Known limit (simulator finding, not fixed): the descent guard has a blind window. With 0.35 s of video
  lag, a descent that starts about 0.8 s or later into the 1.2 s settle is not yet seen by the guard and
  can still receive the landing toggle. This is one reason `land_on_arrival` is off by default.

### 10.3 Care loop (care/status, care/store)
- A dose keeps `arrived_at` in every status. Each dose gains `arrived_mode`: `"sim"`, `"real"` or null,
  copied from the arrival event's `detail.mode`.
- Limit, stated in the docs rather than fixed: status is per calendar day and resets at midnight.
- `add_event` writes a leading newline when the log does not end in one; the event log is read with
  `errors="replace"`; a wrong-shape schedule file is moved aside as `.corrupt-<ts>` before seeding.

### 10.4 API changes
- Status `link` becomes `{ "video_live", "frame_age_s", "fps", "control_up", "drone_seen", "sticks_blocked" }`.
- Status `pilot` gains `"estop_delivered": bool`.
- Status `mission.land_on_arrival` now defaults to false. Abort reasons add `unexpected_descent` and
  `pilot_link_lost`; blockers add `no_pilot_link`.
- Control socket: after a successful pilot claim the server sends `{"type":"hello","pilot":true}`; the
  client treats the link as open only after it. Every ack and error carries `of` (the command type).
  Errors add `code`: `landing_in_progress`, `drone_link_down`, `estop_active`, `toggle_guard`.
  The `estop` ack is `{"type":"ack","of":"estop","delivered":bool}`.
- Status `mission` gains `"last_landing"`: one of `"sent"` (the landing toggle went onto an open socket),
  `"skipped_settle_guard_undecided"` (the descent guard had not cleared by `settle_s` + 1.0 s),
  `"refused_by_mixer"` (the mixer refused the toggle, for example pilot input in the last 0.4 s),
  `"off"` (`land_on_arrival` was OFF), or null (reset at each `start()`; no run yet, or the run has not
  arrived). An older backend does not send it. The arrival event's `landing_skipped` is
  `"settle_guard_undecided"` or `"refused_by_mixer"` when the toggle was not sent with `land_on_arrival` ON.
- The Pilot page's end-of-run message follows `mission.last_landing` exactly:
  - `"sent"`: "Arrived at station. The landing command was sent once: check that the drone has landed."
  - `"skipped_settle_guard_undecided"`: "Arrived at station. The landing command was NOT sent (the descent check could not decide). Land by hand."
  - `"refused_by_mixer"`: "Arrived at station. The landing command was NOT sent (the safety layer refused it, for example because you used the controls just before or the drone link was down). Land by hand."
  - `"off"`: "Arrived at station. Landing on arrival is off: land by hand."
  - null or missing (older backend): "Arrived at station. Check whether the drone has landed; land by hand if not."

### 10.5 Frontend
- Flight keys pause only for text entry (text-type inputs, textarea, contenteditable). Sliders, checkboxes
  and selects never block flight keys or Space; flight keys always `preventDefault`; non-text controls
  blur after a change.
- When the control link leaves `open`, release every held input (keyboard and on-screen pads).
- E-stop banner: never claims the motor cut is confirmed (the backend cannot confirm it). Headlines, as
  implemented in `frontend/src/logic/pilot.ts`:
  - "Emergency stop SENT, not confirmed" while waiting up to 0.5 s for the backend;
  - "Emergency stop NOT confirmed: the backend did not answer within half a second." after that;
  - "Emergency stop NOT sent: the control link is down." when pressed with the control link down;
  - "Emergency stop active" when latched and `estop_delivered` (detail: "Motor-cut command is being sent
    to the drone. Sticks are held neutral until you reset.");
  - "Emergency stop NOT delivered yet: drone link reconnecting." when latched but not delivered (detail:
    "If the drone is still flying, keep clear and switch it off by hand when safe.");
  - "Emergency stop active: motor-cut command sent." from an older backend without `estop_delivered`;
  - "Emergency stop state unknown: the backend is not reachable." when status is unreachable.
  The word "delivered" in "NOT delivered yet" and in `estop_delivered` refers to the emergency-stop
  command only (sent on an open socket), never to medicine.
- Takeoff/land is disabled while `mission.state == "landing"` (note "Landing in progress") and shows the
  refusal `code` text otherwise. Errors are matched to commands by `of` and time.
- Pilot page shows drone-link state separately from the browser control link: "Drone link: connected",
  "Drone link: reconnecting. Commands are not reaching the drone.", or "No reply from the drone yet. Is
  this laptop on the drone's Wi-Fi?" (real mode; the simulator shows "Simulator (no real drone)").
- Plain-English text for `pilot_link_lost`, `no_pilot_link`, `unexpected_descent`, every drift-assist
  `disabled_reason`, and the four error codes.
- Care page and spoken reminder: "The drone reached the station at HH:MM." (never a claim that the pouch
  itself arrived); "(simulator) The drone reached the station at HH:MM." when `arrived_mode == "sim"`;
  show it whenever `arrived_at` is set.
  After "I picked it up", keep the button disabled for 3 s and show the next dose under "Next:".
- Caregiver page: show the date on events not from today, label simulator runs (events, "Last run result"
  and the doses table, which shows "Arrived at station HH:MM (simulator)"), and limit "Last run result"
  to today (or show its date).
- Battery line: show the raw byte and age; "No recent reading. Last: ..." when older than 3 s; say the
  check is off when `battery_check_enabled` is false ("Battery check is off (the meaning of this number
  has not been verified on this drone)", verdict "Info").

### 10.6 Docs and scripts
- Checklist order: ground checks (key seen by backend, Space latches and resets) come first; the first
  real takeoff is the emergency-stop test; no test flies without a working stop. Add: motors-off range
  check for the sign, minimum corridor width, two-person arrival calibration with e-stop latched,
  "quit turbodrone's own server and the phone app", battery notes.
- `scripts/fly-real.sh` refuses to start while turbodrone's own server is running (port 8000 or a
  `web_server` process).
- PROVENANCE lists every change in the modified turbodrone checkout that real mode relies on, drops the
  blanket "same for every event" claim, and states per event what is confirmed.
- README, SAFETY and HOW_IT_WORKS match the behaviour above (pilot-link-lost aborts; e-stop is available
  only while the links are up; no real flight has been done yet).
