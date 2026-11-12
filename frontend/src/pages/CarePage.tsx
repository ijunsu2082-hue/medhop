import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useStatus } from "../hooks/useStatus";
import { ACK_COOLDOWN_MS, arrivalLine, careFocus, isEarlyArrival, reminderMaySpeak, spokenReminder } from "../logic/care";
import { IconCheck, IconSpeaker } from "../components/Icons";
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

  let main: ReactNode;
  if (reachable === false || !status || !focus) {
    main = (
      <>
        <p className="care-main">{reachable === false ? "The reminder system cannot be reached right now." : "Loading your reminders."}</p>
        {reachable === false && <p className="care-sub">It will keep trying by itself.</p>}
      </>
    );
  } else if (focus.kind === "pending") {
    const d = focus.dose;
    const arrival = arrivalLine(d);
    const early = isEarlyArrival(d, status.care.now_local);
    main = (
      <>
        {/* After an acknowledgement the card visibly moves on, so a second tap is clearly for a different dose. */}
        {thanks && (
          <p className="care-sub">
            <strong>Next:</strong>
          </p>
        )}
        {early ? (
          <>
            <p className="care-main">Coming up at {d.time}: {d.label}</p>
            <p className="care-sub">It is not time for it yet.</p>
          </>
        ) : (
          <>
            <p className="care-main">It is time for: {d.label}</p>
            <p className="care-sub">This was due at {d.time}.</p>
          </>
        )}
        {d.notes && <p className="care-sub">{d.notes}</p>}
        {arrival && (
          <p className="care-arrived">
            <IconCheck size={40} /> <span>{arrival}.</span>
          </p>
        )}
        <button type="button" className="care-ack" onClick={() => void acknowledge()} disabled={sending || coolingDown}>
          {sending ? "Sending..." : "I picked it up"}
        </button>
        {ackError && (
          <p className="care-error" role="alert">
            {ackError}
          </p>
        )}
      </>
    );
  } else if (focus.kind === "upcoming") {
    main = (
      <>
        <p className="care-main">
          Next: {focus.dose.label} at {focus.dose.time}
        </p>
        <p className="care-sub">Nothing to do right now.</p>
      </>
    );
  } else if (focus.kind === "all_done") {
    main = <p className="care-main">All done for today.</p>;
  } else {
    main = <p className="care-main">No reminders are set for today.</p>;
  }

  return (
    <div className="care">
      <h1 className="sr-only">Your reminders</h1>
      {status && reachable !== false && (
        <p className="care-clock">
          <span className="care-clock-label">Now</span> <span className="care-clock-time">{status.care.now_local}</span>
        </p>
      )}

      {thanks && (
        <p className="care-thanks" role="status">
          <IconCheck size={40} /> <span>Thank you. We noted that you picked up {thanks.label}.</span>
        </p>
      )}

      <section className="care-card" aria-live="polite" aria-atomic="true">
        {main}
      </section>

      <section className="care-speech" aria-label="Spoken reminders">
        {!speechSupported ? (
          <p className="care-sub">Spoken reminders are not available in this browser.</p>
        ) : !speechOn ? (
          <button type="button" className="care-btn" onClick={turnOnSpeech}>
            <IconSpeaker size={32} /> <span>Turn on spoken reminders</span>
          </button>
        ) : (
          <button type="button" className="care-btn" aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
            <IconSpeaker size={32} muted={muted} /> <span>{muted ? "Spoken reminders are muted. Press to unmute." : "Mute spoken reminders"}</span>
          </button>
        )}
      </section>
    </div>
  );
}
