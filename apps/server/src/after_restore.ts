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
// What was taken away on request since the copy comes back with it unless it's carried too: an account deleted, a
// chat message taken back or hidden by the club, a sign-in, device, assistant or code ended or used, a yes or no to
// texts or club news. So those are read from the database before it as well (GONE below, the same SQL release.sh runs
// when an update's snapshot goes back) and done again: a deleted account is queued (erase_after_restore) and deleted
// again the same way (privacy.ts), right after the restore and whenever the server starts.
//
// The usage meter (usage.ts) is carried over too: the copy's counts are older, so what AI, texts and email cost since
// would go uncounted, and the host would bill too little and the cap let more through. Each club month and kind
// keeps the larger of the two counts, and an 80% or cap message either had said stays said. When the database before
// it can't vouch, what was spent between the copy's last count and the restore isn't known: the restore says so, and
// keeps it (usage_gap) for `kumi usage` and `kumi doctor`.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sql } from "kysely";
import { newestLocal } from "./backups.ts";
import { connect, eraseAfterRestore, holdableTopics, holdPending, migrate, MESSAGE_FP, openSupportCount, REPEAT_WINDOW_DAYS, runAsSystem, USAGE_KINDS, type Db, type HeldCounts, type Trx } from "@kumi/core";

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
  /** What it had taken away on request (GONE): done again in the copy. */
  gone?: GoneBefore;
}
/** The usage meter a database had: each club month's counts by kind, and the 80%, cap and paused messages said. */
export interface MeterBefore {
  months: Array<{ month: string; kind: string; count: number; input_tokens: string; output_tokens: string; segments: number; cents: string; updated_at: Date }>;
  alerts: Array<{ month: string; near_cap: number | null; reached_cap: number | null; paused_limit: number | null }>;
}
/** What a database had taken away on request, which a copy from before then would bring back (each its rows, as
 *  GONE's read gives them). */
export type GoneBefore = Record<GoneKind, Record<string, unknown>[]>;
type GoneKind = (typeof GONE_PARTS)[number] | `revoked:${string}`;

/** The SQL for each, in one place: after_restore.ts runs it with the rows read from the database before, and
 *  deploy/release.sh runs the same strings (COPY (read) TO STDOUT before, then table, COPY FROM STDIN and apply after;
 *  deploy.test checks the two match, and kumi-hosted's own rollback uses them too). Each apply only takes away, never
 *  gives back, so it's safe to run again. */
export const GONE = {
  // Accounts deleted (and any the database before it still had waiting to delete again, from an earlier restore):
  // queued with who asked, and deleted again by privacy.erase_again.
  people: { read: "SELECT p.id, p.redacted_at, (SELECT CASE WHEN r.actor_person_id = p.id THEN 'self' WHEN r.actor_person_id IS NOT NULL THEN 'staff' END FROM action_run r WHERE r.action = 'privacy.erase' AND r.status = 'applied' AND r.input->>'person_id' = p.id::text ORDER BY r.applied_at DESC LIMIT 1) AS deleted_by FROM person p WHERE p.redacted_at IS NOT NULL UNION ALL SELECT q.person_id, q.redacted_at, q.deleted_by FROM erase_after_restore q",
    table: "CREATE TEMP TABLE kumi_gone (id uuid, redacted_at timestamptz, deleted_by text)",
    apply: "INSERT INTO erase_after_restore (person_id, redacted_at, deleted_by) SELECT g.id, g.redacted_at, g.deleted_by FROM kumi_gone g JOIN person p ON p.id = g.id WHERE p.redacted_at IS NULL ON CONFLICT (person_id) DO NOTHING" },
  // Chat messages taken back or hidden by the club: their words go where the database before it had blanked them,
  // and stay where it kept them for the staff (a report still open there).
  chat: { read: "SELECT id, removed_at, hidden_at, hidden_by, body = '' AS blank FROM chat_message WHERE removed_at IS NOT NULL OR hidden_at IS NOT NULL",
    table: "CREATE TEMP TABLE kumi_chat_gone (id uuid, removed_at timestamptz, hidden_at timestamptz, hidden_by uuid, blank boolean)",
    apply: "UPDATE chat_message m SET removed_at = coalesce(m.removed_at, g.removed_at), hidden_at = coalesce(m.hidden_at, g.hidden_at), hidden_by = coalesce(m.hidden_by, (SELECT p.id FROM person p WHERE p.id = g.hidden_by)), body = CASE WHEN g.blank THEN '' ELSE m.body END, version = m.version + 1 FROM kumi_chat_gone g WHERE m.id = g.id AND ((g.removed_at IS NOT NULL AND m.removed_at IS NULL) OR (g.hidden_at IS NOT NULL AND m.hidden_at IS NULL) OR (g.blank AND m.body <> ''))" },
  // Staff authenticators: whichever row changed last (set up, or removed) wins, whole, secret and all (sealed under
  // the same server key), so a replaced one works and the old one doesn't, and a removed one stays removed; the same
  // one keeps the later of the two codes used. Read as text: a timestamp through JavaScript loses its microseconds.
  factors: { read: "SELECT person_id, secret, confirmed_at::text AS confirmed_at, last_step, removed_at::text AS removed_at FROM staff_factor",
    table: "CREATE TEMP TABLE kumi_factor (person_id uuid, secret text, confirmed_at timestamptz, last_step bigint, removed_at timestamptz)",
    apply: "INSERT INTO staff_factor AS f (person_id, secret, confirmed_at, last_step, removed_at) SELECT g.person_id, g.secret, g.confirmed_at, g.last_step, g.removed_at FROM kumi_factor g JOIN person p ON p.id = g.person_id WHERE p.redacted_at IS NULL ON CONFLICT (person_id) DO UPDATE SET secret = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.secret ELSE f.secret END, confirmed_at = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.confirmed_at ELSE f.confirmed_at END, removed_at = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.removed_at ELSE f.removed_at END, last_step = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.last_step ELSE greatest(f.last_step, excluded.last_step) END, version = f.version + 1 WHERE greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) OR (excluded.confirmed_at = f.confirmed_at AND excluded.last_step > f.last_step)" },
  // Sign-in addresses taken away on request (an attacker's phone undone, a kid's own login removed): a copy's address
  // goes when the database before it has neither that row nor the same address for that person.
  idents: { read: "SELECT p.id AS person_id, a.id, a.kind, a.value, a.verified_at::text AS verified_at FROM person p LEFT JOIN auth_identity a ON a.person_id = p.id WHERE p.redacted_at IS NULL",
    table: "CREATE TEMP TABLE kumi_ident (person_id uuid, id uuid, kind text, value text, verified_at timestamptz)",
    apply: "DELETE FROM auth_identity a WHERE EXISTS (SELECT 1 FROM kumi_ident k WHERE k.person_id = a.person_id) AND NOT EXISTS (SELECT 1 FROM kumi_ident k WHERE k.id = a.id OR (k.person_id = a.person_id AND k.kind = a.kind AND k.value = a.value))" },
  // And where that left someone with no address of a kind the database before it has for them, theirs from there,
  // so nobody is locked out of their own account.
  idents_back: { read: "SELECT p.id AS person_id, a.id, a.kind, a.value, a.verified_at::text AS verified_at FROM person p LEFT JOIN auth_identity a ON a.person_id = p.id WHERE p.redacted_at IS NULL",
    table: "CREATE TEMP TABLE kumi_ident_back (person_id uuid, id uuid, kind text, value text, verified_at timestamptz)",
    apply: "INSERT INTO auth_identity (id, person_id, kind, value, verified_at) SELECT k.id, k.person_id, k.kind, k.value, k.verified_at FROM kumi_ident_back k JOIN person p ON p.id = k.person_id AND p.redacted_at IS NULL WHERE k.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth_identity x WHERE x.person_id = k.person_id AND x.kind = k.kind) ON CONFLICT DO NOTHING" },
  // A phone number taken off since (removed, or undone after someone else added it): off in the copy too.
  phones: { read: "SELECT id FROM person WHERE phone IS NULL AND redacted_at IS NULL",
    table: "CREATE TEMP TABLE kumi_nophone (id uuid)",
    apply: "UPDATE person x SET phone = NULL, version = x.version + 1 FROM kumi_nophone g WHERE x.id = g.id AND x.phone IS NOT NULL" },
  // Every no to texts, email and club news made since the copy is added (they're never changed); a yes only when the
  // copy has the same number or address it was given for, so it never reaches a number the member has left.
  consents: { read: "SELECT c.id, c.person_id, c.channel, c.purpose, c.granted, c.source, c.form_version, c.evidence, c.at, (SELECT CASE c.channel WHEN 'sms' THEN p.phone WHEN 'email' THEN p.email END FROM person p WHERE p.id = c.person_id) AS addr FROM channel_consent c",
    table: "CREATE TEMP TABLE kumi_consent (id uuid, person_id uuid, channel text, purpose text, granted boolean, source text, form_version text, evidence jsonb, at timestamptz, addr text)",
    apply: "INSERT INTO channel_consent (id, person_id, channel, purpose, granted, source, form_version, evidence, at) SELECT c.id, c.person_id, c.channel, c.purpose, c.granted, c.source, c.form_version, c.evidence, c.at FROM kumi_consent c JOIN person p ON p.id = c.person_id WHERE NOT EXISTS (SELECT 1 FROM channel_consent x WHERE x.id = c.id) AND (NOT c.granted OR c.addr IS NOT DISTINCT FROM CASE c.channel WHEN 'sms' THEN p.phone WHEN 'email' THEN p.email END)" },
  // A family card removed: removed in the copy too, so it isn't charged.
  cards: { read: "SELECT id, removed_at FROM family_card WHERE status = 'removed'",
    table: "CREATE TEMP TABLE kumi_card (id uuid, removed_at timestamptz)",
    apply: "UPDATE family_card x SET status = 'removed', removed_at = coalesce(x.removed_at, g.removed_at), saved_customer = NULL, saved_method = NULL, version = x.version + 1 FROM kumi_card g WHERE x.id = g.id AND x.status <> 'removed'" },
  // A phone's push, by its address: the copy stops pushing to a device that's someone else's since, or nobody's.
  push: { read: "SELECT endpoint, person_id, revoked_at FROM push_subscription",
    table: "CREATE TEMP TABLE kumi_push (endpoint text, person_id uuid, revoked_at timestamptz)",
    apply: "UPDATE push_subscription x SET revoked_at = now() WHERE x.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM kumi_push g WHERE g.endpoint = x.endpoint AND g.person_id = x.person_id AND g.revoked_at IS NULL)" },
  // Gift cards redeemed or voided since: so in the copy too (a code redeemed can't be redeemed again), a redemption's
  // value moved from the cards owed to the redeemer's club credit, as it was then.
  gifts: { read: "SELECT id, status, redeemed_by, redeemed_at::text AS redeemed_at, voided_at::text AS voided_at FROM gift_card WHERE status IN ('redeemed', 'void')",
    table: "CREATE TEMP TABLE kumi_gift (id uuid, status text, redeemed_by uuid, redeemed_at timestamptz, voided_at timestamptz)",
    apply: "WITH done AS (UPDATE gift_card x SET status = g.status, redeemed_by = (SELECT p.id FROM person p WHERE p.id = g.redeemed_by), redeemed_at = g.redeemed_at, voided_at = g.voided_at, version = x.version + 1 FROM kumi_gift g WHERE x.id = g.id AND x.status NOT IN ('redeemed', 'void') RETURNING x.id, x.status, x.redeemed_by, x.amount_cents), moves AS (SELECT gen_random_uuid() AS txn_id, d.* FROM done d WHERE d.status = 'redeemed' AND d.redeemed_by IS NOT NULL), run AS (INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at) SELECT gen_random_uuid(), 'restore.carry', 1, 'restore', '{}', '{}', 'applied', 'none', '{}', now(), now() WHERE EXISTS (SELECT 1 FROM moves) RETURNING id), acct AS (INSERT INTO ledger_account (id, kind, person_id) SELECT gen_random_uuid(), 'member_credit', m.redeemed_by FROM moves m ON CONFLICT DO NOTHING RETURNING id, person_id), txn AS (INSERT INTO ledger_txn (id, kind, action_run_id, memo) SELECT m.txn_id, 'gift_card_redeemed', (SELECT id FROM run), 'gift card redeemed before a restore, carried over' FROM moves m RETURNING id), ent AS (INSERT INTO ledger_entry (txn_id, account_id, amount_cents) SELECT m.txn_id, (SELECT a.id FROM ledger_account a WHERE a.kind = 'gift_cards' AND a.person_id IS NULL AND a.revenue_type IS NULL), m.amount_cents FROM moves m UNION ALL SELECT m.txn_id, coalesce((SELECT c.id FROM acct c WHERE c.person_id = m.redeemed_by), (SELECT a.id FROM ledger_account a WHERE a.kind = 'member_credit' AND a.person_id = m.redeemed_by)), -m.amount_cents FROM moves m RETURNING 1) SELECT count(*) AS n FROM done" },
  // Club credit paid out at the desk or spent since: nobody's credit in the copy is more than the database before it
  // had left (the difference goes to the books' adjustment account), so cash handed over can't be paid out again.
  // Never more: credit the copy lacks isn't made up.
  credit: { read: "SELECT person_id, cents FROM member_credit_balance",
    table: "CREATE TEMP TABLE kumi_credit (person_id uuid, cents bigint)",
    apply: "WITH over AS (SELECT a.id AS account_id, b.cents - coalesce(g.cents, 0) AS cut FROM member_credit_balance b JOIN ledger_account a ON a.kind = 'member_credit' AND a.person_id = b.person_id LEFT JOIN kumi_credit g ON g.person_id = b.person_id WHERE b.cents > coalesce(g.cents, 0)), moves AS (SELECT gen_random_uuid() AS txn_id, o.* FROM over o), run AS (INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at) SELECT gen_random_uuid(), 'restore.carry', 1, 'restore', '{}', '{}', 'applied', 'none', '{}', now(), now() WHERE EXISTS (SELECT 1 FROM moves) RETURNING id), adj AS (INSERT INTO ledger_account (id, kind) SELECT gen_random_uuid(), 'adjustment' WHERE EXISTS (SELECT 1 FROM moves) ON CONFLICT DO NOTHING RETURNING id), txn AS (INSERT INTO ledger_txn (id, kind, action_run_id, memo) SELECT m.txn_id, 'restore_credit', (SELECT id FROM run), 'club credit paid out or spent before a restore, carried over' FROM moves m RETURNING id), ent AS (INSERT INTO ledger_entry (txn_id, account_id, amount_cents) SELECT m.txn_id, m.account_id, m.cut FROM moves m UNION ALL SELECT m.txn_id, coalesce((SELECT id FROM adj), (SELECT a.id FROM ledger_account a WHERE a.kind = 'adjustment' AND a.person_id IS NULL AND a.revenue_type IS NULL)), -m.cut FROM moves m RETURNING 1) SELECT count(*) AS n FROM moves" },
  // Wrong gift card codes tried: the count starts again (it only slows guessing).
  tries: { read: "SELECT count(*) AS n FROM gift_card_try",
    table: "CREATE TEMP TABLE kumi_tries (n bigint)",
    apply: "DELETE FROM gift_card_try" },
  // Ended or used since: sign-ins (signed out), passkeys, phones' push, calendar links, assistants and their tokens,
  // recovery codes. "$t $k $c" is the table, its key and the column (REVOKED).
  revoked: { read: "SELECT $k::text, $c FROM $t WHERE $c IS NOT NULL",
    table: "CREATE TEMP TABLE kumi_rev (k text, at timestamptz)",
    apply: "UPDATE $t x SET $c = r.at FROM kumi_rev r WHERE x.$k::text = r.k AND x.$c IS NULL" },
} as const;
/** A database from before the queue (migration 082) can't be read with GONE.people.read: its deletions alone. */
export const GONE_PEOPLE_OLD = "SELECT p.id, p.redacted_at, NULL::text AS deleted_by FROM person p WHERE p.redacted_at IS NOT NULL";
/** A snapshot from before the queue: who came back, to be deleted again by hand (release.sh and kumi-hosted say so). */
export const GONE_LIST = "SELECT g.id, p.display_name, g.deleted_by FROM kumi_gone g JOIN person p ON p.id = g.id WHERE p.redacted_at IS NULL";
/** The parts carried, in this order (release.sh and kumi-hosted run them in the same order). */
export const GONE_PARTS = ["people", "chat", "factors", "idents", "idents_back", "phones", "consents", "cards", "push", "gifts", "credit", "tries"] as const;
export const REVOKED: ReadonlyArray<readonly [table: string, key: string, column: string]> = [
  ["web_session", "token_hash", "revoked_at"], ["passkey", "credential_id", "revoked_at"], ["push_subscription", "id", "revoked_at"],
  ["calendar_feed", "id", "revoked_at"], ["oauth_grant", "id", "revoked_at"], ["oauth_token", "token_hash", "revoked_at"],
  ["oauth_token", "token_hash", "used_at"], ["recovery_code", "id", "used_at"],
];
const fill = (q: string, [t, k, c]: readonly [string, string, string]) => q.replaceAll("$t", t).replaceAll("$k", k).replaceAll("$c", c);
const revokedKey = (r: readonly [string, string, string]) => `revoked:${r[0]}.${r[2]}` as const;

/** What the database had taken away (each read on its own: a database from before one of them has none of it). */
async function readGone(db: Db): Promise<GoneBefore> {
  const rows = async (q: string) => (await sql.raw<Record<string, unknown>>(q).execute(db).then((r) => r.rows, () => null));
  const gone = {} as GoneBefore;
  for (const k of GONE_PARTS) gone[k] = (await rows(GONE[k].read)) ?? [];
  // A database from before the queue (082) can't answer the people read: its deletions alone.
  if (!gone.people.length) gone.people = (await rows(GONE_PEOPLE_OLD)) ?? [];
  for (const r of REVOKED) gone[revokedKey(r)] = ((await rows(fill(GONE.revoked.read, r))) ?? []).map((x) => { const [k, at] = Object.values(x); return { k, at }; });
  return gone;
}

/** Done again in the copy (brought up to this Kumi first, so every table is there), with the same SQL as release.sh:
 *  the rows go into its temporary table, then its apply, in GONE_PARTS' order. How many accounts were queued, and
 *  how many other things taken away again. */
async function carryGone(trx: Trx, gone: GoneBefore | undefined): Promise<{ people: number; other: number }> {
  if (!gone) return { people: 0, other: 0 };
  const cols = (table: string) => /\((.*)\)$/.exec(table)![1]!, nameOf = (table: string) => /^CREATE TEMP TABLE (\w+)/.exec(table)![1]!;
  const run = async (part: { table: string; apply: string }, rows: Record<string, unknown>[] | undefined) => {
    if (!rows?.length) return 0;
    const name = nameOf(part.table);
    await sql.raw(part.table).execute(trx);
    await sql`INSERT INTO ${sql.raw(name)} SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS s(${sql.raw(cols(part.table))})`.execute(trx);
    const r = await sql.raw(part.apply).execute(trx);
    await sql.raw(`DROP TABLE ${name}`).execute(trx);
    return Number(r.numAffectedRows ?? (r.rows[0] as { n?: string } | undefined)?.n ?? 0);
  };
  let people = 0, other = 0;
  for (const k of GONE_PARTS) { const n = await run(GONE[k], gone[k]); if (k === "people") people = n; else other += n; }
  for (const r of REVOKED) other += await run({ table: GONE.revoked.table, apply: fill(GONE.revoked.apply, r) }, gone[revokedKey(r)]);
  return { people, other };
}

/** Who keeps their account after a restore although the database before it had deleted it: those staff deleted, when
 *  the person running the restore says so (`--keep-staff-deleted`, or by id with `--keep`). Someone who deleted their
 *  own account is always deleted again. */
export interface KeepDeleted { staff?: boolean; ids?: string[] }
/** The accounts queued to be deleted again, with who asked; those kept are taken off the queue first. */
async function queuedPeople(db: Db, keep: KeepDeleted | undefined): Promise<GonePerson[]> {
  const rows = await db.selectFrom("erase_after_restore").innerJoin("person", "person.id", "erase_after_restore.person_id")
    .select(["erase_after_restore.person_id as id", "person.display_name as name", "erase_after_restore.deleted_by as by"]).orderBy("erase_after_restore.queued_at").execute();
  const kept = rows.filter((r) => r.by !== "self" && ((keep?.staff && r.by === "staff") || keep?.ids?.includes(r.id)));
  if (kept.length) await db.deleteFrom("erase_after_restore").where("person_id", "in", kept.map((r) => r.id)).execute();
  return rows.map((r) => ({ id: r.id, name: r.name, by: r.by, kept: kept.includes(r) }));
}
export interface GonePerson { id: string; name: string; by: "self" | "staff" | null; kept: boolean }
/** What deleting them again did: how many, the last owner's role kept, money left for the desk to give back. */
async function eraseQueued(db: Db, people: GonePerson[], now: Date): Promise<AfterRestore["gone"]> {
  const r = await eraseAfterRestore(db, now);
  return { erased: r.erased, other: 0, people, last_owner_kept: r.lastOwnerKept, failed: r.failed };
}

export interface AfterRestore {
  carried: { messages: number; events_held: number; repeats: number }; held: HeldCounts; vouched: boolean; support_ended: number;
  /** The club months whose meter kept what was spent since the copy; gap: it couldn't (the database before can't vouch). */
  usage: { months: string[]; gap: boolean };
  /** Accounts the database before it had deleted, deleted again (each with who asked, and whether it was kept); other
   *  things it had taken away, taken away again; the last owner whose role stayed; any not deleted yet (the next start
   *  tries again). unvouched: the database before it couldn't say, so only the newest backup's list (from_backup)
   *  could be used, or nothing. */
  gone: { erased: number; other: number; people: GonePerson[]; last_owner_kept: string[]; failed: number; unvouched?: boolean; from_backup?: string | null };
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

/** For an import (export.ts): what the database about to be replaced had taken away on request, with whose club it is. */
export async function readGoneBefore(url: string): Promise<{ timeline: string; gone: GoneBefore } | null> {
  const db = connect(url);
  try {
    const t = await timeline(db);
    return t ? { timeline: t, gone: await readGone(db) } : null;
  } catch { return null; } finally { await db.destroy(); }
}
/** An export put onto the server the club ran on before: what this server's database had taken away since the file
 *  was made (an account deleted, words taken back) is taken away again. Another club's, or none: nothing to carry. */
export async function carryGoneAfterImport(db: Db, before: { timeline: string; gone: GoneBefore } | null, now = new Date(), keep?: KeepDeleted): Promise<AfterRestore["gone"]> {
  if (!before || before.timeline !== await timeline(db)) return { erased: 0, other: 0, people: [], last_owner_kept: [], failed: 0 };
  const { other } = await db.transaction().execute((trx) => carryGone(trx, before.gone));
  return { ...await eraseQueued(db, await queuedPeople(db, keep), now), other };
}

/** The database before it can't vouch (lost, empty, unreadable, another club's): the newest nightly backup's list of
 *  deleted accounts (backups.ts writes it into each manifest), if there is one here, is queued instead. */
async function queueFromBackup(db: Db, dir: string | undefined): Promise<string | null> {
  const newest = dir ? newestLocal(dir) : null;
  if (!newest?.manifestFile) return null;
  let redacted: Array<{ id: string; at: string }> = [];
  try { redacted = (JSON.parse(readFileSync(newest.manifestFile, "utf8")) as { redacted?: typeof redacted }).redacted ?? []; } catch { return null; }
  if (redacted.length) await sql`INSERT INTO erase_after_restore (person_id, redacted_at) SELECT g.id, g.at FROM jsonb_to_recordset(${JSON.stringify(redacted)}::jsonb) AS g(id uuid, at timestamptz)
    JOIN person p ON p.id = g.id WHERE p.redacted_at IS NULL ON CONFLICT (person_id) DO NOTHING`.execute(db);
  return basename(newest.manifestFile);
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
    return { timeline: t, messages, events, fingerprints, support_ended, usage: await readMeter(db), suppressions, gone: await readGone(db) };
  } catch { return null; } finally { await db.destroy(); }
}

/** Right after a restore (the server still stopped): bring the restored copy up to this Kumi, then carry over what
 *  the database before it had sent, or hold what's waiting when it couldn't say. */
export async function afterRestore(url: string, before: SentBefore | null, now = new Date(), o: { keep?: KeepDeleted; backupDir?: string } = {}): Promise<AfterRestore> {
  const db = connect(url);
  try {
    await migrate(db);
    if (!before || before.timeline !== await timeline(db)) {
      const held = await holdPending(db, now);
      // It can't say which support access was ended since: all of it ends, and the owners hear (support.ts).
      const open = await openSupportCount(db, now);
      if (open) await runAsSystem(db, "support.end_all", { why: "restored" }, "restore", { now });
      await recordGap(db, now);
      // Nor which accounts were deleted since the copy: the newest backup here may know some of them.
      const fromBackup = await queueFromBackup(db, o.backupDir);
      const gone = await eraseQueued(db, await queuedPeople(db, o.keep), now);
      return { carried: { messages: 0, events_held: 0, repeats: 0 }, held, vouched: false, support_ended: open, usage: { months: [], gap: true }, gone: { ...gone, unvouched: true, from_backup: fromBackup } };
    }
    let other = 0;
    const done = await db.transaction().execute(async (trx) => {
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
      // What it had taken away on request: taken away again (GONE), deleted accounts queued for below.
      other = (await carryGone(trx, before.gone)).other;
      return { carried: { messages, events_held: eventsHeld, repeats }, held: { messages: 0, events: eventsHeld }, vouched: true, support_ended: supportEnded, usage };
    });
    // Deleted again now, the same way as the first time (and anything an earlier start couldn't finish), but for
    // those the person running the restore keeps.
    return { ...done, gone: { ...await eraseQueued(db, await queuedPeople(db, o.keep), now), other } };
  } finally { await db.destroy(); }
}
