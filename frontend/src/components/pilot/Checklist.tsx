import { useState } from "react";
import type { Status } from "../../api/types";
import { preflightChecklist, type Verdict } from "../../logic/checklist";
import { IconChevron } from "../Icons";
import { VerdictTag } from "../Verdict";

const WORD: Record<Verdict, string> = { pass: "Pass", warn: "Warn", fail: "Fail", info: "Info" };

/**
 * Pre-flight checklist: one row per check (label, verdict word). Each row opens to show its text; a failing row
 * is open by default. A manual open/close is remembered per row and verdict, so a new verdict starts at its default.
 */
export function Checklist({ status }: { status: Status }) {
  const rows = preflightChecklist(status);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  return (
    <ul className="checklist">
      {rows.map((r) => {
        const key = `${r.id}:${r.verdict}`;
        const open = toggled[key] ?? r.verdict === "fail";
        const textId = `check-text-${r.id}`;
        return (
          <li key={r.id} className={`check check-${r.verdict}`}>
            <button
              type="button"
              className="check-row"
              aria-expanded={open}
              aria-controls={textId}
              onClick={(e) => {
                setToggled((t) => ({ ...t, [key]: !open }));
                // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
                e.currentTarget.blur();
              }}
            >
              <span className="check-label">{r.label}</span>
              <span className="sr-only">: {WORD[r.verdict]}</span>
              <span aria-hidden="true">
                <VerdictTag verdict={r.verdict} />
              </span>
              <IconChevron className="disclosure-chevron" size={16} />
            </button>
            <p className="check-text" id={textId} hidden={!open}>
              {r.text}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
