// API objects, typed exactly per docs/SPEC.md section 7. Nullable fields are nullable here too.

export type Mode = "sim" | "real";

export interface LinkStatus {
  video_live: boolean;
  frame_age_s: number | null;
  fps: number | null;
  /** Revision 3. Optional: an older backend does not send these, and then the drone link is shown as unknown. */
  control_up?: boolean;
  drone_seen?: boolean;
  sticks_blocked?: boolean;
}

/** null until the first status message from the drone. Values are raw and their units are NOT verified. */
export interface Telemetry {
  simulated: boolean;
  age_s: number | null;
  fly_state_raw: number | null;
  battery_raw: number | null;
  flags_raw: number | null;
  battery_low: boolean;
  /** Revision 3. false: the backend's battery check is off (the byte's meaning is unverified). */
  battery_check_enabled?: boolean;
}

export interface Trim {
  roll: number;
  pitch: number;
}

export interface PilotStatus {
  manual_active: boolean;
  max_stick: number;
  estop_active: boolean;
  /** Revision 3. True once the stop bit has gone out on an open socket for 0.5 s since the latch. */
  estop_delivered?: boolean;
}

export interface MarkerObservation {
  id: number;
  cx: number;
  cy: number;
  /** marker width as a fraction of frame width */
  width: number;
  age_s: number;
}

/** Advisory person check (pretrained YOLO). Never a safety system. */
export interface PersonCheck {
  enabled: boolean;
  detected: boolean;
  count: number;
  age_s: number | null;
}

export interface VisionStatus {
  marker: MarkerObservation | null;
  person: PersonCheck;
  brightness: number | null;
  dark: boolean;
}

export type MissionState =
  | "idle"
  | "countdown"
  | "taking_off"
  | "searching"
  | "approaching"
  | "arrived"
  | "landing"
  | "done"
  | "aborted"
  | "hover_test";

export type BlockerCode =
  | "no_video"
  | "estop_active"
  | "already_running"
  | "person_in_view"
  | "battery_low"
  | "marker_too_close"
  | "confirm_airborne_required"
  | "marker_not_visible"
  | "no_pilot_link"
  | "drone_flying"
  | "recent_toggle";

export type AbortReason =
  | "marker_not_found"
  | "marker_lost"
  | "off_axis"
  | "video_stale"
  | "timeout"
  | "pilot_took_over"
  | "person_in_view"
  | "battery_low"
  | "estop"
  | "pilot_link_lost"
  | "unexpected_descent"
  | "takeoff_refused"
  | "not_lined_up"
  | "already_at_station";

/** Experimental drift assist (SPEC section 6, Revision 2). Roll values are stick fractions. */
export interface DriftAssist {
  enabled: boolean;
  active: boolean;
  roll: number;
  disabled_reason: string | null;
  suggested_trim_roll: number | null;
}

export interface MissionStatus {
  state: MissionState;
  /** abort reason code; string so that unknown codes from a newer backend still render */
  reason: AbortReason | string | null;
  run_id: string | null;
  dose_id: string | null;
  elapsed_s: number;
  command: { yaw: number; pitch: number };
  arrive_width: number;
  land_on_arrival: boolean;
  /** Revision 2. Optional: an older backend does not send it, and then the drift assist panel is hidden. */
  drift_assist?: DriftAssist | null;
  can_start: boolean;
  blockers: (BlockerCode | string)[];
  /** How the last run ended its arrival (SPEC 10.2). null before the run arrives; missing from an older backend. */
  last_landing?: "sent" | "skipped_settle_guard_undecided" | "refused_by_mixer" | "off" | "safe_landing" | null;
  // Automatic mode. Optional: an older backend does not send these, and then the Automatic view says so.
  /** the current or last run was automatic */
  automatic?: boolean;
  /** persisted switch: start an automatic run when a dose comes due */
  auto_fly?: boolean;
  /** blockers for an automatic start (no confirm needed); may include drone_flying */
  auto_blockers?: (BlockerCode | string)[];
  can_start_auto?: boolean;
  /** ESTIMATED metres to the sign now; null when it is not in view */
  distance_m?: number | null;
  /** ESTIMATED metres from the sign where a run lands */
  arrive_distance_m?: number;
  /** the sign grew enough in this run to show the drone flew toward it */
  flight_confirmed?: boolean;
  /** seconds left on the ground before an automatic takeoff; null outside the countdown */
  countdown_remaining_s?: number | null;
  /** an automatic run stopped early without landing: the drone may still be in the air */
  needs_pilot?: boolean;
  /** the pilot marked the drone ready on its start spot; scheduled automatic flights need it */
  ready_for_dose?: boolean;
}

export interface HoverTestResult {
  pass: boolean;
  drift_frame_widths: number;
  /** metres, an ESTIMATE using the printed marker size as scale */
  drift_m_estimate: number;
  width_change_pct: number;
  visible_pct: number;
}

export interface HoverTest {
  running: boolean;
  elapsed_s: number;
  result: HoverTestResult | null;
}

export type DoseStatus = "upcoming" | "due" | "arrived" | "acknowledged" | "needs_attention";

export interface DoseToday {
  id: string;
  /** 24-hour HH:MM */
  time: string;
  label: string;
  notes: string;
  status: DoseStatus;
  /** local "HH:MM" (SPEC Revision 2). A number (unix seconds) from an older backend is tolerated and formatted. */
  arrived_at: string | number | null;
  acknowledged_at: string | number | null;
  /** Revision 3: mode of the arrival event ("sim" | "real"), null when not arrived. Optional for older backends. */
  arrived_mode?: Mode | null;
}

export interface CareStatus {
  now_local: string;
  date_local: string;
  doses: DoseToday[];
  next_due_id: string | null;
}

export interface Status {
  server_time: number;
  mode: Mode;
  link: LinkStatus;
  telemetry: Telemetry | null;
  trim: Trim;
  pilot: PilotStatus;
  vision: VisionStatus;
  mission: MissionStatus;
  hover_test: HoverTest | null;
  care: CareStatus;
}

// ---- REST bodies ----

export interface ScheduleDose {
  id: string;
  time: string;
  label: string;
  notes: string;
}

export interface ScheduleResponse {
  doses: ScheduleDose[];
}

export interface ScheduleDoseInput {
  time: string;
  label: string;
  notes: string;
}

export interface MissionStartBody {
  /** manual runs only; an automatic run does not need it */
  confirm_airborne?: true;
  dose_id: string | null;
  automatic?: boolean;
}

export interface MissionSettingsBody {
  land_on_arrival?: boolean;
  drift_assist?: boolean;
  auto_fly?: boolean;
}

export interface BlockersResponse {
  blockers: (BlockerCode | string)[];
}

export type EventType =
  | "reminder_due"
  | "run_started"
  | "arrived_at_station"
  | "run_aborted"
  | "pickup_acknowledged"
  | "needs_attention"
  | "hover_test"
  | "auto_run_skipped";

export interface CareEvent {
  ts: number;
  time_local: string;
  type: EventType | string;
  dose_id: string | null;
  run_id: string | null;
  detail: Record<string, unknown> | null;
}

export interface EventsResponse {
  events: CareEvent[];
}

export interface HealthResponse {
  ok: boolean;
  mode: Mode;
}

// ---- Control WebSocket ----

export interface AxesMessage {
  type: "axes";
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export type ControlMessage =
  | AxesMessage
  | { type: "takeoff_land" }
  | { type: "estop" }
  | { type: "estop_reset" }
  | { type: "calibrate" }
  | { type: "max_stick"; value: number };

/** Revision 3 refusal codes on control-socket errors. */
export type ControlErrorCode = "landing_in_progress" | "drone_link_down" | "estop_active" | "toggle_guard";

// Revision 3 fields are optional so that an older backend (no `of` on errors, no hello) still parses.
export type ControlServerMessage =
  | { type: "ack"; of: string; delivered?: boolean }
  | { type: "error"; message: string; of?: string; code?: ControlErrorCode | string }
  | { type: "hello"; pilot: boolean };
