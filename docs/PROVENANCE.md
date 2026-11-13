# Provenance: what existed before MedHop, and what was built for it

This page separates work that existed before MedHop from work done for MedHop, so that judges and
organisers can decide for themselves what counts for their event. It states only what the author can
show or has reported.

## Timeline

| Date | What | Who | Where it lives |
|---|---|---|---|
| 2025-04-29 to 2026-06-22 | **turbodrone** upstream: an open-source project that reverse-engineered the "WiFi UAV" phone app's protocol so a laptop can fly these toy drones. 70 commits in its public history over this period, 64 of them by its author Marshall Richards and 6 by three other contributors. Licence: Apache-2.0. Latest upstream commit in the author's checkout: `2c09cf8` ("README small update", 2026-06-22). | Marshall Richards and contributors. Not the MedHop author. | https://github.com/marshallrichards/turbodrone |
| 2026-11-04 and 2026-11-05 | **The author's local changes inside their turbodrone checkout**, made with AI coding assistance, before MedHop started: fixes that made the takeoff/land commands reliable on this drone; logging of the drone's MCU status messages; a rewrite of the person-follow plugin; a redesign of the browser UI; a video recorder. | The author, with AI coding assistance. | The author's turbodrone checkout only (uncommitted working-tree changes on top of `2c09cf8`). **Not in this repo.** |
| 2026-11-11 onward | **MedHop** (this repo): the care loop (schedule, reminders, arrival log, self-reported pickup acknowledgement, caregiver page), the station-run controller, the simulator, the loopback test double, the tests, the browser app and these docs. The repo was created on 2026-11-11 and all code in it was written from that date. | AI coding agents (Anthropic's Claude) under the author's direction (see the README's "AI disclosure"). | This repo. |
| 2026-11-12 and 2026-11-13 | **MedHop rework** (branch `rework/browser-demo`): the browser engine, a TypeScript port of the backend's flight code, care store and API with the simulator, so the site can run with no backend (`frontend/src/engine/`), checked against traces recorded from the Python code (`backend/tools/parity_traces.py`); the start page with its live demo; waiting for people and obstacles (SPEC section 11, simulator-tested only); and the restyle of the pages to six colours and one typeface (Atkinson Hyperlegible Next, self-hosted). | AI coding agents (Anthropic's Claude) under the author's direction. | This repo. |

### How MedHop relates to the earlier work

- MedHop does **not** copy turbodrone's code. `backend/medhop/drone/turbodrone.py` imports turbodrone at
  run time from the checkout named by `MEDHOP_TURBODRONE_BACKEND`. It uses turbodrone's RC model
  (`WifiUavRcModel`), RC and video protocol adapters, flight controller, video receiver,
  `DirectStrategy` and `DroppingQueue`. It never imports turbodrone's `web_server`.
- **MedHop's real-drone mode does not run against unmodified upstream turbodrone.** It relies on the
  author's uncommitted local changes listed in the next section. Those changes were written by the author
  with AI assistance on 2026-11-04 and 2026-11-05, before MedHop, and are uncommitted in that checkout.
- **Simulator mode (the default) needs no turbodrone at all**, and neither does the browser build of the
  site, which never talks to a drone.
- None of the person-follow plugin, the redesigned browser UI or the video recorder from 2026-11-04/05 is
  used by MedHop. MedHop has its own browser app (`frontend/`) and its own, separate person check
  (`backend/medhop/vision/person.py`).
- `backend/tools/fake_wifi_uav.py` (MedHop's loopback stand-in for the drone) was written for MedHop, but
  the packet formats it imitates are the ones turbodrone's adapters use: the protocol knowledge comes from
  turbodrone's reverse-engineering work.

*[author: decide whether to publish the modified checkout as a fork so judges can run real mode]*

### Changes in the modified turbodrone checkout that MedHop's real mode relies on

Established by reading `backend/medhop/drone/turbodrone.py` and running `git status --short` and
`git diff` in the author's checkout (paths are inside turbodrone's `backend/`). "Upstream" means commit
`2c09cf8`.

| Change | File | How MedHop uses it |
|---|---|---|
| `WifiUavRcModel.calibrate_gyro()` added (sets the calibration flag). Upstream has this method only on other drone models, not on `WifiUavRcModel`. | `models/wifi_uav_rc.py` | MedHop's `calibrate()` ("Calibrate level" on the Pilot page) calls it. Without it that call fails. |
| `SPEED_SCALES` moved onto the model and a `speed_scale` property added (same values as upstream). | `models/wifi_uav_rc.py` | Not called by MedHop directly; the modified RC adapter reads `WifiUavRcModel.SPEED_SCALES`, so the two files go together. |
| Command hold logic: the takeoff/land bit, the stop bit and the calibrate bit are each held for `COMMAND_HOLD_S` = 0.15 s across packets, instead of being sent in one packet only. A repeated takeoff/land request during a hold does not extend it (so it stays one press), and the stop bit wins over a takeoff/land that is still being held. | `protocols/wifi_uav_rc_protocol_adapter.py` | Every MedHop takeoff/land toggle, emergency stop and gyro calibrate goes through this. |
| The RC adapter keeps a copy of its newest 20-byte command (`latest_command`), logs a warning when a takeoff/land or stop packet could not be sent (socket closed), and logs stick changes. | `protocols/wifi_uav_rc_protocol_adapter.py` | The copy is used by the video change below. The warning is the only library-side trace of a command lost during the reconnect gap. |
| Video frame requests carry the RC adapter's newest command instead of a fixed neutral command. The change's own comment says a neutral command there would cancel takeoff, land, e-stop and stick input. The video adapter also stores the RC adapter it was given. | `protocols/wifi_uav_video_protocol.py` | On MedHop's real path for every command. MedHop has not been tested against the real drone with or without this change. |
| MCU status messages are recognised in incoming packets and passed to a new `_on_mcu_message(message)` method, which logs them. Upstream has no such hook. | `protocols/wifi_uav_video_protocol.py` | MedHop subclasses the video adapter and overrides `_on_mcu_message` (calling the original) to read the raw fly-state, battery and flags bytes. |
| New helper module that parses and describes MCU messages (`parse_mcu_packet`, `describe_mcu_message`). | `utils/wifi_uav_mcu.py` (new, untracked file) | Imported by the modified video adapter, so real mode cannot start without it. |
| The video adapter sends a firmware version query a few times once video starts, and logs unrecognised packet types. The query packet already existed upstream as `UNK_FRAME` (same bytes) and is renamed `VERSION_QUERY`. | `protocols/wifi_uav_video_protocol.py`, `utils/wifi_uav_packets.py` | Not used by MedHop, but it runs in real mode because it is part of the adapter MedHop imports. |
| Manual-priority gate in `FlightController`: `set_axes_from` drops input from sources other than `frontend` and `follow-stop` for 1 s after `note_manual_input()` is called. | `services/flight_controller.py` | On MedHop's call path (MedHop sends sticks with `set_axes_from("frontend", ...)`), but MedHop never calls `note_manual_input()`, so the gate never blocks it. `set_axes_from` itself exists upstream. MedHop does not depend on this change. |

Unmodified upstream files MedHop also uses: `control/strategies.py` (`DirectStrategy`),
`services/video_receiver.py`, `utils/dropping_queue.py` and `utils/wifi_uav_variants.py` (the `fld`
variant). The rest of the local diff (`web_server.py`, `plugins/`, `services/video_recorder.py`,
`frontend/`, and the turbodrone tests) is not used by MedHop.

## How a reader can check this

- **This repo's commit history.** The git history of this repo starts on the day of its first commit and
  is the record of when MedHop code was written. Git commit dates are recorded by the committer's own
  computer, so on their own they are self-reported; the times at which commits were pushed to a public
  host are a separate record.
- **turbodrone's upstream history**, at https://github.com/marshallrichards/turbodrone, shows what
  turbodrone itself contained and who wrote it.
- **The author's local turbodrone changes** are uncommitted files in the author's checkout. Their file
  modification dates (2026-11-04 and 2026-11-05) are **self-reported**: they come from the author's own
  computer and cannot be independently verified. If the author publishes the modified checkout (see
  below), a diff against upstream commit `2c09cf8` shows exactly what was changed, though not when.

## Event by event

The author intends to enter this same project in four events and says so openly (see the README's
cross-submission statement). MedHop's code was written from 2026-11-11, and the turbodrone work above
existed before that. Whether that falls inside a given event's
build period, and what the event's rules allow, differs per event and is stated below only where it is
known. Nothing here claims that MedHop is eligible for any event.

The drone has flown station runs for real, with no footage; the project's notes do not record a real run
that went cleanly from takeoff to landing (README "Results").

| Event | What is known | Still to add |
|---|---|---|
| DSH Hacks V2 | The author intends to enter. The pre-existing work is third-party turbodrone and the author's 2026-11-04/05 turbodrone changes, as above. | *[author: add the build period, what the rules say about pre-existing work, and the organisers' answer if asked]* |
| IceHacks | Build period 8 to 15 November 2026 *[author: add a link to the IceHacks rules that state this period]*. The 2026-11-04/05 changes were made before that period; MedHop was started on 2026-11-11. The author asked the IceHacks organisers on Discord about building on the pre-existing drone-control work described above and reports that they approved it. | *[author: add a screenshot or link to the Discord message here]* |
| STEMergent Hacks | The author intends to enter. Pre-existing work as above. | *[author: add the build period, what the rules say about pre-existing work, and the organisers' answer if asked]* |
| STEM2Connect AI Hackathon | The author intends to enter. Pre-existing work as above. | *[author: add the build period, what the rules say about pre-existing work, and the organisers' answer if asked]* |

## AI disclosure

MedHop's code and docs were written with Claude, Anthropic's AI assistant, directed by the author (see
the README's "AI disclosure" for who did what). The author's 2026-11-04/05 turbodrone changes were also
made with AI coding assistance.

## Apache-2.0 obligations if the author publishes the modified turbodrone checkout

turbodrone is licensed under the Apache License 2.0, and the checkout includes a `LICENSE` and a `NOTICE`
file. Publishing (redistributing) the modified checkout brings the conditions of section 4 of that
licence into play. In short:

1. **Keep the licence.** Include turbodrone's `LICENSE` file (the Apache License 2.0 text).
2. **Keep the NOTICE.** Include turbodrone's `NOTICE` file with its attribution notices. You may add your
   own notice next to them, but must not remove theirs.
3. **Mark changed files.** Every file you modified must carry a prominent notice saying that you changed
   it (for example a comment at the top: "Modified by <author> in November 2026 with AI coding
   assistance: <what changed>").
4. **Keep existing notices.** Keep all copyright, patent, trademark and attribution notices in the source
   files you redistribute.
5. **Your own changes** may be released under your own terms, provided the conditions above are met for
   the original work.
6. **Names.** The licence does not grant use of the original author's name or project name beyond
   describing where the code came from.

This is a plain summary, not legal advice; the licence text itself is what applies.

MedHop itself does not redistribute any turbodrone code, so these obligations do not arise from
publishing this repo. The README credits turbodrone and its licence.
