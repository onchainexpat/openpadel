// What the jobs make again after a restore (migration 069). A reminder, a notice or club news whose "already said"
// record was written after the copy was made isn't in the copy, so the job makes it again: a new message, with the
// same words. The restore kept a fingerprint of everything the database before it had sent that the copy doesn't
// have (after_restore.ts, and deploy/release.sh for a snapshot going back). Each sender looks first: a waiting email,
// text or push with a fingerprint from the last week takes the earlier one's answer (sent, at its time) instead of
// going again. One fingerprint answers one message; after the week, the same words go as new.
import { sql } from "kysely";
import type { Db, Trx } from "./db.ts";

/** A message's fingerprint: who it's for, what it is, how it goes, its exact words and link, and for a chat push which
 *  message it's for (a chat push keeps no words, so every push to one person about one game reads the same; without
 *  it, a push sent before a restore would answer for a new message's push after it). Read through to_jsonb, so a
 *  database from before chat (no such column) gives the same fingerprint as any message without one, and concat_ws
 *  leaves a missing one out: an email's fingerprint is what it always was. The same SQL runs in deploy/release.sh and
 *  kumi-hosted, where a snapshot goes back; the tests keep them in step. */
export const MESSAGE_FP = "encode(sha256(convert_to(concat_ws(chr(31), person_id::text, kind, channel, subject, body, coalesce(link, ''), to_jsonb(outbound_message)->>'chat_message_id'), 'UTF8')), 'hex')";
/** How long after a restore a message made again takes the earlier one's answer. */
export const REPEAT_WINDOW_DAYS = 7;

/** Waiting messages the database before a restore had already sent: marked sent, at the time they went. */
export async function skipRepeatsAfterRestore(db: Db | Trx, now = new Date()): Promise<number> {
  const open = await db.selectFrom("sent_before_restore").select("id").where("used_at", "is", null).where("until", ">", now).limit(1).executeTakeFirst();
  if (!open) return 0;
  const r = await sql`WITH w AS (
      SELECT id, fp, row_number() OVER (PARTITION BY fp ORDER BY created_at, id) AS n
      FROM (SELECT id, created_at, ${sql.raw(MESSAGE_FP)} AS fp FROM outbound_message WHERE status = 'waiting' AND channel <> 'inbox') x),
    l AS (SELECT id, fp, sent_at, row_number() OVER (PARTITION BY fp ORDER BY sent_at, id) AS n
      FROM sent_before_restore WHERE used_at IS NULL AND until > ${now}),
    pair AS (SELECT w.id AS mid, l.id AS lid, l.sent_at FROM w JOIN l ON l.fp = w.fp AND l.n = w.n),
    used AS (UPDATE sent_before_restore s SET used_at = ${now}, used_by = pair.mid FROM pair WHERE s.id = pair.lid)
    UPDATE outbound_message m SET status = 'sent', sent_at = pair.sent_at FROM pair WHERE m.id = pair.mid AND m.status = 'waiting'`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}
