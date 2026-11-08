// People whose account here was deleted, as Playtomic knows them (migration 102). Erasing a person (privacy.ts) marks
// them here first; every later read of Playtomic, its bookings (playtomic_archive.ts, three months back included) and
// its players (brought_in.ts), asks erasedMatcher and keeps anyone it matches out, without a name, email or phone. A
// person who comes back by their own act (markRejoined) starts fresh from that day; nothing staff do brings them back.
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
 *  players read) and every address, all under their id. Call before their Playtomic ids and rows are deleted. Someone
 *  deleted again after coming back is marked afresh: the earlier rejoin no longer counts. */
export async function markErased(trx: Trx, personId: string, emails: string[], now: Date): Promise<number> {
  const addresses = [...new Set(emails.filter((e) => e.includes("@")).map(norm))];
  const ids = new Set((await trx.selectFrom("external_ref").select("external_id").where("system", "=", "playtomic").where("entity", "=", "person").where("entity_id", "=", personId).execute())
    .map((r) => r.external_id));
  for (const r of await trx.selectFrom("playtomic_booking_player").select("participant_id").where("family_member_id", "is", null)
    .where((w) => w.or([w("person_id", "=", personId), ...(addresses.length ? [w(sql<string>`lower(email)`, "in", addresses)] : [])])).execute()) ids.add(r.participant_id);
  if (addresses.length) for (const r of await trx.selectFrom("playtomic_player").select("player_id").where(sql<string>`lower(email)`, "in", addresses).execute()) ids.add(r.player_id);
  const s = await salt(trx), fresh = { erased_at: now, erased_person_id: personId, rejoined_at: null };
  let n = 0;
  for (const id of ids) n += Number((await trx.insertInto("playtomic_erased").values({ id: uuidv7(), playtomic_id: id, ...fresh })
    .onConflict((oc) => oc.column("playtomic_id").where("playtomic_id", "is not", null).doUpdateSet(fresh)).executeTakeFirst()).numInsertedOrUpdatedRows ?? 0);
  for (const a of addresses) n += Number((await trx.insertInto("playtomic_erased").values({ id: uuidv7(), email_hash: emailHash(s, a), ...fresh })
    .onConflict((oc) => oc.column("email_hash").where("email_hash", "is not", null).doUpdateSet(fresh)).executeTakeFirst()).numInsertedOrUpdatedRows ?? 0);
  return n;
}

/**
 * Someone deleted here who comes back by their own act: signing up themselves (person.sign_up), adding or changing their
 * own address (email.add, email.change without staff), or the first sign-in that proves an address someone else
 * entered for them (the desk's person.create, a parent's kid.give_login, household.give_login, the owner at setup):
 * proving it takes reading that mailbox, which only they can. Never what anyone else does (an import, which leaves a
 * deleted member's address out, support access, the desk or a parent entering the address, a staff email change):
 * those leave the person marked. Every marker row of the deleted account is lifted from now (what Playtomic
 * holds from before stays out), and their upcoming bookings in the archive are read afresh at the next read, so what's
 * theirs from now comes in by name. Returns how many marker rows it lifted.
 */
export async function markRejoined(trx: Trx, personId: string, now: Date): Promise<number> {
  const p = await trx.selectFrom("person").select(["email", "redacted_at", "created_via"]).where("id", "=", personId).executeTakeFirst();
  if (!p || p.redacted_at || p.created_via === "support") return 0;
  const more = await trx.selectFrom("auth_identity").select("value").where("person_id", "=", personId).where("kind", "=", "email").execute();
  const s = await salt(trx), hashes = [...new Set([p.email, ...more.map((m) => m.value)].filter((e): e is string => Boolean(e) && e!.includes("@")).map((e) => emailHash(s, e)))];
  if (!hashes.length) return 0;
  const hit = await trx.selectFrom("playtomic_erased").select(["id", "erased_person_id"]).where("email_hash", "in", hashes).where("rejoined_at", "is", null).execute();
  if (!hit.length) return 0;
  const people = [...new Set(hit.map((h) => h.erased_person_id).filter((x): x is string => Boolean(x)))];
  const rows = await trx.updateTable("playtomic_erased").set({ rejoined_at: now }).where("rejoined_at", "is", null)
    .where((w) => w.or([w("id", "in", hit.map((h) => h.id)), ...(people.length ? [w("erased_person_id", "in", people)] : [])])).returning("playtomic_id").execute();
  // Their upcoming bookings already in the archive (kept nameless until now) are written again at the next read.
  const ids = rows.map((r) => r.playtomic_id).filter((x): x is string => Boolean(x));
  if (ids.length) await trx.updateTable("playtomic_booking").set({ row_hash: "rejoined" })
    .where("starts_at", ">=", now).where("booking_id", "in", trx.selectFrom("playtomic_booking_player").select("booking_id").where("participant_id", "in", ids)).execute();
  return rows.length;
}

export interface ErasedMatcher {
  /** Whether a player (by Playtomic id, or by address) belongs to an account deleted here: always, until they come
   *  back; once back, only for what's dated before (`at`, a booking's start). Without `at` (a players read, which is
   *  how things stand now), someone who came back isn't matched. */
  (p: { id?: string | null; email?: string | null; at?: Date | null }): boolean;
  /** Playtomic ids matched by address only, to add to the marker (learnErasedIds). */
  learned: Map<string, { erased_person_id: string | null; erased_at: Date; rejoined_at: Date | null }>;
}

/** For one read of Playtomic: who belongs to an account deleted here (see ErasedMatcher). */
export async function erasedMatcher(db: Db | Trx, o: { ids: (string | null | undefined)[]; emails: (string | null | undefined)[] }): Promise<ErasedMatcher> {
  const ids = [...new Set(o.ids.filter((x): x is string => Boolean(x)))];
  const s = await salt(db), hashes = [...new Set(o.emails.filter((x): x is string => Boolean(x) && x!.includes("@")).map((e) => emailHash(s, e)))];
  const rows = ids.length || hashes.length ? await db.selectFrom("playtomic_erased").select(["playtomic_id", "email_hash", "erased_person_id", "erased_at", "rejoined_at"])
    .where((w) => w.or([...(ids.length ? [w("playtomic_id", "in", ids)] : []), ...(hashes.length ? [w("email_hash", "in", hashes)] : [])])).execute() : [];
  const byId = new Map(rows.filter((r) => r.playtomic_id).map((r) => [r.playtomic_id!, r])), byMail = new Map(rows.filter((r) => r.email_hash).map((r) => [r.email_hash!, r]));
  const hits = (r: (typeof rows)[number] | undefined, at: Date | null | undefined) => Boolean(r) && (!r!.rejoined_at || (at ? at.getTime() < new Date(r!.rejoined_at).getTime() : false));
  const learned: ErasedMatcher["learned"] = new Map();
  const match = ((p) => {
    const viaId = p.id ? byId.get(p.id) : undefined;
    if (hits(viaId, p.at)) return true;
    const viaMail = p.email && p.email.includes("@") ? byMail.get(emailHash(s, p.email)) : undefined;
    if (!hits(viaMail, p.at)) return false;
    // Matched by address only: their Playtomic id is learned, so a later read listing it without the address keeps them out too.
    if (p.id && !viaId) learned.set(p.id, { erased_person_id: viaMail!.erased_person_id, erased_at: viaMail!.erased_at, rejoined_at: viaMail!.rejoined_at });
    return true;
  }) as ErasedMatcher;
  match.learned = learned;
  return match;
}

/** Add the Playtomic ids a read matched by address only (ErasedMatcher.learned) to the marker, under the same person. */
export async function learnErasedIds(trx: Trx, m: ErasedMatcher): Promise<number> {
  let n = 0;
  for (const [id, r] of m.learned) n += Number((await trx.insertInto("playtomic_erased").values({ id: uuidv7(), playtomic_id: id, ...r })
    .onConflict((oc) => oc.column("playtomic_id").where("playtomic_id", "is not", null).doNothing()).executeTakeFirst()).numInsertedOrUpdatedRows ?? 0);
  m.learned.clear();
  return n;
}
