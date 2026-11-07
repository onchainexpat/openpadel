// People whose account here was deleted, as Playtomic knows them (migration 102). Erasing a person (privacy.ts) marks
// them here first; every later read of Playtomic, its bookings (playtomic_archive.ts, three months back included) and
// its players (brought_in.ts), asks erasedMatcher and keeps anyone it matches out, without a name, email or phone.
// Kept: Playtomic's own id for them, and a one-way hash of each address salted with the club's own random value,
// never the address.
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Trx } from "./db.ts";
import { uuidv7 } from "./ids.ts";

const norm = (email: string) => email.trim().toLowerCase();
async function salt(db: Db | Trx): Promise<string> {
  return (await db.selectFrom("club").select("erase_salt").executeTakeFirstOrThrow()).erase_salt;
}
export const emailHash = (s: string, email: string) => createHash("sha256").update(`${s}:${norm(email)}`).digest("hex");

/** Mark a person as erased, by every Playtomic id Kumi knows for them (an import's, the archive's matches, the move-in's
 *  players read) and every address. Call before their Playtomic ids and rows are deleted. */
export async function markErased(trx: Trx, personId: string, emails: string[], now: Date): Promise<number> {
  const addresses = [...new Set(emails.filter((e) => e.includes("@")).map(norm))];
  const ids = new Set((await trx.selectFrom("external_ref").select("external_id").where("system", "=", "playtomic").where("entity", "=", "person").where("entity_id", "=", personId).execute())
    .map((r) => r.external_id));
  for (const r of await trx.selectFrom("playtomic_booking_player").select("participant_id").where("family_member_id", "is", null)
    .where((w) => w.or([w("person_id", "=", personId), ...(addresses.length ? [w(sql<string>`lower(email)`, "in", addresses)] : [])])).execute()) ids.add(r.participant_id);
  if (addresses.length) for (const r of await trx.selectFrom("playtomic_player").select("player_id").where(sql<string>`lower(email)`, "in", addresses).execute()) ids.add(r.player_id);
  const s = await salt(trx);
  let n = 0;
  for (const id of ids) n += Number((await trx.insertInto("playtomic_erased").values({ id: uuidv7(), playtomic_id: id, erased_at: now })
    .onConflict((oc) => oc.column("playtomic_id").where("playtomic_id", "is not", null).doNothing()).executeTakeFirst()).numInsertedOrUpdatedRows ?? 0);
  for (const a of addresses) n += Number((await trx.insertInto("playtomic_erased").values({ id: uuidv7(), email_hash: emailHash(s, a), erased_at: now })
    .onConflict((oc) => oc.column("email_hash").where("email_hash", "is not", null).doNothing()).executeTakeFirst()).numInsertedOrUpdatedRows ?? 0);
  return n;
}

/** For one read of Playtomic: whether a player (by Playtomic id, or by address) belongs to an account deleted here. */
export async function erasedMatcher(db: Db | Trx, o: { ids: (string | null | undefined)[]; emails: (string | null | undefined)[] }) {
  const ids = [...new Set(o.ids.filter((x): x is string => Boolean(x)))];
  const s = await salt(db), hashes = [...new Set(o.emails.filter((x): x is string => Boolean(x) && x!.includes("@")).map((e) => emailHash(s, e)))];
  const rows = ids.length || hashes.length ? await db.selectFrom("playtomic_erased").select(["playtomic_id", "email_hash"])
    .where((w) => w.or([...(ids.length ? [w("playtomic_id", "in", ids)] : []), ...(hashes.length ? [w("email_hash", "in", hashes)] : [])])).execute() : [];
  const byId = new Set(rows.map((r) => r.playtomic_id).filter(Boolean)), byMail = new Set(rows.map((r) => r.email_hash).filter(Boolean));
  return (p: { id?: string | null; email?: string | null }) => Boolean((p.id && byId.has(p.id)) || (p.email && p.email.includes("@") && byMail.has(emailHash(s, p.email))));
}
