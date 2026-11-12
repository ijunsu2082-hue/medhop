import type { Verdict as V } from "../logic/checklist";
import { IconCheck, IconClock, IconCross, IconWarn } from "./Icons";

const WORD: Record<V, string> = { pass: "Pass", warn: "Warn", fail: "Fail", info: "Info" };

/** Icon + word, so the verdict never relies on colour alone. */
export function VerdictTag({ verdict }: { verdict: V }) {
  const Icon = verdict === "pass" ? IconCheck : verdict === "warn" ? IconWarn : verdict === "info" ? IconClock : IconCross;
  return (
    <span className={`verdict verdict-${verdict}`}>
      <Icon size={16} />
      <span>{WORD[verdict]}</span>
    </span>
  );
}
