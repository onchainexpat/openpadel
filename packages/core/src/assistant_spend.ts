// A player's own assistant (the MCP door) spends within the weekly cap they set for it: the oauth_grant's
// weekly_cap_cents, $0 until they choose more. What counts is money the person themselves is asked to pay
// (their court, their share, their place, their membership), by changes the assistant made this week, the
// club's week from Monday. Only what's charged or still waiting to be paid counts: a hold that lapsed or a
// payment called off counts nothing, and whatever came back to the card comes off again. A court shared "pay
// my part" counts in full until the others pay, since what they don't pay goes on the organiser's card at the
// deadline. Staff work for the club (refunds, someone else's booking) isn't the person's own money, so it
// never counts.
import { sql } from "kysely";
import { money } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { atLocal, localParts } from "./clock.ts";

/** Actions whose plan's money is what the person themselves pays, when it's for them or a junior they manage. */
const PAYS = new Set(["booking.request", "booking.request_courts", "booking.repeat_request", "booking.join", "booking.ask", "booking.take_place", "lesson.request",
  "enrolment.join", "enrolment.join_dates", "enrolment.accept_offer", "membership.join"]);
/** Membership changes the membership's payer pays for: one more person now, or the next period once resumed. */
const MEMBERSHIP = new Set(["membership.add_person", "membership.resume"]);
/** Changes to a booking that can add to what its organiser owes. */
const ADDS = new Set(["booking.extend", "booking.move"]);

interface PlanMoney { moneyCents?: number; details?: unknown }

/** A court or lesson shared "pay my part" that isn't an open match: the organiser's card covers what the
 *  others don't pay. */
export const sharedCourt = (name: string, input: any): boolean =>
  (name === "booking.request" && input?.pay === "split" && !input?.open) || (name === "lesson.request" && input?.pay === "split");

/** What a change can cost whoever pays for it: for a shared court or lesson the whole price (their share now,
 *  the others' at the deadline if they don't pay), otherwise what the plan asks. */
export function fullCost(name: string, input: any, plan: PlanMoney): number {
  const d = plan.details as { quote?: { total_cents?: number }; total?: number; weeks?: { price_cents: number; clash: string | null }[] } | undefined;
  // A weekly court counts in full: every week goes on the card saved with the first (booking_series.ts).
  if (name === "booking.repeat_request" && d?.weeks) return d.weeks.filter((w) => !w.clash).reduce((n, w) => n + w.price_cents, 0);
  const whole = sharedCourt(name, input) ? d?.quote?.total_cents ?? d?.total : undefined;
  return Math.max(0, whole ?? plan.moneyCents ?? 0);
}

/** Whether money asked of `payer` is the person's own: theirs, or a junior's they manage (the same household,
 *  as households.ts's managersOf; not imported, since actions.ts loads this file first). */
async function ownMoney(db: Db | Trx, payer: string, personId: string): Promise<boolean> {
  if (payer === personId) return true;
  return Boolean(await db.selectFrom("household_member as j").innerJoin("household_member as a", "a.household_id", "j.household_id").select("a.person_id")
    .where("j.person_id", "=", payer).where("j.role", "=", "junior").where("j.removed_at", "is", null)
    .where("a.person_id", "=", personId).where("a.role", "=", "adult").where("a.removed_at", "is", null).executeTakeFirst());
}

/** What this change asks the person to pay themselves, in cents (0 for anything else). For a shared court,
 *  the whole court: their share now, and the others' if they don't pay. */
export async function chargeOf(db: Db | Trx, name: string, input: any, plan: PlanMoney, personId: string): Promise<number> {
  if (PAYS.has(name)) {
    const payer = typeof input?.person_id === "string" ? input.person_id : personId;
    return await ownMoney(db, payer, personId) ? fullCost(name, input, plan) : 0;
  }
  if (MEMBERSHIP.has(name) && typeof input?.membership_id === "string") {
    const m = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
      .select(["membership.person_id", "membership.price_cents", "membership_plan.price_cents as plan_price"]).where("membership.id", "=", input.membership_id).executeTakeFirst();
    if (!m || !(await ownMoney(db, m.person_id, personId))) return 0;
    return name === "membership.add_person" ? Math.max(0, Number((plan.details as { charge?: number } | undefined)?.charge ?? 0)) : Math.max(0, m.price_cents ?? m.plan_price);
  }
  if (ADDS.has(name) && typeof input?.booking_id === "string") {
    const b = await db.selectFrom("booking").select("organiser_id").where("id", "=", input.booking_id).executeTakeFirst();
    return b?.organiser_id === personId ? Math.max(0, Number((plan.details as { owed?: number } | undefined)?.owed ?? 0)) : 0;
  }
  return 0;
}

/** Monday 00:00 of this week, on the club's clock. */
export async function weekStart(db: Db | Trx, now: Date): Promise<Date> {
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  const p = localParts(now, tz);
  return atLocal(p.y, p.m, p.d - ((p.weekday + 6) % 7), 0, tz);
}

const refunded = sql<string>`(select coalesce(sum(r.amount_cents), 0) from refund r where r.payment_id = payment.id and r.status in ('pending', 'sent'))`;

/** What these payments cost: charged ones less what came back, waiting ones while what they pay for is still
 *  there (a booking not cancelled, a place not left, a membership not ended), failed or called off ones nothing. */
async function paymentsCost(db: Db | Trx, ids: string[]): Promise<number> {
  const rows = await db.selectFrom("payment").leftJoin("booking_player", "booking_player.id", "payment.booking_player_id").leftJoin("booking", "booking.id", "booking_player.booking_id")
    .leftJoin("enrolment", "enrolment.id", "payment.enrolment_id").leftJoin("membership", "membership.id", "payment.membership_id")
    .select(["payment.amount_cents", "payment.status", "booking.status as booking_status", "booking_player.removed_at", "enrolment.status as enrolment_status", "membership.status as membership_status", refunded.as("back")])
    .where("payment.id", "in", ids).execute();
  let cost = 0;
  for (const r of rows) {
    if (r.status === "succeeded") cost += Math.max(0, r.amount_cents - Number(r.back));
    else if (r.status === "pending" && r.booking_status !== "cancelled" && !r.removed_at && r.enrolment_status !== "cancelled" && r.membership_status !== "ended") cost += r.amount_cents;
  }
  return cost;
}

/** A shared court the assistant booked: the whole court less what the others paid, while it's on; once it's
 *  cancelled, what the organiser was charged and kept. */
async function sharedCourtCost(db: Db | Trx, bookingId: string, personId: string): Promise<number> {
  const b = await db.selectFrom("booking").select(["status", "price_cents"]).where("id", "=", bookingId).executeTakeFirst();
  if (!b) return 0;
  const rows = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select(["payment.person_id", "payment.amount_cents", refunded.as("back")]).where("booking_player.booking_id", "=", bookingId).where("payment.status", "=", "succeeded").execute();
  let mine = 0, others = 0;
  for (const r of rows) { const kept = r.amount_cents - Number(r.back); if (r.person_id === personId) mine += kept; else others += kept; }
  return Math.max(0, b.status === "cancelled" ? mine : b.price_cents - others);
}

/** A weekly court the assistant made: each week booked or still to be booked counts its price until it's charged;
 *  once charged, what was kept; a week left out, cancelled before it was charged, or never booked (the series
 *  ended) counts nothing. */
async function seriesCost(db: Db | Trx, seriesId: string): Promise<number> {
  const s = await db.selectFrom("booking_series").select(["ended_at", "last_date"]).where("id", "=", seriesId).executeTakeFirstOrThrow();
  const weeks = await db.selectFrom("booking_series_week").leftJoin("booking", "booking.id", "booking_series_week.booking_id")
    .select(["booking_series_week.on_date", "booking_series_week.price_cents", "booking_series_week.missed", "booking.id as booking_id", "booking.status"]).where("booking_series_week.series_id", "=", seriesId).execute();
  let cost = 0;
  for (const w of weeks) {
    // Not booked and never will be: the series ended, or ends before this week (ended from an earlier week).
    if (w.missed || (!w.booking_id && (s.ended_at || w.on_date > s.last_date))) continue;
    const kept = w.booking_id ? await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .select(sql<string>`coalesce(sum(payment.amount_cents - (select coalesce(sum(r.amount_cents), 0) from refund r where r.payment_id = payment.id and r.status in ('pending', 'sent'))), 0)`.as("c"))
      .where("booking_player.booking_id", "=", w.booking_id).where("payment.status", "=", "succeeded").executeTakeFirstOrThrow() : null;
    const paid = Number(kept?.c ?? 0);
    cost += w.status === "cancelled" ? Math.max(0, paid) : Math.max(paid, w.price_cents);
  }
  return cost;
}

/** What one change the assistant made still costs the person now. */
async function stillCosts(db: Db | Trx, run: { id: string; action: string; input: unknown; plan: unknown }, personId: string): Promise<number> {
  const asked = await chargeOf(db, run.action, run.input, run.plan as PlanMoney, personId);
  if (asked <= 0) return 0;
  const made = await db.selectFrom("entity_change").select(["entity", "entity_id"]).where("action_run_id", "=", run.id).where("op", "=", "insert")
    .where("entity", "in", ["payment", "booking"]).execute();
  // A weekly court: every week still to be charged, and what was charged and kept, while it runs.
  if (run.action === "booking.repeat_request") {
    const series = (await db.selectFrom("entity_change").select("entity_id").where("action_run_id", "=", run.id).where("op", "=", "insert").where("entity", "=", "booking_series").executeTakeFirst())?.entity_id;
    if (series) return seriesCost(db, series);
  }
  const booking = sharedCourt(run.action, run.input) ? made.find((m) => m.entity === "booking")?.entity_id : undefined;
  if (booking) return sharedCourtCost(db, booking, personId);
  const payments = made.filter((m) => m.entity === "payment").map((m) => m.entity_id);
  // Nothing to pay yet (an extension owed at the desk, a membership that starts later): what it asked for.
  return payments.length ? paymentsCost(db, payments) : asked;
}

/** What an assistant has spent this week: what its changes still cost the person. */
export async function weekSpent(db: Db | Trx, grantId: string, now: Date, exceptRunId?: string): Promise<number> {
  const from = await weekStart(db, now);
  const grant = await db.selectFrom("oauth_grant").select("person_id").where("id", "=", grantId).executeTakeFirstOrThrow();
  const runs = await db.selectFrom("action_run").select(["id", "action", "input", "plan"]).where("oauth_grant_id", "=", grantId).where("status", "=", "applied")
    .where("applied_at", ">=", from).$if(Boolean(exceptRunId), (q) => q.where("id", "!=", exceptRunId!)).execute();
  let spent = 0;
  for (const r of runs) spent += await stillCosts(db, r, grant.person_id);
  return spent;
}

/** Stops a change an assistant makes that would take it over its weekly cap. Gives back what it counts. */
export async function checkAssistantSpend(db: Db | Trx, grantId: string, name: string, input: unknown, plan: PlanMoney, personId: string, now: Date, exceptRunId?: string): Promise<number> {
  const cents = await chargeOf(db, name, input, plan, personId);
  if (cents <= 0) return 0;
  const g = await db.selectFrom("oauth_grant").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id").innerJoin("person", "person.id", "oauth_grant.person_id")
    .select(["oauth_grant.weekly_cap_cents", "oauth_grant.revoked_at", "oauth_client.name", "person.locale"]).where("oauth_grant.id", "=", grantId).executeTakeFirstOrThrow();
  if (g.revoked_at) throw new KumiError("error.assistant_disconnected", {}, 403);
  const spent = await weekSpent(db, grantId, now, exceptRunId);
  if (spent + cents <= g.weekly_cap_cents) return cents;
  const usd = (c: number) => ({ en: money(c, "en"), es: money(c, "es") });
  throw new KumiError(sharedCourt(name, input) ? "error.assistant_over_cap_shared" : "error.assistant_over_cap",
    { client: g.name ?? "Your assistant", amount: usd(cents), cap: usd(g.weekly_cap_cents), left: usd(Math.max(0, g.weekly_cap_cents - spent)) }, 403);
}
