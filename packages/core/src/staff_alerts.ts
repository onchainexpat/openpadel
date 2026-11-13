// Staff alerts on the Today view: the staff messages that need a person to do something (a place left empty at
// the last minute, a question still waiting, money owed, a program short of its minimum, a refund that failed,
// a membership renewal that failed or ended unpaid, what can wait paused at the club's monthly cap). Each stays on
// the list until someone marks it handled, once for the whole club, with who and when, or until it needs nobody
// (a failed renewal paid after all, the cap raised: closed with no one's name). The words are the message the
// person already got (the same event, in their language): nothing is written twice.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { decide } from "./permissions.ts";
import { messageInLang, readerLang } from "./messages.ts";

export const ALERT_KINDS = ["match_late_cancel_staff", "question_unanswered_staff", "booking_balance_due_staff", "booking_parts_owed_staff", "program_min_short", "program_min_cancelled_staff", "refund_failed", "ops_failed_staff", "ops_restore_staff",
  "membership_payment_failed_staff", "membership_ended_unpaid_staff", "usage_reached_staff", "usage_paused_staff", "chat_reported_staff", "playtomic_refund_staff", "playtomic_wallets_staff"] as const;
/** Alerts that stay however old they are, until handled: what a restore left for staff, and the Playtomic wallets to
 *  set to zero after their credit came over (brought_in.ts; the owner marks that done on the Playtomic page). */
const KEPT_KINDS = ["ops_restore_staff", "playtomic_wallets_staff"] as const;
/** How far back the list looks: older alerts have been dealt with one way or another. Not what a restore left for
 *  staff (ops_restore_staff): that stays until someone handles it, however long ago the restore was. */
export const ALERT_DAYS = 14;

/** The alerts this person was told about and nobody has handled yet, newest first, and the ones handled in the
 *  last day (with who). A message gone stale (a match that has started) no longer needs anyone. */
export async function staffAlerts(db: Db | Trx, personId: string, now: Date) {
  const since = new Date(now.getTime() - ALERT_DAYS * 86400_000);
  const rows = await db.selectFrom("outbound_message").leftJoin("staff_alert", (j) => j.onRef("staff_alert.event_id", "=", "outbound_message.event_id").onRef("staff_alert.kind", "=", "outbound_message.kind"))
    .leftJoin("person as by", "by.id", "staff_alert.handled_by")
    .select(["outbound_message.event_id", "outbound_message.kind", "outbound_message.subject", "outbound_message.body", "outbound_message.lang", "outbound_message.alt_subject", "outbound_message.alt_body", "outbound_message.link", "outbound_message.created_at",
      "staff_alert.handled_at", "by.display_name as handled_by"])
    .where("outbound_message.person_id", "=", personId).where("outbound_message.channel", "=", "inbox").where("outbound_message.purpose", "=", "staff")
    .where("outbound_message.kind", "in", [...ALERT_KINDS]).where("outbound_message.event_id", "is not", null)
    .where((eb) => eb.or([eb("outbound_message.created_at", ">=", since), eb.and([eb("outbound_message.kind", "in", [...KEPT_KINDS]), eb("staff_alert.handled_at", "is", null)])]))
    .where((eb) => eb.or([eb("staff_alert.id", "is not", null), eb("outbound_message.stale_at", "is", null), eb("outbound_message.stale_at", ">", now)]))
    .orderBy("outbound_message.created_at", "desc").limit(100).execute();
  const day = now.getTime() - 86400_000;
  // In the reader's language now, whatever it was when the alert was made.
  const lang = await readerLang(db, personId);
  const view = (r: (typeof rows)[number]) => ({ event_id: r.event_id!, kind: r.kind, ...messageInLang(r, lang), link: r.link, at: r.created_at });
  // Whether this person may mark each one handled: a desk kept to one location, only its own and the whole club's.
  const byPlace = new Map<string | null, boolean>();
  const may = async (eventId: string) => {
    const at = await alertLocation(db, eventId);
    if (!byPlace.has(at)) byPlace.set(at, (await decide(db, "alert.handle", { personId, locationId: at, at: now, clubWide: true })).mode !== "no");
    return byPlace.get(at)!;
  };
  const open = rows.filter((r) => !r.handled_at);
  const can = await Promise.all(open.map((r) => may(r.event_id!)));
  return {
    open: open.map((r, n) => ({ ...view(r), can_handle: can[n]! })),
    handled: rows.filter((r) => r.handled_at && new Date(r.handled_at).getTime() >= day).map((r) => ({ ...view(r), handled_at: r.handled_at!, handled_by: r.handled_by ?? "" })),
  };
}

/** Where an alert is, from the event it came from: its booking's location (a player's place, a match's chat), or its
 *  program's (a session, a place, a refund of one); null for the rest, which are the whole club's (a question, a
 *  membership, the club's own jobs), so any desk handles those. */
export async function alertLocation(db: Db | Trx, eventId: string): Promise<string | null> {
  const e = await db.selectFrom("event_outbox").select("payload").where("id", "=", eventId).executeTakeFirst();
  const p = (e?.payload ?? {}) as Record<string, unknown>, id = (k: string) => (typeof p[k] === "string" ? p[k] as string : null);
  let booking = id("booking_id"), program = id("program_id"), session = id("session_id");
  const seat = id("booking_player_id"), enrolment = id("enrolment_id"), refund = id("refund_id"), thread = id("thread_id");
  if (seat) booking ??= (await db.selectFrom("booking_player").select("booking_id").where("id", "=", seat).executeTakeFirst())?.booking_id ?? null;
  if (thread) {
    // A chat's game. The chat itself goes 90 days after the game (tidyChats) while its report can still be on Today:
    // then the event's own kind and ref_id (chat.reported carries both) still say whose it is.
    const t = await db.selectFrom("chat_thread").select(["kind", "ref_id"]).where("id", "=", thread).executeTakeFirst()
      ?? (id("kind") && id("ref_id") ? { kind: id("kind")!, ref_id: id("ref_id")! } : undefined);
    if (t?.kind === "booking") booking ??= t.ref_id; else if (t?.kind === "session") session ??= t.ref_id;
  }
  if (refund && !booking && !program) {
    const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").leftJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .select(["refund.enrolment_id", "booking_player.booking_id"]).where("refund.id", "=", refund).executeTakeFirst();
    booking = r?.booking_id ?? null;
    if (!booking && r?.enrolment_id) program = (await db.selectFrom("enrolment").select("program_id").where("id", "=", r.enrolment_id).executeTakeFirst())?.program_id ?? null;
  }
  if (booking) return (await db.selectFrom("booking").select("location_id").where("id", "=", booking).executeTakeFirst())?.location_id ?? null;
  if (enrolment) program ??= (await db.selectFrom("enrolment").select("program_id").where("id", "=", enrolment).executeTakeFirst())?.program_id ?? null;
  if (session) program ??= (await db.selectFrom("session").select("program_id").where("id", "=", session).executeTakeFirst())?.program_id ?? null;
  if (program) return (await db.selectFrom("program").select("location_id").where("id", "=", program).executeTakeFirst())?.location_id ?? null;
  return null;
}

export const alertHandle = defineAction({
  name: "alert.handle", version: 1, clubWide: true,
  input: z.object({ event_id: z.string().check(z.regex(/^\d{1,18}$/)), kind: z.enum(ALERT_KINDS) }),
  async plan(ctx, i) {
    // The message as this person got it (or as anyone did): the alert's own words.
    const m = await ctx.db.selectFrom("outbound_message").select(["subject", "lang", "alt_subject"]).where("event_id", "=", i.event_id).where("kind", "=", i.kind).where("channel", "=", "inbox")
      .orderBy(sql`person_id = ${ctx.actor.personId ?? "00000000-0000-0000-0000-000000000000"}`, "desc").limit(1).executeTakeFirst();
    if (!m) throw new KumiError("error.not_found", { thing: both("thing.alert") }, 404);
    if (await ctx.db.selectFrom("staff_alert").select("id").where("event_id", "=", i.event_id).where("kind", "=", i.kind).executeTakeFirst()) throw new KumiError("error.alert_handled");
    // Done only by saying the wallets are at zero (credit.brought_zeroed), which stops credit coming over again.
    if (i.kind === "playtomic_wallets_staff") throw new KumiError("error.alert_wallets_on_page");
    return { title: both("action.alert.handle"), summary: both("plan.alert.handle", { subject: { en: m.lang === "en" || m.alt_subject == null ? m.subject : m.alt_subject, es: m.lang === "es" || m.alt_subject == null ? m.subject : m.alt_subject } }), reads: [],
      // A booking's or a program's alert is that location's: a desk kept to another doesn't handle it (alertLocation).
      locationId: await alertLocation(ctx.db, i.event_id), undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx, i) {
    try { await ctx.insert("staff_alert", { id: uuidv7(), event_id: i.event_id, kind: i.kind, handled_by: ctx.actor.personId, handled_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.alert_handled"); throw e; }
    return null;
  },
});
