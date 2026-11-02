// Texts counted per club month, in carrier segments (what Twilio bills), against the monthly cap the club sets.
// At 80% the owner and managers hear once, and once more at the cap. Past it, texts that can wait for another
// channel aren't sent: the message stays in the app's inbox and goes by email where the person has one. Codes
// (signing in, confirming a number) and the HELP and START answers carriers require keep going up to twice the
// cap, so nobody is locked out. A new month starts fresh, and raising the cap lets texts go again at once.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import { atLocal, localDate } from "./clock.ts";
import type { Db, Trx } from "./db.ts";
import { uuidv7 } from "./ids.ts";

/** The share of the cap that brings the first message. */
export const NEAR_SHARE = 0.8;
/** Codes and required answers keep going up to this many times the cap, and at least CODE_FLOOR segments. */
export const CODE_CEILING = 2, CODE_FLOOR = 100;
/** Months kept, this one included. */
export const HISTORY_MONTHS = 12;
/** A message that can wait for another channel, or a code (and HELP and START answers) that can't. */
export type TextUse = "message" | "code";

type Limits = { tz: string; cap: number; cost: number };
async function limits(db: Db | Trx): Promise<Limits | null> {
  const c = await db.selectFrom("club").select(["time_zone", "text_cap_segments", "text_segment_cost"]).executeTakeFirst();
  return c ? { tz: c.time_zone, cap: c.text_cap_segments, cost: Number(c.text_segment_cost) } : null;
}
/** The first day of the club's month at an instant ("2026-11-01"). */
export const monthOf = (now: Date, tz: string) => `${localDate(now, tz).slice(0, 7)}-01`;
/** When the club's next month starts. */
export function nextMonthStart(month: string, tz: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return atLocal(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, 0, tz);
}
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const ceiling = (cap: number) => Math.max(cap * CODE_CEILING, CODE_FLOOR);
const usedIn = async (db: Db | Trx, month: string) => (await db.selectFrom("text_usage").select("segments").where("month", "=", month).executeTakeFirst())?.segments ?? 0;

/** Whether a text of this many segments may go now. A message refused at the cap tells the owner and managers
 *  (once for this cap this month). */
export async function textAllowed(db: Db, use: TextUse, segs: number, now = new Date()): Promise<{ ok: true } | { ok: false; used: number; cap: number }> {
  const c = await limits(db);
  if (!c) return { ok: true };
  const month = monthOf(now, c.tz), used = await usedIn(db, month);
  if (used + segs <= (use === "code" ? ceiling(c.cap) : c.cap)) return { ok: true };
  if (use === "message") { await ensureMonth(db, month); await tell(db, month, "reached", c, used, now); }
  return { ok: false, used, cap: c.cap };
}

/** A new month's row, and the oldest one past the history dropped. */
async function ensureMonth(db: Db, month: string) {
  const r = await db.insertInto("text_usage").values({ month, near_cap: null, reached_cap: null }).onConflict((oc) => oc.column("month").doNothing()).executeTakeFirst();
  if (Number(r.numInsertedOrUpdatedRows ?? 0)) await sql`DELETE FROM text_usage WHERE month <= ${month}::date - make_interval(months => ${HISTORY_MONTHS})`.execute(db);
}

/** A text Twilio took: counted in its month, and the owner and managers told when it brings the month to 80%
 *  of the cap, or to the cap. */
export async function countText(db: Db, use: TextUse, segs: number, now = new Date()): Promise<void> {
  const c = await limits(db);
  if (!c) return;
  const month = monthOf(now, c.tz), code = use === "code" ? 1 : 0;
  await ensureMonth(db, month);
  const r = await db.updateTable("text_usage").set((eb) => ({ texts: eb("texts", "+", 1), segments: eb("segments", "+", segs), code_texts: eb("code_texts", "+", code),
    code_segments: eb("code_segments", "+", code * segs), updated_at: now })).where("month", "=", month).returning("segments").executeTakeFirstOrThrow();
  if (r.segments >= c.cap && c.cap > 0) await tell(db, month, "reached", c, r.segments, now);
  else if (r.segments >= c.cap * NEAR_SHARE && c.cap > 0) await tell(db, month, "near", c, r.segments, now);
}

/** A text the cap kept back (the person gets the message in the app, and by email where they have one). */
export async function countHeld(db: Db, now = new Date()): Promise<void> {
  const c = await limits(db);
  if (!c) return;
  const month = monthOf(now, c.tz);
  await ensureMonth(db, month);
  await db.updateTable("text_usage").set((eb) => ({ held: eb("held", "+", 1), updated_at: now })).where("month", "=", month).execute();
}

/** Twilio's price for a text it sent ("-0.00790", in dollars), counted once in the month it went. */
export async function textPrice(db: Db, ref: string, price: string | null | undefined, now = new Date()): Promise<void> {
  const dollars = Number(price);
  if (price == null || price === "" || !Number.isFinite(dollars)) return;
  const cents = Math.round(Math.abs(dollars) * 100_000) / 1000;
  const m = await db.updateTable("outbound_message").set({ cost_cents: String(cents) }).where("provider_ref", "=", ref).where("channel", "=", "sms").where("cost_cents", "is", null)
    .returning(["sent_at", "created_at"]).executeTakeFirst();
  const c = m && await limits(db);
  if (!m || !c) return;
  const month = monthOf(m.sent_at ?? m.created_at ?? now, c.tz);
  await ensureMonth(db, month);
  await db.updateTable("text_usage").set((eb) => ({ priced: eb("priced", "+", 1), actual_cents: sql`actual_cents + ${cents}`, updated_at: now })).where("month", "=", month).execute();
}

/** The owner and managers hear once per cap per month: at 80%, and at the cap (which counts as the 80% one too). */
async function tell(db: Db, month: string, level: "near" | "reached", c: Limits, used: number, now: Date) {
  const col = level === "near" ? "near_cap" : "reached_cap";
  const r = await db.updateTable("text_usage").set(level === "reached" ? { reached_cap: c.cap, near_cap: c.cap } : { near_cap: c.cap }).where("month", "=", month)
    .where((eb) => eb.or([eb(col, "is", null), eb(col, "!=", c.cap)])).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) return;
  await runAsSystem(db, "texts.usage_alert", { level, used, cap: c.cap, month }, "texts", { now });
}

/** This month and the ones before it, newest first, with the estimate at the club's price per segment. */
export async function textUsage(db: Db, now = new Date()) {
  const c = await limits(db);
  if (!c) return null;
  const month = monthOf(now, c.tz);
  const rows = await db.selectFrom("text_usage").selectAll().orderBy("month", "desc").limit(HISTORY_MONTHS).execute();
  const view = (r: (typeof rows)[number]) => ({ month: String(r.month).slice(0, 10), texts: r.texts, segments: r.segments, code_texts: r.code_texts, code_segments: r.code_segments,
    held: r.held, estimate_cents: Math.round(r.segments * c.cost), priced: r.priced, actual_cents: Math.round(Number(r.actual_cents)) });
  const empty = { month, texts: 0, segments: 0, code_texts: 0, code_segments: 0, held: 0, estimate_cents: 0, priced: 0, actual_cents: 0 };
  const now_ = rows.find((r) => String(r.month).slice(0, 10) === month);
  const current = now_ ? view(now_) : empty;
  return { cap: c.cap, cents_per_segment: c.cost, code_ceiling: ceiling(c.cap), share: c.cap ? current.segments / c.cap : null, paused: current.segments >= c.cap,
    resets: nextMonthStart(month, c.tz).toISOString(), current, history: rows.filter((r) => String(r.month).slice(0, 10) !== month).map(view) };
}

/** The 80% or 100% message, as an event the messages turn into words (system only). */
export const textsUsageAlert = defineAction({
  name: "texts.usage_alert", version: 1, system: true, internal: true,
  input: z.object({ level: z.enum(["near", "reached"]), used: z.number().check(z.int(), z.minimum(0)), cap: z.number().check(z.int(), z.minimum(0)), month: z.string().check(z.regex(/^\d{4}-\d{2}-01$/)) }),
  async plan(_ctx, i) {
    return { title: both("action.texts.usage_alert"), summary: both(i.level === "near" ? "plan.texts.usage_near" : "plan.texts.usage_reached", { used: i.used, cap: i.cap }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.emit("texts.usage", i); return null; },
});

/** The monthly cap, in segments, and the price per segment the estimate uses (cents). Owners and managers set
 *  it at once. Raised above what's used this month, texts go again straight away, and the "cap reached" alert on
 *  Today needs nobody (closed with no one's name). */
export const textsCapSet = defineAction({
  name: "texts.cap_set", version: 1,
  input: z.object({
    cap_segments: z.number().check(z.int(), z.minimum(0), z.maximum(1_000_000), z.describe("Text segments the club may send a month (one plain text of up to 160 characters is one segment).")),
    cents_per_segment: z.optional(z.number().check(z.minimum(0), z.maximum(100), z.describe("What one segment costs the club, in cents, for the estimate (Twilio US: about 1.26)."))),
  }),
  async plan(ctx, i) {
    const c = (await limits(ctx.db))!;
    const cost = i.cents_per_segment ?? c.cost, used = await usedIn(ctx.db, monthOf(ctx.now, c.tz));
    const about = usd(Math.round(i.cap_segments * cost));
    const key = i.cap_segments <= used ? "plan.texts.cap_set_paused" : "plan.texts.cap_set";
    return { title: both("action.texts.cap_set"), summary: both(key, { cap: i.cap_segments, money: about, used }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const c = (await limits(ctx.trx))!;
    await ctx.update("club", "singleton", { text_cap_segments: i.cap_segments, ...(i.cents_per_segment !== undefined ? { text_segment_cost: String(Math.round(i.cents_per_segment * 1000) / 1000) } : {}) });
    const month = monthOf(ctx.now, c.tz);
    if (i.cap_segments > await usedIn(ctx.trx, month)) {
      // The "cap reached" alert this month needs nobody now.
      const open = await ctx.trx.selectFrom("event_outbox").select("event_outbox.id").where("event_outbox.topic", "=", "texts.usage")
        .where(sql<string>`event_outbox.payload->>'level'`, "=", "reached").where(sql<string>`event_outbox.payload->>'month'`, "=", month)
        .where((eb) => eb.not(eb.exists(eb.selectFrom("staff_alert").select("staff_alert.id").whereRef("staff_alert.event_id", "=", "event_outbox.id").where("staff_alert.kind", "=", "texts_cap_reached_staff"))))
        .execute();
      for (const e of open) await ctx.insert("staff_alert", { id: uuidv7(), event_id: e.id, kind: "texts_cap_reached_staff", handled_by: null, handled_at: ctx.now });
    }
    return null;
  },
});
