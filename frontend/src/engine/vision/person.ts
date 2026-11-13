// Ports the PersonStatus shape of backend/medhop/vision/person.py, which the mission runner reads.
//
// The person check itself (a pretrained YOLO detector on the camera picture) is not ported: the
// browser engine has no such model. Its provider therefore reports "disabled" by default
// (`NO_PERSON`), exactly what Python reports without local weights. Tests (and a future check) can
// hand the runner any PersonStatus through its `personStatus` provider.
//
// This is an ADVISORY check in Python too: not a safety system, it can miss people.

/** x1, y1, x2, y2 as fractions of the frame */
export type PersonBox = readonly [x1: number, y1: number, x2: number, y2: number];

/** Python's frozen dataclass PersonStatus, with its field names. */
export interface PersonStatus {
  readonly enabled: boolean;
  readonly detected: boolean;
  readonly count: number;
  /** when the last check finished (monotonic), null before the first */
  readonly ts: number | null;
  readonly boxes: readonly PersonBox[];
}

/** PersonStatus(**fields) with the dataclass defaults. */
export function makePersonStatus(fields: Partial<PersonStatus> = {}): PersonStatus {
  return Object.freeze({
    enabled: fields.enabled ?? false,
    detected: fields.detected ?? false,
    count: fields.count ?? 0,
    ts: fields.ts ?? null,
    boxes: Object.freeze([...(fields.boxes ?? [])]),
  });
}

/** PersonStatus(): the check is off (the runner's default provider returns this). */
export const NO_PERSON: PersonStatus = makePersonStatus();
