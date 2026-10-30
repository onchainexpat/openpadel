// Memberships: the plans a club offers (by the month or the year) and who holds one. A plan can come with
// member prices on courts (price rules for that plan) and a longer booking window. The desk gives a
// membership (a comp, a founding member, one paid at the counter), with or without an end date. Members
// join in the app and pay by card; Kumi renews from that saved card each period, at the price they joined
// at, and cancelling stops renewal at the period's end. One membership at a time per person. A family plan
// covers others from the payer's household too (see memberships covered below).
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localDate, localParts, onDate } from "./clock.ts";
import { account, paymentProvider, post } from "./money.ts";
import { householdOf } from "./households.ts";

const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const LIVE = ["active", "past_due"] as const;
/** Held: live, or joined for a plan that hasn't started yet. One at a time per person. */
const HELD = ["upcoming", "active", "past_due"] as const;
/** A presale place with no card saved is let go after this long, so an abandoned card form doesn't keep it. */
export const CARD_HOURS = 2;

/** Whoever already holds a membership, of any kind (given, paid, or waiting for its plan to start), or is
 *  covered by someone's family plan. */
async function holds(db: Db | Trx, personId: string) {
  return (await db.selectFrom("membership").select("id").where("person_id", "=", personId).where("status", "in", HELD).executeTakeFirst())
    ?? (await db.selectFrom("membership_member").innerJoin("membership", "membership.id", "membership_member.membership_id").select("membership.id")
      .where("membership_member.person_id", "=", personId).where("membership_member.ends_at", "is", null).where("membership.status", "in", HELD).executeTakeFirst()) ?? null;
}
/** Whether a plan has room for one more (its limit counts every membership held on it). */
async function hasRoom(db: Db | Trx, plan: { id: string; max_members: number | null }) {
  if (!plan.max_members) return true;
  const n = await db.selectFrom("membership").select(sql<string>`count(*)`.as("n")).where("plan_id", "=", plan.id).where("status", "in", HELD).executeTakeFirstOrThrow();
  return Number(n.n) < plan.max_members;
}

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
    // Theirs, or a family plan that covers them (until they're taken off it).
    .where((eb) => eb.or([eb("membership.person_id", "=", personId), eb.exists(eb.selectFrom("membership_member").select("membership_member.id")
      .whereRef("membership_member.membership_id", "=", "membership.id").where("membership_member.person_id", "=", personId)
      .where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", at)])))]))
    // Paused: no benefits until it's over.
    .where((eb) => eb.or([eb("membership.paused_until", "is", null), eb("membership.paused_until", "<=", at), eb("membership.paused_from", ">", at)]))
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
/** "clinic, social", in each language. */
export function kindList(kinds: string[]): Text {
  const f = (lang: Lang) => kinds.map((k) => both(`kind.${k}` as Key)[lang]).join(", ");
  return { en: f("en"), es: f("es") };
}
const clubTz = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;

// ---- Plans ----
const planInput = {
  name: z.string().check(z.minLength(1), z.maxLength(60)), description: z.optional(z.nullable(z.string().check(z.maxLength(300)))),
  price_cents: z.number().check(z.int(), z.minimum(0)), period: z.enum(["month", "year"]),
  days_ahead: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(365)))), join_in_app: z.optional(z.boolean()), sort: z.optional(z.number().check(z.int())),
  max_members: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1)))),   // a founding offer: the first so many
  starts_on: z.optional(z.nullable(clubDate)),                                      // joining before: card saved, first charge then
  // On programs (clinics, socials): a discount, a percent or an amount; and single sessions included each period.
  program_percent_off: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(100)))),
  program_cents_off: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1)))),
  included_sessions: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(100), z.describe("Single sessions included each membership period, free")))),
  included_kinds: z.optional(z.array(z.enum(["clinic", "social", "tournament"])).check(z.minLength(1))),
  // A family plan: how many people from one household it covers (the payer included), and the price of each one more.
  family_size: z.optional(z.nullable(z.number().check(z.int(), z.minimum(2), z.maximum(12), z.describe("People covered, the payer included: a family plan")))),
  extra_person_cents: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.describe("Each person beyond family_size, each period; none: no more than family_size")))),
};
export const planSet = defineAction({
  name: "membership.plan_set", version: 1,
  input: z.object({ plan_id: z.optional(z.uuid()), ...planInput }),
  async plan(ctx, i) {
    const reads = i.plan_id ? [(await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan")).read] : [];
    if (i.program_percent_off && i.program_cents_off) throw new KumiError("error.one_program_discount");
    if (i.extra_person_cents != null && !i.family_size) throw new KumiError("error.extra_needs_family");
    const kinds = i.included_kinds ?? ["clinic", "social"];
    const extra = [i.days_ahead ? both("plan.membership.window", { count: i.days_ahead }) : null,
      i.program_percent_off ? both("plan.membership.program_percent", { percent: i.program_percent_off }) : null,
      i.program_cents_off ? both("plan.membership.program_cents", { amount: { en: money(i.program_cents_off, "en"), es: money(i.program_cents_off, "es") } }) : null,
      i.included_sessions ? both("plan.membership.included", { count: i.included_sessions, period: both(`ui.period_${i.period}`), kinds: kindList(kinds) }) : null,
      i.family_size ? both("plan.membership.family", { count: i.family_size }) : null,
      i.family_size && i.extra_person_cents != null ? both("plan.membership.family_extra", { amount: { en: money(i.extra_person_cents, "en"), es: money(i.extra_person_cents, "es") } }) : null,
      i.max_members ? both("plan.membership.limit", { count: i.max_members }) : null,
      i.starts_on ? both("plan.membership.starts", { date: dayText(i.starts_on) }) : null].filter((x): x is Text => Boolean(x));
    const window = { en: extra.map((x) => x.en).join(""), es: extra.map((x) => x.es).join("") };
    return { title: both("action.membership.plan_set"), summary: both("plan.membership.plan_set", { name: i.name, price: planPrice(i.price_cents, i.period), window }),
      reads, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { plan_id, ...p } = i;
    const row = { ...p, description: p.description ?? null, days_ahead: p.days_ahead ?? null, join_in_app: p.join_in_app ?? true, sort: p.sort ?? 0,
      max_members: p.max_members ?? null, starts_on: p.starts_on ?? null, program_percent_off: p.program_percent_off ?? null, program_cents_off: p.program_cents_off ?? null,
      included_sessions: p.included_sessions ?? null, included_kinds: p.included_kinds ?? ["clinic", "social"],
      family_size: p.family_size ?? null, extra_person_cents: p.family_size ? p.extra_person_cents ?? null : null };
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
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_member", { name: person.display_name });
    const club = await ctx.db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
    if (i.until && i.until < localDate(ctx.now, club.time_zone)) throw new KumiError("error.in_the_past");
    return { title: both("action.membership.grant"), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" },
      summary: both(i.until ? "plan.membership.grant_until" : "plan.membership.grant", { person: person.display_name, name: plan.name, until: i.until ? dayText(i.until) : "" }) };
  },
  async apply(ctx, i) {
    const club = await ctx.trx.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
    const id = uuidv7();
    try {
      const plan = await ctx.trx.selectFrom("membership_plan").select(["family_size", "extra_person_cents"]).where("id", "=", i.plan_id).executeTakeFirstOrThrow();
      await ctx.insert("membership", { id, person_id: i.person_id, plan_id: i.plan_id, status: "active", source: "desk", started_at: ctx.now,
        current_period_end: i.until ? onDate(i.until, "24:00", club.time_zone) : null, note: i.note ?? null, family_size: plan.family_size, extra_person_cents: plan.extra_person_cents });
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
  const rows = await db.selectFrom("membership").select(["plan_id", sql<string>`count(*)`.as("n")]).where("status", "in", HELD).groupBy("plan_id").execute();
  return new Map(rows.map((r) => [r.plan_id, Number(r.n)]));
}

// ---- Joining in the app, and renewing ----
type PlanRow = { id: string; name: string; price_cents: number; period: "month" | "year"; family_size: number | null; extra_person_cents: number | null };

/** The membership starts now, for one period, renewing from the card it was paid with. */
async function startMembership(ctx: ApplyCtx, personId: string, plan: PlanRow, card: { customer: string | null; method: string | null; account: string | null }) {
  const tz = await clubTz(ctx.trx), id = uuidv7();
  try {
    await ctx.insert("membership", { id, person_id: personId, plan_id: plan.id, status: "active", source: "app", started_at: ctx.now,
      current_period_end: addPeriod(ctx.now, plan.period, tz, localParts(ctx.now, tz).d), price_cents: plan.price_cents, period: plan.period,
      family_size: plan.family_size, extra_person_cents: plan.extra_person_cents, saved_customer: card.customer, saved_method: card.method, provider_account: card.account });
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
  const plan = await ctx.trx.selectFrom("membership_plan").select(["id", "name", "price_cents", "period", "max_members", "family_size", "extra_person_cents"]).where("id", "=", pay.membership_plan_id!).forUpdate().executeTakeFirstOrThrow();
  // The price paid is the price it renews at. Paid for the last place someone else took meanwhile: back.
  const id = await holds(ctx.trx, pay.person_id) || !await hasRoom(ctx.trx, plan) ? null
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
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_a_member");
    if (!await hasRoom(ctx.db, plan as { id: string; max_members: number | null })) throw new KumiError("error.plan_full", { name: plan.name });
    const tz = await clubTz(ctx.db), presale = Boolean(plan.starts_on && plan.starts_on > localDate(ctx.now, tz));
    const p = { name: plan.name, price: planPrice(plan.price_cents, plan.period), period: both(plan.period === "year" ? "plan.membership.every_year" : "plan.membership.every_month"),
      date: plan.starts_on ? dayText(plan.starts_on) : "" };
    const base = both(!plan.price_cents ? "plan.membership.join_free" : presale ? "plan.membership.join_presale" : "plan.membership.join", p);
    // A family plan: whom else it can cover, added afterwards from the Membership page.
    const fam = plan.family_size ? both(plan.extra_person_cents != null ? "plan.membership.join_family_extra" : "plan.membership.join_family",
      { count: plan.family_size - 1, amount: { en: money(plan.extra_person_cents ?? 0, "en"), es: money(plan.extra_person_cents ?? 0, "es") }, period: both(`ui.period_${plan.period}` as Key) }) : null;
    return { title: both("action.membership.join"), summary: fam ? { en: `${base.en} ${fam.en}`, es: `${base.es} ${fam.es}` } : base,
      reads: [read], ownerIds: [i.person_id], moneyCents: presale ? 0 : plan.price_cents, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const plan = await ctx.trx.selectFrom("membership_plan").select(["id", "name", "price_cents", "period", "max_members", "starts_on", "family_size", "extra_person_cents"]).where("id", "=", i.plan_id).forUpdate().executeTakeFirstOrThrow();
    const tz = await clubTz(ctx.trx);
    if (plan.starts_on && plan.starts_on > localDate(ctx.now, tz)) {
      // Before the plan starts: a place now, the card saved next (the members' app opens the form), the
      // first charge on the start date. One place at a time, so the limit holds when many join at once.
      if (!await hasRoom(ctx.trx, plan)) throw new KumiError("error.plan_full", { name: plan.name });
      const id = uuidv7(), start = onDate(plan.starts_on, "00:00", tz);
      try {
        await ctx.insert("membership", { id, person_id: i.person_id, plan_id: plan.id, status: "upcoming", source: "app", started_at: start, current_period_end: start,
          price_cents: plan.price_cents, period: plan.period, family_size: plan.family_size, extra_person_cents: plan.extra_person_cents, created_at: ctx.now });
      } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.already_a_member"); throw e; }
      return { membership_id: id, save_card: plan.price_cents > 0 };
    }
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
    const own = ctx.actor.personId === m.person_id;
    // Before its plan starts, nothing has been charged: the place is given up at once.
    if (m.status === "upcoming") return { title: both("action.membership.cancel"), summary: both(own ? "plan.membership.release_own" : "plan.membership.release", { name: plan.name, person }),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
    const p = { name: plan.name, person, until: dayText(endDay(m, await clubTz(ctx.db))) };
    return { title: both("action.membership.cancel"), summary: both(own ? "plan.membership.cancel_own" : "plan.membership.cancel", p),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select("status").where("id", "=", i.membership_id).executeTakeFirstOrThrow();
    if (m.status === "upcoming") {
      await ctx.update("membership", i.membership_id, { status: "ended", ended_at: ctx.now, end_reason: "gave_up_place" });
      await ctx.emit("membership.released", { membership_id: i.membership_id });
      return null;
    }
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
  const due = await db.selectFrom("membership").select("id").where("source", "=", "app").where("status", "in", HELD).where("current_period_end", "<=", now)
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
    const cents = await periodCents(ctx.trx, m, plan.price_cents, ctx.now), club = await ctx.trx.selectFrom("club").select("currency").executeTakeFirstOrThrow();
    if (cents === 0) {
      await extend(ctx, m.id);
      if (m.status === "upcoming") await ctx.emit("membership.started", { membership_id: m.id });
      return { outcome: "renewed" };
    }
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
      // The first charge of a membership joined before its plan started is its start.
      await ctx.emit(m.status === "upcoming" ? "membership.started" : "membership.renewed", { membership_id: m.id, payment_id: id });
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

// ---- Presales: saving the card of a member who joined before the plan starts ----
/** The card form for an upcoming membership's card: a setup at the provider, opened once and reused. */
export async function openCardSetup(db: Db, membershipId: string, personId: string): Promise<{ clientSecret: string; provider: "test" | "stripe"; account: string | null }> {
  const m = await db.selectFrom("membership").selectAll().where("id", "=", membershipId).executeTakeFirst();
  if (!m || m.person_id !== personId) throw new KumiError("error.not_found", { thing: both("thing.membership") }, 404);
  if (m.status !== "upcoming" || m.saved_method) throw new KumiError("error.not_pending", {}, 409);
  const pv = paymentProvider();
  if (m.provider_ref) return { clientSecret: (await pv.getSetup(m.provider_ref, m.provider_account)).clientSecret, provider: pv.name, account: m.provider_account };
  const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", personId).executeTakeFirstOrThrow();
  const customer = await pv.ensureCustomer({ key: personId, email: person.email, name: person.display_name });
  const it = await pv.createSetup({ customer: customer.id, idempotencyKey: m.id, metadata: { kumi_membership_id: m.id } });
  await runAsSystem(db, "membership.card_open", { membership_id: m.id, provider_ref: it.ref, saved_customer: customer.id, ...(it.account ? { provider_account: it.account } : {}) }, "payments");
  return { clientSecret: it.clientSecret, provider: pv.name, account: it.account };
}

/** Ask the provider whether the card was saved, and record it once it is. Safe to call any number of times:
 *  after the card form, from a webhook, and from the job that catches what both missed. */
export async function checkCardSetup(db: Db, membershipId: string, via = "payments", now?: Date): Promise<"pending" | "succeeded" | "failed" | null> {
  const m = await db.selectFrom("membership").select(["id", "status", "provider_ref", "provider_account", "saved_method"]).where("id", "=", membershipId).executeTakeFirst();
  if (!m) return null;
  if (m.saved_method) return "succeeded";
  if (!m.provider_ref || m.status !== "upcoming") return m.status === "ended" ? "failed" : "pending";
  const st = await paymentProvider().getSetup(m.provider_ref, m.provider_account);
  if (st.status === "succeeded" && st.paymentMethod)
    await runAsSystem(db, "membership.card_saved", { membership_id: m.id, saved_method: st.paymentMethod, ...(st.customer ? { saved_customer: st.customer } : {}) }, via, now ? { now } : {});
  return st.status;
}

export const membershipCardOpen = defineAction({
  name: "membership.card_open", version: 1, system: true, internal: true,
  input: z.object({ membership_id: z.uuid(), provider_ref: z.string().check(z.minLength(1)), saved_customer: z.string(), provider_account: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    return { title: both("action.membership.card_open"), summary: both("action.membership.card_open"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["provider_ref", "status"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.provider_ref === i.provider_ref) return { already: true };   // two taps: the same setup
    if (m.provider_ref || m.status !== "upcoming") throw new KumiError("error.changed");
    await ctx.update("membership", i.membership_id, { provider_ref: i.provider_ref, saved_customer: i.saved_customer, provider_account: i.provider_account ?? null });
    return null;
  },
});

export const membershipCardSaved = defineAction({
  name: "membership.card_saved", version: 1, system: true, internal: true,
  input: z.object({ membership_id: z.uuid(), saved_method: z.string(), saved_customer: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    return { title: both("action.membership.card_saved"), summary: both("action.membership.card_saved"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["saved_method", "status"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.saved_method) return { already: true };
    // Let go meanwhile (no card in time): the card is saved, but the place is gone; nothing was charged.
    if (m.status !== "upcoming") return { gone: true };
    await ctx.update("membership", i.membership_id, { saved_method: i.saved_method, ...(i.saved_customer ? { saved_customer: i.saved_customer } : {}) });
    await ctx.emit("membership.reserved", { membership_id: i.membership_id });
    return null;
  },
});

/** The job: card setups not yet recorded here (a missed webhook), then presale places whose card never came. */
export async function tidyPresales(db: Db, now = new Date()) {
  const open = await db.selectFrom("membership").select("id").where("status", "=", "upcoming").where("saved_method", "is", null).where("provider_ref", "is not", null).execute();
  let saved = 0;
  for (const m of open) {
    try { if ((await checkCardSetup(db, m.id, "job:payments", now)) === "succeeded") saved++; }
    catch (e) { console.error(`card setup ${m.id}:`, (e as Error).message); }   // tried again next time
  }
  const stale = await db.selectFrom("membership").select("id").where("status", "=", "upcoming").where("saved_method", "is", null).where("price_cents", ">", 0)
    .where("created_at", "<=", new Date(now.getTime() - CARD_HOURS * 3600_000)).execute();
  for (const m of stale) await runAsSystem(db, "membership.release", { membership_id: m.id }, "jobs", { now });
  return { saved, released: stale.length };
}

/** Kumi lets go of a presale place whose card wasn't saved in time. */
export const membershipRelease = defineAction({
  name: "membership.release", version: 1, system: true, internal: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    return { title: both("action.membership.release"), summary: both("action.membership.release"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["status", "saved_method"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.status !== "upcoming" || m.saved_method) return { already: true };
    await ctx.update("membership", i.membership_id, { status: "ended", ended_at: ctx.now, end_reason: "no_card" });
    return null;
  },
});

// ---- Family plans: who's covered, and what each period costs ----
/** The people a family plan covers at `at`, besides its payer (someone taken off is covered until their end). */
export async function coveredBy(db: Db | Trx, membershipId: string, at: Date) {
  return db.selectFrom("membership_member").innerJoin("person", "person.id", "membership_member.person_id")
    .select(["membership_member.id", "membership_member.person_id", "membership_member.ends_at", "membership_member.extra", "person.display_name", "person.junior"])
    .where("membership_member.membership_id", "=", membershipId).where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", at)]))
    .orderBy("membership_member.created_at").execute();
}
/** What a period costs: the price joined at, and each person beyond the plan's number at their price.
 *  Someone taken off doesn't count once their cover has ended (at the renewal). */
export async function periodCents(db: Db | Trx, m: { id: string; price_cents: number | null; family_size: number | null; extra_person_cents: number | null }, planCents: number, at: Date): Promise<number> {
  const base = m.price_cents ?? planCents;
  if (!m.family_size || !m.extra_person_cents) return base;
  const people = 1 + (await coveredBy(db, m.id, at)).filter((x) => !x.ends_at).length;
  return base + Math.max(0, people - m.family_size) * m.extra_person_cents;
}
const usdText = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });

export const membershipAddPerson = defineAction({
  name: "membership.add_person", version: 1,
  input: z.object({ membership_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person: payer } = await membershipRow(ctx.db, i.membership_id);
    if (!["upcoming", "active", "past_due"].includes(m.status)) throw new KumiError("error.membership_not_live");
    if (!m.family_size) throw new KumiError("error.not_family_plan", { name: plan.name });
    const { row: who } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    // Only from the payer's household: the other parent, a grown-up child, or a junior.
    const mine = await householdOf(ctx.db, m.person_id), theirs = await householdOf(ctx.db, i.person_id);
    if (i.person_id === m.person_id || !mine || theirs?.household_id !== mine.household_id || who.status !== "active") throw new KumiError("error.not_in_family", { name: who.display_name });
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_member", { name: who.display_name });
    const people = 1 + (await coveredBy(ctx.db, m.id, ctx.now)).filter((x) => !x.ends_at).length, extra = people + 1 > m.family_size;
    if (extra && m.extra_person_cents == null) throw new KumiError("error.family_full", { name: plan.name, count: m.family_size });
    const xc = m.extra_person_cents ?? 0, tz = await clubTz(ctx.db), p = { name: who.display_name, plan: plan.name, count: m.family_size, amount: usdText(xc) };
    // One more than the plan covers: charged now for this period (a plan that hasn't started yet: from its first charge).
    const total = usdText((m.price_cents ?? plan.price_cents) + Math.max(0, people + 1 - m.family_size) * xc);
    const money_ = !extra ? both("plan.membership.add_included", p)
      : m.status === "upcoming" ? both("plan.membership.add_extra_later", { ...p, total, date: dayText(localDate(m.started_at, tz)) })
      : m.source !== "app" ? both("plan.membership.add_extra_desk", p)
      : both("plan.membership.add_extra_now", { ...p, total });
    return { title: both("action.membership.add_person"), summary: { en: `${both("plan.membership.add_person", p).en} ${money_.en}`, es: `${both("plan.membership.add_person", p).es} ${money_.es}` },
      reads: [read], ownerIds: [m.person_id], moneyCents: extra && m.status !== "upcoming" && m.source === "app" ? xc : 0, undo: { kind: "compensating" },
      details: { extra, charge: extra && m.status !== "upcoming" && m.source === "app" && xc > 0 ? xc : 0 } };
  },
  async apply(ctx, i, plan) {
    const { extra, charge } = plan.details as { extra: boolean; charge: number };
    const m = await ctx.trx.selectFrom("membership").selectAll().where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();   // one at a time
    const people = 1 + (await coveredBy(ctx.trx, m.id, ctx.now)).filter((x) => !x.ends_at).length;
    if ((people + 1 > (m.family_size ?? 0)) !== extra) throw new KumiError("error.changed");
    const id = uuidv7();
    try { await ctx.insert("membership_member", { id, membership_id: m.id, person_id: i.person_id, extra, added_by: ctx.actor.personId }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    if (charge) {
      const planRow = await ctx.trx.selectFrom("membership_plan").select("name").where("id", "=", m.plan_id).executeTakeFirstOrThrow();
      const club = await ctx.trx.selectFrom("club").select("currency").executeTakeFirstOrThrow();
      const r = m.saved_customer && m.saved_method
        ? await paymentProvider().chargeSaved({ customer: m.saved_customer, paymentMethod: m.saved_method, amountCents: charge, currency: club.currency, description: `${planRow.name} membership: one more person`,
            idempotencyKey: `extra:${m.id}:${i.person_id}:${m.current_period_end?.toISOString() ?? ""}`, account: m.provider_account })
        : { ref: "", status: "failed" as const, failure: "no saved card" };
      if (r.status !== "succeeded") throw new KumiError("error.extra_declined", { failure: r.failure ?? "" });
      await ctx.insert("payment", { id: uuidv7(), person_id: m.person_id, amount_cents: charge, method: "card", provider: paymentProvider().name, provider_ref: r.ref,
        provider_account: m.provider_account, status: "succeeded", membership_id: m.id, membership_member_id: id });
      await post(ctx.trx, ctx.runId, "payment", "family membership: one more person", [
        { account: await account(ctx.trx, "provider_clearing"), cents: charge }, { account: await account(ctx.trx, "revenue", { revenueType: "memberships" }), cents: -charge }]);
    }
    await ctx.emit("membership.person_added", { membership_id: m.id, person_id: i.person_id, charged: charge });
    return { membership_member_id: id };
  },
});

export const membershipRemovePerson = defineAction({
  name: "membership.remove_person", version: 1,
  input: z.object({ membership_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan } = await membershipRow(ctx.db, i.membership_id);
    const row = (await coveredBy(ctx.db, m.id, ctx.now)).find((x) => x.person_id === i.person_id && !x.ends_at);
    if (!row) throw new KumiError("error.not_covered");
    // Covered until the next renewal (paid for until then); at once when nothing renews.
    const until = m.source === "app" && m.status !== "upcoming" && m.current_period_end && m.current_period_end > ctx.now ? m.current_period_end as Date : null;
    const p = { name: row.display_name, plan: plan.name, date: until ? dayText(endDay({ current_period_end: until, source: "app" }, await clubTz(ctx.db))) : "" };
    return { title: both("action.membership.remove_person"), summary: both(until ? "plan.membership.remove_person" : "plan.membership.remove_person_now", p),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" },
      details: { row: row.id, until: (until ?? ctx.now).toISOString() } };
  },
  async apply(ctx, i, plan) {
    const { row, until } = plan.details as { row: string; until: string };
    await ctx.update("membership_member", row, { ends_at: new Date(until) });
    await ctx.emit("membership.person_removed", { membership_id: i.membership_id, person_id: i.person_id, until });
    return null;
  },
});

// ---- Pausing (the club does it: an injury, a long trip) ----
export const membershipPause = defineAction({
  name: "membership.pause", version: 1,
  input: z.object({ membership_id: z.uuid(), until: clubDate, note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (m.status === "ended" || m.status === "upcoming") throw new KumiError("error.membership_not_live");
    if (m.paused_until && m.paused_until > ctx.now) throw new KumiError("error.membership_paused_already");
    const tz = await clubTz(ctx.db), until = onDate(i.until, "24:00", tz);
    if (until <= ctx.now) throw new KumiError("error.in_the_past");
    const shift = until.getTime() - ctx.now.getTime();
    const renews = m.current_period_end ? dayText(endDay({ current_period_end: new Date(m.current_period_end.getTime() + shift), source: m.source }, tz)) : null;
    return { title: both("action.membership.pause"), reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" },
      summary: both(renews ? (m.source === "app" ? "plan.membership.pause_renews" : "plan.membership.pause_until") : "plan.membership.pause", { person, name: plan.name, date: dayText(i.until), renews: renews ?? "" }) };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["current_period_end"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    const until = onDate(i.until, "24:00", await clubTz(ctx.trx)), shift = until.getTime() - ctx.now.getTime();
    // The paid (or given) time left is kept for after the pause.
    const end = m.current_period_end ? new Date(m.current_period_end.getTime() + shift) : null;
    await ctx.update("membership", i.membership_id, { paused_from: ctx.now, paused_until: until, ...(end ? { current_period_end: end } : {}), ...(i.note ? { note: i.note } : {}) });
    // The dates as they are now: the message is written a moment later, and the pause could end early before then.
    await ctx.emit("membership.paused", { membership_id: i.membership_id, until: until.toISOString(), renews: end?.toISOString() ?? null });
    return null;
  },
});

export const membershipUnpause = defineAction({
  name: "membership.unpause", version: 1,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (!m.paused_until || m.paused_until <= ctx.now) throw new KumiError("error.membership_not_paused");
    return { title: both("action.membership.unpause"), summary: both("plan.membership.unpause", { person, name: plan.name }), reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["current_period_end", "paused_until"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    // Back early: the pause it didn't use comes off the renewal date again.
    const unused = Math.max(0, m.paused_until!.getTime() - ctx.now.getTime());
    await ctx.update("membership", i.membership_id, { paused_until: ctx.now, ...(m.current_period_end ? { current_period_end: new Date(m.current_period_end.getTime() - unused) } : {}) });
    await ctx.emit("membership.unpaused", { membership_id: i.membership_id });
    return null;
  },
});
