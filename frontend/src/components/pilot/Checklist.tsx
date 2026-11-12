import { useState } from "react";
import type { Status } from "../../api/types";
import { preflightChecklist, type Verdict } from "../../logic/checklist";
import { IconCheck, IconClock, IconCross, IconWarn } from "../Icons";
import { IconChevron } from "./PilotIcons";

const WORD: Record<Verdict, string> = { pass: "Pass", warn: "Warn", fail: "Fail", info: "Info" };
const ICON: Record<Verdict, typeof IconCheck> = { pass: IconCheck, warn: IconWarn, fail: IconCross, info: IconClock };

/**
 * Pre-flight checklist as a row of chips (verdict icon + label). Each chip opens to show its text; a failing row
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
        const Icon = ICON[r.verdict];
        const textId = `check-text-${r.id}`;
        return (
          <li key={r.id} className={`check check-${r.verdict}${open ? " check-open" : ""}`}>
            <button
              type="button"
              className="check-chip"
              aria-expanded={open}
              aria-controls={textId}
              onClick={(e) => {
                setToggled((t) => ({ ...t, [key]: !open }));
                // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
                e.currentTarget.blur();
              }}
            >
              <span className={`check-icon verdict-${r.verdict}`}>
                <Icon size={18} />
              </span>
              <span className="check-label">{r.label}</span>
              <span className="sr-only">: {WORD[r.verdict]}</span>
              <IconChevron className="check-chevron" size={14} />
            </button>
            <p className="check-text" id={textId} hidden={!open}>
              <span className="check-word">{WORD[r.verdict]}:</span> {r.text}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
