// A player's own assistant (the MCP door) spends within the weekly cap they set for it: the oauth_grant's
// weekly_cap_cents, $0 until they choose more. What counts is money the person themselves is asked to pay
// (their court, their share, their place, their membership), by changes the assistant made this week, the
// club's week from Monday; whatever came back to the card from those changes comes off again. Staff work for
// the club (refunds, someone else's booking) isn't the person's own money, so it never counts.
import { sql } from "kysely";
import { money } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { atLocal, localParts } from "./clock.ts";

/** Actions whose plan's money is what the person themselves pays, when it's for them. */
const PAYS = new Set(["booking.request", "booking.request_courts", "booking.join", "booking.ask", "booking.take_place", "lesson.request",
  "enrolment.join", "enrolment.accept_offer", "membership.join", "membership.add_person"]);
/** Changes to a booking that can add to what its organiser owes. */
const ADDS = new Set(["booking.extend", "booking.move"]);

interface PlanMoney { moneyCents?: number; details?: unknown }

/** What this change asks the person to pay themselves, in cents (0 for anything else). */
export async function chargeOf(db: Db | Trx, name: string, input: any, plan: PlanMoney, personId: string): Promise<number> {
  if (PAYS.has(name)) {
    const payer = typeof input?.person_id === "string" ? input.person_id : personId;
    return payer === personId ? Math.max(0, plan.moneyCents ?? 0) : 0;
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

/** What an assistant has spent this week: its changes' charges, less refunds of the payments they made. */
export async function weekSpent(db: Db | Trx, grantId: string, now: Date, exceptRunId?: string): Promise<number> {
  const from = await weekStart(db, now);
  const grant = await db.selectFrom("oauth_grant").select("person_id").where("id", "=", grantId).executeTakeFirstOrThrow();
  const runs = await db.selectFrom("action_run").select(["id", "action", "input", "plan"]).where("oauth_grant_id", "=", grantId).where("status", "=", "applied")
    .where("applied_at", ">=", from).$if(Boolean(exceptRunId), (q) => q.where("id", "!=", exceptRunId!)).execute();
  let spent = 0;
  for (const r of runs) spent += await chargeOf(db, r.action, r.input, r.plan as PlanMoney, grant.person_id);
  if (!runs.length) return spent;
  const back = await db.selectFrom("refund").innerJoin("entity_change", (j) => j.on("entity_change.entity", "=", "payment").on("entity_change.op", "=", "insert")
    .on(sql<boolean>`entity_change.entity_id = refund.payment_id::text`))
    .select(sql<string>`coalesce(sum(refund.amount_cents), 0)`.as("c")).where("entity_change.action_run_id", "in", runs.map((r) => r.id))
    .where("refund.status", "in", ["pending", "sent"]).executeTakeFirstOrThrow();
  return Math.max(0, spent - Number(back.c));
}

/** Stops a change an assistant makes that would take it over its weekly cap. */
export async function checkAssistantSpend(db: Db | Trx, grantId: string, name: string, input: unknown, plan: PlanMoney, personId: string, now: Date, exceptRunId?: string): Promise<void> {
  const cents = await chargeOf(db, name, input, plan, personId);
  if (cents <= 0) return;
  const g = await db.selectFrom("oauth_grant").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id").innerJoin("person", "person.id", "oauth_grant.person_id")
    .select(["oauth_grant.weekly_cap_cents", "oauth_grant.revoked_at", "oauth_client.name", "person.locale"]).where("oauth_grant.id", "=", grantId).executeTakeFirstOrThrow();
  if (g.revoked_at) throw new KumiError("error.assistant_disconnected", {}, 403);
  const spent = await weekSpent(db, grantId, now, exceptRunId);
  if (spent + cents <= g.weekly_cap_cents) return;
  const usd = (c: number) => ({ en: money(c, "en"), es: money(c, "es") });
  throw new KumiError("error.assistant_over_cap", { client: g.name ?? "Your assistant", amount: usd(cents), cap: usd(g.weekly_cap_cents), left: usd(Math.max(0, g.weekly_cap_cents - spent)) }, 403);
}
