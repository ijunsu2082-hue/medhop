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
| `mission.json` | `PUT /api/mission/settings` | `{"drift_assist", "land_on_arrival", "auto_fly", "avoid"}`: the experimental drift-assist switch, the land-on-arrival switch, the "Fly automatically when a dose is due" switch, and waiting for people and obstacles (`"hold"` or `"off"`; without it, `MEDHOP_AVOID` or its default applies). Each switch is off unless the file says `true`; saving one keeps the others. |
| `runs/<run_id>.json` | mission runner | Trace of one station run: result, abort reason, drift-assist summary, and per-frame samples (time, state, marker centre and width, yaw, pitch and roll commands, raw telemetry bytes). |

Notes on what the log does and does not say:

- `arrived_at_station` means the drone (or, in `sim` mode, the simulated drone: see `detail.mode`)
  reached the station marker. It does not mean anything was handed over.
- `pickup_acknowledged` is self-reported by pressing a button. Nothing here proves a dose was taken.
- Telemetry values in the run traces are raw bytes from the drone. Their units are not verified.

To start again from scratch, stop the backend and delete the files (keep this README). A file that
cannot be parsed is renamed to `<name>.corrupt-<unix time>` rather than overwritten.

## The browser simulator

The browser build of the site (`npm run dev:browser`, and the hosted site) writes nothing here. Its
simulator keeps its data in the browser's own storage (`localStorage`, one key per file, same formats as
above; `frontend/src/engine/care/store.ts`):

| Python file | Browser storage key | Kept |
|---|---|---|
| `schedule.json` | `medhop.v1.schedule` | in the browser's storage, across visits |
| `events.jsonl` | `medhop.v1.events` | in the browser's storage, across visits |
| `mission.json` | `medhop.v1.mission` | in the browser's storage, across visits |
| `trim.json` | `medhop.v1.trim` | in memory, for this visit only |
| `calibration.json` | `medhop.v1.calibration` | in memory, for this visit only |
| `runs/<run_id>.json` | `medhop.v1.runs.<run_id>` | in memory, for this visit only |

If the browser refuses storage (a private window, blocked site data, a full quota), that data is kept in
memory for the visit and the page keeps working. A stored value that is not valid JSON is set aside under
`<key>.corrupt-<unix time>`. To start again, clear the site's data in the browser.
