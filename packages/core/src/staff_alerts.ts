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

export const ALERT_KINDS = ["match_late_cancel_staff", "question_unanswered_staff", "booking_balance_due_staff", "program_min_short", "program_min_cancelled_staff", "refund_failed", "ops_failed_staff", "ops_restore_staff",
  "membership_payment_failed_staff", "membership_ended_unpaid_staff", "usage_reached_staff", "usage_paused_staff", "chat_reported_staff"] as const;
/** How far back the list looks: older alerts have been dealt with one way or another. Not what a restore left for
 *  staff (ops_restore_staff): that stays until someone handles it, however long ago the restore was. */
export const ALERT_DAYS = 14;

/** The alerts this person was told about and nobody has handled yet, newest first, and the ones handled in the
 *  last day (with who). A message gone stale (a match that has started) no longer needs anyone. */
export async function staffAlerts(db: Db | Trx, personId: string, now: Date) {
  const since = new Date(now.getTime() - ALERT_DAYS * 86400_000);
  const rows = await db.selectFrom("outbound_message").leftJoin("staff_alert", (j) => j.onRef("staff_alert.event_id", "=", "outbound_message.event_id").onRef("staff_alert.kind", "=", "outbound_message.kind"))
    .leftJoin("person as by", "by.id", "staff_alert.handled_by")
    .select(["outbound_message.event_id", "outbound_message.kind", "outbound_message.subject", "outbound_message.body", "outbound_message.link", "outbound_message.created_at",
      "staff_alert.handled_at", "by.display_name as handled_by"])
    .where("outbound_message.person_id", "=", personId).where("outbound_message.channel", "=", "inbox").where("outbound_message.purpose", "=", "staff")
    .where("outbound_message.kind", "in", [...ALERT_KINDS]).where("outbound_message.event_id", "is not", null)
    .where((eb) => eb.or([eb("outbound_message.created_at", ">=", since), eb.and([eb("outbound_message.kind", "=", "ops_restore_staff"), eb("staff_alert.handled_at", "is", null)])]))
    .where((eb) => eb.or([eb("staff_alert.id", "is not", null), eb("outbound_message.stale_at", "is", null), eb("outbound_message.stale_at", ">", now)]))
    .orderBy("outbound_message.created_at", "desc").limit(100).execute();
  const day = now.getTime() - 86400_000;
  const view = (r: (typeof rows)[number]) => ({ event_id: r.event_id!, kind: r.kind, subject: r.subject, body: r.body, link: r.link, at: r.created_at });
  return {
    open: rows.filter((r) => !r.handled_at).map(view),
    handled: rows.filter((r) => r.handled_at && new Date(r.handled_at).getTime() >= day).map((r) => ({ ...view(r), handled_at: r.handled_at!, handled_by: r.handled_by ?? "" })),
  };
}

export const alertHandle = defineAction({
  name: "alert.handle", version: 1,
  input: z.object({ event_id: z.string().check(z.regex(/^\d{1,18}$/)), kind: z.enum(ALERT_KINDS) }),
  async plan(ctx, i) {
    // The message as this person got it (or as anyone did): the alert's own words.
    const m = await ctx.db.selectFrom("outbound_message").select(["subject"]).where("event_id", "=", i.event_id).where("kind", "=", i.kind).where("channel", "=", "inbox")
      .orderBy(sql`person_id = ${ctx.actor.personId ?? "00000000-0000-0000-0000-000000000000"}`, "desc").limit(1).executeTakeFirst();
    if (!m) throw new KumiError("error.not_found", { thing: both("thing.alert") }, 404);
    if (await ctx.db.selectFrom("staff_alert").select("id").where("event_id", "=", i.event_id).where("kind", "=", i.kind).executeTakeFirst()) throw new KumiError("error.alert_handled");
    return { title: both("action.alert.handle"), summary: both("plan.alert.handle", { subject: m.subject }), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx, i) {
    try { await ctx.insert("staff_alert", { id: uuidv7(), event_id: i.event_id, kind: i.kind, handled_by: ctx.actor.personId, handled_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.alert_handled"); throw e; }
    return null;
  },
});
