import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { CareEvent, DoseStatus, DoseToday, Status } from "../api/types";
import { useStatus } from "../hooks/useStatus";
import { newlyNeedingAttention } from "../logic/care";
import {
  doseTableStatusLine,
  eventDateIfNotToday,
  eventDetailText,
  lastRunResult,
  localDateOf,
  simulatorSuffix,
} from "../logic/caregiver";
import { countItems, dayCounts, dayHeadline, splitStatusLine } from "../logic/caregiverSummary";
import { batteryLine } from "../logic/checklist";
import { formatDateWords } from "../logic/dateWords";
import { abortText, eventText, missionStateText } from "../text/wording";
import { ScheduleEditor } from "../components/caregiver/ScheduleEditor";
import "./caregiver.css";

const EVENTS_REFRESH_MS = 5000;
/** Recent events shown before "Show earlier" is pressed. */
const EVENTS_SHOWN = 8;

/** Events about the person's dose: bold ink titles. The others describe drone runs and recede. */
const CARE_EVENTS = new Set(["reminder_due", "arrived_at_station", "pickup_acknowledged", "needs_attention"]);

/** The mark beside a dose's state: filled once it arrived or was picked up, hollow while waiting, red when late. */
const DOSE_TONE: Record<DoseStatus, string> = {
  upcoming: "tone-info",
  due: "tone-warn",
  arrived: "tone-pass",
  acknowledged: "tone-pass",
  needs_attention: "tone-fail",
};

const WAITING = <p className="muted">Waiting for status.</p>;

function Section({ id, title, className, children }: { id: string; title: string; className: string; children: ReactNode }) {
  return (
    <section className={`section ${className}`} aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function DoseTable({ doses }: { doses: DoseToday[] }) {
  if (doses.length === 0) return <p className="muted">No doses scheduled today.</p>;
  const sorted = [...doses].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <div className="table-wrap">
      <table className="table dose-table" role="table">
        <caption className="sr-only">Today's doses and their status</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Time
            </th>
            <th scope="col" role="columnheader">
              Dose
            </th>
            <th scope="col" role="columnheader">
              Status
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {sorted.map((d) => {
            const { head, tail } = splitStatusLine(doseTableStatusLine(d));
            return (
              <tr key={d.id} className={`dose-row dose-${d.status}`} role="row">
                <td className="dose-time" role="cell">
                  {d.time}
                </td>
                <td className="dose-label" role="cell">
                  {d.label}
                  {d.notes && <span className="dose-notes">{d.notes}</span>}
                </td>
                <td className="dose-status-cell" role="cell">
                  <span className={`state dose-status ${DOSE_TONE[d.status] ?? "tone-info"}`}>
                    <span className="dot" aria-hidden="true" />
                    <span>{head}</span>
                  </span>
                  {tail && (
                    <>
                      {" "}
                      <span className="dose-status-detail">{tail}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
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
  backendDown,
  doses,
  today,
}: {
  events: CareEvent[] | null;
  failed: boolean;
  /** the shell already says the backend is not reachable; this list then says nothing more about it */
  backendDown: boolean;
  doses: DoseToday[];
  /** care.date_local; events from another day carry their date */
  today: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [focusRevealed, setFocusRevealed] = useState(false);
  const firstRevealed = useRef<HTMLLIElement | null>(null);
  const labelOf = (id: string | null) => (id ? doses.find((d) => d.id === id)?.label ?? id : null);

  // "Show earlier" goes away once pressed: focus the first event it revealed so keyboard focus is not lost.
  useEffect(() => {
    if (!focusRevealed) return;
    firstRevealed.current?.focus();
    setFocusRevealed(false);
  }, [focusRevealed]);

  const failedMsg = failed && !backendDown && <p className="msg msg-warn">Could not load events. Retrying every 5 s.</p>;
  if (events === null) return failedMsg || (backendDown ? WAITING : <p className="muted">Loading events.</p>);
  if (events.length === 0) {
    return (
      <>
        {failedMsg}
        <p className="muted">No events yet.</p>
      </>
    );
  }

  const shown = showAll ? events : events.slice(0, EVENTS_SHOWN);
  const items: ReactNode[] = [];
  let lastDay: string | null = null;
  shown.forEach((e, i) => {
    const day = localDateOf(e.ts);
    if (i === 0 || day !== lastDay) {
      items.push(
        <li key={`day-${i}-${day ?? "unknown"}`} className="event-day">
          <h3>{day ? formatDateWords(day) ?? day : "Date unknown"}</h3>
        </li>,
      );
    }
    lastDay = day;
    const detail = eventDetailText(e);
    const dose = labelOf(e.dose_id);
    const date = eventDateIfNotToday(e, today);
    const revealed = showAll && i === EVENTS_SHOWN;
    items.push(
      <li
        key={`${e.ts}-${e.type}-${i}`}
        className={`event event-${e.type} ${CARE_EVENTS.has(e.type) ? "event-care" : "event-run"}`}
        ref={revealed ? firstRevealed : undefined}
        tabIndex={revealed ? -1 : undefined}
      >
        <span className="event-time">
          {date && <span className="sr-only">{date} </span>}
          {e.time_local}
        </span>
        <span className="event-body">
          <span className="event-name">
            {eventText(e.type)}
            {simulatorSuffix(e)}
          </span>
          {dose && <span className="event-dose">{dose}</span>}
          {detail && <span className="event-detail">{detail}</span>}
        </span>
      </li>,
    );
  });

  return (
    <>
      {failedMsg}
      <ol className="events">{items}</ol>
      {!showAll && events.length > EVENTS_SHOWN && (
        <button
          type="button"
          className="btn events-more"
          onClick={() => {
            setShowAll(true);
            setFocusRevealed(true);
          }}
        >
          Show earlier
        </button>
      )}
    </>
  );
}

function NotificationControl() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");
  if (perm === "unsupported") return <p className="hint">Browser notifications are not available here.</p>;
  if (perm === "granted") return <p className="hint">Browser notifications are on for doses that need attention.</p>;
  if (perm === "denied") return <p className="hint">Browser notifications are blocked in this browser's settings.</p>;
  return (
    <button type="button" className="btn btn-quiet" onClick={() => void Notification.requestPermission().then(setPerm)}>
      Turn on browser notifications
    </button>
  );
}

function DroneSummary({ status, lastRun, stale }: { status: Status; lastRun: string; stale: boolean }) {
  const t = status.telemetry;
  return (
    <dl className="kv drone-kv">
      <div>
        <dt>Video</dt>
        <dd>
          {status.link.video_live ? (
            <span className={`state ${stale ? "tone-info" : "tone-pass"}`}>
              <span className="dot" aria-hidden="true" />
              {stale ? "Live (last known)" : "Live"}
            </span>
          ) : (
            <span className="state tone-info">
              <span className="dot" aria-hidden="true" />
              No video
            </span>
          )}
        </dd>
      </div>
      <div className="drone-battery">
        <dt>Battery</dt>
        {t && t.battery_raw !== null && <dd>{t.battery_raw}</dd>}
        <dd className="drone-battery-line">{batteryLine(t).text}</dd>
      </div>
      <div>
        <dt>Station run now</dt>
        <dd>
          {missionStateText(status.mission.state)}
          {status.mission.state === "aborted" ? `: ${abortText(status.mission.reason)}` : ""}
        </dd>
      </div>
      <div>
        <dt>Last run result</dt>
        <dd>{lastRun}</dd>
      </div>
      {typeof status.mission.auto_fly === "boolean" && (
        <div>
          <dt>Automatic flights</dt>
          <dd>{status.mission.auto_fly ? "On" : "Off"}</dd>
        </div>
      )}
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

  return (
    <div className="caregiver container">
      <header className="caregiver-head">
        {status ? (
          <>
            <p className="caregiver-when">
              {formatDateWords(status.care.date_local) ?? status.care.date_local}, {status.care.now_local}
              {reachable === false ? " (last known)" : ""}
            </p>
            <h1 className="caregiver-headline">
              <span className="sr-only">Caregiver: </span>
              {dayHeadline(doses)}
            </h1>
            <p className="caregiver-counts">
              {countItems(dayCounts(doses)).map((item, i, all) => (
                <Fragment key={item.words}>
                  {i > 0 && " "}
                  <span className="caregiver-count">
                    {item.count} {item.words}
                    {i < all.length - 1 && <span aria-hidden="true">{" ·"}</span>}
                  </span>
                </Fragment>
              ))}
            </p>
          </>
        ) : (
          <h1 className="caregiver-headline">Caregiver</h1>
        )}
      </header>

      {attention.length > 0 && (
        <div className="banner banner-attention" role="alert">
          <span>
            <strong>Needs attention: </strong>
            {attention.map((d) => `${d.label} (${d.time})`).join(", ")} not acknowledged in time.
          </span>
        </div>
      )}

      <div className="caregiver-grid">
        <div className="caregiver-main">
          <Section id="h-today" title="Today" className="caregiver-today">
            {status ? <DoseTable doses={doses} /> : WAITING}
            <div className="caregiver-foot">
              <p className="hint">
                "Acknowledged" is the person's own report that they picked the pouch up. It does not confirm the medicine was taken.
              </p>
              <p className="hint">Status is per day and resets at midnight.</p>
              <NotificationControl />
            </div>
          </Section>

          <Section id="h-schedule" title="Schedule" className="caregiver-schedule">
            <p className="hint schedule-note">Demo data: use made-up labels only. No real names or medicines.</p>
            <ScheduleEditor backendDown={reachable === false} />
          </Section>
        </div>

        <div className="caregiver-rail">
          <Section id="h-events" title="Recent events" className="caregiver-events">
            <EventsList
              events={events}
              failed={failed}
              backendDown={reachable === false}
              doses={doses}
              today={status?.care.date_local ?? ""}
            />
          </Section>

          <Section id="h-drone" title="Drone" className="caregiver-drone">
            {status ? (
              <DroneSummary
                status={status}
                lastRun={lastRunResult(events, status.care.date_local)}
                stale={reachable === false}
              />
            ) : (
              WAITING
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
