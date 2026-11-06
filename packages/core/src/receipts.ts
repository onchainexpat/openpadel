// Receipts. Every payment that goes through, and every refund sent, gets a numbered receipt for whoever paid:
// by email (an account message, so it goes whatever they chose about news) and in the members' app, where it
// can be printed. A kid's charge on the family card is the parent's receipt, saying whom it was for. Several
// courts paid with one card payment share one receipt.
//
// Receipts are written by a job (issueReceipts), not by each way of paying, so a payment made any way (the card
// form, a saved card at a deadline, a renewal, the desk) gets one, once: the payment's receipt_payment row
// says it has. The card's brand and last four digits come from the payment provider when it gives them. Only
// payments and refunds from the update that added receipts on get one (club.receipts_from).
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, money, type Lang, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { textOf } from "./club_text.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const NOTHING: Text = { en: "", es: "" };
type Card = { brand: string; last4: string };
type Line = { what: Text; cents: number };
type Paid = { id: string; person_id: string; amount_cents: number; method: string; booking_player_id: string | null; enrolment_id: string | null; membership_plan_id: string | null;
  membership_id: string | null; membership_member_id: string | null; family_card_id: string | null; discount_cents?: number };

/** A date and time with the year, in the club's time: a receipt is kept. */
export function receiptDate(d: Date, lang: Lang, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}
const whenText = (d: Date, tz: string): Text => ({
  en: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d),
  es: new Intl.DateTimeFormat("es-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) });
/** "R-001042": the number as printed. */
export const receiptNo = (n: string | number) => `R-${String(n).padStart(6, "0")}`;

/** What one payment was for, its sales tax (a court or lesson's, in proportion to what was paid) and where. */
async function lineOf(db: Db | Trx, p: Paid, tz: string): Promise<Line & { tax: number; locationId: string | null }> {
  // A promo code's discount is named on the line (promo_codes.ts): what was paid, after it.
  const l = await lineWithout(db, p, tz);
  return p.discount_cents ? { ...l, what: both("receipt.line_promo", { what: l.what, off: { en: money(p.discount_cents, "en"), es: money(p.discount_cents, "es") } }) } : l;
}
async function lineWithout(db: Db | Trx, p: Paid, tz: string): Promise<Line & { tax: number; locationId: string | null }> {
  if (p.booking_player_id) {
    const b = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
      .innerJoin("court", "court.id", "court_time.court_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
      .select(["booking.kind", "booking.price_cents", "booking.tax_cents", "booking.location_id", "court.name as court", "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start")])
      .where("booking_player.id", "=", p.booking_player_id).orderBy(sql`court_time.active`, "desc").executeTakeFirst();
    if (b) {
      const params = { court: b.court, when: whenText(new Date(b.start), tz), coach: b.coach ?? "" };
      const what = b.kind === "lesson" ? both("receipt.line_lesson", params) : p.amount_cents + (p.discount_cents ?? 0) >= b.price_cents ? both("receipt.line_court", params) : both("receipt.line_share", params);
      const tax = b.price_cents > 0 ? Math.round(b.tax_cents * p.amount_cents / b.price_cents) : 0;
      return { what, cents: p.amount_cents, tax, locationId: b.location_id };
    }
  }
  if (p.enrolment_id) {
    const e = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").select(["program.id", "program.name", "program.translations", "program.location_id", "enrolment.session_id"])
      .where("enrolment.id", "=", p.enrolment_id).executeTakeFirst();
    if (e) {
      const s = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", e.id).where("status", "!=", "cancelled")
        .$if(Boolean(e.session_id), (q) => q.where("id", "=", e.session_id!)).executeTakeFirst();
      // Each language's receipt names the program in that language, when the club wrote one.
      const name = textOf(e.name, e.translations, "name");
      const what = s?.s ? both("receipt.line_program", { name, when: whenText(new Date(s.s as Date), tz) }) : both("receipt.line_program_only", { name });
      return { what, cents: p.amount_cents, tax: 0, locationId: e.location_id };
    }
  }
  const planId = p.membership_plan_id ?? (p.membership_id ? (await db.selectFrom("membership").select("plan_id").where("id", "=", p.membership_id).executeTakeFirst())?.plan_id : null);
  if (planId) {
    const plan = await db.selectFrom("membership_plan").select(["name", "translations"]).where("id", "=", planId).executeTakeFirstOrThrow();
    return { what: both(p.membership_member_id ? "receipt.line_membership_extra" : "receipt.line_membership", { name: textOf(plan.name, plan.translations, "name") }), cents: p.amount_cents, tax: 0, locationId: null };
  }
  return { what: both("receipt.line_other"), cents: p.amount_cents, tax: 0, locationId: null };
}

const PAID_COLUMNS = ["id", "person_id", "amount_cents", "method", "booking_player_id", "enrolment_id", "membership_plan_id", "membership_id", "membership_member_id", "family_card_id",
  "group_id", "provider_ref", "discount_cents"] as const;

/** Who a payment's receipt is for: whoever paid, which for a kid's charge on the family card is the parent who
 *  saved the card (the kid is named on it). */
async function payerOf(db: Db | Trx, p: Paid): Promise<{ to: string; forPerson: string | null }> {
  if (!p.family_card_id) return { to: p.person_id, forPerson: null };
  const card = await db.selectFrom("family_card").select("saved_by").where("id", "=", p.family_card_id).executeTakeFirst();
  return card && card.saved_by !== p.person_id ? { to: card.saved_by, forPerson: p.person_id } : { to: p.person_id, forPerson: null };
}
async function firstLocation(db: Db | Trx): Promise<string | null> {
  return (await db.selectFrom("location").select("id").where("archived_at", "is", null).orderBy("name").executeTakeFirst())?.id ?? null;
}

export const receiptIssue = defineAction({
  name: "receipt.issue", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.optional(z.uuid()), refund_id: z.optional(z.uuid()), card: z.optional(z.nullable(z.object({ brand: z.string().check(z.maxLength(20)), last4: z.string().check(z.regex(/^\d{4}$/)) }))) }),
  async plan(ctx, i) {
    if (Boolean(i.payment_id) === Boolean(i.refund_id)) throw new KumiError("error.invalid_input", { details: "a payment or a refund" });
    return { title: both("action.receipt.issue"), summary: both(i.refund_id ? "plan.receipt.issue_refund" : "plan.receipt.issue"), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const tz = (await ctx.trx.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
    const card = i.card ?? null;
    if (i.payment_id) {
      if (await ctx.trx.selectFrom("receipt_payment").select("receipt_id").where("payment_id", "=", i.payment_id).executeTakeFirst()) return { already: true };
      const pay = await ctx.trx.selectFrom("payment").select([...PAID_COLUMNS, "status"]).where("id", "=", i.payment_id).executeTakeFirstOrThrow();
      if (pay.status !== "succeeded") throw new KumiError("error.invalid_input", { details: "only a payment that went through has a receipt" });
      // Several courts paid together: every payment the one card payment covered, on one receipt.
      const rows = pay.group_id ? await ctx.trx.selectFrom("payment").select([...PAID_COLUMNS]).where("group_id", "=", pay.group_id).where("status", "=", "succeeded")
        .where(sql<boolean>`provider_ref IS NOT DISTINCT FROM ${pay.provider_ref}`)
        .where((eb) => eb.not(eb.exists(eb.selectFrom("receipt_payment").select("receipt_payment.payment_id").whereRef("receipt_payment.payment_id", "=", "payment.id")))).orderBy("id").execute() : [pay];
      const lines = await Promise.all(rows.map((r) => lineOf(ctx.trx, r, tz)));
      const total = lines.reduce((n, l) => n + l.cents, 0), tax = lines.reduce((n, l) => n + l.tax, 0);
      const { to, forPerson } = await payerOf(ctx.trx, pay);
      const id = uuidv7(ctx.now.getTime());
      await ctx.trx.insertInto("receipt").values({ id, kind: "payment", person_id: to, for_person_id: forPerson, payment_id: rows[0]!.id, refund_id: null,
        location_id: lines.find((l) => l.locationId)?.locationId ?? await firstLocation(ctx.trx), lines: JSON.stringify(lines.map((l) => ({ what: l.what, cents: l.cents }))),
        subtotal_cents: total - tax, tax_cents: tax, total_cents: total, method: pay.method, card: card ? JSON.stringify(card) : null, paid_at: ctx.now }).execute();
      await ctx.trx.insertInto("receipt_payment").values(rows.map((r) => ({ payment_id: r.id, receipt_id: id }))).execute();
      await ctx.emit("receipt.issued", { receipt_id: id });
      return { receipt_id: id };
    }
    if (await ctx.trx.selectFrom("receipt").select("id").where("refund_id", "=", i.refund_id!).executeTakeFirst()) return { already: true };
    const r = await ctx.trx.selectFrom("refund").selectAll().where("id", "=", i.refund_id!).executeTakeFirstOrThrow();
    if (r.status !== "sent") throw new KumiError("error.invalid_input", { details: "only a refund that was sent has a receipt" });
    const pay = await ctx.trx.selectFrom("payment").select([...PAID_COLUMNS]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
    const line = await lineOf(ctx.trx, pay, tz);
    // The tax comes back in the same share as it was paid.
    const tax = pay.amount_cents > 0 ? Math.round(line.tax * r.amount_cents / pay.amount_cents) : 0;
    const paidReceipt = await ctx.trx.selectFrom("receipt_payment").innerJoin("receipt", "receipt.id", "receipt_payment.receipt_id").select(["receipt.card", "receipt.location_id"])
      .where("receipt_payment.payment_id", "=", pay.id).executeTakeFirst();
    const { to, forPerson } = await payerOf(ctx.trx, pay);
    const id = uuidv7(ctx.now.getTime());
    await ctx.trx.insertInto("receipt").values({ id, kind: "refund", person_id: to, for_person_id: forPerson, payment_id: pay.id, refund_id: r.id,
      location_id: paidReceipt?.location_id ?? line.locationId ?? await firstLocation(ctx.trx), lines: JSON.stringify([{ what: line.what, cents: r.amount_cents }]),
      subtotal_cents: r.amount_cents - tax, tax_cents: tax, total_cents: r.amount_cents, method: r.destination === "credit" ? "credit" : pay.method,
      card: r.destination === "credit" ? null : paidReceipt?.card ? JSON.stringify(paidReceipt.card) : card ? JSON.stringify(card) : null, paid_at: ctx.now }).execute();
    await ctx.emit("receipt.issued", { receipt_id: id });
    return { receipt_id: id };
  },
});

/** Staff send a receipt again, by email, to the person it's for (a lost email, a new address). */
export const receiptResend = defineAction({
  name: "receipt.resend", version: 1,
  input: z.object({ receipt_id: z.uuid() }),
  async plan(ctx, i) {
    const r = await ctx.db.selectFrom("receipt").innerJoin("person", "person.id", "receipt.person_id").select(["receipt.number", "receipt.person_id", "person.display_name", "person.email"])
      .where("receipt.id", "=", i.receipt_id).executeTakeFirst();
    if (!r) throw new KumiError("error.not_found", { thing: both("thing.receipt") }, 404);
    if (!r.email) throw new KumiError("error.receipt_no_email", { name: r.display_name });
    return { title: both("action.receipt.resend"), summary: both("plan.receipt.resend", { number: receiptNo(r.number), name: r.display_name, email: r.email }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.emit("receipt.resent", { receipt_id: i.receipt_id, by: ctx.actor.personId });
    return null;
  },
});

/** How a receipt says it was paid, or where a refund went. */
function methodText(method: string, card: Card | null, refund: boolean): Text {
  if (method === "credit") return both("receipt.method_credit");
  if (method === "card") return card ? both(refund ? "receipt.method_card_back" : "receipt.method_card", { brand: brandName(card.brand), last4: card.last4 }) : both(refund ? "receipt.method_card_back_plain" : "receipt.method_card_plain");
  return both(method === "cash" ? "receipt.method_cash" : method === "terminal" ? "receipt.method_terminal" : "receipt.method_other");
}
const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };
const brandName = (b: string) => BRANDS[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);

/** A receipt as it's shown and sent, in both languages: everything on it, worked out from the stored row. */
export async function receiptView(db: Db | Trx, receiptId: string) {
  const r = await db.selectFrom("receipt").leftJoin("location", "location.id", "receipt.location_id").leftJoin("person as kid", "kid.id", "receipt.for_person_id")
    .selectAll("receipt").select(["location.address", "location.name as location", "kid.display_name as kid"]).where("receipt.id", "=", receiptId).executeTakeFirst();
  if (!r) return null;
  const club = await db.selectFrom("club").select(["name", "legal_name", "time_zone"]).executeTakeFirstOrThrow();
  const card = r.card as Card | null, refund = r.kind === "refund";
  const original = refund ? await db.selectFrom("receipt_payment").innerJoin("receipt", "receipt.id", "receipt_payment.receipt_id").select("receipt.number")
    .where("receipt_payment.payment_id", "=", r.payment_id).executeTakeFirst() : null;
  const lines = (r.lines as { what: Text; cents: number }[]).map((l) => ({ what: l.what, amount: usd(l.cents) }));
  return {
    id: r.id, number: receiptNo(r.number), kind: r.kind, person_id: r.person_id, club: club.legal_name ?? club.name, address: r.address ?? null,
    when: { en: receiptDate(r.paid_at, "en", club.time_zone), es: receiptDate(r.paid_at, "es", club.time_zone) } as Text,
    lines, subtotal: usd(r.subtotal_cents), tax: r.tax_cents ? usd(r.tax_cents) : null, total: usd(r.total_cents), total_cents: r.total_cents,
    method: methodText(r.method, card, refund), kid: r.kid ?? null, original: original ? receiptNo(original.number) : null,
  };
}

/** A receipt's message: the receipt itself, as plain text. */
export async function receiptParams(db: Db, receiptId: string) {
  const v = await receiptView(db, receiptId);
  if (!v) return null;
  const lineText = (lang: Lang) => v.lines.map((l) => `${l.what[lang]}: ${l.amount[lang]}`).join("\n");
  return { view: v, kind: v.kind === "refund" ? "refund_receipt" : "receipt", params: {
    club: v.club, number: v.number, when: v.when, total: v.total, subtotal: v.subtotal, method: v.method,
    address: v.address ? `\n${v.address}` : "", lines: { en: lineText("en"), es: lineText("es") },
    tax: v.tax ? both("receipt.tax_line", { amount: v.tax }) : NOTHING,
    for: v.kid ? both("receipt.for_line", { name: v.kid }) : NOTHING,
    original: v.original ? both("receipt.original_line", { number: v.original }) : NOTHING,
  } };
}

/** The card a payment was made with, if the provider says. */
export type CardLookup = (ref: string, account: string | null) => Promise<Card | null>;

/** Write the receipts that are due: each payment that went through and each refund sent since receipts began,
 *  that hasn't one yet. Safe to run twice, and from two servers at once (one wins, the other finds it done). */
export async function issueReceipts(db: Db, o: { card?: CardLookup; now?: Date; limit?: number } = {}): Promise<{ issued: number }> {
  const now = o.now ?? new Date(), out = { issued: 0 };
  const from = (await db.selectFrom("club").select("receipts_from").executeTakeFirst())?.receipts_from;
  if (!from) return out;
  // A pass or a promo code that paid all of something took no money: its receipt is the pass's, or none.
  const pays = await db.selectFrom("payment").select(["id", "method", "provider", "provider_ref", "provider_account"]).where("status", "=", "succeeded").where("created_at", ">=", from).where("method", "not in", ["pass", "promo"])
    .where((eb) => eb.not(eb.exists(eb.selectFrom("receipt_payment").select("receipt_payment.payment_id").whereRef("receipt_payment.payment_id", "=", "payment.id"))))
    .orderBy("created_at").limit(o.limit ?? 50).execute();
  for (const p of pays) {
    if (await db.selectFrom("receipt_payment").select("payment_id").where("payment_id", "=", p.id).executeTakeFirst()) continue;   // on another's receipt, just written
    let card: Card | null = null;
    if (p.method === "card" && p.provider_ref && o.card) card = await o.card(p.provider_ref, p.provider_account).catch(() => null);
    try { if (!((await runAsSystem(db, "receipt.issue", { payment_id: p.id, card }, "job:receipts", { now })).result as { already?: boolean })?.already) out.issued++; }
    catch (e) { console.error(`receipt for payment ${p.id}:`, (e as Error).message); }
  }
  const refunds = await db.selectFrom("refund").select("id").where("status", "=", "sent").where("created_at", ">=", from).where("destination", "!=", "pass")
    .where((eb) => eb.not(eb.exists(eb.selectFrom("receipt").select("receipt.id").whereRef("receipt.refund_id", "=", "refund.id")))).orderBy("created_at").limit(o.limit ?? 50).execute();
  for (const r of refunds) {
    try { if (!((await runAsSystem(db, "receipt.issue", { refund_id: r.id }, "job:receipts", { now })).result as { already?: boolean })?.already) out.issued++; }
    catch (e) { console.error(`receipt for refund ${r.id}:`, (e as Error).message); }
  }
  return out;
}

/** Someone's receipts, newest first: theirs, and the ones for a kid they paid for. */
export async function receiptsOf(db: Db | Trx, personId: string, o: { asStaff?: boolean } = {}) {
  const rows = await db.selectFrom("receipt").select(["id", "number", "kind", "total_cents", "paid_at", "lines", "person_id", "for_person_id"])
    .where((eb) => o.asStaff ? eb.or([eb("person_id", "=", personId), eb("for_person_id", "=", personId)]) : eb("person_id", "=", personId))
    .orderBy("created_at", "desc").limit(200).execute();
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  return rows.map((r) => {
    const lines = r.lines as { what: Text; cents: number }[];
    return { id: r.id, number: receiptNo(r.number), kind: r.kind, total: usd(r.total_cents), when: { en: receiptDate(r.paid_at, "en", tz), es: receiptDate(r.paid_at, "es", tz) } as Text,
      what: lines[0]?.what ?? NOTHING, more: Math.max(0, lines.length - 1) };
  });
}

/** The club's receipts between two club dates (inclusive), newest first, for the money people: who paid, for
 *  whom, what, and the amounts (refunds as receipts of their own). At most `limit`. */
export async function clubReceipts(db: Db | Trx, from: string, to: string, o: { limit?: number } = {}) {
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  const rows = await db.selectFrom("receipt").leftJoin("person as payer", "payer.id", "receipt.person_id").leftJoin("person as for", "for.id", "receipt.for_person_id")
    .select(["receipt.id", "receipt.number", "receipt.kind", "receipt.person_id", "payer.display_name as paid_by", "for.display_name as for_name", "receipt.lines", "receipt.subtotal_cents",
      "receipt.tax_cents", "receipt.total_cents", "receipt.method", "receipt.card", "receipt.paid_at"])
    .where(sql<boolean>`(receipt.paid_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date`)
    .orderBy("receipt.paid_at", "desc").orderBy("receipt.number", "desc").limit(o.limit ?? 5000).execute();
  return rows.map((r) => {
    const lines = r.lines as { what: Text; cents: number }[], card = r.card as Card | null;
    return { id: r.id, number: receiptNo(r.number), kind: r.kind, person_id: r.person_id, paid_by: r.paid_by ?? "", for: r.for_name, paid_at: r.paid_at,
      when: { en: receiptDate(r.paid_at, "en", tz), es: receiptDate(r.paid_at, "es", tz) } as Text, local: localStamp(r.paid_at, tz),
      what: lines[0]?.what ?? NOTHING, more: Math.max(0, lines.length - 1), subtotal_cents: r.subtotal_cents, tax_cents: r.tax_cents, total_cents: r.total_cents,
      method: r.method, card: card ? `${card.brand} ${card.last4}` : null };
  });
}
/** "2026-11-02 14:05" on the club's clock, for a spreadsheet. */
function localStamp(d: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
