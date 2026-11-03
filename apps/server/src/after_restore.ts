// After a restore, nothing goes out twice. A backup (or a minute from the archive, or an update's snapshot) holds
// the messages and events that were still waiting when it was made; the server since sent many of them. So before
// `kumi restore` replaces the database, what it had already sent or handled is read, and afterwards:
//   - a message the restored copy has waiting, which the database before it had sent (or given up on), takes that
//     answer: it isn't sent again;
//   - an event the restored copy has waiting, which the database before it had handled, is held (held.ts): its
//     messages may have gone, and only whoever runs the server can say (`kumi held send|drop`);
//   - what neither had sent yet goes as usual.
// When the database before it can't vouch (it's empty, unreadable, or another club's: a new server after the old
// one was lost), everything still waiting is held, as after a move (held.ts).
// Refunds and card charges ask the provider first (stripe.ts), so they're never held and never repeated.
import { sql } from "kysely";
import { connect, holdableTopics, holdPending, migrate, type HeldCounts } from "@kumi/core";

export interface SentBefore { timeline: string; messages: Array<{ id: string; status: string; sent_at: Date | null; failure: string | null }>; events: Array<{ id: string; delivered_at: Date }> }
export interface AfterRestore { carried: { messages: number; events_held: number }; held: HeldCounts; vouched: boolean }

/** The club's first recorded change: two databases with the same one are the same club's, one an earlier copy of
 *  the other. */
async function timeline(db: ReturnType<typeof connect>): Promise<string | null> {
  return (await sql<{ id: string | null }>`SELECT (SELECT id::text FROM action_run ORDER BY created_at, id LIMIT 1) AS id`.execute(db)).rows[0]?.id ?? null;
}

/** What the database about to be replaced had sent and handled (the last 400 days). Null when it can't say. */
export async function readSentBefore(url: string): Promise<SentBefore | null> {
  const db = connect(url);
  try {
    const t = await timeline(db);
    if (!t) return null;
    const since = sql`now() - interval '400 days'`;
    const messages = (await sql<SentBefore["messages"][number]>`SELECT id::text, status, sent_at, failure FROM outbound_message
      WHERE status IN ('sent', 'failed', 'dropped') AND created_at >= ${since}`.execute(db)).rows;
    const events = (await sql<SentBefore["events"][number]>`SELECT id::text, delivered_at FROM event_outbox WHERE delivered_at IS NOT NULL AND created_at >= ${since}`.execute(db)).rows;
    return { timeline: t, messages, events };
  } catch { return null; } finally { await db.destroy(); }
}

/** Right after a restore (the server still stopped): bring the restored copy up to this Kumi, then carry over what
 *  the database before it had sent, or hold what's waiting when it couldn't say. */
export async function afterRestore(url: string, before: SentBefore | null, now = new Date()): Promise<AfterRestore> {
  const db = connect(url);
  try {
    await migrate(db);
    if (!before || before.timeline !== await timeline(db)) return { carried: { messages: 0, events_held: 0 }, held: await holdPending(db, now), vouched: false };
    return await db.transaction().execute(async (trx) => {
      let messages = 0, eventsHeld = 0;
      if (before.messages.length) {
        const r = await sql`UPDATE outbound_message m SET status = s.status, sent_at = s.sent_at, failure = s.failure
          FROM jsonb_to_recordset(${JSON.stringify(before.messages)}::jsonb) AS s(id uuid, status text, sent_at timestamptz, failure text)
          WHERE m.id = s.id AND m.status IN ('waiting', 'held')`.execute(trx);
        messages = Number(r.numAffectedRows ?? 0);
      }
      if (before.events.length) {
        const r = await sql`UPDATE event_outbox e SET held_at = ${now} FROM jsonb_to_recordset(${JSON.stringify(before.events)}::jsonb) AS s(id bigint, delivered_at timestamptz)
          WHERE e.id = s.id AND e.delivered_at IS NULL AND e.held_at IS NULL AND e.topic = ANY(${holdableTopics()})`.execute(trx);
        eventsHeld = Number(r.numAffectedRows ?? 0);
      }
      return { carried: { messages, events_held: eventsHeld }, held: { messages: 0, events: eventsHeld }, vouched: true };
    });
  } finally { await db.destroy(); }
}
