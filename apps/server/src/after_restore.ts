// After a restore, nothing goes out twice. A backup (or a minute from the archive, or an update's snapshot) holds
// the messages and events that were still waiting when it was made; the server since sent many of them. So before
// `kumi restore` replaces the database, what it had already sent or handled is read, and afterwards:
//   - a message the restored copy has waiting, which the database before it had sent (or given up on), takes that
//     answer: it isn't sent again;
//   - an event the restored copy has waiting, which the database before it had handled, is held (held.ts): its
//     messages may have gone, and only whoever runs the server can say (`kumi held send|drop`);
//   - what neither had sent yet goes as usual;
//   - an email, text or push it had sent that the copy doesn't have at all (made after the copy) is kept as a
//     fingerprint for a week: when a job makes it again, because its "already said" record was newer than the copy,
//     it takes the earlier answer instead of going twice (repeats.ts).
// When the database before it can't vouch (it's empty, unreadable, or another club's: a new server after the old
// one was lost), everything still waiting is held, as after a move (held.ts).
// Refunds and card charges ask the provider first (stripe.ts), so they're never held and never repeated.
//
// The usage meter (usage.ts) is carried over too: the copy's counts are older, so what AI, texts and email cost since
// would go uncounted, and the host would bill too little and the cap let more through. Each club month and kind
// keeps the larger of the two counts, and an 80% or cap message either had said stays said. When the database before
// it can't vouch, what was spent between the copy's last count and the restore isn't known: the restore says so, and
// keeps it (usage_gap) for `kumi usage` and `kumi doctor`.
import { sql } from "kysely";
import { connect, holdableTopics, holdPending, migrate, MESSAGE_FP, openSupportCount, REPEAT_WINDOW_DAYS, runAsSystem, USAGE_KINDS, type Db, type HeldCounts, type Trx } from "@kumi/core";

export interface SentBefore {
  timeline: string;
  messages: Array<{ id: string; status: string; sent_at: Date | null; failure: string | null }>;
  events: Array<{ id: string; delivered_at: Date }>;
  /** Emails, texts and pushes it had sent, by fingerprint (repeats.ts): kept for those the copy doesn't have. */
  fingerprints?: Array<{ id: string; fp: string; sent_at: Date }>;
  /** Support access it had ended (support.ts): a copy from before then mustn't bring it back. */
  support_ended?: Array<{ id: string; ended_at: Date; ended_by: string | null; end_told_at: Date | null }>;
  /** Its usage meter (usage.ts): what was spent since the copy stays counted. */
  usage?: MeterBefore;
  /** Addresses the email service said can't take the club's email (email_suppression.ts), and the desk's clears. */
  suppressions?: Array<{ address: string; reason: string; detail: string | null; first_at: Date; last_at: Date; times: number; cleared_at: Date | null; cleared_by: string | null }>;
}
/** The usage meter a database had: each club month's counts by kind, and the 80%, cap and paused messages said. */
export interface MeterBefore {
  months: Array<{ month: string; kind: string; count: number; input_tokens: string; output_tokens: string; segments: number; cents: string; updated_at: Date }>;
  alerts: Array<{ month: string; near_cap: number | null; reached_cap: number | null; paused_limit: number | null }>;
}
export interface AfterRestore {
  carried: { messages: number; events_held: number; repeats: number }; held: HeldCounts; vouched: boolean; support_ended: number;
  /** The club months whose meter kept what was spent since the copy; gap: it couldn't (the database before can't vouch). */
  usage: { months: string[]; gap: boolean };
}

/** The club's first recorded change: two databases with the same one are the same club's, one an earlier copy of
 *  the other. */
async function timeline(db: ReturnType<typeof connect>): Promise<string | null> {
  return (await sql<{ id: string | null }>`SELECT (SELECT id::text FROM action_run ORDER BY created_at, id LIMIT 1) AS id`.execute(db)).rows[0]?.id ?? null;
}

/** Its own queries: a database from before the meter (migration 064) has none, and can still vouch. */
async function readMeter(db: Db): Promise<MeterBefore> {
  const months = (await sql<MeterBefore["months"][number]>`SELECT month::text AS month, kind, count, input_tokens::text AS input_tokens,
    output_tokens::text AS output_tokens, segments, cents::text AS cents, updated_at FROM usage_month`.execute(db).catch(() => ({ rows: [] }))).rows;
  const alerts = (await sql<MeterBefore["alerts"][number]>`SELECT month::text AS month, near_cap, reached_cap, paused_limit FROM usage_alert`
    .execute(db).catch(() => ({ rows: [] }))).rows;
  return { months, alerts };
}

/** Each club month and kind keeps the larger count (the meter only ever goes up within a month), and a message either
 *  database had said for a month stays said, so the carried count doesn't bring the 80% or cap message again. The
 *  months whose meter went up. */
async function carryMeter(db: Db | Trx, u: MeterBefore | undefined): Promise<string[]> {
  if (!u) return [];
  const months = new Set<string>();
  if (u.months.length) {
    const r = await sql<{ month: string }>`INSERT INTO usage_month AS u (month, kind, count, input_tokens, output_tokens, segments, cents, updated_at)
      SELECT s.month, s.kind, s.count, s.input_tokens, s.output_tokens, s.segments, s.cents, s.updated_at
      FROM jsonb_to_recordset(${JSON.stringify(u.months)}::jsonb) AS s(month date, kind text, count int, input_tokens bigint, output_tokens bigint, segments int, cents numeric, updated_at timestamptz)
      WHERE s.kind = ANY(${USAGE_KINDS})
      ON CONFLICT (month, kind) DO UPDATE SET count = greatest(u.count, excluded.count), input_tokens = greatest(u.input_tokens, excluded.input_tokens),
        output_tokens = greatest(u.output_tokens, excluded.output_tokens), segments = greatest(u.segments, excluded.segments),
        cents = greatest(u.cents, excluded.cents), updated_at = greatest(u.updated_at, excluded.updated_at)
      WHERE excluded.count > u.count OR excluded.input_tokens > u.input_tokens OR excluded.output_tokens > u.output_tokens
        OR excluded.segments > u.segments OR excluded.cents > u.cents
      RETURNING u.month::text AS month`.execute(db);
    for (const row of r.rows) months.add(row.month);
  }
  if (u.alerts.length) {
    await sql`INSERT INTO usage_alert AS a (month, near_cap, reached_cap, paused_limit)
      SELECT s.month, s.near_cap, s.reached_cap, s.paused_limit FROM jsonb_to_recordset(${JSON.stringify(u.alerts)}::jsonb) AS s(month date, near_cap int, reached_cap int, paused_limit int)
      ON CONFLICT (month) DO UPDATE SET near_cap = coalesce(a.near_cap, excluded.near_cap), reached_cap = coalesce(a.reached_cap, excluded.reached_cap),
        paused_limit = coalesce(a.paused_limit, excluded.paused_limit)`.execute(db);
  }
  return [...months].sort();
}

/** Nothing to carry the meter over from: what was spent between the copy's last count and now isn't known. */
async function recordGap(db: Db, now: Date): Promise<void> {
  const last = (await sql<{ at: Date | null }>`SELECT max(updated_at) AS at FROM usage_month`.execute(db)).rows[0]?.at ?? null;
  await sql`INSERT INTO usage_gap (restored_at, counted_until) VALUES (${now}, ${last}) ON CONFLICT (restored_at) DO NOTHING`.execute(db);
}

/** For an import (export.ts): the meter of the database about to be replaced, with whose club it is. */
export async function readMeterBefore(url: string): Promise<(MeterBefore & { timeline: string }) | null> {
  const db = connect(url);
  try {
    const t = await timeline(db);
    return t ? { timeline: t, ...await readMeter(db) } : null;
  } catch { return null; } finally { await db.destroy(); }
}
/** An export put onto the server the club ran on before: the meter keeps what that database had counted (the club
 *  may have come back, or the file be older than this server's copy). Another club's, or none: nothing to carry. */
export async function carryMeterAfterImport(db: Db, before: (MeterBefore & { timeline: string }) | null): Promise<string[]> {
  if (!before || before.timeline !== await timeline(db)) return [];
  return db.transaction().execute((trx) => carryMeter(trx, before));
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
    const fingerprints = (await sql<NonNullable<SentBefore["fingerprints"]>[number]>`SELECT id::text, ${sql.raw(MESSAGE_FP)} AS fp, sent_at FROM outbound_message
      WHERE status = 'sent' AND channel <> 'inbox' AND sent_at IS NOT NULL AND created_at >= ${since}`.execute(db)).rows;
    // Its own query: a database from before support access (migration 067) has no such table, and can still vouch.
    const support_ended = (await sql<NonNullable<SentBefore["support_ended"]>[number]>`SELECT id::text, ended_at, ended_by::text, end_told_at FROM support_grant
      WHERE ended_at IS NOT NULL`.execute(db).catch(() => ({ rows: [] }))).rows;
    // Its own query too: a database from before migration 072 has none.
    const suppressions = (await sql<NonNullable<SentBefore["suppressions"]>[number]>`SELECT address, reason, detail, first_at, last_at, times, cleared_at, cleared_by::text
      FROM email_suppression`.execute(db).catch(() => ({ rows: [] }))).rows;
    return { timeline: t, messages, events, fingerprints, support_ended, usage: await readMeter(db), suppressions };
  } catch { return null; } finally { await db.destroy(); }
}

/** Right after a restore (the server still stopped): bring the restored copy up to this Kumi, then carry over what
 *  the database before it had sent, or hold what's waiting when it couldn't say. */
export async function afterRestore(url: string, before: SentBefore | null, now = new Date()): Promise<AfterRestore> {
  const db = connect(url);
  try {
    await migrate(db);
    if (!before || before.timeline !== await timeline(db)) {
      const held = await holdPending(db, now);
      // It can't say which support access was ended since: all of it ends, and the owners hear (support.ts).
      const open = await openSupportCount(db, now);
      if (open) await runAsSystem(db, "support.end_all", { why: "restored" }, "restore", { now });
      await recordGap(db, now);
      return { carried: { messages: 0, events_held: 0, repeats: 0 }, held, vouched: false, support_ended: open, usage: { months: [], gap: true } };
    }
    return await db.transaction().execute(async (trx) => {
      let messages = 0, eventsHeld = 0, repeats = 0;
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
      // Sent since the copy was made, so the copy has no row for it: its fingerprint, for the week ahead.
      if (before.fingerprints?.length) {
        const until = new Date(now.getTime() + REPEAT_WINDOW_DAYS * 86_400_000);
        const r = await sql`INSERT INTO sent_before_restore (fp, message_id, sent_at, restored_at, until)
          SELECT s.fp, s.id, s.sent_at, ${now}, ${until} FROM jsonb_to_recordset(${JSON.stringify(before.fingerprints)}::jsonb) AS s(id uuid, fp text, sent_at timestamptz)
          WHERE NOT EXISTS (SELECT 1 FROM outbound_message m WHERE m.id = s.id)`.execute(trx);
        repeats = Number(r.numAffectedRows ?? 0);
      }
      // Support access the database before it had ended stays ended (the owner already heard when it ended).
      let supportEnded = 0;
      if (before.support_ended?.length) {
        const r = await sql`UPDATE support_grant g SET ended_at = s.ended_at, ended_by = (SELECT p.id FROM person p WHERE p.id = s.ended_by), end_told_at = coalesce(s.end_told_at, s.ended_at), version = g.version + 1
          FROM jsonb_to_recordset(${JSON.stringify(before.support_ended)}::jsonb) AS s(id uuid, ended_at timestamptz, ended_by uuid, end_told_at timestamptz)
          WHERE g.id = s.id AND g.ended_at IS NULL`.execute(trx);
        supportEnded = Number(r.numAffectedRows ?? 0);
      }
      const usage = { months: await carryMeter(trx, before.usage), gap: false };
      // An address reported since the copy (or cleared since) stays as the database before it had it: whichever
      // happened last wins. With no database to vouch, nothing is carried: the next email bounces and is reported again.
      if (before.suppressions?.length)
        await sql`INSERT INTO email_suppression AS e (address, reason, detail, first_at, last_at, times, cleared_at, cleared_by)
          SELECT s.address, s.reason, s.detail, s.first_at, s.last_at, s.times, s.cleared_at, (SELECT p.id FROM person p WHERE p.id = s.cleared_by)
          FROM jsonb_to_recordset(${JSON.stringify(before.suppressions)}::jsonb) AS s(address text, reason text, detail text, first_at timestamptz, last_at timestamptz, times int, cleared_at timestamptz, cleared_by uuid)
          ON CONFLICT (address) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, first_at = least(e.first_at, EXCLUDED.first_at), last_at = EXCLUDED.last_at,
            times = greatest(e.times, EXCLUDED.times), cleared_at = EXCLUDED.cleared_at, cleared_by = EXCLUDED.cleared_by, version = e.version + 1
          WHERE greatest(EXCLUDED.last_at, coalesce(EXCLUDED.cleared_at, '-infinity')) > greatest(e.last_at, coalesce(e.cleared_at, '-infinity'))`.execute(trx);
      return { carried: { messages, events_held: eventsHeld, repeats }, held: { messages: 0, events: eventsHeld }, vouched: true, support_ended: supportEnded, usage };
    });
  } finally { await db.destroy(); }
}
