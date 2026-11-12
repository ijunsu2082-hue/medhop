import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { CareEvent, DoseStatus, DoseToday, Status } from "../api/types";
import { useStatus } from "../hooks/useStatus";
import { newlyNeedingAttention } from "../logic/care";
import { doseTableStatusLine, eventDetailText, eventWhen, lastRunResult, simulatorSuffix } from "../logic/caregiver";
import { batteryLine } from "../logic/checklist";
import { abortText, eventText, missionStateText } from "../text/wording";
import { IconBell, IconCheck, IconClock, IconPin, IconWarn } from "../components/Icons";
import { ScheduleEditor } from "../components/caregiver/ScheduleEditor";
import "./caregiver.css";

const EVENTS_REFRESH_MS = 5000;

function StatusIcon({ status }: { status: DoseStatus }) {
  switch (status) {
    case "upcoming":
      return <IconClock />;
    case "due":
      return <IconBell />;
    case "arrived":
      return <IconPin />;
    case "acknowledged":
      return <IconCheck />;
    case "needs_attention":
      return <IconWarn />;
    default:
      return null;
  }
}

function DoseTable({ doses }: { doses: DoseToday[] }) {
  if (doses.length === 0) return <p className="muted">No doses scheduled today.</p>;
  const sorted = [...doses].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Today's doses and their status</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Dose</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.id} className={`dose-row dose-${d.status}`}>
              <td className="dose-time">{d.time}</td>
              <td className="dose-label">
                {d.label}
                {d.notes && <span className="small muted block">{d.notes}</span>}
              </td>
              <td className="dose-status-cell">
                <span className={`dose-status dose-status-${d.status}`}>
                  <StatusIcon status={d.status} />
                  <span>{doseTableStatusLine(d)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useEvents(): { events: CareEvent[] | null; failed: boolean } {
  const [events, setEvents] = useState<CareEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const r = await api.events(50);
        if (!disposed) {
          setEvents(Array.isArray(r.events) ? r.events : []);
          setFailed(false);
        }
      } catch {
        if (!disposed) setFailed(true);
      }
      if (!disposed) timer = setTimeout(load, EVENTS_REFRESH_MS);
    };
    void load();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { events, failed };
}

function EventsList({
  events,
  failed,
  doses,
  today,
}: {
  events: CareEvent[] | null;
  failed: boolean;
  doses: DoseToday[];
  /** care.date_local; events from another day show their date */
  today: string;
}) {
  const labelOf = (id: string | null) => (id ? doses.find((d) => d.id === id)?.label ?? id : null);

  return (
    <>
      {failed && <p className="msg msg-warn">Could not load events. Retrying every 5 s.</p>}
      {events === null ? (
        !failed && <p className="muted">Loading events.</p>
      ) : events.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol className="events">
          {events.map((e, i) => {
            const detail = eventDetailText(e);
            const dose = labelOf(e.dose_id);
            return (
              <li key={`${e.ts}-${e.type}-${i}`} className={`event event-${e.type}`}>
                <span className="event-time">{eventWhen(e, today)}</span>
                <span className="event-dot" aria-hidden="true" />
                <span className="event-body">
                  <span className="event-name">
                    {eventText(e.type)}
                    {simulatorSuffix(e)}
                  </span>
                  {(dose || detail) && (
                    <span className="event-meta">
                      {dose && <span className="event-dose">{dose}</span>}
                      {detail && <span className="event-detail">{detail}</span>}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function NotificationControl() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");
  if (perm === "unsupported") return <p className="small muted">Browser notifications are not available here.</p>;
  if (perm === "granted") return <p className="small">Browser notifications are on for doses that need attention.</p>;
  if (perm === "denied") return <p className="small muted">Browser notifications are blocked in this browser's settings.</p>;
  return (
    <button type="button" className="btn" onClick={() => void Notification.requestPermission().then(setPerm)}>
      <IconBell size={16} /> Turn on browser notifications
    </button>
  );
}

function DroneSummary({ status, lastRun }: { status: Status; lastRun: string }) {
  const t = status.telemetry;
  return (
    <dl className="kv drone-kv">
      <dt>Mode</dt>
      <dd>{status.mode === "sim" ? "Simulator" : "Real drone"}</dd>
      <dt>Video</dt>
      <dd>{status.link.video_live ? "Live" : "No video"}</dd>
      <dt>Battery</dt>
      <dd className="small muted">{batteryLine(t).text}</dd>
      <dt>Station run now</dt>
      <dd>
        {missionStateText(status.mission.state)}
        {status.mission.state === "aborted" ? `: ${abortText(status.mission.reason)}` : ""}
      </dd>
      <dt>Last run result</dt>
      <dd>{lastRun}</dd>
    </dl>
  );
}

export function CaregiverPage() {
  const { status, reachable } = useStatus();
  const prevStatuses = useRef<Map<string, string> | null>(null);
  const { events, failed } = useEvents();

  useEffect(() => {
    document.title = "Caregiver - MedHop";
  }, []);

  const doses = status?.care.doses ?? [];

  // Browser notification when a dose enters needs_attention while this page is open (permission asked by button only).
  useEffect(() => {
    if (!status) return;
    const fresh = newlyNeedingAttention(prevStatuses.current, status.care.doses);
    prevStatuses.current = new Map(status.care.doses.map((d) => [d.id, d.status]));
    if (fresh.length === 0 || !("Notification" in window) || Notification.permission !== "granted") return;
    for (const d of fresh) {
      new Notification("MedHop: needs attention", {
        body: `${d.label} (${d.time}) has not been acknowledged.`,
        tag: `medhop-attention-${d.id}`,
      });
    }
  }, [status]);

  const attention = doses.filter((d) => d.status === "needs_attention");
  const acknowledgedCount = doses.filter((d) => d.status === "acknowledged").length;
  const upcomingCount = doses.filter((d) => d.status === "upcoming").length;

  return (
    <div className="caregiver">
      <header className="caregiver-head">
        <div className="caregiver-title">
          <h1>Caregiver</h1>
          {status && (
            <p className="muted small caregiver-when">
              {status.care.date_local}, now {status.care.now_local}
              {reachable === false ? " (last known; backend not reachable)" : ""}
            </p>
          )}
        </div>
        {status && (
          <ul className="stat-tiles" aria-label="Today's doses at a glance">
            <li className={`stat-tile stat-attention${attention.length > 0 ? " stat-active" : ""}`}>
              <IconWarn size={20} />
              <span className="stat-label">Needs attention</span>
              <span className="stat-value">{attention.length}</span>
            </li>
            <li className="stat-tile stat-acknowledged">
              <IconCheck size={20} />
              <span className="stat-label">Acknowledged</span>
              <span className="stat-value">{acknowledgedCount}</span>
            </li>
            <li className="stat-tile stat-upcoming">
              <IconClock size={20} />
              <span className="stat-label">Upcoming</span>
              <span className="stat-value">{upcomingCount}</span>
            </li>
          </ul>
        )}
      </header>

      {attention.length > 0 && (
        <div className="banner banner-attention" role="alert">
          <IconWarn size={20} />
          <span>
            <strong>Needs attention: </strong>
            {attention.map((d) => `${d.label} (${d.time})`).join(", ")} not acknowledged in time.
          </span>
        </div>
      )}

      <div className="caregiver-grid">
        <section className="panel caregiver-today" aria-labelledby="h-today">
          <h2 id="h-today">Today</h2>
          {status ? <DoseTable doses={doses} /> : <p className="muted">Waiting for status from the backend.</p>}
          <p className="small muted caregiver-foot">
            "Acknowledged" is the person's own report that they picked the pouch up. It does not confirm the medicine was taken.
          </p>
          <p className="small muted">Status is per day and resets at midnight.</p>
          <NotificationControl />
        </section>

        <section className="panel caregiver-events" aria-labelledby="h-events">
          <h2 id="h-events">Recent events</h2>
          <EventsList events={events} failed={failed} doses={doses} today={status?.care.date_local ?? ""} />
        </section>

        <section className="panel caregiver-schedule" aria-labelledby="h-schedule">
          <h2 id="h-schedule">Schedule (demo data)</h2>
          <ScheduleEditor />
        </section>

        <section className="panel caregiver-drone" aria-labelledby="h-drone">
          <h2 id="h-drone">Drone</h2>
          {status ? <DroneSummary status={status} lastRun={lastRunResult(events, status.care.date_local)} /> : <p className="muted">Waiting for status.</p>}
        </section>
      </div>
    </div>
  );
}
