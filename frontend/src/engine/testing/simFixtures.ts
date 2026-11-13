// Shared helpers for the simulator parity suites: the row forms backend/tools/parity_traces.py writes
// for actors, configs and snapshots (see _actor_row, _sim_config, _snap_row and _snap_list there).

import { highQualitySimConfig, makeSimConfig, type SimConfig, type SimSnapshot } from "../drone/sim";
import { Actor, ACTOR_FIELDS } from "../drone/simActors";

/** An actor as a fixture row: the dataclass fields in their Python order. */
export type ActorRow = [string, number, number, number, number, number, number, number, number, number];

export function actorFromRow(row: readonly unknown[]): Actor {
  const init: Record<string, unknown> = {};
  ACTOR_FIELDS.forEach((name, i) => {
    init[name] = row[i];
  });
  return new Actor(init);
}

export function actorRow(actor: Actor): unknown[] {
  return ACTOR_FIELDS.map((name) => actor[name]);
}

/** _sim_config(profile, overrides): actors arrive as rows. */
export function configFromFixture(profile: string, overrides: Record<string, unknown>): SimConfig {
  const init: Record<string, unknown> = { ...overrides };
  if (Array.isArray(init["actors"])) init["actors"] = (init["actors"] as unknown[][]).map(actorFromRow);
  return profile === "high" ? highQualitySimConfig(init as Partial<SimConfig>) : makeSimConfig(init as Partial<SimConfig>);
}

/** _snap_row: the snapshot dict with full actor rows (no capture time). */
export function snapRow(snap: SimSnapshot): Record<string, unknown> {
  return {
    x: snap.x,
    z: snap.z,
    heading: snap.heading,
    cam_y: snap.cam_y,
    marker_hidden: snap.marker_hidden,
    actors: snap.actors.map(actorRow),
  };
}

/** _snap_list: x, z, heading, cam_y, marker_hidden, then [x_m, distance_m] of each actor. */
export function snapList(snap: SimSnapshot): unknown[] {
  return [snap.x, snap.z, snap.heading, snap.cam_y, snap.marker_hidden, snap.actors.map((a) => [a.x_m, a.distance_m])];
}
