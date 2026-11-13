import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useStatus } from "../hooks/useStatus";
import { ACK_COOLDOWN_MS, arrivalLine, careFocus, isEarlyArrival, reminderMaySpeak, spokenReminder } from "../logic/care";
import { formatDateWords } from "../logic/dateWords";
import "./care.css";

const REPEAT_MS = 2 * 60 * 1000;
const CHECK_MS = 5000;
const THANKS_MS = 20000;

const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;

function speak(text: string) {
  if (!speechSupported) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

export function CarePage() {
  const { status, reachable } = useStatus();
  const [speechOn, setSpeechOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sending, setSending] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const [thanks, setThanks] = useState<{ id: string; label: string; at: number } | null>(null);
  // True for ACK_COOLDOWN_MS after a successful "I picked it up": the button stays disabled meanwhile.
  const [coolingDown, setCoolingDown] = useState(false);
  const lastSpoken = useRef(new Map<string, number>());

  useEffect(() => {
    document.title = "Care - MedHop";
  }, []);

  // A dose acknowledged moments ago is not offered again while the status snapshot catches up.
  const focus = status ? careFocus(status.care, thanks?.id ?? null) : null;
  const pendingDose = focus?.kind === "pending" ? focus.dose : null;
  const nowLocal = status?.care.now_local ?? "";

  // Keep a ref to the current text so the timer always speaks the latest wording (e.g. once the pouch arrives).
  // An early arrival is not spoken until the clock reaches the dose time.
  const speechText = pendingDose && reminderMaySpeak(pendingDose, nowLocal) ? spokenReminder(pendingDose) : null;
  const speechTextRef = useRef(speechText);
  speechTextRef.current = speechText;
  const pendingId = pendingDose?.id ?? null;
  // Only a dose whose reminder may be spoken now takes part in the repeat timer.
  const speakId = speechText ? pendingId : null;

  const maybeSpeak = useCallback(() => {
    if (!speechOn || muted || !speakId || !speechTextRef.current) return;
    const last = lastSpoken.current.get(speakId);
    if (last === undefined || Date.now() - last >= REPEAT_MS) {
      lastSpoken.current.set(speakId, Date.now());
      speak(speechTextRef.current);
    }
  }, [speechOn, muted, speakId]);

  useEffect(() => {
    maybeSpeak();
    const t = setInterval(maybeSpeak, CHECK_MS);
    return () => clearInterval(t);
  }, [maybeSpeak]);

  useEffect(() => {
    if (muted && speechSupported) window.speechSynthesis.cancel();
  }, [muted]);

  useEffect(() => {
    if (!thanks) return;
    const t = setTimeout(() => setThanks(null), THANKS_MS);
    return () => clearTimeout(t);
  }, [thanks]);

  useEffect(() => {
    if (!coolingDown) return;
    const t = setTimeout(() => setCoolingDown(false), ACK_COOLDOWN_MS);
    return () => clearTimeout(t);
  }, [coolingDown]);

  useEffect(() => () => {
    if (speechSupported) window.speechSynthesis.cancel();
  }, []);

  const turnOnSpeech = () => {
    setSpeechOn(true);
    setMuted(false);
    // Speaking inside the click is what unlocks speech in browsers that block it before a user gesture.
    speak(speechText ?? "Spoken reminders are on.");
    if (speakId) lastSpoken.current.set(speakId, Date.now());
  };

  const acknowledge = async () => {
    if (!pendingDose) return;
    setSending(true);
    setAckError(null);
    try {
      await api.acknowledge(pendingDose.id);
      setThanks({ id: pendingDose.id, label: pendingDose.label, at: Date.now() });
      setCoolingDown(true);
      if (speechSupported) window.speechSynthesis.cancel();
    } catch {
      setAckError("That did not go through. Please press the button again, or tell your carer.");
    } finally {
      setSending(false);
    }
  };

  // The clock, split so the colon can be set tight: "14:26" -> hours, colon, minutes.
  const clock = status ? status.care.now_local : "";
  const colonAt = clock.indexOf(":");
  const dateWords = status ? formatDateWords(status.care.date_local) : null;

  const thanksLine = thanks && (
    <p className="care-thanks" role="status">
      Thank you. We noted that you picked up {thanks.label}.
    </p>
  );

  let main: ReactNode;
  // Nothing to act on: the same block and height, a quieter headline, no button.
  const quiet = !(reachable !== false && status && focus?.kind === "pending");
  if (reachable === false || !status || !focus) {
    main = (
      <>
        <p className="care-quiet-title">
          {reachable === false ? "The reminder system cannot be reached right now." : "Loading your reminders."}
        </p>
        {reachable === false && <p className="care-support">It will keep trying by itself.</p>}
      </>
    );
  } else if (focus.kind === "pending") {
    const d = focus.dose;
    const arrival = arrivalLine(d);
    const early = isEarlyArrival(d, status.care.now_local);
    const waiting = sending || coolingDown;
    const note = sending ? "Your answer is being sent." : coolingDown ? "Ready in a moment." : "";
    main = (
      <>
        {/* One statement, read as one sentence: the lead, then the dose label. After an acknowledgement "Next:"
            heads the same statement, so the block visibly moves on and a second tap is clearly for a different dose. */}
        <div className="care-statement">
          {thanks && <p className="care-next">Next:</p>}
          <p className="care-lead">{early ? `Coming up at ${d.time}:` : "It is time for:"}</p>{" "}
          <p className="care-dose">{d.label}</p>
        </div>
        <p className="care-sub">{early ? "It is not time for it yet." : `This was due at ${d.time}.`}</p>
        {d.notes && <p className="care-sub">{d.notes}</p>}
        {arrival && (
          <p className="care-arrived state tone-pass">
            <span className="dot" aria-hidden="true" />
            <span>{arrival}.</span>
          </p>
        )}
        {ackError && (
          <p className="care-error state tone-fail" role="alert">
            <span className="dot" aria-hidden="true" />
            <span>{ackError}</span>
          </p>
        )}
        {/* Pinned to the bottom edge of the block, so the button never moves when lines above come and go. */}
        <div className="care-action">
          <p className="care-ack-note" data-empty={note ? undefined : "true"}>
            {note}
          </p>
          <button
            type="button"
            className="care-ack"
            onClick={() => void acknowledge()}
            disabled={waiting}
            aria-busy={sending ? true : undefined}
          >
            {sending ? "Sending..." : "I picked it up"}
          </button>
        </div>
      </>
    );
  } else if (focus.kind === "upcoming") {
    main = (
      <>
        <p className="care-upnext">
          <span className="care-upnext-lead">Next:</span> <span className="care-quiet-title">{focus.dose.label}</span>{" "}
          <span className="care-upnext-at">
            at <span className="care-upnext-time">{focus.dose.time}</span>
          </span>
        </p>
        <p className="care-support">Nothing to do right now.</p>
      </>
    );
  } else if (focus.kind === "all_done") {
    main = <p className="care-quiet-title">All done for today.</p>;
  } else {
    main = <p className="care-quiet-title">No reminders are set for today.</p>;
  }

  const speechActive = speechOn && !muted;

  return (
    <div className="care">
      <h1 className="sr-only">Your reminders</h1>
      {status && reachable !== false ? (
        <div className="care-top">
          {dateWords && <p className="care-date">{dateWords}</p>}
          <p className="care-clock">
            <span className="sr-only">The time is </span>
            {colonAt > 0 ? (
              <>
                {clock.slice(0, colonAt)}
                <span className="care-clock-colon">:</span>
                {clock.slice(colonAt + 1)}
              </>
            ) : (
              clock
            )}
          </p>
        </div>
      ) : (
        // Loading or unreachable: no date or time is shown, but their space is held so the block does not jump
        // down when the first status arrives. Invisible and hidden from assistive technology.
        <div className="care-top care-top--placeholder" aria-hidden="true">
          <p className="care-date">Wednesday 30 September</p>
          <p className="care-clock">00:00</p>
        </div>
      )}

      <section
        className={quiet ? "care-block care-block--quiet" : "care-block"}
        aria-live="polite"
        aria-atomic="true"
      >
        {thanksLine}
        {main}
      </section>

      <section className="care-speech" aria-label="Spoken reminders">
        {!speechSupported ? (
          <p className="care-speech-note">Spoken reminders are not available in this browser.</p>
        ) : (
          <button
            type="button"
            className="care-speech-toggle"
            aria-pressed={speechActive}
            onClick={() => {
              // The first switch-on must speak inside this click: that is what unlocks speech in browsers.
              if (!speechOn) turnOnSpeech();
              else setMuted((m) => !m);
            }}
          >
            <span>Spoken reminders</span>
            <span className={`state ${speechActive ? "tone-pass" : "tone-warn"}`} aria-hidden="true">
              <span className="dot" />
              {speechActive ? "On" : "Off"}
            </span>
          </button>
        )}
      </section>
    </div>
  );
}
