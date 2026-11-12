# data/

Runtime files written by the MedHop backend. Everything here except this README is ignored by git.
The location can be changed with `MEDHOP_DATA_DIR`.

All of it is demo data: no real names, no real medicines, nothing is sent to any external service.

| File | Written by | Content |
|---|---|---|
| `schedule.json` | schedule editor (`/api/schedule`) | `{"doses": [{"id", "time", "label", "notes"}], "next_id": n}`. Seeded on first run with three doses whose labels end in "(demo)". |
| `events.jsonl` | care loop and mission runner | One JSON object per line: `{"ts", "type", "dose_id", "run_id", "detail"}`. Types: `reminder_due`, `run_started`, `arrived_at_station`, `run_aborted`, `pickup_acknowledged`, `needs_attention`, `hover_test`. |
| `trim.json` | `PUT /api/trim` | `{"roll", "pitch"}` stick trim added to every command. |
| `calibration.json` | `POST /api/mission/calibrate-arrival` | `{"arrive_width"}`: marker width (fraction of the frame width) that counts as arrived. Overrides `MEDHOP_ARRIVE_WIDTH`. |
| `mission.json` | `PUT /api/mission/settings` | `{"drift_assist", "land_on_arrival"}`: the experimental drift-assist switch and the land-on-arrival switch. Each is off unless the file says `true`; saving one keeps the other. |
| `runs/<run_id>.json` | mission runner | Trace of one station run: result, abort reason, drift-assist summary, and per-frame samples (time, state, marker centre and width, yaw, pitch and roll commands, raw telemetry bytes). |

Notes on what the log does and does not say:

- `arrived_at_station` means the drone (or, in `sim` mode, the simulated drone: see `detail.mode`)
  reached the station marker. It does not mean anything was handed over.
- `pickup_acknowledged` is self-reported by pressing a button. Nothing here proves a dose was taken.
- Telemetry values in the run traces are raw bytes from the drone. Their units are not verified.

To start again from scratch, stop the backend and delete the files (keep this README). A file that
cannot be parsed is renamed to `<name>.corrupt-<unix time>` rather than overwritten.
