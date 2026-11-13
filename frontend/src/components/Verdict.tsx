import type { Verdict as V } from "../logic/checklist";

const WORD: Record<V, string> = { pass: "Pass", warn: "Warn", fail: "Fail", info: "Info" };

/** The verdict as a word with a round mark (filled on pass, hollow on warn and info, red on fail). */
export function VerdictTag({ verdict }: { verdict: V }) {
  return (
    <span className={`state tone-${verdict} verdict`}>
      <span className="dot" aria-hidden="true" />
      <span>{WORD[verdict]}</span>
    </span>
  );
}
