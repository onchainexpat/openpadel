// Memberships: the plans a club offers (by the month or the year) and who holds one. A plan can come with
// member prices on courts (price rules for that plan) and a longer booking window. The desk gives a
// membership (a comp, a founding member), with or without an end date, or sells one paid at the desk for one
// period, which doesn't renew by itself (paid at the desk, below). Members join in the app and pay by card;
// Kumi renews from that saved card each period, at the price they joined at, and cancelling stops renewal at
// the period's end. One membership at a time per person. A family plan covers others from the payer's
// household too (see memberships covered below).
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Key, type Lang, type Text, formatLocale } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { mergeTranslations, textOf, translationsInput } from "./club_text.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localDate, localParts, onDate } from "./clock.ts";
import { account, paymentProvider, post } from "./money.ts";
import { householdOf, withManagers } from "./households.ts";
import { callOff, deskPaid, paidHow, recordAtDesk, refundTo } from "./desk_pay.ts";
import { declineReason } from "./declines.ts";
import { isReadOnly, refuseWhenReadOnly } from "./read_only.ts";
import { deskOrUp } from "./booking_pay.ts";

const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const LIVE = ["active", "past_due"] as const;
/** Held: live, or joined for a plan that hasn't started yet. One at a time per person. */
const HELD = ["upcoming", "active", "past_due"] as const;
/** A presale place with no card saved is let go after this long, so an abandoned card form doesn't keep it. */
export const CARD_HOURS = 2;

/** Whoever already holds a membership, of any kind (given, paid, or waiting for its plan to start), or is
 *  covered by someone's family plan. */
export async function holds(db: Db | Trx, personId: string) {
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
  const f = (lang: Lang) => new Intl.DateTimeFormat(formatLocale(lang), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
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
      eb.and([eb("membership.status", "=", "active"), eb.or([eb("membership.current_period_end", "is", null), eb("membership.current_period_end", ">", at)])]),
      // A founding member before the plan starts, card saved (or nothing to pay): its prices and discounts already,
      // when the plan says so (programPerks keeps included sessions for once it's started).
      eb.and([eb("membership.status", "=", "upcoming"), eb("membership_plan.perks_before_start", "=", true),
        eb.or([eb("membership.saved_method", "is not", null), eb("membership.price_cents", "=", 0)])])]))
    .executeTakeFirst()) ?? null;
}

/** After a failed renewal, try the card again this many days later; after the last, the membership ends. */
export const RETRY_AFTER_DAYS = [2, 3];
/** When the last try is, and the membership ends if that fails too: from the next try, after `tries` have failed. */
export function lastTryAt(next: Date, tries: number): Date {
  return new Date(next.getTime() + RETRY_AFTER_DAYS.slice(tries).reduce((a, d) => a + d, 0) * 86400_000);
}
/** The staff alert about a failed renewal, on the Today view until someone handles it. */
const RENEWAL_FAILED_ALERT = "membership_payment_failed_staff";

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
  perks_before_start: z.optional(z.boolean()),                                      // and the plan's prices and discounts already (default yes)
  // On programs (clinics, socials): a discount, a percent or an amount; and single sessions included each period.
  program_percent_off: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(100)))),
  program_cents_off: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1)))),
  included_sessions: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(100), z.describe("Single sessions included each membership period, free")))),
  included_kinds: z.optional(z.array(z.enum(["clinic", "social", "tournament"])).check(z.minLength(1))),
  // A family plan: how many people from one household it covers (the payer included), and the price of each one more.
  family_size: z.optional(z.nullable(z.number().check(z.int(), z.minimum(2), z.maximum(12), z.describe("People covered, the payer included: a family plan")))),
  extra_person_cents: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.describe("Each person beyond family_size, each period; none: no more than family_size")))),
  // The name and description in the other language (club_text.ts): { es: { name, description } }. Left out: kept as they are.
  translations: translationsInput("membership_plan"),
};
export const planSet = defineAction({
  name: "membership.plan_set", version: 1, clubWide: true,
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
      i.starts_on ? both("plan.membership.starts", { date: dayText(i.starts_on) }) : null,
      i.starts_on ? both(i.perks_before_start === false ? "plan.membership.perks_from_start" : "plan.membership.perks_early") : null].filter((x): x is Text => Boolean(x));
    const window = { en: extra.map((x) => x.en).join(""), es: extra.map((x) => x.es).join("") };
    return { title: both("action.membership.plan_set"), summary: both("plan.membership.plan_set", { name: i.name, price: planPrice(i.price_cents, i.period), window }),
      reads, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { plan_id, translations, ...p } = i;
    const old = plan_id ? (await ctx.trx.selectFrom("membership_plan").select("translations").where("id", "=", plan_id).executeTakeFirst())?.translations : {};
    const row = { ...p, translations: JSON.stringify(mergeTranslations(old, translations)), description: p.description ?? null, days_ahead: p.days_ahead ?? null, join_in_app: p.join_in_app ?? true, sort: p.sort ?? 0,
      max_members: p.max_members ?? null, starts_on: p.starts_on ?? null, perks_before_start: p.perks_before_start ?? true, program_percent_off: p.program_percent_off ?? null, program_cents_off: p.program_cents_off ?? null,
      included_sessions: p.included_sessions ?? null, included_kinds: p.included_kinds ?? ["clinic", "social"],
      family_size: p.family_size ?? null, extra_person_cents: p.family_size ? p.extra_person_cents ?? null : null };
    if (plan_id) { await ctx.update("membership_plan", plan_id, row); return { plan_id }; }
    const id = uuidv7();
    await ctx.insert("membership_plan", { id, ...row });
    return { plan_id: id };
  },
});

export const planRemove = defineAction({
  name: "membership.plan_remove", version: 1, clubWide: true,
  input: z.object({ plan_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    return { title: both("action.membership.plan_remove"), summary: both("plan.membership.plan_remove", { name: textOf(row.name, row.translations, "name") }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("membership_plan", i.plan_id, { active: false }); return null; },
});

// ---- Memberships ----
export const membershipGrant = defineAction({
  name: "membership.grant", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), plan_id: z.uuid(), until: z.optional(z.nullable(clubDate)), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: person } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const { row: plan, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    if (!plan.active) throw new KumiError("error.plan_not_offered", { name: textOf(plan.name, plan.translations, "name") });
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_member", { name: person.display_name });
    const club = await ctx.db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
    if (i.until && i.until < localDate(ctx.now, club.time_zone)) throw new KumiError("error.in_the_past");
    return { title: both("action.membership.grant"), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" },
      summary: both(i.until ? "plan.membership.grant_until" : "plan.membership.grant", { person: person.display_name, name: textOf(plan.name, plan.translations, "name"), until: i.until ? dayText(i.until) : "" }) };
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
  name: "membership.end", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid(), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: m, read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    if (m.status === "ended") throw new KumiError("error.membership_ended");
    const person = await ctx.db.selectFrom("person").select("display_name").where("id", "=", m.person_id).executeTakeFirstOrThrow();
    const plan = await ctx.db.selectFrom("membership_plan").select(["name", "translations"]).where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    return { title: both("action.membership.end"), summary: both("plan.membership.end", { person: person.display_name, name: textOf(plan.name, plan.translations, "name") }),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select("status").where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    await ctx.update("membership", i.membership_id, { status: "ended", ended_at: ctx.now, ...(m.status === "past_due" ? { next_attempt_at: null } : {}), ...(i.note ? { note: i.note } : {}) });
    // Ended by the staff while a renewal was unpaid: nothing is tried again, and its alert needs nobody now.
    if (m.status === "past_due") { await dropPayNow(ctx, i.membership_id); await closeRenewalAlert(ctx, i.membership_id); }
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

/** Paid for: one more period, on from the end of the last (a late payment keeps the days it was late), and one
 *  more on the count of its periods (a pause moves the dates, never the count). */
async function extend(ctx: ApplyCtx, membershipId: string, card?: { customer: string | null; method: string | null }) {
  const m = await ctx.trx.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.current_period_end", "membership.started_at", "membership.period", "membership.period_no", "membership.anchor_day", "membership_plan.period as plan_period"]).where("membership.id", "=", membershipId).executeTakeFirstOrThrow();
  const tz = await clubTz(ctx.trx), from = m.current_period_end ?? ctx.now;
  // Its day of the month: the day it was joined, or one kept apart (anchor_day: a membership carried over from Playtomic
  // renews on Playtomic's day), so a 31st that fell on a shorter month goes back to the 31st after.
  const anchor = m.anchor_day ?? localParts(m.started_at, tz).d;
  await ctx.update("membership", membershipId, { status: "active", failed_attempts: 0, next_attempt_at: null, period_no: m.period_no + 1,
    current_period_end: addPeriod(from, m.period ?? m.plan_period, tz, anchor), ...(card?.method ? { saved_customer: card.customer, saved_method: card.method } : {}) });
}

/** Give a membership payment back, all of it, to the card (the outbox sends it; paid at the desk, it waits there). */
async function refundCard(ctx: ApplyCtx, paymentId: string, cents: number) {
  await refundTo(ctx, paymentId, cents);
}

/** The renewal was paid after all, or the membership ended for want of it: the staff alert about its failure
 *  needs nobody now. It's closed with no one's name, and the staff hear what happened instead. */
async function closeRenewalAlert(ctx: ApplyCtx, membershipId: string) {
  const open = await ctx.trx.selectFrom("event_outbox").select("event_outbox.id").where("event_outbox.topic", "=", "membership.payment_failed")
    .where(sql<string>`event_outbox.payload->>'membership_id'`, "=", membershipId)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("staff_alert").select("staff_alert.id").whereRef("staff_alert.event_id", "=", "event_outbox.id").where("staff_alert.kind", "=", RENEWAL_FAILED_ALERT))))
    .execute();
  for (const e of open) await ctx.insert("staff_alert", { id: uuidv7(), event_id: e.id, kind: RENEWAL_FAILED_ALERT, handled_by: null, handled_at: ctx.now });
}

/** Payments asked of the member for a renewal that no card form has opened yet: not needed any more. */
async function dropPayNow(ctx: ApplyCtx, membershipId: string) {
  for (const p of await ctx.trx.selectFrom("payment").select("id").where("membership_id", "=", membershipId).where("status", "=", "pending").where("provider_ref", "is", null).execute())
    await callOff(ctx, p.id);
}

/** After a membership payment succeeds (called by payment.settle): joining starts the membership; paying a
 *  late renewal by hand renews it. Paid for a membership that can't be had any more: all of it back. */
export async function afterMembershipPayment(ctx: ApplyCtx, pay: { id: string; person_id: string; amount_cents: number; membership_plan_id: string | null; membership_id: string | null;
  provider_account: string | null; save_card: boolean; for_period_no?: number | null; method?: string; discount_cents?: number }, card: { customer: string | null; method: string | null }) {
  if (pay.membership_id) {
    const m = await ctx.trx.selectFrom("membership").select(["status", "period_no", "balance_cents"]).where("id", "=", pay.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.status === "ended") { await refundCard(ctx, pay.id, pay.amount_cents); return; }
    // Asked for a period that was paid another way while its card form was open (at the desk, or by the saved
    // card's retry), and the card went through too: no second period. It pays what's still owed at the desk, and
    // the rest goes back to the card. Told by the count of periods, which a pause doesn't move (its dates it does).
    // payment.settle holds the payment's lock, so this runs once for it, and it goes back once.
    if (pay.for_period_no != null && pay.for_period_no !== m.period_no) {
      const kept = Math.min(m.balance_cents, pay.amount_cents), back = pay.amount_cents - kept;
      if (kept > 0) await ctx.update("membership", pay.membership_id, { balance_cents: m.balance_cents - kept });
      if (back > 0) await refundCard(ctx, pay.id, back);
      await ctx.emit("membership.paid_twice", { membership_id: pay.membership_id, payment_id: pay.id, kept, back });
      return;
    }
    await extend(ctx, pay.membership_id, pay.save_card ? card : undefined);
    await dropPayNow(ctx, pay.membership_id);
    const late = m.status === "past_due";
    if (late) await closeRenewalAlert(ctx, pay.membership_id);
    await ctx.emit("membership.renewed", { membership_id: pay.membership_id, payment_id: pay.id, late });
    return;
  }
  const plan = await ctx.trx.selectFrom("membership_plan").select(["id", "name", "price_cents", "period", "max_members", "family_size", "extra_person_cents"]).where("id", "=", pay.membership_plan_id!).forUpdate().executeTakeFirstOrThrow();
  // The price paid is the price it renews at, before any promo code: a code is for the first payment only
  // (promo_codes.ts). Paid for the last place someone else took meanwhile: back.
  const id = await holds(ctx.trx, pay.person_id) || !await hasRoom(ctx.trx, plan) ? null
    : await startMembership(ctx, pay.person_id, { ...plan, price_cents: pay.amount_cents + (pay.method === "promo" ? 0 : pay.discount_cents ?? 0) }, { customer: card.customer, method: card.method, account: pay.provider_account });
  if (!id) { await refundCard(ctx, pay.id, pay.amount_cents); return; }   // paid twice, or already a member
  await ctx.update("payment", pay.id, { membership_id: id });
}

export const membershipJoin = defineAction({
  name: "membership.join", version: 1, clubWide: true,
  input: z.object({ plan_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: plan, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    if (!plan.active || !plan.join_in_app) throw new KumiError("error.plan_not_in_app", { name: textOf(plan.name, plan.translations, "name") });
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_a_member");
    if (!await hasRoom(ctx.db, plan as { id: string; max_members: number | null })) throw new KumiError("error.plan_full", { name: textOf(plan.name, plan.translations, "name") });
    const tz = await clubTz(ctx.db), presale = Boolean(plan.starts_on && plan.starts_on > localDate(ctx.now, tz));
    // A founding place given up before the start can't be taken again in the app: its member prices came with it
    // (perks before the start), and joining and leaving again would keep them for nothing. Staff can still add them.
    if (presale && await ctx.db.selectFrom("membership").select("id").where("person_id", "=", i.person_id).where("plan_id", "=", plan.id).where("end_reason", "=", "gave_up_place").executeTakeFirst()
      && !(await deskOrUp(ctx.db, ctx.actor)))
      throw new KumiError("error.presale_given_up", { name: textOf(plan.name, plan.translations, "name") });
    const p = { name: textOf(plan.name, plan.translations, "name"), price: planPrice(plan.price_cents, plan.period), period: both(plan.period === "year" ? "plan.membership.every_year" : "plan.membership.every_month"),
      date: plan.starts_on ? dayText(plan.starts_on) : "" };
    const base = both(!plan.price_cents ? "plan.membership.join_free" : presale ? "plan.membership.join_presale" : "plan.membership.join", p);
    // A family plan: whom else it can cover, added afterwards from the Membership page.
    const fam = plan.family_size ? both(plan.extra_person_cents != null ? "plan.membership.join_family_extra" : "plan.membership.join_family",
      { count: plan.family_size - 1, amount: { en: money(plan.extra_person_cents ?? 0, "en"), es: money(plan.extra_person_cents ?? 0, "es") }, period: both(`ui.period_${plan.period}` as Key) }) : null;
    return { title: both("action.membership.join"), summary: fam ? { en: `${base.en} ${fam.en}`, es: `${base.es} ${fam.es}` } : base,
      reads: [read], ownerIds: [i.person_id], moneyCents: presale ? 0 : plan.price_cents, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const plan = await ctx.trx.selectFrom("membership_plan").select(["id", "name", "translations", "price_cents", "period", "max_members", "starts_on", "family_size", "extra_person_cents"]).where("id", "=", i.plan_id).forUpdate().executeTakeFirstOrThrow();
    const tz = await clubTz(ctx.trx);
    if (plan.starts_on && plan.starts_on > localDate(ctx.now, tz)) {
      // Before the plan starts: a place now, the card saved next (the members' app opens the form), the
      // first charge on the start date. One place at a time, so the limit holds when many join at once.
      if (!await hasRoom(ctx.trx, plan)) throw new KumiError("error.plan_full", { name: textOf(plan.name, plan.translations, "name") });
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
  const plan = await db.selectFrom("membership_plan").select(["name", "translations", "price_cents", "period"]).where("id", "=", row.plan_id).executeTakeFirstOrThrow();
  const person = await db.selectFrom("person").select("display_name").where("id", "=", row.person_id).executeTakeFirstOrThrow();
  return { m: row as Record<string, any> & { current_period_end: Date; source: string }, read, plan, person: person.display_name as string };
}

export const membershipCancel = defineAction({
  name: "membership.cancel", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (m.status === "ended") throw new KumiError("error.membership_ended");
    if (m.source !== "app") throw new KumiError("error.membership_not_renewing");
    if (m.cancel_at_period_end) throw new KumiError("error.membership_already_cancelled");
    const own = ctx.actor.personId === m.person_id;
    // Before its plan starts, nothing has been charged: the place is given up at once. Member prices already had
    // before then (perks before the start) stay as they were: nothing is charged back.
    if (m.status === "upcoming") {
      const early = (await ctx.db.selectFrom("membership_plan").select("perks_before_start").where("id", "=", m.plan_id).executeTakeFirstOrThrow()).perks_before_start;
      const s = both(own ? "plan.membership.release_own" : "plan.membership.release", { name: textOf(plan.name, plan.translations, "name"), person }), kept = both("plan.membership.perks_kept");
      const had = early && (Boolean(m.saved_method) || m.price_cents === 0);   // the perks were theirs already
      return { title: both("action.membership.cancel"), summary: had ? { en: `${s.en} ${kept.en}`, es: `${s.es} ${kept.es}` } : s,
        reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
    }
    const p = { name: textOf(plan.name, plan.translations, "name"), person, until: dayText(endDay(m, await clubTz(ctx.db))) };
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
  name: "membership.resume", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (m.status === "ended" || !m.cancel_at_period_end) throw new KumiError("error.membership_not_cancelled");
    const p = { name: textOf(plan.name, plan.translations, "name"), person, date: dayText(endDay(m, await clubTz(ctx.db))), price: { en: money(m.price_cents ?? plan.price_cents, "en"), es: money(m.price_cents ?? plan.price_cents, "es") } };
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
  // Read-only: no card is charged, and no membership ends for it either; renewals wait until it's over.
  if (await isReadOnly(db)) return { renewed: 0, failed: 0, ended: 0 };
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
    // Carried over from Playtomic and no card added here: it ends the day Playtomic's period did, with nothing charged
    // and nobody's renewal failing (brought_in.ts). The member was reminded before.
    if (m.brought_from && !m.saved_method) {
      await ctx.update("membership", m.id, { status: "ended", ended_at: m.current_period_end, end_reason: "not_continued", next_attempt_at: null });
      await dropPayNow(ctx, m.id);
      await ctx.emit("membership.brought_ended", { membership_id: m.id });
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
      // Paid on a try after a failed one: the staff who heard of the failure hear it's sorted.
      const late = m.status === "past_due";
      if (late) await closeRenewalAlert(ctx, m.id);
      // The first charge of a membership joined before its plan started is its start.
      await ctx.emit(m.status === "upcoming" ? "membership.started" : "membership.renewed", { membership_id: m.id, payment_id: id, late });
      return { outcome: "renewed" };
    }
    const tries = m.failed_attempts + 1;
    if (tries > RETRY_AFTER_DAYS.length) {
      await ctx.update("membership", m.id, { status: "ended", ended_at: ctx.now, end_reason: "not_paid", failed_attempts: tries, next_attempt_at: null });
      await dropPayNow(ctx, m.id);
      await closeRenewalAlert(ctx, m.id);
      await ctx.emit("membership.ended", { membership_id: m.id });
      return { outcome: "ended", failure: charge.failure };
    }
    const next = new Date(ctx.now.getTime() + RETRY_AFTER_DAYS[tries - 1]! * 86400_000);
    await ctx.update("membership", m.id, { status: "past_due", failed_attempts: tries, next_attempt_at: next });
    // Meanwhile the member can pay it with another card in the app, which then becomes the one it renews on.
    const open = await ctx.trx.selectFrom("payment").select("id").where("membership_id", "=", m.id).where("status", "=", "pending").executeTakeFirst();
    if (!open) await ctx.insert("payment", { id: uuidv7(), person_id: m.person_id, amount_cents: cents, method: "card", provider: paymentProvider().name, provider_ref: null,
      status: "pending", membership_id: m.id, save_card: true, for_period_no: m.period_no });
    // The staff hear of the first failed try only (messages.ts); why it failed goes with it.
    await ctx.emit("membership.payment_failed", { membership_id: m.id, cents, next_attempt_at: next.toISOString(), tries, failure: charge.failure ?? null, ...(m.status === "upcoming" ? { first: true } : {}) });
    return { outcome: "failed", failure: charge.failure };
  },
});

// ---- Presales: saving the card of a member who joined before the plan starts ----
/** Whether a membership is waiting for a card: one joined before its plan starts, or one carried over from Playtomic
 *  that renews here (brought_in.ts) from the day Playtomic's period ends. */
export function cardWanted(m: { status: string; brought_from?: string | null; source?: string }): boolean {
  return m.status === "upcoming" || (Boolean(m.brought_from) && m.source === "app" && (m.status === "active" || m.status === "past_due"));
}
/** The card form for an upcoming membership's card: a setup at the provider, opened once and reused. */
export async function openCardSetup(db: Db, membershipId: string, personId: string): Promise<{ clientSecret: string; provider: "test" | "stripe"; account: string | null }> {
  const m = await db.selectFrom("membership").selectAll().where("id", "=", membershipId).executeTakeFirst();
  if (!m || m.person_id !== personId) throw new KumiError("error.not_found", { thing: both("thing.membership") }, 404);
  if (!cardWanted(m) || m.saved_method) throw new KumiError("error.not_pending", {}, 409);
  await refuseWhenReadOnly(db);
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
  const m = await db.selectFrom("membership").select(["id", "status", "provider_ref", "provider_account", "saved_method", "brought_from", "source"]).where("id", "=", membershipId).executeTakeFirst();
  if (!m) return null;
  if (m.saved_method) return "succeeded";
  if (!m.provider_ref || !cardWanted(m)) return m.status === "ended" ? "failed" : "pending";
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
    const m = await ctx.trx.selectFrom("membership").select(["provider_ref", "status", "brought_from", "source"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.provider_ref === i.provider_ref) return { already: true };   // two taps: the same setup
    if (m.provider_ref || !cardWanted(m)) throw new KumiError("error.changed");
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
    const m = await ctx.trx.selectFrom("membership").select(["saved_method", "status", "brought_from", "source"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.saved_method) return { already: true };
    // Let go meanwhile (no card in time): the card is saved, but the place is gone; nothing was charged.
    if (!cardWanted(m)) return { gone: true };
    await ctx.update("membership", i.membership_id, { saved_method: i.saved_method, ...(i.saved_customer ? { saved_customer: i.saved_customer } : {}) });
    // A membership carried over from Playtomic now renews here from that card; one joined ahead of its plan is held.
    await ctx.emit(m.status === "upcoming" ? "membership.reserved" : "membership.brought_card", { membership_id: i.membership_id });
    return null;
  },
});

/** The job: card setups not yet recorded here (a missed webhook), then presale places whose card never came. */
export async function tidyPresales(db: Db, now = new Date()) {
  // Read-only: nobody can save a card, so no presale place is let go for want of one.
  if (await isReadOnly(db)) return { saved: 0, released: 0 };
  const open = await db.selectFrom("membership").select("id").where((w) => w.or([w("status", "=", "upcoming"), w.and([w("brought_from", "is not", null), w("source", "=", "app"), w("status", "=", "active")])]))
    .where("saved_method", "is", null).where("provider_ref", "is not", null).execute();
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
  name: "membership.add_person", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person: payer } = await membershipRow(ctx.db, i.membership_id);
    if (!["upcoming", "active", "past_due"].includes(m.status)) throw new KumiError("error.membership_not_live");
    if (!m.family_size) throw new KumiError("error.not_family_plan", { name: textOf(plan.name, plan.translations, "name") });
    const { row: who } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    // Only from the payer's household: the other parent, a grown-up child, or a junior.
    const mine = await householdOf(ctx.db, m.person_id), theirs = await householdOf(ctx.db, i.person_id);
    if (i.person_id === m.person_id || !mine || theirs?.household_id !== mine.household_id || who.status !== "active") throw new KumiError("error.not_in_family", { name: who.display_name });
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_member", { name: who.display_name });
    // Taken off this period and still covered until its end: put back, nothing charged again.
    const back = (await coveredBy(ctx.db, m.id, ctx.now)).find((x) => x.person_id === i.person_id && x.ends_at);
    if (back) return { title: both("action.membership.add_person"), summary: both("plan.membership.add_back", { name: who.display_name, plan: textOf(plan.name, plan.translations, "name") }),
      reads: [read], ownerIds: [m.person_id], moneyCents: 0, undo: { kind: "compensating" }, details: { back: back.id, extra: back.extra, charge: 0 } };
    const people = 1 + (await coveredBy(ctx.db, m.id, ctx.now)).filter((x) => !x.ends_at).length, extra = people + 1 > m.family_size;
    if (extra && m.extra_person_cents == null) throw new KumiError("error.family_full", { name: textOf(plan.name, plan.translations, "name"), count: m.family_size });
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
    const { extra, charge, back } = plan.details as { extra: boolean; charge: number; back?: string };
    const m = await ctx.trx.selectFrom("membership").selectAll().where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();   // one at a time
    if (back) {
      const row = await ctx.trx.selectFrom("membership_member").select(["ends_at"]).where("id", "=", back).forUpdate().executeTakeFirstOrThrow();
      if (!row.ends_at || row.ends_at <= ctx.now) throw new KumiError("error.changed");
      try { await ctx.update("membership_member", back, { ends_at: null }); }
      catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
      await ctx.emit("membership.person_added", { membership_id: m.id, person_id: i.person_id, charged: 0 });
      return { membership_member_id: back };
    }
    const people = 1 + (await coveredBy(ctx.trx, m.id, ctx.now)).filter((x) => !x.ends_at).length;
    if ((people + 1 > (m.family_size ?? 0)) !== extra) throw new KumiError("error.changed");
    const id = uuidv7();
    try { await ctx.insert("membership_member", { id, membership_id: m.id, person_id: i.person_id, extra, added_by: ctx.actor.personId }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    // One more on a membership from the desk: this period's price for them is owed there.
    if (extra && m.source === "desk" && m.status !== "upcoming" && (m.extra_person_cents ?? 0) > 0) await ctx.update("membership", m.id, { balance_cents: m.balance_cents + m.extra_person_cents! });
    if (charge) {
      const planRow = await ctx.trx.selectFrom("membership_plan").select("name").where("id", "=", m.plan_id).executeTakeFirstOrThrow();
      const club = await ctx.trx.selectFrom("club").select("currency").executeTakeFirstOrThrow();
      const r = m.saved_customer && m.saved_method
        ? await paymentProvider().chargeSaved({ customer: m.saved_customer, paymentMethod: m.saved_method, amountCents: charge, currency: club.currency, description: `${planRow.name} membership: one more person`,
            // One key per try (this change's own id): Stripe answers a reused key with its first answer, a decline
            // included, so a key per person and period would refuse every retry after a declined card. The same
            // change applied again after a deadlock gets the same answer, never a second charge.
            idempotencyKey: `extra:${ctx.runId}`, account: m.provider_account })
        : { ref: "", status: "failed" as const, failure: "no saved card" };
      if (r.status !== "succeeded") throw new KumiError("error.extra_declined", { reason: declineReason(r.failure) });
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
  name: "membership.remove_person", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan } = await membershipRow(ctx.db, i.membership_id);
    const row = (await coveredBy(ctx.db, m.id, ctx.now)).find((x) => x.person_id === i.person_id && !x.ends_at);
    if (!row) throw new KumiError("error.not_covered");
    // From the desk, one more than the plan covers whose price is still owed there: it comes off what's owed, and
    // they go at once, as if never added. Paid for already: covered to the end of the period, like the app's, so
    // putting them back before then charges nothing again.
    const off = deskOff(m, row);
    // Covered until the next renewal (paid for until then); at once when nothing renews.
    const until = !off && (m.source === "app" || m.source === "desk") && m.status !== "upcoming" && m.current_period_end && m.current_period_end > ctx.now ? m.current_period_end as Date : null;
    const p = { name: row.display_name, plan: plan.name, date: until ? dayText(endDay({ current_period_end: until, source: m.source }, await clubTz(ctx.db))) : "", amount: usdText(off) };
    return { title: both("action.membership.remove_person"), summary: both(until ? (m.source === "desk" ? "plan.membership.remove_person_desk" : "plan.membership.remove_person") : off ? "plan.membership.remove_person_owed" : "plan.membership.remove_person_now", p),
      reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" },
      details: { row: row.id, until: (until ?? ctx.now).toISOString(), off } };
  },
  async apply(ctx, i, plan) {
    const { row, until, off } = plan.details as { row: string; until: string; off?: number };
    const m = await ctx.trx.selectFrom("membership").selectAll().where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    const r = await ctx.trx.selectFrom("membership_member").select(["extra"]).where("id", "=", row).executeTakeFirstOrThrow();
    if (deskOff(m, r) !== (off ?? 0)) throw new KumiError("error.changed");   // paid at the desk meanwhile: again from the preview
    if (off) await ctx.update("membership", m.id, { balance_cents: m.balance_cents - off });
    await ctx.update("membership_member", row, { ends_at: new Date(until) });
    await ctx.emit("membership.person_removed", { membership_id: i.membership_id, person_id: i.person_id, until });
    return null;
  },
});

/** What taking one person off a membership from the desk takes off what's owed there: their price, while all of
 *  it is still owed (so what's left is what was owed without them); nothing once it's been paid. */
function deskOff(m: Record<string, any>, row: { extra: boolean }): number {
  const x = m.extra_person_cents ?? 0;
  return m.source === "desk" && m.status !== "upcoming" && row.extra && x > 0 && m.balance_cents >= x ? x : 0;
}

// ---- Pausing (the club does it: an injury, a long trip) ----
export const membershipPause = defineAction({
  name: "membership.pause", version: 1, clubWide: true,
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
      summary: both(renews ? (m.source === "app" ? "plan.membership.pause_renews" : "plan.membership.pause_until") : "plan.membership.pause", { person, name: textOf(plan.name, plan.translations, "name"), date: dayText(i.until), renews: renews ?? "" }) };
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
  name: "membership.unpause", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    if (!m.paused_until || m.paused_until <= ctx.now) throw new KumiError("error.membership_not_paused");
    return { title: both("action.membership.unpause"), summary: both("plan.membership.unpause", { person, name: textOf(plan.name, plan.translations, "name") }), reads: [read], ownerIds: [m.person_id], undo: { kind: "reversible" } };
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

// ---- Paid at the desk (cash, the club's card reader, another way) ----
/** The next period can be paid (at the desk, or in the app) once this few days are left of the current one. */
export const PAY_AHEAD_DAYS = 14;
/** A membership paid at the desk doesn't renew by itself: its member hears this many days before it ends. */
export const END_REMINDER_DAYS = 7;

/** A period sold at the desk runs to the start of the day a period on, in the club's time: "until 3 December". */
function deskPeriodEnd(from: Date, period: "month" | "year", tz: string, day: number): Date {
  return onDate(localDate(addPeriod(from, period, tz, day), tz), "00:00", tz);
}
/** Never more than is owed on it: Kumi keeps no credit for later, so more has nowhere to go. */
function deskOwed(owed: number, cents: number) {
  if (owed <= 0) throw new KumiError("error.membership_paid_up");
  if (cents > owed) throw new KumiError("error.more_than_owed_membership", { owed: usdText(owed), amount: usdText(cents) });
}
/** What the desk takes for a membership now: what's still owed on this period, or else the next period (once
 *  it's close, or a renewal is late), at the price it was sold or joined at. */
async function dueAtDesk(db: Db | Trx, m: Record<string, any>, planCents: number, now: Date): Promise<{ cents: number; next: boolean }> {
  if (m.status === "upcoming") throw new KumiError("error.membership_not_started_desk");
  // Still owed on its period, even once it's over: paid at the desk when they come in.
  if (m.balance_cents > 0) return { cents: m.balance_cents, next: false };
  if (m.status === "ended") throw new KumiError("error.membership_ended");
  if (!m.current_period_end) throw new KumiError("error.membership_no_end");
  const opens = new Date(m.current_period_end.getTime() - PAY_AHEAD_DAYS * 86400_000);
  if (m.status !== "past_due" && opens > now) throw new KumiError("error.next_period_later", { date: dayText(localDate(opens, await clubTz(db))) });
  return { cents: await periodCents(db, m as any, planCents, m.current_period_end), next: true };
}
/** "until 3 December 2026", for the period after the current one. */
async function nextUntil(db: Db | Trx, m: Record<string, any>, plan: { period: "month" | "year" }): Promise<Text> {
  // On its own day of the month: anchor_day when it keeps one apart (carried over from Playtomic), as extend() does.
  const tz = await clubTz(db), end = addPeriod(m.current_period_end, m.period ?? plan.period, tz, m.anchor_day ?? localParts(m.started_at, tz).d);
  return dayText(endDay({ current_period_end: end, source: m.source }, tz));
}
/** For the staff's and members' pages: what the desk would take for a membership now (what's still owed on it, or
 *  the next period), or null when there's nothing to take yet. */
export async function membershipDue(db: Db | Trx, membershipId: string, now = new Date()): Promise<{ cents: number; next: boolean } | null> {
  const m = await db.selectFrom("membership").selectAll().where("id", "=", membershipId).executeTakeFirst();
  if (!m) return null;
  const plan = await db.selectFrom("membership_plan").select("price_cents").where("id", "=", m.plan_id).executeTakeFirstOrThrow();
  try { const due = await dueAtDesk(db, m, plan.price_cents, now); return due.cents > 0 ? due : null; }
  catch (e) { if (e instanceof KumiError) return null; throw e; }
}
const rest = (cents: number): Text => cents > 0 ? both("plan.membership.rest_desk", { amount: usdText(cents) }) : { en: "", es: "" };

export const membershipSell = defineAction({
  name: "membership.sell", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), plan_id: z.uuid(), ...deskPaid }),
  async plan(ctx, i) {
    const { row: person } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const { row: plan, read } = await readRow(ctx.db, "membership_plan", i.plan_id, "thing.membership_plan");
    const name = textOf(plan.name, plan.translations, "name"), tz = await clubTz(ctx.db);
    if (!plan.active) throw new KumiError("error.plan_not_offered", { name });
    if (!plan.price_cents) throw new KumiError("error.plan_free_desk", { name });   // nothing to pay: given (membership.grant)
    if (plan.starts_on && plan.starts_on > localDate(ctx.now, tz)) throw new KumiError("error.plan_starts_later_desk", { name, date: dayText(plan.starts_on) });
    if (await holds(ctx.db, i.person_id)) throw new KumiError("error.already_member", { name: person.display_name });
    if (!await hasRoom(ctx.db, plan as { id: string; max_members: number | null })) throw new KumiError("error.plan_full", { name });
    deskOwed(plan.price_cents, i.cents);
    const until = dayText(endDay({ current_period_end: deskPeriodEnd(ctx.now, plan.period, tz, localParts(ctx.now, tz).d), source: "desk" }, tz));
    return { title: both("action.membership.sell"), reads: [read], ownerIds: [i.person_id], moneyCents: i.cents, undo: { kind: "compensating" },
      summary: both("plan.membership.sell", { person: person.display_name, name, until, amount: usdText(i.cents), how: paidHow(i.method), rest: rest(plan.price_cents - i.cents) }),
      details: { price: plan.price_cents } };
  },
  async apply(ctx, i, plan) {
    // One sale at a time per plan, so a limit on it holds when two desks sell its last place at once.
    const p = await ctx.trx.selectFrom("membership_plan").select(["id", "price_cents", "period", "max_members", "family_size", "extra_person_cents"]).where("id", "=", i.plan_id).forUpdate().executeTakeFirstOrThrow();
    if (p.price_cents !== (plan.details as { price: number }).price || !await hasRoom(ctx.trx, p)) throw new KumiError("error.changed");
    const tz = await clubTz(ctx.trx), id = uuidv7();
    try {
      await ctx.insert("membership", { id, person_id: i.person_id, plan_id: p.id, status: "active", source: "desk", started_at: ctx.now,
        current_period_end: deskPeriodEnd(ctx.now, p.period, tz, localParts(ctx.now, tz).d), price_cents: p.price_cents, period: p.period,
        family_size: p.family_size, extra_person_cents: p.extra_person_cents, note: i.note ?? null, balance_cents: p.price_cents - i.cents });
    } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }   // a member another way meanwhile
    const payment = await recordAtDesk(ctx, { personId: i.person_id, cents: i.cents, method: i.method, note: i.note, revenue: "memberships", memo: "membership", link: { membership_id: id } });
    await ctx.emit("membership.started", { membership_id: id });
    return { membership_id: id, payment_id: payment };
  },
});

/** Money for a membership taken at the desk: what's still owed on its period, or the next period (a card on file
 *  isn't charged for a period paid here: its renewal moves on a period). A renewal that failed is paid this way too. */
export const membershipRecordPayment = defineAction({
  name: "membership.record_payment", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid(), ...deskPaid }),
  async plan(ctx, i) {
    const { m, read, plan, person } = await membershipRow(ctx.db, i.membership_id);
    const due = await dueAtDesk(ctx.db, m, plan.price_cents, ctx.now);
    deskOwed(due.cents, i.cents);
    const p = { person, name: textOf(plan.name, plan.translations, "name"), amount: usdText(i.cents), how: paidHow(i.method), rest: rest(due.cents - i.cents) };
    return { title: both("action.membership.record_payment"), reads: [read], ownerIds: [m.person_id], moneyCents: i.cents, undo: { kind: "compensating" },
      summary: due.next ? both(m.source === "app" ? "plan.membership.pay_next_desk_card" : "plan.membership.pay_next_desk", { ...p, until: await nextUntil(ctx.db, m, plan) })
        : both("plan.membership.pay_rest_desk", p),
      details: due };
  },
  async apply(ctx, i, plan) {
    const m = await ctx.trx.selectFrom("membership").selectAll().where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    const pl = await ctx.trx.selectFrom("membership_plan").select(["price_cents", "period"]).where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    // Again under the lock: two desks at once (or the member's card meanwhile) can't both pay it.
    const due = await dueAtDesk(ctx.trx, m, pl.price_cents, ctx.now), planned = plan.details as { cents: number; next: boolean };
    if (due.next !== planned.next || due.cents !== planned.cents) throw new KumiError("error.changed");
    deskOwed(due.cents, i.cents);
    const payment = await recordAtDesk(ctx, { personId: m.person_id, cents: i.cents, method: i.method, note: i.note, revenue: "memberships", memo: "membership", link: { membership_id: m.id } });
    if (!due.next) { await ctx.update("membership", m.id, { balance_cents: m.balance_cents - i.cents }); return { payment_id: payment }; }
    // A comp given until a date, paid for from now on: it keeps the plan's price.
    if (m.price_cents == null) await ctx.update("membership", m.id, { price_cents: pl.price_cents, period: pl.period });
    await extend(ctx, m.id);
    if (due.cents > i.cents) await ctx.update("membership", m.id, { balance_cents: due.cents - i.cents });
    await dropPayNow(ctx, m.id);
    const late = m.status === "past_due";
    if (late) await closeRenewalAlert(ctx, m.id);
    await ctx.emit("membership.renewed", { membership_id: m.id, payment_id: payment, late });
    return { payment_id: payment };
  },
});

/** A member pays the next period of a membership from the desk by card in the app, when its plan is one they could
 *  join there. Nothing renews from that card: the next period is paid the same way, or at the desk. */
export const membershipPayNext = defineAction({
  name: "membership.pay_next", version: 1, clubWide: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { m, read, plan } = await membershipRow(ctx.db, i.membership_id);
    const name = textOf(plan.name, plan.translations, "name");
    if (m.source === "app") throw new KumiError("error.membership_renews_itself", { name });
    const p = await ctx.db.selectFrom("membership_plan").select("join_in_app").where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    if (!p.join_in_app || m.price_cents == null) throw new KumiError("error.pay_next_at_desk", { name });
    if (m.balance_cents > 0) throw new KumiError("error.membership_owed_desk", { amount: usdText(m.balance_cents) });
    const due = await dueAtDesk(ctx.db, m, plan.price_cents, ctx.now);
    return { title: both("action.membership.pay_next"), summary: both("plan.membership.pay_next_card", { name, amount: usdText(due.cents), until: await nextUntil(ctx.db, m, plan) }),
      reads: [read], ownerIds: await withManagers(ctx.db, [m.person_id]), moneyCents: due.cents, undo: { kind: "compensating" }, details: due };
  },
  async apply(ctx, i, plan) {
    const m = await ctx.trx.selectFrom("membership").selectAll().where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    const pl = await ctx.trx.selectFrom("membership_plan").select("price_cents").where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    const due = await dueAtDesk(ctx.trx, m, pl.price_cents, ctx.now);
    if (!due.next || due.cents !== (plan.details as { cents: number }).cents) throw new KumiError("error.changed");
    // Already asked (a second tap, or back after closing the card form): the same payment, for the same period.
    const open = await ctx.trx.selectFrom("payment").select("id").where("membership_id", "=", m.id).where("status", "=", "pending").where("amount_cents", "=", due.cents)
      .where("for_period_no", "=", m.period_no).executeTakeFirst();
    if (open) return { payment_id: open.id };
    const id = uuidv7();
    await ctx.insert("payment", { id, person_id: m.person_id, amount_cents: due.cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", membership_id: m.id,
      for_period_no: m.period_no });
    return { payment_id: id };
  },
});

/** The member hears once that a membership paid at the desk ends soon, and how to keep it. */
export const membershipEndRemind = defineAction({
  name: "membership.end_remind", version: 1, system: true, internal: true,
  input: z.object({ membership_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "membership", i.membership_id, "thing.membership");
    return { title: both("action.membership.end_remind"), summary: both("action.membership.end_remind"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const m = await ctx.trx.selectFrom("membership").select(["status", "source", "price_cents", "current_period_end", "end_reminded_for", "brought_from", "saved_method"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    // Carried over from Playtomic, renewing here: told to add a card before the day, until they have.
    const brought = Boolean(m.brought_from) && m.source === "app" && !m.saved_method;
    if (m.status !== "active" || (!brought && (m.source !== "desk" || m.price_cents == null)) || !m.current_period_end || m.current_period_end <= ctx.now
      || m.end_reminded_for?.getTime() === m.current_period_end.getTime()) return { already: true };
    await ctx.update("membership", i.membership_id, { end_reminded_for: m.current_period_end });
    await ctx.emit(brought ? "membership.brought_ending" : "membership.ending", { membership_id: i.membership_id });
    return null;
  },
});
/** The job: memberships paid at the desk ending within a week, whose member hasn't heard yet. */
export async function remindMembershipEnds(db: Db, now = new Date()): Promise<number> {
  // Read-only: nothing can be paid, so nobody's told to pay.
  if (await isReadOnly(db)) return 0;
  const due = await db.selectFrom("membership").select("id").where("status", "=", "active")
    .where((w) => w.or([w.and([w("source", "=", "desk"), w("price_cents", "is not", null)]), w.and([w("source", "=", "app"), w("brought_from", "is not", null), w("saved_method", "is", null)])]))
    .where("current_period_end", ">", now).where("current_period_end", "<=", new Date(now.getTime() + END_REMINDER_DAYS * 86400_000))
    .where(sql<boolean>`end_reminded_for IS DISTINCT FROM current_period_end`).execute();
  for (const m of due) await runAsSystem(db, "membership.end_remind", { membership_id: m.id }, "jobs", { now });
  return due.length;
}
