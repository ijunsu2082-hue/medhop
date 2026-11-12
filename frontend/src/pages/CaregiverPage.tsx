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
import { countItems, dayCounts, dayHeadline, isCodeLike, splitStatusLine } from "../logic/caregiverSummary";
import { batteryLine } from "../logic/checklist";
import { formatDateWords } from "../logic/dateWords";
import { abortText, eventText, missionStateText } from "../text/wording";
import { IconBell, IconClock, IconCross, IconDrone, IconInfo, IconPass, IconPin, IconWarn } from "../components/Icons";
import { ScheduleEditor } from "../components/caregiver/ScheduleEditor";
import "./caregiver.css";

const EVENTS_REFRESH_MS = 5000;
/** Recent events shown before "Show earlier" is pressed. */
const EVENTS_SHOWN = 8;

/** Events about the person's dose: bold ink titles. The others describe drone runs and recede. */
const CARE_EVENTS = new Set(["reminder_due", "arrived_at_station", "pickup_acknowledged", "needs_attention"]);

function StatusIcon({ status }: { status: DoseStatus }) {
  switch (status) {
    case "upcoming":
      return <IconClock size={20} />;
    case "due":
      return <IconBell size={20} />;
    case "arrived":
      return <IconPin size={20} />;
    case "acknowledged":
      return <IconPass size={20} />;
    case "needs_attention":
      return <IconCross size={20} />;
    default:
      return <IconInfo size={20} />;
  }
}

function EventIcon({ type }: { type: string }) {
  switch (type) {
    case "reminder_due":
      return <IconBell size={16} />;
    case "run_started":
    case "hover_test":
      return <IconDrone size={16} />;
    case "arrived_at_station":
      return <IconPin size={16} />;
    case "run_aborted":
      return <IconWarn size={16} />;
    case "pickup_acknowledged":
      return <IconPass size={16} />;
    case "needs_attention":
      return <IconCross size={16} />;
    default:
      return <IconInfo size={16} />;
  }
}

/** Section per contract C3: a 2px rule, the index number, the h2, then the content directly on paper. */
function Section({
  id,
  index,
  title,
  className,
  children,
}: {
  id: string;
  index: string;
  title: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <section className={`section ${className}`} aria-labelledby={id}>
      <div className="section-head">
        <span className="section-index" aria-hidden="true">
          {index}
        </span>
        <h2 id={id}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function DoseTable({ doses }: { doses: DoseToday[] }) {
  if (doses.length === 0) return <p className="caregiver-empty">No doses scheduled today.</p>;
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
                  <span className={`dose-status dose-status-${d.status}`}>
                    <StatusIcon status={d.status} />
                    <span className="dose-status-word">{head}</span>
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
  doses,
  today,
}: {
  events: CareEvent[] | null;
  failed: boolean;
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

  const failedMsg = failed && <p className="msg msg-warn">Could not load events. Retrying every 5 s.</p>;
  if (events === null) return failedMsg || <p className="caregiver-empty">Loading events.</p>;
  if (events.length === 0) {
    return (
      <>
        {failedMsg}
        <p className="caregiver-empty">No events yet.</p>
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
          {date && <span className="event-date">{date} </span>}
          {e.time_local}
        </span>
        <span className="event-icon" aria-hidden="true">
          <EventIcon type={e.type} />
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
  if (perm === "unsupported") return <p className="small notify-state">Browser notifications are not available here.</p>;
  if (perm === "granted") return <p className="small notify-state">Browser notifications are on for doses that need attention.</p>;
  if (perm === "denied") return <p className="small notify-state">Browser notifications are blocked in this browser's settings.</p>;
  return (
    <button type="button" className="btn btn-quiet notify-btn" onClick={() => void Notification.requestPermission().then(setPerm)}>
      <IconBell size={16} /> Turn on browser notifications
    </button>
  );
}

function DroneSummary({ status, lastRun, stale }: { status: Status; lastRun: string; stale: boolean }) {
  const t = status.telemetry;
  return (
    <>
      {stale && (
        <p className="drone-stale">
          <IconInfo size={16} />
          <span>Last known values; backend not reachable.</span>
        </p>
      )}
      <dl className="kv drone-kv">
        <dt>Mode</dt>
        <dd>
          {status.mode === "sim" ? <span className="stamp">Simulator</span> : <span className="stamp stamp--amber">Real drone</span>}
        </dd>
        <dt>Video</dt>
        <dd>
          {status.link.video_live ? (
            <span className="status-line">
              <span className={`status-sq ${stale ? "tone-info" : "tone-pass"}`} aria-hidden="true" />
              {stale ? "Live (last known)" : "Live"}
            </span>
          ) : (
            <span className="status-line">
              <span className="status-sq status-sq--hollow tone-info" aria-hidden="true" />
              No video
            </span>
          )}
        </dd>
        <dt>Battery</dt>
        <dd className="drone-battery">
          {t && t.battery_raw !== null && <span className="drone-battery-raw">{t.battery_raw}</span>}
          <span className="drone-battery-line">
            {batteryLine(t)
              .text.split(/(\d+)/)
              .map((part, i) => (i % 2 === 1 ? <span key={i} className="tnum">{part}</span> : part))}
          </span>
        </dd>
        <dt>Station run now</dt>
        <dd>
          {missionStateText(status.mission.state)}
          {status.mission.state === "aborted" ? `: ${abortText(status.mission.reason)}` : ""}
        </dd>
        <dt>Last run result</dt>
        <dd className={isCodeLike(lastRun) ? "data" : undefined}>{lastRun}</dd>
        {typeof status.mission.auto_fly === "boolean" && (
          <>
            <dt>Automatic flights</dt>
            <dd>{status.mission.auto_fly ? "On" : "Off"}</dd>
          </>
        )}
      </dl>
    </>
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
              {formatDateWords(status.care.date_local) ?? status.care.date_local},{" "}
              <span className="data">{status.care.now_local}</span>
              {reachable === false ? " (last known; backend not reachable)" : ""}
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
                    <span className="data">{item.count}</span> {item.words}
                    {i < all.length - 1 && <span aria-hidden="true">{" ·"}</span>}
                  </span>
                </Fragment>
              ))}
            </p>
          </>
        ) : (
          <>
            <h1 className="caregiver-headline">Caregiver</h1>
            <p className="caregiver-counts">Waiting for status from the backend.</p>
          </>
        )}
      </header>

      {attention.length > 0 && (
        <div className="banner banner-attention" role="alert">
          <IconCross size={24} />
          <span>
            <strong>Needs attention: </strong>
            {attention.map((d) => `${d.label} (${d.time})`).join(", ")} not acknowledged in time.
          </span>
        </div>
      )}

      <div className="caregiver-grid">
        <div className="caregiver-main">
          <Section id="h-today" index="01" title="Today" className="caregiver-today">
            {status ? <DoseTable doses={doses} /> : <p className="caregiver-empty">Waiting for status from the backend.</p>}
            <div className="caregiver-foot">
              <p className="small">
                "Acknowledged" is the person's own report that they picked the pouch up. It does not confirm the medicine was taken.
              </p>
              <p className="small">Status is per day and resets at midnight.</p>
              <div className="caregiver-notify">
                <NotificationControl />
              </div>
            </div>
          </Section>

          <Section id="h-schedule" index="02" title="Schedule" className="caregiver-schedule">
            <p className="schedule-note">
              <span className="stamp">Demo data</span>
              <span>Use made-up labels only. No real names or medicines.</span>
            </p>
            <ScheduleEditor />
          </Section>
        </div>

        <div className="caregiver-rail">
          <Section id="h-events" index="03" title="Recent events" className="caregiver-events">
            <EventsList events={events} failed={failed} doses={doses} today={status?.care.date_local ?? ""} />
          </Section>

          <Section id="h-drone" index="04" title="Drone" className="caregiver-drone">
            {status ? (
              <DroneSummary
                status={status}
                lastRun={lastRunResult(events, status.care.date_local)}
                stale={reachable === false}
              />
            ) : (
              <p className="caregiver-empty">Waiting for status.</p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
