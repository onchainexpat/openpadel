// One meter per club month (hosted.md item 9): what the club's paid outside services cost, in cents, against one
// monthly cap the owner sets. AI (the decisions ask the club makes, and drafts of the club's words in its other
// language), texts and email each count in the club's month, at the prices in the server's settings (KUMI_PRICES):
// a hosted club is billed from it, and a club on its own keys sees what its providers will charge.
//
// At 80% of the cap and at the cap the owner and managers hear once each. Past the cap, plus any amount the owner
// allows over it for a busy month (the limit), what can wait waits for the 1st: drafts stop and the staff write
// the words themselves, club news emails wait, and texts that can wait go in the app and by email instead.
// Decisions (a fact sent word for word, or the question to the staff), sign-in codes, booking confirmations and
// cancellations keep going, up to twice the limit, so a bill can pass the cap by cents but never run away.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import { atLocal, localDate } from "./clock.ts";
import type { Db, Trx } from "./db.ts";
import { uuidv7 } from "./ids.ts";

export type UsageKind = "ai_decisions" | "ai_drafts" | "texts" | "email";
export const USAGE_KINDS: UsageKind[] = ["ai_decisions", "ai_drafts", "texts", "email"];
/** What can wait for next month (texts that can go another way, drafts, club news), and what can't. */
export type UsageNeed = "can_wait" | "essential";

/** What each thing costs, in cents; AI per million tokens. */
export interface Prices { text_segment: number; email: number; jev_input: number; jev_output: number; haiku_input: number; haiku_output: number }
/** List prices in late 2026: a Twilio US text segment with the carrier fee; a Resend email past the plan; TypeSafe's
 *  Jev (output free); Claude Haiku 5.5 for prompts up to 100,000 tokens. */
export const DEFAULT_PRICES: Prices = { text_segment: 1.26, email: 0.09, jev_input: 4.2, jev_output: 0, haiku_input: 10, haiku_output: 50 };
/** KUMI_PRICES, like "text_segment=0.83,email=0": any price left out keeps its default. */
export function parsePrices(s: string | undefined): Prices {
  const p: Prices = { ...DEFAULT_PRICES };
  for (const part of (s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split("=").map((x) => x.trim()) as [string, string | undefined];
    if (!(k in p)) throw new Error(`KUMI_PRICES: "${k}" isn't a price (${Object.keys(p).join(", ")})`);
    const n = Number(v);
    if (v === undefined || v === "" || !Number.isFinite(n) || n < 0 || n > 100_000) throw new Error(`KUMI_PRICES: ${k} should be a number of cents, like ${k}=${p[k as keyof Prices]}`);
    p[k as keyof Prices] = n;
  }
  return p;
}
let prices: Prices = DEFAULT_PRICES;
export function setPrices(p: Prices): void { prices = p; }
export const currentPrices = (): Prices => prices;
/** One call to a model, in cents. */
export const aiCents = (model: "jev" | "haiku", input: number, output: number) =>
  (input * prices[`${model}_input`] + output * prices[`${model}_output`]) / 1_000_000;

/** The share of the cap that brings the first message. */
export const NEAR_SHARE = 0.8;
/** What can't wait keeps going up to this many times the limit, and at least ESSENTIAL_FLOOR cents. */
export const ESSENTIAL_CEILING = 2, ESSENTIAL_FLOOR = 200;

/** The first day of the club's month at an instant ("2026-11-01"). */
export const monthOf = (now: Date, tz: string) => `${localDate(now, tz).slice(0, 7)}-01`;
/** When the club's next month starts. */
export function nextMonthStart(month: string, tz: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return atLocal(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, 0, tz);
}

type Cap = { tz: string; cap: number; over: number };
async function capOf(db: Db | Trx): Promise<Cap | null> {
  const c = await db.selectFrom("club").select(["time_zone", "usage_cap_cents", "usage_over_cents"]).executeTakeFirst();
  return c ? { tz: c.time_zone, cap: c.usage_cap_cents, over: c.usage_over_cents } : null;
}
const limitOf = (c: { cap: number; over: number }) => c.cap + c.over;
const ceilingOf = (c: { cap: number; over: number }) => Math.max(limitOf(c) * ESSENTIAL_CEILING, ESSENTIAL_FLOOR);
async function spentIn(db: Db | Trx, month: string): Promise<number> {
  const r = await db.selectFrom("usage_month").select(sql<string>`coalesce(sum(cents), 0)`.as("cents")).where("month", "=", month).executeTakeFirst();
  return Number(r?.cents ?? 0);
}

/** Whether something costing this many cents may go now. What can wait stops at the limit (and the owner and
 *  managers hear, once); what can't goes on to the ceiling. */
export async function usageAllows(db: Db, need: UsageNeed, cents: number, now = new Date()): Promise<boolean> {
  const c = await capOf(db);
  if (!c) return true;
  const month = monthOf(now, c.tz), spent = await spentIn(db, month);
  if (spent + cents <= (need === "essential" ? ceilingOf(c) : limitOf(c))) return true;
  if (need === "can_wait") await sayAlerts(db, month, c, spent, now);
  return false;
}

/** Something the club's paid outside services did: counted in its club month, and the owner and managers told
 *  when it brings the month to 80% of the cap, to the cap, or past what's allowed over it. */
export async function countUsage(db: Db, kind: UsageKind, add: { count?: number; input_tokens?: number; output_tokens?: number; segments?: number; cents: number }, now = new Date()): Promise<void> {
  const c = await capOf(db);
  if (!c) return;
  const month = monthOf(now, c.tz), v = { count: add.count ?? 1, input_tokens: add.input_tokens ?? 0, output_tokens: add.output_tokens ?? 0, segments: add.segments ?? 0, cents: add.cents };
  await sql`INSERT INTO usage_month (month, kind, count, input_tokens, output_tokens, segments, cents, updated_at)
    VALUES (${month}::date, ${kind}, ${v.count}, ${v.input_tokens}, ${v.output_tokens}, ${v.segments}, ${v.cents}, ${now})
    ON CONFLICT (month, kind) DO UPDATE SET count = usage_month.count + excluded.count, input_tokens = usage_month.input_tokens + excluded.input_tokens,
      output_tokens = usage_month.output_tokens + excluded.output_tokens, segments = usage_month.segments + excluded.segments,
      cents = usage_month.cents + excluded.cents, updated_at = excluded.updated_at`.execute(db);
  await sayAlerts(db, month, c, await spentIn(db, month), now);
}
/** A call to a model that answered, at its price per token. */
export function countAi(db: Db, kind: "ai_decisions" | "ai_drafts", model: "jev" | "haiku", tokens: { input: number; output: number }, now = new Date()): Promise<void> {
  return countUsage(db, kind, { input_tokens: tokens.input, output_tokens: tokens.output, cents: aiCents(model, tokens.input, tokens.output) }, now);
}
/** An email the provider took. */
export const countEmail = (db: Db, now = new Date()) => countUsage(db, "email", { cents: prices.email }, now);

/** Which message is due: the highest level reached that hasn't been said for this cap (or limit) this month.
 *  Saying one counts as saying the ones below it. With nothing allowed over the cap, the cap pauses at once. */
async function sayAlerts(db: Db, month: string, c: Cap, spent: number, now: Date) {
  const level = c.over > 0 && spent >= limitOf(c) ? "paused" : spent >= c.cap ? (c.over > 0 ? "over" : "reached") : spent >= c.cap * NEAR_SHARE ? "near" : null;
  if (!level) return;
  await db.insertInto("usage_alert").values({ month, near_cap: null, reached_cap: null, paused_limit: null }).onConflict((oc) => oc.column("month").doNothing()).execute();
  const set = level === "near" ? { near_cap: c.cap } : level === "paused" ? { near_cap: c.cap, reached_cap: c.cap, paused_limit: limitOf(c) } : { near_cap: c.cap, reached_cap: c.cap };
  const col = level === "near" ? "near_cap" : level === "paused" ? "paused_limit" : "reached_cap", value = level === "paused" ? limitOf(c) : c.cap;
  const r = await db.updateTable("usage_alert").set(set).where("month", "=", month).where((eb) => eb.or([eb(col, "is", null), eb(col, "!=", value)])).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) return;
  await runAsSystem(db, "club.usage_alert", { level, spent_cents: Math.round(spent), cap_cents: c.cap, over_cents: c.over, month }, "usage", { now });
}

type Line = { count: number; input_tokens: number; output_tokens: number; segments: number; cents: number };
const empty = (): Line => ({ count: 0, input_tokens: 0, output_tokens: 0, segments: 0, cents: 0 });
async function monthsOf(db: Db | Trx, months?: string[]) {
  const rows = await db.selectFrom("usage_month").select(["month", "kind", "count", "input_tokens", "output_tokens", "segments", "cents"])
    .$if(Boolean(months), (q) => q.where("month", "in", months!)).orderBy("month", "desc").execute();
  const by = new Map<string, Record<UsageKind, Line>>();
  for (const r of rows) {
    const m = String(r.month).slice(0, 10);
    if (!by.has(m)) by.set(m, Object.fromEntries(USAGE_KINDS.map((k) => [k, empty()])) as Record<UsageKind, Line>);
    by.get(m)![r.kind] = { count: r.count, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), segments: r.segments, cents: Number(r.cents) };
  }
  return by;
}
const total = (kinds: Record<UsageKind, Line>) => USAGE_KINDS.reduce((n, k) => n + kinds[k].cents, 0);
const cents4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Restores that couldn't carry the meter over (after_restore.ts) and touch this club month: what was spent between
 *  the copy's last count and the restore isn't counted, so the month may be short. */
export async function usageGaps(db: Db | Trx, month: string, tz: string): Promise<Array<{ restored_at: Date; counted_until: Date | null }>> {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return db.selectFrom("usage_gap").select(["restored_at", "counted_until"])
    .where("restored_at", ">=", atLocal(y, m, 1, 0, tz)).where(sql<Date>`coalesce(counted_until, restored_at)`, "<", nextMonthStart(month, tz))
    .orderBy("restored_at").execute();
}

/** One month's lines by kind, in cents to four places, for the host's bill (`kumi usage`); gaps, when a restore left
 *  part of the month uncounted. */
export async function usageMonth(db: Db | Trx, month: string) {
  const c = await capOf(db);
  const kinds = (await monthsOf(db, [month])).get(month) ?? Object.fromEntries(USAGE_KINDS.map((k) => [k, empty()])) as Record<UsageKind, Line>;
  const gaps = c ? (await usageGaps(db, month, c.tz)).map((g) => ({ restored_at: g.restored_at.toISOString(), counted_until: g.counted_until?.toISOString() ?? null })) : [];
  return { month, time_zone: c?.tz ?? null, cap_cents: c?.cap ?? null, over_cents: c?.over ?? null, total_cents: cents4(total(kinds)),
    kinds: Object.fromEntries(USAGE_KINDS.map((k) => [k, { ...kinds[k], cents: cents4(kinds[k].cents) }])) as Record<UsageKind, Line>, gaps };
}

/** This month by kind against the cap, and the twelve months before it, newest first (the Usage page). */
export async function usageView(db: Db | Trx, now = new Date()) {
  const c = await capOf(db);
  if (!c) return null;
  const month = monthOf(now, c.tz), by = await monthsOf(db);
  const kinds = by.get(month) ?? Object.fromEntries(USAGE_KINDS.map((k) => [k, empty()])) as Record<UsageKind, Line>;
  const spent = total(kinds), limit = limitOf(c);
  const state = spent >= limit ? "paused" : spent >= c.cap ? "over" : spent >= c.cap * NEAR_SHARE ? "near" : "ok";
  return { month, cap_cents: c.cap, over_cents: c.over, limit_cents: limit, ceiling_cents: ceilingOf(c), spent_cents: Math.round(spent), share: c.cap ? spent / c.cap : null,
    state, resets: nextMonthStart(month, c.tz).toISOString(), prices,
    kinds: Object.fromEntries(USAGE_KINDS.map((k) => [k, { ...kinds[k], cents: Math.round(kinds[k].cents) }])) as Record<UsageKind, Line>,
    history: [...by.entries()].filter(([m]) => m < month).slice(0, 12).map(([m, k]) => ({ month: m, cents: Math.round(total(k)),
      kinds: Object.fromEntries(USAGE_KINDS.map((x) => [x, Math.round(k[x].cents)])) as Record<UsageKind, number> })) };
}

// The meter counts in US dollars, as the services bill them (usage.ts prices), whatever the club's own currency.
const usd = (cents: number): Text => ({ en: money(cents, "en", "USD"), es: money(cents, "es", "USD") });

/** The 80%, cap, over and paused messages, as an event the messages turn into words (system only). */
export const usageAlert = defineAction({
  name: "club.usage_alert", version: 1, system: true, internal: true,
  input: z.object({ level: z.enum(["near", "reached", "over", "paused"]), spent_cents: z.number().check(z.int(), z.minimum(0)), cap_cents: z.number().check(z.int(), z.minimum(0)),
    over_cents: z.number().check(z.int(), z.minimum(0)), month: z.string().check(z.regex(/^\d{4}-\d{2}-01$/)) }),
  async plan(_ctx, i) {
    return { title: both("action.club.usage_alert"), summary: both(`plan.club.usage_${i.level}`, { spent: usd(i.spent_cents), cap: usd(i.cap_cents) }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.emit("usage.cap", i); return null; },
});

/** The monthly cap, and what's allowed over it in a busy month, in cents. The owner's (a manager can ask), with a
 *  passkey from anyone who has one: it's the club's money. Raised above what's used this month, what can wait goes
 *  again straight away, and the "paused" alert on Today needs nobody (closed with no one's name). */
export const usageCapSet = defineAction({
  name: "club.usage_cap_set", version: 1, strongAuth: true,
  input: z.object({
    cap_cents: z.number().check(z.int(), z.minimum(0), z.maximum(10_000_000), z.describe("What the club may spend a month on AI, texts and email, in cents ($50 is 5000).")),
    over_cents: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(10_000_000), z.describe("How much more is allowed in a busy month before what can wait pauses, in cents. 0: none."))),
  }),
  async plan(ctx, i) {
    const c = (await capOf(ctx.db))!, over = i.over_cents ?? c.over, month = monthOf(ctx.now, c.tz), spent = await spentIn(ctx.db, month);
    const params = { cap: usd(i.cap_cents), over: usd(over), spent: usd(Math.round(spent)) };
    const key = spent >= i.cap_cents + over ? "plan.club.usage_cap_set_paused" : over > 0 ? "plan.club.usage_cap_set_over" : "plan.club.usage_cap_set";
    return { title: both("action.club.usage_cap_set"), summary: both(key, params), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const c = (await capOf(ctx.trx))!;
    await ctx.update("club", "singleton", { usage_cap_cents: i.cap_cents, ...(i.over_cents !== undefined ? { usage_over_cents: i.over_cents } : {}) });
    const month = monthOf(ctx.now, c.tz);
    if (i.cap_cents + (i.over_cents ?? c.over) > await spentIn(ctx.trx, month)) {
      // The "paused" alerts this month need nobody now.
      const open = await ctx.trx.selectFrom("event_outbox").select(["event_outbox.id", sql<string>`event_outbox.payload->>'level'`.as("level")])
        .where("event_outbox.topic", "=", "usage.cap").where(sql<string>`event_outbox.payload->>'month'`, "=", month).where(sql<string>`event_outbox.payload->>'level'`, "in", ["reached", "paused"])
        .where((eb) => eb.not(eb.exists(eb.selectFrom("staff_alert").select("staff_alert.id").whereRef("staff_alert.event_id", "=", "event_outbox.id"))))
        .execute();
      for (const e of open) await ctx.insert("staff_alert", { id: uuidv7(), event_id: e.id, kind: e.level === "paused" ? "usage_paused_staff" : "usage_reached_staff", handled_by: null, handled_at: ctx.now });
    }
    return null;
  },
});
