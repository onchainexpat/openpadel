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

/** Actions whose plan's money is what the person themselves pays, when it's for them. */
const PAYS = new Set(["booking.request", "booking.request_courts", "booking.join", "booking.ask", "booking.take_place", "lesson.request",
  "enrolment.join", "enrolment.join_dates", "enrolment.accept_offer", "membership.join", "membership.add_person"]);
/** Changes to a booking that can add to what its organiser owes. */
const ADDS = new Set(["booking.extend", "booking.move"]);

interface PlanMoney { moneyCents?: number; details?: unknown }

/** A court shared "pay my part" that isn't an open match: the organiser's card covers what the others don't pay. */
export const sharedCourt = (name: string, input: any): boolean => name === "booking.request" && input?.pay === "split" && !input?.open;

/** What this change asks the person to pay themselves, in cents (0 for anything else). For a shared court,
 *  the whole court: their share now, and the others' if they don't pay. */
export async function chargeOf(db: Db | Trx, name: string, input: any, plan: PlanMoney, personId: string): Promise<number> {
  if (PAYS.has(name)) {
    const payer = typeof input?.person_id === "string" ? input.person_id : personId;
    if (payer !== personId) return 0;
    const whole = sharedCourt(name, input) ? (plan.details as { quote?: { total_cents?: number } } | undefined)?.quote?.total_cents : undefined;
    return Math.max(0, whole ?? plan.moneyCents ?? 0);
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

/** What one change the assistant made still costs the person now. */
async function stillCosts(db: Db | Trx, run: { id: string; action: string; input: unknown; plan: unknown }, personId: string): Promise<number> {
  const asked = await chargeOf(db, run.action, run.input, run.plan as PlanMoney, personId);
  if (asked <= 0) return 0;
  const made = await db.selectFrom("entity_change").select(["entity", "entity_id"]).where("action_run_id", "=", run.id).where("op", "=", "insert")
    .where("entity", "in", ["payment", "booking"]).execute();
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
