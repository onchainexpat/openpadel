// What a person pays for a program (a clinic, a social, a course): the full price; a member price (the
// program's own member price, or else their plan's discount on programs); or nothing, using one of the
// single sessions their plan includes each membership period. Paused memberships give nothing; one whose
// renewal is late still does (memberPlan). The price and its reason are kept with the place, so a price
// changed later never changes what someone already agreed to pay.
import { sql } from "kysely";
import { both, money, type Key, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { localParts } from "./clock.ts";
import { addPeriod, memberPlan } from "./memberships.ts";

export type PriceBasis = "full" | "member" | "included";
type ProgramLike = { id: string; kind: string; price_cents: number; member_price_cents: number | null };
type PlanLike = { program_percent_off: number | null; program_cents_off: number | null; included_sessions: number | null; included_kinds: string[] };
export interface ProgramPrice {
  cents: number; full: number; basis: PriceBasis;
  /** Using an included session: which one this is (1 of 4), against which membership and period. */
  included: { n: number; of: number; membership_id: string; period_start: Date } | null;
}

/** What a member of this plan pays, before any included session: the program's member price, or the plan's discount. */
export function memberCents(p: Pick<ProgramLike, "price_cents" | "member_price_cents">, plan: Pick<PlanLike, "program_percent_off" | "program_cents_off"> | null): number {
  if (p.member_price_cents !== null) return Math.min(p.member_price_cents, p.price_cents);
  if (plan?.program_percent_off) return Math.round(p.price_cents * (100 - plan.program_percent_off) / 100);
  if (plan?.program_cents_off) return Math.max(0, p.price_cents - plan.program_cents_off);
  return p.price_cents;
}

/** When the membership period holding `at` began: periods run from the day it started, a month or a year at a time. */
export function periodStart(m: { started_at: Date; period: "month" | "year" }, tz: string, at: Date): Date {
  const day = localParts(m.started_at, tz).d;
  let start = m.started_at;
  for (let next = addPeriod(start, m.period, tz, day); next <= at; next = addPeriod(next, m.period, tz, day)) start = next;
  return start;
}

/** Included sessions a person has used in a period: places still held, and ones left too late to give back.
 *  On a family plan each person covered has their own. */
export async function includedUsed(db: Db | Trx, membershipId: string, start: Date, personId: string): Promise<number> {
  const r = await db.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("price_basis", "=", "included")
    .where("included_membership_id", "=", membershipId).where("included_period_start", "=", start).where("person_id", "=", personId)
    .where((eb) => eb.or([eb("status", "in", ["booked", "attended", "no_show"]), eb.and([eb("status", "=", "cancelled"), eb("included_back", "=", false)])])).executeTakeFirstOrThrow();
  return Number(r.n);
}

/** A person's membership as far as programs go: the plan's terms and this period's included sessions. */
export async function programPerks(db: Db | Trx, personId: string, at: Date) {
  const m = await memberPlan(db, personId, at);
  if (!m) return null;
  const row = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.id", "membership.started_at", "membership.period", "membership_plan.period as plan_period", "membership_plan.name", "membership_plan.program_percent_off",
      "membership_plan.program_cents_off", "membership_plan.included_sessions", "membership_plan.included_kinds"]).where("membership.id", "=", m.membership_id).executeTakeFirstOrThrow();
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  const start = row.included_sessions ? periodStart({ started_at: row.started_at, period: row.period ?? row.plan_period }, tz, at) : null;
  return { ...row, membership_id: row.id, period: row.period ?? row.plan_period, period_start: start, used: start ? await includedUsed(db, row.id, start, personId) : 0 };
}
export type ProgramPerks = NonNullable<Awaited<ReturnType<typeof programPerks>>>;

/** Whether a program is a single session (a course of several dates, paid once, isn't). */
async function singleSessions(db: Db | Trx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.selectFrom("session").select(["program_id", sql<string>`count(*)`.as("n")]).where("program_id", "in", ids).where("status", "!=", "cancelled").groupBy("program_id").execute();
  const many = new Set(rows.filter((r) => Number(r.n) > 1).map((r) => r.program_id));
  return new Set(ids.filter((id) => !many.has(id)));
}

/** The price for one person, given their perks (null: not a member now). `included` false: never use an
 *  included session (a waitlist place, which only takes one when it becomes a real place). */
export function priceFor(p: ProgramLike, perks: ProgramPerks | null, single: boolean, o: { included: boolean; usedExtra?: number } = { included: true }): ProgramPrice {
  const full = p.price_cents;
  const none: ProgramPrice = { cents: full, full, basis: "full", included: null };
  if (!perks || full <= 0) return none;
  const member = memberCents(p, perks);
  const used = perks.used + (o.usedExtra ?? 0);
  if (o.included && member > 0 && single && perks.included_sessions && perks.period_start && p.kind !== "course" && perks.included_kinds.includes(p.kind) && used < perks.included_sessions)
    return { cents: 0, full, basis: "included", included: { n: used + 1, of: perks.included_sessions, membership_id: perks.membership_id, period_start: perks.period_start } };
  return member < full ? { cents: member, full, basis: "member", included: null } : none;
}

/** The price one person pays for one program, now. */
export async function programPrice(db: Db | Trx, programId: string, personId: string, at: Date, o: { included: boolean } = { included: true }): Promise<ProgramPrice> {
  const p = await db.selectFrom("program").select(["id", "kind", "price_cents", "member_price_cents"]).where("id", "=", programId).executeTakeFirstOrThrow();
  return priceFor(p, await programPerks(db, personId, at), (await singleSessions(db, [p.id])).has(p.id), o);
}

/** Prices for a list of programs, for one person, in one go (the What's On page). */
export async function programPrices(db: Db | Trx, programs: ProgramLike[], personId: string, at: Date): Promise<Map<string, ProgramPrice>> {
  const perks = await programPerks(db, personId, at), single = await singleSessions(db, programs.map((p) => p.id));
  return new Map(programs.map((p) => [p.id, priceFor(p, perks, single.has(p.id))]));
}

/** What members pay, shown to someone who isn't one: the program's member price, or the best discount among
 *  the plans offered in the app. Null when members pay the same. */
export async function membersFrom(db: Db | Trx, programs: Pick<ProgramLike, "id" | "price_cents" | "member_price_cents">[]): Promise<Map<string, number | null>> {
  const plans = await db.selectFrom("membership_plan").select(["program_percent_off", "program_cents_off"]).where("active", "=", true).where("join_in_app", "=", true).execute();
  return new Map(programs.map((p) => {
    const best = Math.min(memberCents(p, null), ...plans.map((plan) => memberCents(p, plan)));
    return [p.id, best < p.price_cents ? best : null];
  }));
}

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
/** The price as a plan says it: " for $20.00", " for $15.00 (member price)", or an included session. */
export function priceWords(pr: ProgramPrice): Text {
  if (pr.basis === "included") return both("price.included", { n: pr.included!.n, of: pr.included!.of });
  if (pr.cents <= 0) return both("price.free");
  return both((pr.basis === "member" ? "price.member" : "price.amount") as Key, { amount: usd(pr.cents) });
}
