// What a court booking costs, and the rules for booking. A quote prices each half hour by the highest-priority
// rule covering it (in the location's time: its weekday, time of day and season; a member price only for
// members of its plans), adds the club's tax, and is stored with the booking: the price shown is the price
// paid. The booking rules come in versions, and a booking keeps the version it was made under.
import * as z from "zod/mini";
import { both, money, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts } from "./clock.ts";
import { memberPlan } from "./memberships.ts";

const clockTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/));
const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const HALF = 30 * 60_000;

export interface QuoteLine { rule_id: string | null; name: string; from: string; to: string; cents_per_hour: number; cents: number }
/** `member`: the plan whose member price some part of it got. */
export interface Quote { lines: QuoteLine[]; subtotal_cents: number; tax_bp: number; tax_cents: number; total_cents: number; priced: boolean; member: string | null }

/** The price of a court from `start` for `minutes`, for `personId` (their membership at `at`) or for anyone.
 *  `priced` is false when some half hour has no rule. */
export async function quote(db: Db | Trx, i: { courtId: string; start: Date; minutes: number; personId?: string | null; at?: Date }): Promise<Quote> {
  const court = await db.selectFrom("court").innerJoin("location", "location.id", "court.location_id").select(["court.id", "court.location_id", "location.time_zone"])
    .where("court.id", "=", i.courtId).executeTakeFirst();
  if (!court) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
  const member = i.personId ? await memberPlan(db, i.personId, i.at) : null;
  // Where priorities tie, a member price beats the price for everyone.
  const rules = (await db.selectFrom("price_rule").selectAll().where("location_id", "=", court.location_id).where("active", "=", true).orderBy("priority", "desc").orderBy("id", "desc").execute())
    .filter((r) => !r.plan_ids || (member && r.plan_ids.includes(member.plan_id)))
    .sort((a, b) => b.priority - a.priority || Number(Boolean(b.plan_ids)) - Number(Boolean(a.plan_ids)));
  const club = await db.selectFrom("club").select("tax_rate_bp").executeTakeFirstOrThrow();
  const lines: QuoteLine[] = [];
  for (let s = i.start.getTime(); s < i.start.getTime() + i.minutes * 60_000; s += HALF) {
    const p = localParts(new Date(s), court.time_zone), day = localDate(new Date(s), court.time_zone);
    const hhmm = `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
    const rule = rules.find((r) => (!r.court_ids || r.court_ids.includes(court.id)) && (!r.weekdays || r.weekdays.includes(p.weekday))
      && (!r.starts || (hhmm >= r.starts.slice(0, 5) && hhmm < (r.ends!.slice(0, 5) === "24:00" ? "24:00" : r.ends!.slice(0, 5))))
      && (!r.valid_from || day >= r.valid_from) && (!r.valid_to || day <= r.valid_to));
    const last = lines.at(-1), to = new Date(s + HALF).toISOString();
    if (last && last.rule_id === (rule?.id ?? null)) { last.to = to; continue; }
    lines.push({ rule_id: rule?.id ?? null, name: rule?.name ?? "", from: new Date(s).toISOString(), to, cents_per_hour: rule?.cents_per_hour ?? 0, cents: 0 });
  }
  for (const l of lines) l.cents = Math.round(l.cents_per_hour * (new Date(l.to).getTime() - new Date(l.from).getTime()) / 3600_000);
  const subtotal = lines.reduce((n, l) => n + l.cents, 0), tax = Math.round(subtotal * club.tax_rate_bp / 10_000);
  const memberRule = lines.some((l) => rules.find((r) => r.id === l.rule_id)?.plan_ids);
  return { lines, subtotal_cents: subtotal, tax_bp: club.tax_rate_bp, tax_cents: tax, total_cents: subtotal + tax, priced: lines.every((l) => l.rule_id), member: memberRule ? member!.name : null };
}

/** The booking rules in force: the newest active version. */
export async function currentPolicy(db: Db | Trx) {
  return db.selectFrom("booking_policy").selectAll().where("active", "=", true).orderBy("version_no", "desc").limit(1).executeTakeFirstOrThrow();
}

// ---- Price rules ----
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
function dayNames(days: number[] | null | undefined, lang: Lang): string {
  if (!days?.length || days.length === 7) return lang === "es" ? "todos los días" : "every day";
  const f = (w: number) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(f).join(", ");
}
/** "every day 17:00 to 22:00, 2026-06-01 to 2026-08-31", in each language. */
function ruleWhen(r: { weekdays?: number[] | null; starts?: string | null; ends?: string | null; valid_from?: string | null; valid_to?: string | null }): Text {
  const part = (lang: Lang) => [dayNames(r.weekdays, lang), r.starts ? `${r.starts.slice(0, 5)} ${lang === "es" ? "a" : "to"} ${r.ends!.slice(0, 5)}` : "",
    r.valid_from || r.valid_to ? `${r.valid_from ?? "…"} ${lang === "es" ? "a" : "to"} ${r.valid_to ?? "…"}` : ""].filter(Boolean).join(", ");
  return { en: part("en"), es: part("es") };
}

/** "Monthly or Annual", in each language. */
function orList(names: string[]): Text {
  const f = (lang: Lang) => new Intl.ListFormat(lang === "es" ? "es" : "en", { type: "disjunction" }).format(names);
  return { en: f("en"), es: f("es") };
}

const ruleInput = {
  location_id: z.uuid(), name: z.string().check(z.minLength(1), z.maxLength(60)), court_ids: z.optional(z.nullable(z.array(z.uuid()))),
  weekdays: z.optional(z.nullable(z.array(z.number().check(z.int(), z.minimum(0), z.maximum(6))))), starts: z.optional(z.nullable(clockTime)), ends: z.optional(z.nullable(clockTime)),
  valid_from: z.optional(z.nullable(clubDate)), valid_to: z.optional(z.nullable(clubDate)), cents_per_hour: z.number().check(z.int(), z.minimum(0)), priority: z.optional(z.number().check(z.int())),
  plan_ids: z.optional(z.nullable(z.array(z.uuid()))),   // a member price: only for these membership plans
};
export const priceRuleSet = defineAction({
  name: "price.rule_set", version: 1,
  input: z.object({ rule_id: z.optional(z.uuid()), ...ruleInput }),
  async plan(ctx, i) {
    const { row: loc } = await readRow(ctx.db, "location", i.location_id, "thing.location");
    if (Boolean(i.starts) !== Boolean(i.ends) || (i.starts && i.ends! <= i.starts)) throw new KumiError("error.bad_hours");
    const reads = i.rule_id ? [(await readRow(ctx.db, "price_rule", i.rule_id, "thing.price_rule")).read] : [];
    const plans = i.plan_ids?.length ? await ctx.db.selectFrom("membership_plan").select("name").where("id", "in", i.plan_ids).orderBy("sort").orderBy("name").execute() : [];
    if (plans.length !== (i.plan_ids?.length ?? 0)) throw new KumiError("error.not_found", { thing: both("thing.membership_plan") }, 404);
    const p = { name: i.name, location: loc.name, amount: usd(i.cents_per_hour), when: ruleWhen(i), plans: orList(plans.map((x) => x.name)) };
    return { title: both("action.price.rule_set"), summary: both(plans.length ? "plan.price.rule_set_members" : "plan.price.rule_set", p), reads, locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { rule_id, ...r } = i;
    const row = { ...r, court_ids: r.court_ids?.length ? r.court_ids : null, weekdays: r.weekdays?.length && r.weekdays.length < 7 ? r.weekdays : null,
      starts: r.starts ?? null, ends: r.ends ?? null, valid_from: r.valid_from ?? null, valid_to: r.valid_to ?? null, priority: r.priority ?? 0, plan_ids: r.plan_ids?.length ? r.plan_ids : null };
    if (rule_id) { await ctx.update("price_rule", rule_id, row); return { rule_id }; }
    const id = uuidv7();
    await ctx.insert("price_rule", { id, ...row });
    return { rule_id: id };
  },
});

export const priceRuleRemove = defineAction({
  name: "price.rule_remove", version: 1,
  input: z.object({ rule_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "price_rule", i.rule_id, "thing.price_rule");
    return { title: both("action.price.rule_remove"), summary: both("plan.price.rule_remove", { name: row.name }), reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("price_rule", i.rule_id, { active: false }); return null; },
});

// ---- Booking rules ----
export const policySet = defineAction({
  name: "policy.set", version: 1,
  input: z.object({
    days_ahead: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(365))), max_active: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
    free_cancel_hours: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(720))), late_refund_percent: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(100))),
    split_deadline_hours: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(168))),
    lengths: z.optional(z.array(z.number().check(z.int(), z.minimum(30), z.maximum(480))).check(z.minLength(1))),
  }),
  async plan(ctx, i) {
    const cur = await currentPolicy(ctx.db), next = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) } as typeof cur;
    if (next.lengths.some((m) => m % 30)) throw new KumiError("error.bad_length");
    return { title: both("action.policy.set"), reads: [], undo: { kind: "reversible" },
      summary: both("plan.policy.set", { version: cur.version_no + 1, days: next.days_ahead, max: next.max_active, hours: next.free_cancel_hours, percent: next.late_refund_percent,
        split: next.split_deadline_hours, lengths: [...next.lengths].sort((a, b) => a - b).join(", ") }) };
  },
  async apply(ctx, i) {
    const cur = await currentPolicy(ctx.trx);
    const id = uuidv7(), { id: _, version_no, created_at, active, version, ...keep } = cur;
    await ctx.insert("booking_policy", { ...keep, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)), id, version_no: version_no + 1 });
    return { policy_id: id, version: version_no + 1 };
  },
});
