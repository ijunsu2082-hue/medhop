import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText } from "../../api/client";
import type { ScheduleDose, ScheduleDoseInput } from "../../api/types";
import { normaliseHHMM } from "../../logic/time";
import { IconChevron } from "../Icons";

interface FormState {
  time: string;
  label: string;
  notes: string;
}

const EMPTY: FormState = { time: "", label: "", notes: "" };

/** Ids of the row controls, so focus can be put back on them when the control the user pressed goes away. */
const ADD_TOGGLE_ID = "schedule-add-toggle";
const editId = (doseId: string) => `schedule-${doseId}-edit`;
const deleteId = (doseId: string) => `schedule-${doseId}-delete`;
const keepId = (doseId: string) => `schedule-${doseId}-keep`;

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
  layout,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  /** "row": fields and the submit button on one line when the form itself is at least 720px wide (a container
   *  query in caregiver.css; viewports of about 784-959px and 1160px and up). Narrower, it falls back to the stacked
   *  fields with the button beneath. "stacked": the actions always sit under the fields. */
  layout: "row" | "stacked";
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
    if (!value) {
      // Put the cursor in the first field that needs fixing; its error is read out through aria-describedby.
      const first = (["time", "label"] as const).find((k) => errs[k]);
      if (first) requestAnimationFrame(() => document.getElementById(`${idPrefix}-${first}`)?.focus());
      return;
    }
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
    <form className={`dose-form dose-form--${layout}`} onSubmit={(e) => void submit(e)} noValidate>
      <div className="field field-time">
        <label htmlFor={`${idPrefix}-time`}>
          Time <span className="muted">HH:MM</span>
        </label>
        <input {...field("time")} type="text" inputMode="numeric" placeholder="e.g. 08:00" autoComplete="off" maxLength={5} />
        {errors.time && (
          <span className="field-error" id={`${idPrefix}-time-err`}>
            {errors.time}
          </span>
        )}
      </div>
      <div className="field field-label">
        <label htmlFor={`${idPrefix}-label`}>Label</label>
        <input {...field("label")} type="text" placeholder="e.g. Morning dose (demo)" autoComplete="off" maxLength={80} />
        {errors.label && (
          <span className="field-error" id={`${idPrefix}-label-err`}>
            {errors.label}
          </span>
        )}
      </div>
      <div className="field field-notes">
        <label htmlFor={`${idPrefix}-notes`}>
          Notes <span className="muted">optional</span>
        </label>
        <input {...field("notes")} type="text" autoComplete="off" maxLength={200} />
      </div>
      <div className="row form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy ? true : undefined}>
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

/**
 * Add / edit / delete doses: GET, POST, PUT /{id}, DELETE /{id} on /api/schedule. Demo data only.
 * `backendDown`: the shell already says the backend is not reachable, so a failed load then shows one quiet line.
 */
export function ScheduleEditor({ backendDown = false }: { backendDown?: boolean }) {
  const [doses, setDoses] = useState<ScheduleDose[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addToggle = useRef<HTMLButtonElement | null>(null);
  /** Where focus goes after the add form opens or closes; set only by the user's own actions. */
  const focusAfter = useRef<"field" | "toggle" | null>(null);
  /**
   * The id of the element to focus after the next render, when the control the user pressed goes away (a row opens
   * into its form, the form closes, the confirm pair replaces Edit and Delete, a row is deleted). Set only by the
   * user's own actions; if the element is gone by then, focus falls back to the "Add a dose" toggle.
   */
  const focusNext = useRef<string | null>(null);
  const requestFocus = (id: string) => {
    focusNext.current = id;
  };

  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    (document.getElementById(id) ?? addToggle.current)?.focus();
  });

  // Opening the add form puts the cursor in its first field; a successful add returns focus to the toggle.
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "field" && adding) document.getElementById("add-time")?.focus();
    if (target === "toggle" && !adding) addToggle.current?.focus();
  }, [adding]);

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
      {loadError &&
        (backendDown ? (
          doses === null && <p className="muted">Waiting for status.</p>
        ) : (
          <p className="msg msg-warn" role="status">
            {loadError}
            {doses === null ? " Retrying every 5 s." : ""}
          </p>
        ))}
      {actionError && (
        <p className="msg msg-fail" role="alert">
          {actionError}
        </p>
      )}

      {doses !== null && doses.length === 0 && <p className="muted">No doses in the schedule.</p>}
      {doses !== null && doses.length > 0 && (
        <ul className="schedule-list">
          {doses.map((d) => (
            <li key={d.id} className={`schedule-item${editing === d.id ? " schedule-item-editing" : ""}`}>
              {editing === d.id ? (
                <DoseForm
                  idPrefix={`edit-${d.id}`}
                  layout="stacked"
                  initial={{ time: d.time, label: d.label, notes: d.notes ?? "" }}
                  submitLabel="Save changes"
                  onSubmit={async (v) => {
                    const ok = await run("Saving", () => api.updateDose(d.id, v));
                    if (ok) {
                      requestFocus(editId(d.id));
                      setEditing(null);
                    }
                    return ok;
                  }}
                  onCancel={() => {
                    requestFocus(editId(d.id));
                    setEditing(null);
                  }}
                />
              ) : (
                <>
                  <span className="schedule-time">{d.time}</span>
                  <span className="schedule-label">
                    {d.label}
                    {d.notes && <span className="hint block">{d.notes}</span>}
                  </span>
                  <span className="row schedule-actions">
                    {confirmDelete === d.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={deleting === d.id}
                          aria-busy={deleting === d.id ? true : undefined}
                          aria-label={deleting === d.id ? undefined : `Confirm delete ${d.label} at ${d.time}`}
                          onClick={() => {
                            // After a delete, focus the next row's Edit (or the previous row's, or the toggle).
                            const i = doses.findIndex((x) => x.id === d.id);
                            const neighbour = doses[i + 1] ?? doses[i - 1];
                            setDeleting(d.id);
                            void run("Deleting", () => api.deleteDose(d.id)).then((ok) => {
                              requestFocus(ok ? (neighbour ? editId(neighbour.id) : ADD_TOGGLE_ID) : deleteId(d.id));
                              setDeleting(null);
                              setConfirmDelete(null);
                            });
                          }}
                        >
                          {deleting === d.id ? "Deleting..." : "Confirm delete"}
                        </button>
                        <button
                          id={keepId(d.id)}
                          type="button"
                          className="btn"
                          disabled={deleting === d.id}
                          aria-label={`Keep ${d.label} at ${d.time}`}
                          onClick={() => {
                            requestFocus(deleteId(d.id));
                            setConfirmDelete(null);
                          }}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          id={editId(d.id)}
                          type="button"
                          className="btn btn-quiet"
                          onClick={() => {
                            requestFocus(`edit-${d.id}-time`);
                            setEditing(d.id);
                            setConfirmDelete(null);
                          }}
                          aria-label={`Edit ${d.label} at ${d.time}`}
                        >
                          Edit
                        </button>
                        <button
                          id={deleteId(d.id)}
                          type="button"
                          className="btn btn-quiet schedule-delete"
                          onClick={() => {
                            // The safe choice takes focus, so a second Enter keeps the dose rather than deleting it.
                            requestFocus(keepId(d.id));
                            setConfirmDelete(d.id);
                          }}
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

      <div className="schedule-add">
        <button
          ref={addToggle}
          id={ADD_TOGGLE_ID}
          type="button"
          className="btn schedule-add-toggle"
          aria-expanded={adding}
          aria-controls="add-dose-form"
          onClick={() => {
            focusAfter.current = adding ? null : "field";
            setAdding(!adding);
          }}
        >
          <IconChevron size={16} className="disclosure-chevron" />
          Add a dose
        </button>
        <div id="add-dose-form" className="schedule-add-body" hidden={!adding}>
          {adding && (
            <DoseForm
              idPrefix="add"
              layout="row"
              initial={EMPTY}
              submitLabel="Add dose"
              onSubmit={async (v) => {
                const ok = await run("Adding", () => api.addDose(v));
                if (ok) {
                  focusAfter.current = "toggle";
                  setAdding(false);
                }
                return ok;
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
