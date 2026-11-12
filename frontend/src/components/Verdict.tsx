import type { Verdict as V } from "../logic/checklist";
import { IconCross, IconInfo, IconPass, IconWarn } from "./Icons";

const WORD: Record<V, string> = { pass: "Pass", warn: "Warn", fail: "Fail", info: "Info" };
const ICON: Record<V, typeof IconPass> = { pass: IconPass, warn: IconWarn, fail: IconCross, info: IconInfo };

/** Icon + word in a stamp, so the verdict never relies on colour alone. */
export function VerdictTag({ verdict }: { verdict: V }) {
  const Icon = ICON[verdict];
  return (
    <span className={`stamp stamp--${verdict} verdict`}>
      <Icon size={16} />
      <span>{WORD[verdict]}</span>
    </span>
  );
}
