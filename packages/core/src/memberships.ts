// Memberships: the plans a club offers (by the month or the year) and who holds one. A plan can come with
// member prices on courts (price rules for that plan) and a longer booking window. The desk gives a
// membership (a comp, a founding member, one paid at the counter), with or without an end date. Members
// join in the app and pay by card; Kumi renews from that saved card each period, at the price they joined
// at, and cancelling stops renewal at the period's end. One membership at a time per person.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localDate, localParts, onDate } from "./clock.ts";
import { account, paymentProvider, post } from "./money.ts";

const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const LIVE = ["active", "past_due"] as const;

/** "$80.00 a month", in each language. */
export function planPrice(cents: number, period: "month" | "year"): Text {
  const f = (lang: Lang) => `${money(cents, lang)} ${lang === "es" ? (period === "month" ? "al mes" : "al año") : (period === "month" ? "a month" : "a year")}`;
  return { en: f("en"), es: f("es") };
}
/** A club date as people say it: "December 31, 2026", "31 de diciembre de 2026". */
export function dayText(date: string): Text {
  const f = (lang: Lang) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return { en: f("en"), es: f("es") };
}

/** The plan whose benefits a person has at `at`: an active membership that hasn't run out, or one whose
 *  renewal payment is late (it carries on while Kumi tries the card again). */
export async function memberPlan(db: Db | Trx, personId: string, at = new Date()) {
  return (await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.id as membership_id", "membership_plan.id as plan_id", "membership_plan.name", "membership_plan.days_ahead"])
    .where("membership.person_id", "=", personId)
    .where((eb) => eb.or([eb("membership.status", "=", "past_due"),
      eb.and([eb("membership.status", "=", "active"), eb.or([eb("membership.current_period_end", "is", null), eb("membership.current_period_end", ">", at)])])]))
    .executeTakeFirst()) ?? null;
}

/** After a failed renewal, try the card again this many days later; after the last, the membership ends. */
export const RETRY_AFTER_DAYS = [2, 3];

/** One period on from `from`, on the membership's own day of the month: joined on the 31st, it renews on
 *  28 February, then 31 March. The same clock time, in the club's time zone. */
export function addPeriod(from: Date, period: "month" | "year", tz: string, day: number): Date {
  const p = localParts(from, tz);
  const y = period === "year" || p.m === 12 ? p.y + 1 : p.y, m = period === "year" ? p.m : (p.m % 12) + 1;
  return atLocal(y, m, Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate()), p.h, tz, p.min);
}
/** The day a membership's time runs out, as a club date: an app membership's renewal day, or the last day of
 *  a desk membership given "until" a date. */
export function endDay(m: { current_period_end: Date; source: string }, tz: string): string {
  return localDate(new Date(m.current_period_end.getTime() - (m.source === "app" ? 0 : 1)), tz);
}
const clubTz = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;

// ---- Plans ----
const planInput = {
  name: z.string().check(z.minLength(1), z.maxLength(60)), description: z.optional(z.nullable(z.string().check(z.maxLength(300)))),
  price_cents: z.number().check(z.int(), z.minimum(0)), period: z.enum(["month", "year"]),
  days_ahead: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(365)))), join_in_app: z.optional(z.boolean()), sort: z.optional(z.number().check(z.int())),
};
export const planSet = defineAction({
  name: "membership.plan_set", version: 1,
  input: z.object({ plan_id: z.optional(z.uuid()), ...planInput }),
  async plan(ctx, i) {
    const reads = i.plan_id ? [(await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan")).read] : [];
    const window = i.days_ahead ? both("plan.membership.window", { count: i.days_ahead }) : { en: "", es: "" };
    return { title: both("action.membership.plan_set"), summary: both("plan.membership.plan_set", { name: i.name, price: planPrice(i.price_cents, i.period), window }),
      reads, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { plan_id, ...p } = i;
    const row = { ...p, description: p.description ?? null, days_ahead: p.days_ahead ?? null, join_in_app: p.join_in_app ?? true, sort: p.sort ?? 0 };
    if (plan_id) { await ctx.update("membership_plan", plan_id, row); return { plan_id }; }
    const id = uuidv7();
    await ctx.insert("membership_plan", { id, ...row });
    return { plan_id: id };
  },
});

export const planRemove = defineAction({
  name: "membership.plan_remove", version: 1,
  input: z.object({ plan_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    return { title: both("action.membership.plan_remove"), summary: both("plan.membership.plan_remove", { name: row.name }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("membership_plan", i.plan_id, { active: false }); return null; },
});

// ---- Memberships ----
export const membershipGrant = defineAction({
  name: "membership.grant", version: 1,
  input: z.object({ person_id: z.uuid(), plan_id: z.uuid(), until: z.optional(z.nullable(clubDate)), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: person } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const { row: plan, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    if (!plan.active) throw new KumiError("error.plan_not_offered", { name: plan.name });
    if (await memberPlan(ctx.db, i.person_id, ctx.now)) throw new KumiError("error.already_member", { name: person.display_name });
    const club = await ctx.db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
    if (i.until && i.until < localDate(ctx.now, club.time_zone)) throw new KumiError("error.in_the_past");
    return { title: both("action.membership.grant"), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" },
      summary: both(i.until ? "plan.membership.grant_until" : "plan.membership.grant", { person: person.display_name, name: plan.name, until: i.until ? dayText(i.until) : "" }) };
  },
  async apply(ctx, i) {
    const club = await ctx.trx.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
    const id = uuidv7();
    try {
      await ctx.insert("membership", { id, person_id: i.person_id, plan_id: i.plan_id, status: "active", source: "desk", started_at: ctx.now,
        current_period_end: i.until ? onDate(i.until, "24:00", club.time_zone) : null, note: i.note ?? null });
    } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    await ctx.emit("membership.started", { membership_id: id });
    return { membership_id: id };
  },
});

export const membershipEnd = defineAction({
  name: "membership.end", version: 1,
  input: z.object({ membership_id: z.uuid(), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: m, read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    if (m.status === "ended") throw new KumiError("error.membership_ended");
    const person = await ctx.db.selectFrom("person").select("display_name").where("id", "=", m.person_id).executeTakeFirstOrThrow();
    const plan = await ctx.db.selectFrom("membership_plan").select("name").where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    return { title: both("action.membership.end"), summary: both("plan.membership.end", { person: person.display_name, name: plan.name }),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("membership", i.membership_id, { status: "ended", ended_at: ctx.now, ...(i.note ? { note: i.note } : {}) });
    await ctx.emit("membership.ended", { membership_id: i.membership_id });
    return null;
  },
});

/** Kumi ends a membership whose time ran out (a desk membership's end date). */
export const membershipLapse = defineAction({
  name: "membership.lapse", version: 1, system: true, internal: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    return { title: both("action.membership.lapse"), summary: both("action.membership.lapse"), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["status", "source", "current_period_end"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.status === "ended" || m.source === "app" || !m.current_period_end || m.current_period_end > ctx.now) return null;
    await ctx.update("membership", i.membership_id, { status: "ended", ended_at: m.current_period_end });
    await ctx.emit("membership.ended", { membership_id: i.membership_id });
    return null;
  },
});

/** The job: end desk memberships whose end date has passed. (Ones joined in the app renew or end by renewMemberships.) */
export async function endLapsedMemberships(db: Db, now = new Date()): Promise<number> {
  const due = await db.selectFrom("membership").select("id").where("status", "in", LIVE).where("source", "!=", "app")
    .where("current_period_end", "is not", null).where("current_period_end", "<=", now).execute();
  for (const m of due) await runAsSystem(db, "membership.lapse", { membership_id: m.id }, "job", { now });
  return due.length;
}

/** How many people hold each plan now, for the staff pages. */
export async function planCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.selectFrom("membership").select(["plan_id", sql<string>`count(*)`.as("n")]).where("status", "in", LIVE).groupBy("plan_id").execute();
  return new Map(rows.map((r) => [r.plan_id, Number(r.n)]));
}

// ---- Joining in the app, and renewing ----
type PlanRow = { id: string; name: string; price_cents: number; period: "month" | "year" };

/** The membership starts now, for one period, renewing from the card it was paid with. */
async function startMembership(ctx: ApplyCtx, personId: string, plan: PlanRow, card: { customer: string | null; method: string | null; account: string | null }) {
  const tz = await clubTz(ctx.trx), id = uuidv7();
  try {
    await ctx.insert("membership", { id, person_id: personId, plan_id: plan.id, status: "active", source: "app", started_at: ctx.now,
      current_period_end: addPeriod(ctx.now, plan.period, tz, localParts(ctx.now, tz).d), price_cents: plan.price_cents, period: plan.period,
      saved_customer: card.customer, saved_method: card.method, provider_account: card.account });
  } catch (e: any) { if (e?.code === "23505") return null; throw e; }   // they became a member another way meanwhile
  await ctx.emit("membership.started", { membership_id: id });
  return id;
}

/** Paid for: one more period, on from the end of the last (a late payment keeps the days it was late). */
async function extend(ctx: ApplyCtx, membershipId: string, card?: { customer: string | null; method: string | null }) {
  const m = await ctx.trx.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.current_period_end", "membership.started_at", "membership.period", "membership_plan.period as plan_period"]).where("membership.id", "=", membershipId).executeTakeFirstOrThrow();
  const tz = await clubTz(ctx.trx), from = m.current_period_end ?? ctx.now;
  await ctx.update("membership", membershipId, { status: "active", failed_attempts: 0, next_attempt_at: null,
    current_period_end: addPeriod(from, m.period ?? m.plan_period, tz, localParts(m.started_at, tz).d), ...(card?.method ? { saved_customer: card.customer, saved_method: card.method } : {}) });
}

/** Give a membership payment back, all of it, to the card (the outbox sends it). */
async function refundCard(ctx: ApplyCtx, paymentId: string, cents: number) {
  const id = uuidv7();
  await ctx.insert("refund", { id, payment_id: paymentId, enrolment_id: null, amount_cents: cents, destination: "card", status: "pending" });
  await ctx.emit("refund.requested", { refund_id: id });
}

/** Payments asked of the member for a renewal that no card form has opened yet: not needed any more. */
async function dropPayNow(ctx: ApplyCtx, membershipId: string) {
  for (const p of await ctx.trx.selectFrom("payment").select("id").where("membership_id", "=", membershipId).where("status", "=", "pending").where("provider_ref", "is", null).execute())
    await ctx.update("payment", p.id, { status: "failed" });
}

/** After a membership payment succeeds (called by payment.settle): joining starts the membership; paying a
 *  late renewal by hand renews it. Paid for a membership that can't be had any more: all of it back. */
export async function afterMembershipPayment(ctx: ApplyCtx, pay: { id: string; person_id: string; amount_cents: number; membership_plan_id: string | null; membership_id: string | null;
  provider_account: string | null; save_card: boolean }, card: { customer: string | null; method: string | null }) {
  if (pay.membership_id) {
    const m = await ctx.trx.selectFrom("membership").select("status").where("id", "=", pay.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.status === "ended") { await refundCard(ctx, pay.id, pay.amount_cents); return; }
    await extend(ctx, pay.membership_id, pay.save_card ? card : undefined);
    await dropPayNow(ctx, pay.membership_id);
    await ctx.emit("membership.renewed", { membership_id: pay.membership_id, payment_id: pay.id });
    return;
  }
  const plan = await ctx.trx.selectFrom("membership_plan").select(["id", "name", "price_cents", "period"]).where("id", "=", pay.membership_plan_id!).executeTakeFirstOrThrow();
  // The price paid is the price it renews at.
  const id = await memberPlan(ctx.trx, pay.person_id, ctx.now) ? null
    : await startMembership(ctx, pay.person_id, { ...plan, price_cents: pay.amount_cents }, { customer: card.customer, method: card.method, account: pay.provider_account });
  if (!id) { await refundCard(ctx, pay.id, pay.amount_cents); return; }   // paid twice, or already a member
  await ctx.update("payment", pay.id, { membership_id: id });
}

export const membershipJoin = defineAction({
  name: "membership.join", version: 1,
  input: z.object({ plan_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: plan, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    if (!plan.active || !plan.join_in_app) throw new KumiError("error.plan_not_in_app", { name: plan.name });
    if (await memberPlan(ctx.db, i.person_id, ctx.now)) throw new KumiError("error.already_a_member");
    const p = { name: plan.name, price: planPrice(plan.price_cents, plan.period), period: both(plan.period === "year" ? "plan.membership.every_year" : "plan.membership.every_month") };
    return { title: both("action.membership.join"), summary: both(plan.price_cents ? "plan.membership.join" : "plan.membership.join_free", p), reads: [read], ownerIds: [i.person_id],
      moneyCents: plan.price_cents, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const plan = await ctx.trx.selectFrom("membership_plan").select(["id", "name", "price_cents", "period"]).where("id", "=", i.plan_id).executeTakeFirstOrThrow();
    if (!plan.price_cents) {
      const id = await startMembership(ctx, i.person_id, plan, { customer: null, method: null, account: null });
      if (!id) throw new KumiError("error.changed");
      return { membership_id: id };
    }
    // Already asked to pay for it (a second tap, or back after closing the card form): the same payment.
    const open = await ctx.trx.selectFrom("payment").select("id").where("person_id", "=", i.person_id).where("membership_plan_id", "=", plan.id).where("membership_id", "is", null)
      .where("status", "=", "pending").where("amount_cents", "=", plan.price_cents).executeTakeFirst();
    if (open) return { payment_id: open.id };
    const id = uuidv7();
    await ctx.insert("payment", { id, person_id: i.person_id, amount_cents: plan.price_cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending",
      membership_plan_id: plan.id, save_card: true });
    return { payment_id: id };
  },
});

async function membershipRow(db: Db | Trx, id: string) {
  const { row, read } = await readRow(db, "membership", id, "thing.membership");
  const plan = await db.selectFrom("membership_plan").select(["name", "price_cents", "period"]).where("id", "=", row.plan_id).executeTakeFirstOrThrow();
  const person = await db.selectFrom("person").select("display_name").where("id", "=", row.person_id).executeTakeFirstOrThrow();
  return { m: row as Record<string, any> & { current_period_end: Date; source: string }, read, plan, person: person.display_name as string };
}

export const membershipCancel = defineAction({
  name: "membership.cancel", version: 1,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (m.status === "ended") throw new KumiError("error.membership_ended");
    if (m.source !== "app") throw new KumiError("error.membership_not_renewing");
    if (m.cancel_at_period_end) throw new KumiError("error.membership_already_cancelled");
    const p = { name: plan.name, person, until: dayText(endDay(m, await clubTz(ctx.db))) };
    return { title: both("action.membership.cancel"), summary: both(ctx.actor.personId === m.person_id ? "plan.membership.cancel_own" : "plan.membership.cancel", p),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("membership", i.membership_id, { cancel_at_period_end: true });
    await ctx.emit("membership.cancelled", { membership_id: i.membership_id });
    return null;
  },
});

export const membershipResume = defineAction({
  name: "membership.resume", version: 1,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (m.status === "ended" || !m.cancel_at_period_end) throw new KumiError("error.membership_not_cancelled");
    const p = { name: plan.name, person, date: dayText(endDay(m, await clubTz(ctx.db))), price: { en: money(m.price_cents ?? plan.price_cents, "en"), es: money(m.price_cents ?? plan.price_cents, "es") } };
    return { title: both("action.membership.resume"), summary: both(ctx.actor.personId === m.person_id ? "plan.membership.resume_own" : "plan.membership.resume", p),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("membership", i.membership_id, { cancel_at_period_end: false });
    await ctx.emit("membership.resumed", { membership_id: i.membership_id });
    return null;
  },
});

/** The job: memberships joined in the app whose period is up. Each is renewed from its saved card, tried again
 *  later if that fails, or ended (cancelled, or its tries ran out). */
export async function renewMemberships(db: Db, now = new Date()) {
  const due = await db.selectFrom("membership").select("id").where("source", "=", "app").where("status", "in", LIVE).where("current_period_end", "<=", now)
    .where((eb) => eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", now)])).execute();
  const n = { renewed: 0, failed: 0, ended: 0 };
  for (const m of due) {
    const r = await runAsSystem(db, "membership.renew", { membership_id: m.id }, "jobs", { now });
    const outcome = (r.result as { outcome: string }).outcome;
    if (outcome === "renewed" || outcome === "failed" || outcome === "ended") n[outcome]++;
  }
  return n;
}

export const membershipRenew = defineAction({
  name: "membership.renew", version: 1, system: true, internal: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    return { title: both("action.membership.renew"), summary: both("action.membership.renew"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").selectAll().where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.status === "ended" || m.source !== "app" || !m.current_period_end || m.current_period_end > ctx.now || (m.next_attempt_at && m.next_attempt_at > ctx.now)) return { outcome: "not_due" };
    if (m.cancel_at_period_end) {
      await ctx.update("membership", m.id, { status: "ended", ended_at: m.current_period_end, next_attempt_at: null });
      await dropPayNow(ctx, m.id);
      await ctx.emit("membership.ended", { membership_id: m.id });
      return { outcome: "ended" };
    }
    const plan = await ctx.trx.selectFrom("membership_plan").select(["name", "price_cents"]).where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    const cents = m.price_cents ?? plan.price_cents, club = await ctx.trx.selectFrom("club").select("currency").executeTakeFirstOrThrow();
    if (cents === 0) { await extend(ctx, m.id); return { outcome: "renewed" }; }
    // One try per period and attempt: a retry of this same change (a crash, a timeout) can't charge twice.
    const charge = m.saved_customer && m.saved_method
      ? await paymentProvider().chargeSaved({ customer: m.saved_customer, paymentMethod: m.saved_method, amountCents: cents, currency: club.currency, description: `${plan.name} membership`,
          idempotencyKey: `renew:${m.id}:${m.current_period_end.toISOString()}:${m.failed_attempts}`, account: m.provider_account })
      : { ref: "", status: "failed" as const, failure: "no saved card" };
    if (charge.status === "succeeded") {
      const id = uuidv7();
      await ctx.insert("payment", { id, person_id: m.person_id, amount_cents: cents, method: "card", provider: paymentProvider().name, provider_ref: charge.ref,
        provider_account: m.provider_account, status: "succeeded", membership_id: m.id });
      await post(ctx.trx, ctx.runId, "payment", "membership renewal", [
        { account: await account(ctx.trx, "provider_clearing"), cents }, { account: await account(ctx.trx, "revenue", { revenueType: "memberships" }), cents: -cents }]);
      await extend(ctx, m.id);
      await dropPayNow(ctx, m.id);
      await ctx.emit("membership.renewed", { membership_id: m.id, payment_id: id });
      return { outcome: "renewed" };
    }
    const tries = m.failed_attempts + 1;
    if (tries > RETRY_AFTER_DAYS.length) {
      await ctx.update("membership", m.id, { status: "ended", ended_at: ctx.now, end_reason: "not_paid", failed_attempts: tries, next_attempt_at: null });
      await dropPayNow(ctx, m.id);
      await ctx.emit("membership.ended", { membership_id: m.id });
      return { outcome: "ended", failure: charge.failure };
    }
    const next = new Date(ctx.now.getTime() + RETRY_AFTER_DAYS[tries - 1]! * 86400_000);
    await ctx.update("membership", m.id, { status: "past_due", failed_attempts: tries, next_attempt_at: next });
    // Meanwhile the member can pay it with another card in the app, which then becomes the one it renews on.
    const open = await ctx.trx.selectFrom("payment").select("id").where("membership_id", "=", m.id).where("status", "=", "pending").executeTakeFirst();
    if (!open) await ctx.insert("payment", { id: uuidv7(), person_id: m.person_id, amount_cents: cents, method: "card", provider: paymentProvider().name, provider_ref: null,
      status: "pending", membership_id: m.id, save_card: true });
    await ctx.emit("membership.payment_failed", { membership_id: m.id, cents, next_attempt_at: next.toISOString() });
    return { outcome: "failed", failure: charge.failure };
  },
});
