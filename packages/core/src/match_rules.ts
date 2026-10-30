// Who may join an open match: the level band its host set. Inside it, a player joins at once; outside it
// (or with no level yet), they ask the host, unless the host closed the match to anyone outside.
import type { Db, Trx } from "./db.ts";

/** A player's shown level, or null with none yet (they've never played a rated game or been given one). */
export async function levelOf(db: Db | Trx, personId: string): Promise<number | null> {
  const r = await db.selectFrom("rating").select("level").where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  return r ? Number(r.level) : null;
}

export async function openMatchOf(db: Db | Trx, bookingId: string) {
  return (await db.selectFrom("open_match").selectAll().where("booking_id", "=", bookingId).executeTakeFirst()) ?? null;
}

/** What a player of `level` may do: join, ask the host, or neither. */
export function joinRule(m: { level_min: string | number; level_max: string | number; outside_band: string }, level: number | null): "join" | "ask" | "closed" {
  if (level !== null && level >= Number(m.level_min) && level <= Number(m.level_max)) return "join";
  return m.outside_band === "ask" ? "ask" : "closed";
}

/** "3.00-3.75". */
export const band = (m: { level_min: string | number; level_max: string | number }) => `${Number(m.level_min).toFixed(2)}-${Number(m.level_max).toFixed(2)}`;
