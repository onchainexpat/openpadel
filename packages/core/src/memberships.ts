// Memberships: the plans a club offers (by the month or the year) and who holds one. A plan can come with
// member prices on courts (price rules for that plan) and a longer booking window. The desk gives a
// membership (a comp, a founding member, one paid at the counter), with or without an end date; joining and
// paying in the app builds on the same rows. One membership at a time per person.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, onDate } from "./clock.ts";

const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const LIVE = ["active", "past_due"] as const;

/** "$80.00 a month", in each language. */
export function planPrice(cents: number, period: "month" | "year"): Text {
  const f = (lang: Lang) => `${money(cents, lang)} ${lang === "es" ? (period === "month" ? "al mes" : "al año") : (period === "month" ? "a month" : "a year")}`;
  return { en: f("en"), es: f("es") };
}
/** A club date as people say it: "31 December 2026". */
export function dayText(date: string): Text {
  const f = (lang: Lang) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return { en: f("en"), es: f("es") };
}

/** The plan whose benefits a person has at `at`: a live membership that hasn't run out. */
export async function memberPlan(db: Db | Trx, personId: string, at = new Date()) {
  return (await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.id as membership_id", "membership_plan.id as plan_id", "membership_plan.name", "membership_plan.days_ahead"])
    .where("membership.person_id", "=", personId).where("membership.status", "in", LIVE)
    .where((eb) => eb.or([eb("membership.current_period_end", "is", null), eb("membership.current_period_end", ">", at)]))
    .executeTakeFirst()) ?? null;
}

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
    const m = await ctx.trx.selectFrom("membership").select(["status", "current_period_end"]).where("id", "=", i.membership_id).forUpdate().executeTakeFirstOrThrow();
    if (m.status === "ended" || !m.current_period_end || m.current_period_end > ctx.now) return null;
    await ctx.update("membership", i.membership_id, { status: "ended", ended_at: m.current_period_end });
    await ctx.emit("membership.ended", { membership_id: i.membership_id });
    return null;
  },
});

/** The job: end desk memberships whose end date has passed. (Paid ones renew or end with their payments.) */
export async function endLapsedMemberships(db: Db, now = new Date()): Promise<number> {
  const due = await db.selectFrom("membership").select("id").where("status", "in", LIVE).where("provider_ref", "is", null)
    .where("current_period_end", "is not", null).where("current_period_end", "<=", now).execute();
  for (const m of due) await runAsSystem(db, "membership.lapse", { membership_id: m.id }, "job", { now });
  return due.length;
}

/** How many people hold each plan now, for the staff pages. */
export async function planCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.selectFrom("membership").select(["plan_id", sql<string>`count(*)`.as("n")]).where("status", "in", LIVE).groupBy("plan_id").execute();
  return new Map(rows.map((r) => [r.plan_id, Number(r.n)]));
}
