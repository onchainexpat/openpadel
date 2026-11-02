// Texts counted per club month, in carrier segments (what Twilio bills), and in the club's one monthly meter
// (usage.ts) at the server's price per segment. Past the meter's limit, texts that can wait for another channel
// aren't sent: the message stays in the app's inbox and goes by email where the person has one. Codes (signing in,
// confirming a number) and the HELP and START answers carriers require keep going up to the meter's ceiling, so
// nobody is locked out. A new month starts fresh, and raising the cap lets texts go again at once.
import { sql } from "kysely";
import type { Db, Trx } from "./db.ts";
import { countUsage, currentPrices, monthOf, nextMonthStart, usageAllows, usageView } from "./usage.ts";

/** Months kept, this one included. */
export const HISTORY_MONTHS = 12;
/** A message that can wait for another channel, or a code (and HELP and START answers) that can't. */
export type TextUse = "message" | "code";

const tzOf = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirst())?.time_zone ?? null;

/** Whether a text of this many segments may go now (the club's monthly meter, usage.ts). */
export async function textAllowed(db: Db, use: TextUse, segs: number, now = new Date()): Promise<{ ok: boolean }> {
  return { ok: await usageAllows(db, use === "code" ? "essential" : "can_wait", segs * currentPrices().text_segment, now) };
}

/** A new month's row, and the oldest one past the history dropped. */
async function ensureMonth(db: Db, month: string) {
  const r = await db.insertInto("text_usage").values({ month }).onConflict((oc) => oc.column("month").doNothing()).executeTakeFirst();
  if (Number(r.numInsertedOrUpdatedRows ?? 0)) await sql`DELETE FROM text_usage WHERE month <= ${month}::date - make_interval(months => ${HISTORY_MONTHS})`.execute(db);
}

/** A text Twilio took: counted in its month, here and on the club's meter. */
export async function countText(db: Db, use: TextUse, segs: number, now = new Date()): Promise<void> {
  const tz = await tzOf(db);
  if (!tz) return;
  const month = monthOf(now, tz), code = use === "code" ? 1 : 0;
  await ensureMonth(db, month);
  await db.updateTable("text_usage").set((eb) => ({ texts: eb("texts", "+", 1), segments: eb("segments", "+", segs), code_texts: eb("code_texts", "+", code),
    code_segments: eb("code_segments", "+", code * segs), updated_at: now })).where("month", "=", month).execute();
  await countUsage(db, "texts", { segments: segs, cents: segs * currentPrices().text_segment }, now);
}

/** A text the cap kept back (the person gets the message in the app, and by email where they have one). */
export async function countHeld(db: Db, now = new Date()): Promise<void> {
  const tz = await tzOf(db);
  if (!tz) return;
  const month = monthOf(now, tz);
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
  const tz = m && await tzOf(db);
  if (!m || !tz) return;
  const month = monthOf(m.sent_at ?? m.created_at ?? now, tz);
  await ensureMonth(db, month);
  await db.updateTable("text_usage").set((eb) => ({ priced: eb("priced", "+", 1), actual_cents: sql`actual_cents + ${cents}`, updated_at: now })).where("month", "=", month).execute();
}

/** This month and the ones before it, newest first, with the estimate at the server's price per segment, and
 *  whether texts that can wait are paused by the club's meter. */
export async function textUsage(db: Db, now = new Date()) {
  const tz = await tzOf(db);
  if (!tz) return null;
  const month = monthOf(now, tz), cost = currentPrices().text_segment, meter = await usageView(db, now);
  const rows = await db.selectFrom("text_usage").selectAll().orderBy("month", "desc").limit(HISTORY_MONTHS).execute();
  const view = (r: (typeof rows)[number]) => ({ month: String(r.month).slice(0, 10), texts: r.texts, segments: r.segments, code_texts: r.code_texts, code_segments: r.code_segments,
    held: r.held, estimate_cents: Math.round(r.segments * cost), priced: r.priced, actual_cents: Math.round(Number(r.actual_cents)) });
  const empty = { month, texts: 0, segments: 0, code_texts: 0, code_segments: 0, held: 0, estimate_cents: 0, priced: 0, actual_cents: 0 };
  const now_ = rows.find((r) => String(r.month).slice(0, 10) === month);
  return { cents_per_segment: cost, paused: meter?.state === "paused", resets: nextMonthStart(month, tz).toISOString(), current: now_ ? view(now_) : empty,
    history: rows.filter((r) => String(r.month).slice(0, 10) !== month).map(view) };
}
