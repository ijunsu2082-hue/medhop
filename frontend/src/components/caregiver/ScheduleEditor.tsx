import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../../api/client";
import type { ScheduleDose, ScheduleDoseInput } from "../../api/types";
import { normaliseHHMM } from "../../logic/time";

interface FormState {
  time: string;
  label: string;
  notes: string;
}

const EMPTY: FormState = { time: "", label: "", notes: "" };

function validate(f: FormState): { value: ScheduleDoseInput | null; errors: Partial<Record<keyof FormState, string>> } {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const time = normaliseHHMM(f.time);
  if (!time) errors.time = "Use 24-hour HH:MM, for example 08:00 or 19:30.";
  const label = f.label.trim();
  if (!label) errors.label = "Give the dose a label, for example Morning dose (demo).";
  if (Object.keys(errors).length > 0 || !time) return { value: null, errors };
  return { value: { time, label, notes: f.notes.trim() }, errors };
}

function DoseForm({
  idPrefix,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: FormState;
  submitLabel: string;
  onSubmit: (v: ScheduleDoseInput) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { value, errors: errs } = validate(f);
    setErrors(errs);
    if (!value) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok && !onCancel) setF(EMPTY);
  };

  const field = (k: keyof FormState) => ({
    id: `${idPrefix}-${k}`,
    value: f[k],
    onChange: (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value })),
    "aria-invalid": errors[k] ? true : undefined,
    "aria-describedby": errors[k] ? `${idPrefix}-${k}-err` : undefined,
  });

  return (
    <form className="dose-form" onSubmit={(e) => void submit(e)} noValidate>
      <div className="field field-time">
        <label htmlFor={`${idPrefix}-time`}>Time (HH:MM)</label>
        <input {...field("time")} type="text" inputMode="numeric" placeholder="08:00" autoComplete="off" maxLength={5} />
        {errors.time && (
          <span className="field-error" id={`${idPrefix}-time-err`}>
            {errors.time}
          </span>
        )}
      </div>
      <div className="field field-label">
        <label htmlFor={`${idPrefix}-label`}>Label</label>
        <input {...field("label")} type="text" placeholder="Morning dose (demo)" autoComplete="off" maxLength={80} />
        {errors.label && (
          <span className="field-error" id={`${idPrefix}-label-err`}>
            {errors.label}
          </span>
        )}
      </div>
      <div className="field field-notes">
        <label htmlFor={`${idPrefix}-notes`}>Notes (optional)</label>
        <input {...field("notes")} type="text" autoComplete="off" maxLength={200} />
      </div>
      <div className="row form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving..." : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Add / edit / delete doses: GET, POST, PUT /{id}, DELETE /{id} on /api/schedule. Demo data only. */
export function ScheduleEditor() {
  const [doses, setDoses] = useState<ScheduleDose[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getSchedule();
      setDoses([...(r.doses ?? [])].sort((a, b) => a.time.localeCompare(b.time)));
      setLoadError(null);
    } catch (e) {
      setLoadError(`Could not load the schedule: ${errorText(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // If the first load failed (backend down), try again every 5 s until it works.
  useEffect(() => {
    if (!loadError || doses !== null) return;
    const t = setTimeout(() => void load(), 5000);
    return () => clearTimeout(t);
  }, [loadError, doses, load]);

  const run = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setActionError(`${what} failed: ${errorText(e)}`);
      return false;
    }
  };

  return (
    <div className="schedule">
      <p className="small muted">Demo data only. Use made-up labels: no real names or medicines.</p>
      {loadError && (
        <p className="msg msg-warn" role="status">
          {loadError}
          {doses === null ? " Retrying every 5 s." : ""}
        </p>
      )}
      {actionError && (
        <p className="msg msg-fail" role="alert">
          {actionError}
        </p>
      )}

      {doses !== null && doses.length === 0 && <p className="muted">No doses in the schedule.</p>}
      {doses !== null && doses.length > 0 && (
        <ul className="schedule-list">
          {doses.map((d) => (
            <li key={d.id} className="schedule-item">
              {editing === d.id ? (
                <DoseForm
                  idPrefix={`edit-${d.id}`}
                  initial={{ time: d.time, label: d.label, notes: d.notes ?? "" }}
                  submitLabel="Save changes"
                  onSubmit={async (v) => {
                    const ok = await run("Saving", () => api.updateDose(d.id, v));
                    if (ok) setEditing(null);
                    return ok;
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <span className="schedule-time">{d.time}</span>
                  <span className="schedule-label">
                    {d.label}
                    {d.notes && <span className="small muted block">{d.notes}</span>}
                  </span>
                  <span className="row schedule-actions">
                    {confirmDelete === d.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-danger-outline"
                          onClick={() => void run("Deleting", () => api.deleteDose(d.id)).then(() => setConfirmDelete(null))}
                        >
                          Confirm delete
                        </button>
                        <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-quiet"
                          onClick={() => {
                            setEditing(d.id);
                            setConfirmDelete(null);
                          }}
                          aria-label={`Edit ${d.label} at ${d.time}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet"
                          onClick={() => setConfirmDelete(d.id)}
                          aria-label={`Delete ${d.label} at ${d.time}`}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>Add a dose</h3>
      <DoseForm idPrefix="add" initial={EMPTY} submitLabel="Add dose" onSubmit={(v) => run("Adding", () => api.addDose(v))} />
    </div>
  );
}
