import type { Status } from "../../api/types";
import { preflightChecklist } from "../../logic/checklist";
import { VerdictTag } from "../Verdict";

export function Checklist({ status }: { status: Status }) {
  const rows = preflightChecklist(status);
  return (
    <ul className="checklist">
      {rows.map((r) => (
        <li key={r.id} className={`check check-${r.verdict}`}>
          <VerdictTag verdict={r.verdict} />
          <span className="check-label">{r.label}</span>
          <span className="check-text">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
