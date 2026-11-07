// Passes: products the club makes, for example "10 clinic places", "5 court bookings up to 90 minutes" or "1 drop-in",
// bought by a member in the app (by card) or sold at the desk. A pass is one person's. It says what it covers:
// program places (some kinds, or some programs, or any), or court bookings paid whole (up to a length, and between
// times of the club's day if the club says so). No expiry unless the club sets one, and then at least 12 months.
// A use is taken when the member (or the desk for them) pays with it, which confirms the place or booking as a card
// would; a cancel the club's rules refund in full gives the use back, one they refund in part or not at all spends it,
// as the money rules do. Until a use is taken the money is the club's liability (a passes account, money.ts): each use
// moves its share of the price to revenue, and the last use whatever is left, so the uses add up to the price. The
// owner or a manager refunds the unused uses, pro rata, the way the pass was paid for. A pass is used one change at a
// time (a lock per pass), so two checkouts at once can't take its last use twice.
import * as z from "zod/mini";
import { sql } from "kysely";
import type { Selectable } from "kysely";
import { both, capFor, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { DB, Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post } from "./money.ts";
import { callOff, deskPaid, paidHow, recordAtDesk, refundTo, revenueType } from "./desk_pay.ts";
import { kidOf, paymentWhat } from "./kids.ts";
import { paidNow } from "./programs.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const PROGRAM_KINDS = ["clinic", "course", "league", "tournament", "social"] as const;

/** One pass, used or refunded one change at a time: held until this change commits. */
export async function lockPass(trx: Trx, passId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pass:${passId}`}, 0))`.execute(trx);
}

/** What's left of a pass's price: the price, less the uses taken and not given back. */
async function valueLeft(db: Db | Trx, pass: { id: string; price_cents: number }) {
  const r = await db.selectFrom("pass_use").select(sql<string>`coalesce(sum(value_cents), 0)`.as("c")).where("pass_id", "=", pass.id).where("returned_at", "is", null).executeTakeFirstOrThrow();
  return pass.price_cents - Number(r.c);
}
/** The share of the price the next use takes: an even share, and the last use whatever is left. */
async function nextUseValue(db: Db | Trx, pass: { id: string; price_cents: number; uses: number; uses_left: number }) {
  const left = await valueLeft(db, pass);
  return pass.uses_left <= 1 ? left : Math.min(left, Math.floor(pass.price_cents / pass.uses));
}

type What = { covers: "courts" | "lessons"; minutes: number; startMinute: number } | { covers: "programs"; programId: string; kind: string };
type PassRow = Selectable<DB["pass"]>;

/** What a payment is for, as a pass sees it, or why no pass can pay it: a court paid whole by the one who booked it, or
 *  a program place. Not a membership, a gift card or a pass, several paid together, a share saving a card for later,
 *  a kid's (the family card pays those), or one whose card form is already open. */
async function whatFor(db: Db | Trx, pay: Selectable<DB["payment"]>): Promise<What | { why: Key }> {
  if (pay.status !== "pending") return { why: "error.pass_paid" };
  if (pay.provider_ref) return { why: "error.pass_card_open" };
  if (pay.membership_id || pay.membership_plan_id || pay.gift_card_id || pay.pass_id || pay.group_id || pay.save_card) return { why: "error.pass_not_for_this" };
  if (pay.family_card_id || pay.parent_to_pay_at || await kidOf(db, pay.person_id)) return { why: "error.pass_kid" };
  if (pay.enrolment_id) {
    const p = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").select(["program.id", "program.kind"]).where("enrolment.id", "=", pay.enrolment_id).executeTakeFirstOrThrow();
    return { covers: "programs", programId: p.id, kind: p.kind };
  }
  if (pay.booking_player_id) {
    const b = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("location", "location.id", "booking.location_id")
      .select(["booking.id", "booking.kind", "booking.pay_mode", "booking.organiser_id", "location.time_zone"]).where("booking_player.id", "=", pay.booking_player_id).executeTakeFirstOrThrow();
    if (b.pay_mode !== "whole" || b.organiser_id !== pay.person_id) return { why: "error.pass_not_for_this" };
    // A courts pass is for court bookings; a coach's lesson only on a pass made for lessons (its price is the coach's).
    if (b.kind !== "court" && b.kind !== "lesson") return { why: "error.pass_not_for_this" };
    const t = await db.selectFrom("court_time").select([sql<string>`extract(epoch from max(upper(during)) - min(lower(during)))`.as("secs"),
      sql<string>`(extract(hour from min(lower(during)) AT TIME ZONE ${b.time_zone}) * 60 + extract(minute from min(lower(during)) AT TIME ZONE ${b.time_zone}))`.as("start")])
      .where("booking_id", "=", b.id).where("active", "=", true).executeTakeFirst();
    if (!t?.secs) return { why: "error.pass_not_for_this" };
    return { covers: b.kind === "lesson" ? "lessons" : "courts", minutes: Math.round(Number(t.secs) / 60), startMinute: Number(t.start) };
  }
  return { why: "error.pass_not_for_this" };
}
/** Whether a pass (as it was bought) covers this. */
function passCovers(p: Pick<PassRow, "covers" | "program_kinds" | "program_ids" | "max_minutes" | "from_minute" | "to_minute">, w: What): boolean {
  if (p.covers !== w.covers) return false;
  if (w.covers === "programs") {
    if (p.program_ids?.length && !p.program_ids.includes(w.programId)) return false;
    if (p.program_kinds?.length && !p.program_kinds.includes(w.kind)) return false;
    return true;
  }
  if (p.max_minutes && w.minutes > p.max_minutes) return false;
  if (p.from_minute != null && w.startMinute < p.from_minute) return false;
  if (p.to_minute != null && w.startMinute >= p.to_minute) return false;
  return true;
}
const usable = (p: PassRow, now: Date) => p.status === "active" && p.uses_left > 0 && (!p.expires_at || p.expires_at > now);

/** A person's passes that could pay this payment now (the pay sheet offers them before the card form opens). */
export async function passesFor(db: Db | Trx, personId: string, paymentId: string, now: Date) {
  const pay = await db.selectFrom("payment").selectAll().where("id", "=", paymentId).where("person_id", "=", personId).executeTakeFirst();
  if (!pay) return [];
  const w = await whatFor(db, pay);
  if ("why" in w) return [];
  const mine = await db.selectFrom("pass").selectAll().where("person_id", "=", personId).where("status", "=", "active").orderBy("expires_at", "asc").orderBy("created_at").execute();
  return mine.filter((p) => usable(p, now) && passCovers(p, w)).map((p) => ({ id: p.id, name: p.name, uses_left: p.uses_left, uses: p.uses, expires_at: p.expires_at }));
}

// ---- The club's products ----
const productInput = {
  name: z.string().check(z.minLength(1), z.maxLength(80)), covers: z.enum(["programs", "courts", "lessons"]),
  program_kinds: z.optional(z.array(z.enum(PROGRAM_KINDS))), program_ids: z.optional(z.array(z.uuid())),
  max_minutes: z.optional(z.nullable(z.number().check(z.int(), z.minimum(15), z.maximum(600)))),
  from_minute: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(1439)))), to_minute: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(1440)))),
  price_cents: z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000_000)), uses: z.number().check(z.int(), z.minimum(1), z.maximum(100)),
  valid_days: z.optional(z.nullable(z.number().check(z.int(), z.minimum(365), z.maximum(3650)))), on_sale: z.optional(z.boolean()),
};
/** The owner or a manager makes a pass the club sells, or changes one (passes already bought keep what they were
 *  bought as), or takes it off sale. An expiry, if any, is at least 12 months: in many states a prepaid pack can't
 *  expire sooner, so the docs ask the club to check its own. */
export const passProductSet = defineAction({
  name: "pass_product.set", version: 1, clubWide: true,
  input: z.object({ product_id: z.optional(z.uuid()), ...productInput }),
  async plan(ctx, i) {
    if (i.from_minute != null && i.to_minute != null && i.to_minute <= i.from_minute) throw new KumiError("error.pass_hours");
    // At most about $5,000, in the club's currency (capFor); at least one whole unit.
    if (i.price_cents < capFor(100) || i.price_cents > capFor(500000)) throw new KumiError("error.amount_range", { min: money(capFor(100), "en"), max: money(capFor(500000), "en") });
    const reads = i.product_id ? [(await readRow(ctx.db, "pass_product", i.product_id, "thing.pass")).read] : [];
    const what = i.covers === "courts" ? both(i.max_minutes ? "plan.pass_courts_up_to" : "plan.pass_courts", { minutes: String(i.max_minutes ?? "") })
      : i.covers === "lessons" ? both(i.max_minutes ? "plan.pass_lessons_up_to" : "plan.pass_lessons", { minutes: String(i.max_minutes ?? "") }) : both("plan.pass_programs");
    return { title: both("action.pass_product.set"), reads, undo: { kind: "compensating" },
      summary: both(i.on_sale === false ? "plan.pass_product.off" : i.product_id ? "plan.pass_product.change" : "plan.pass_product.make",
        { name: i.name, uses: String(i.uses), price: usd(i.price_cents), what, expiry: i.valid_days ? both("plan.pass_expires_days", { days: String(i.valid_days) }) : both("plan.pass_never_expires") }) };
  },
  async apply(ctx, i) {
    const row = { name: i.name, covers: i.covers, program_kinds: i.covers === "programs" && i.program_kinds?.length ? i.program_kinds : null,
      program_ids: i.covers === "programs" && i.program_ids?.length ? i.program_ids : null, max_minutes: i.covers !== "programs" ? i.max_minutes ?? null : null,
      from_minute: i.covers !== "programs" ? i.from_minute ?? null : null, to_minute: i.covers !== "programs" ? i.to_minute ?? null : null,
      price_cents: i.price_cents, uses: i.uses, valid_days: i.valid_days ?? null, on_sale: i.on_sale ?? true };
    if (i.product_id) { await ctx.update("pass_product", i.product_id, row); return { product_id: i.product_id }; }
    const id = uuidv7();
    await ctx.insert("pass_product", { id, ...row });
    return { product_id: id };
  },
});

async function onSale(db: Db | Trx, productId: string) {
  const p = await db.selectFrom("pass_product").selectAll().where("id", "=", productId).executeTakeFirst();
  if (!p || !p.on_sale) throw new KumiError("error.pass_not_on_sale");
  return p;
}
/** A new pass, waiting for its money (bought in the app) or paid (at the desk), as the product is now. */
async function makePass(ctx: ApplyCtx, product: Selectable<DB["pass_product"]>, personId: string, via: "app" | "desk", status: "pending" | "active") {
  const id = uuidv7();
  await ctx.insert("pass", { id, product_id: product.id, person_id: personId, name: product.name, covers: product.covers, program_kinds: product.program_kinds, program_ids: product.program_ids,
    max_minutes: product.max_minutes, from_minute: product.from_minute, to_minute: product.to_minute, price_cents: product.price_cents, uses: product.uses, uses_left: product.uses,
    expires_at: status === "active" && product.valid_days ? new Date(ctx.now.getTime() + product.valid_days * 864e5) : null, sold_via: via, status });
  return id;
}

/** A member buys a pass in the app: it waits for its card payment, and is theirs once that goes through (paidNow ->
 *  passPaid). One person's: not bought for a kid in this version. Club credit can't pay for one. */
export const passBuy = defineAction({
  name: "pass.buy", version: 1,
  input: z.object({ person_id: z.uuid(), product_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const p = await onSale(ctx.db, i.product_id);
    if (await kidOf(ctx.db, i.person_id)) throw new KumiError("error.pass_kid");
    return { title: both("action.pass.buy"), reads: [read], ownerIds: [i.person_id], moneyCents: p.price_cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both("plan.pass.buy", { name: p.name, uses: String(p.uses), price: usd(p.price_cents) }) };
  },
  async apply(ctx, i) {
    const p = await onSale(ctx.trx, i.product_id);
    if (await kidOf(ctx.trx, i.person_id)) throw new KumiError("error.pass_kid");
    // One bought before and never paid is called off (as gift_card.buy does): gone through after all, it's
    // recorded and given back in full.
    for (const x of await ctx.trx.selectFrom("payment").innerJoin("pass", "pass.id", "payment.pass_id").select("payment.id")
      .where("pass.person_id", "=", i.person_id).where("pass.sold_via", "=", "app").where("pass.status", "=", "pending").where("payment.status", "=", "pending").execute()) await callOff(ctx, x.id);
    const pass = await makePass(ctx, p, i.person_id, "app", "pending");
    const payment = uuidv7();
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: p.price_cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", pass_id: pass });
    return { pass_id: pass, payment_id: payment };
  },
});

/** The desk sells a pass for a member, paid there (its price, in cash, on the card reader or another way): theirs at once. */
export const passSell = defineAction({
  name: "pass.sell", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), product_id: z.uuid(), ...deskPaid }),
  async plan(ctx, i) {
    const { row: person, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const p = await onSale(ctx.db, i.product_id);
    if (i.cents !== p.price_cents) throw new KumiError("error.pass_price", { price: usd(p.price_cents) });
    if (await kidOf(ctx.db, i.person_id)) throw new KumiError("error.pass_kid");
    return { title: both("action.pass.sell"), reads: [read], ownerIds: [i.person_id], moneyCents: p.price_cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both("plan.pass.sell", { pass: p.name, name: person.display_name, price: usd(p.price_cents), how: paidHow(i.method) }) };
  },
  async apply(ctx, i) {
    const p = await onSale(ctx.trx, i.product_id);
    if (i.cents !== p.price_cents) throw new KumiError("error.changed");
    if (await kidOf(ctx.trx, i.person_id)) throw new KumiError("error.pass_kid");
    const pass = await makePass(ctx, p, i.person_id, "desk", "active");
    const payment = await recordAtDesk(ctx, { personId: i.person_id, cents: p.price_cents, method: i.method, note: i.note, revenue: "passes", memo: "pass", link: { pass_id: pass } });
    return { pass_id: pass, payment_id: payment };
  },
});

/** The pass bought in the app went through: it's theirs, and its expiry (if the product has one) starts now. */
export async function passPaid(ctx: ApplyCtx, passId: string) {
  const p = await ctx.trx.selectFrom("pass").innerJoin("pass_product", "pass_product.id", "pass.product_id").select(["pass.status", "pass_product.valid_days"]).where("pass.id", "=", passId).forUpdate().executeTakeFirstOrThrow();
  if (p.status !== "pending") return;
  await ctx.update("pass", passId, { status: "active", expires_at: p.valid_days ? new Date(ctx.now.getTime() + p.valid_days * 864e5) : null });
}

/** A member (or the desk for them) pays a place or a court with one use of their pass, before its card form opens: it
 *  goes through as a card's would, and the place or booking is theirs. App only, like credit: what an assistant reads
 *  could tell it to spend someone's pass. */
export const paymentUsePass = defineAction({
  name: "payment.use_pass", version: 1,
  input: z.object({ payment_id: z.uuid(), pass_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    const pay = await ctx.db.selectFrom("payment").selectAll().where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    const w = await whatFor(ctx.db, pay);
    if ("why" in w) throw new KumiError(w.why);
    const pass = await ctx.db.selectFrom("pass").selectAll().where("id", "=", i.pass_id).executeTakeFirst();
    if (!pass || pass.person_id !== pay.person_id) throw new KumiError("error.pass_not_theirs");
    if (!usable(pass, ctx.now)) throw new KumiError(pass.status === "active" && pass.uses_left > 0 ? "error.pass_expired" : "error.pass_used_up");
    if (!passCovers(pass, w)) throw new KumiError("error.pass_not_for_this");
    return { title: both("action.payment.use_pass"), reads: [read], ownerIds: [pay.person_id], undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both("plan.payment.use_pass", { name: pass.name, what: await paymentWhat(ctx.db, pay), left: String(pass.uses_left - 1) }) };
  },
  async apply(ctx, i) {
    await lockPass(ctx.trx, i.pass_id);
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    const pass = await ctx.trx.selectFrom("pass").selectAll().where("id", "=", i.pass_id).forUpdate().executeTakeFirstOrThrow();
    // Again under the locks: another checkout may have taken its last use, or the card form opened, meanwhile.
    const w = await whatFor(ctx.trx, pay);
    if ("why" in w || pass.person_id !== pay.person_id || !usable(pass, ctx.now) || !passCovers(pass, w)) throw new KumiError("error.changed");
    const value = await nextUseValue(ctx.trx, pass);
    await ctx.insert("pass_use", { id: uuidv7(), pass_id: pass.id, payment_id: pay.id, value_cents: value, at: ctx.now });
    await ctx.update("pass", pass.id, { uses_left: pass.uses_left - 1 });
    await paidNow(ctx, pay, { from: "pass", cents: value });
    return { paid: true, payment_id: pay.id, uses_left: pass.uses_left - 1 };
  },
});

/** A payment a pass covered, refunded (refundTo): in full, the use is the pass's again (its share of the price back
 *  into the passes account); in part or not at all, the use is spent, as a card would get that part or nothing back.
 *  A pass refunded since can't take a use back: its share goes to the member's club credit instead. A place passed to
 *  a sub who pays: the use waits for them (a refund to the pass, waiting_for_sub), and is back only once they pay
 *  (refundDue -> passUseDue), never if they don't. */
export async function passUseBack(ctx: ApplyCtx, pay: { id: string; amount_cents: number; person_id: string; booking_player_id: string | null; membership_id: string | null; membership_plan_id: string | null }, cents: number, enrolmentId: string | null, status: "pending" | "waiting_for_sub" = "pending") {
  if (cents < pay.amount_cents) return null;
  const use = await ctx.trx.selectFrom("pass_use").selectAll().where("payment_id", "=", pay.id).executeTakeFirst();
  if (!use || use.returned_at) return null;
  const id = uuidv7();
  if (status === "waiting_for_sub") {
    await ctx.insert("refund", { id, payment_id: pay.id, enrolment_id: enrolmentId, amount_cents: cents, destination: "pass", status: "waiting_for_sub" });
    return { id, desk: false, credit: false, pass: true, cents };
  }
  const toCredit = await returnUse(ctx, pay, use);
  // The refund says what really went back: the use's share of the price, when it went to club credit.
  await ctx.insert("refund", { id, payment_id: pay.id, enrolment_id: enrolmentId, amount_cents: toCredit ? use.value_cents || cents : cents, destination: toCredit ? "credit" : "pass", status: "sent" });
  return { id, desk: false, credit: toCredit, pass: !toCredit, cents };
}
/** The use is the pass's again (or, the pass refunded since, its share goes to club credit): whether it went to credit. */
async function returnUse(ctx: ApplyCtx, pay: { person_id: string; booking_player_id: string | null; membership_id: string | null; membership_plan_id: string | null }, use: Selectable<DB["pass_use"]>) {
  await lockPass(ctx.trx, use.pass_id);
  const pass = await ctx.trx.selectFrom("pass").select(["status", "uses_left"]).where("id", "=", use.pass_id).forUpdate().executeTakeFirstOrThrow();
  const toCredit = pass.status !== "active";
  await ctx.trx.updateTable("pass_use").set({ returned_at: ctx.now }).where("id", "=", use.id).execute();
  if (!toCredit) await ctx.update("pass", use.pass_id, { uses_left: pass.uses_left + 1 });
  if (use.value_cents > 0) await post(ctx.trx, ctx.runId, "pass_use_back", toCredit ? "pass use back as club credit" : "pass use given back", [
    { account: await account(ctx.trx, "revenue", { revenueType: await revenueType(ctx.trx, pay) }), cents: use.value_cents },
    { account: toCredit ? await account(ctx.trx, "member_credit", { personId: pay.person_id }) : await account(ctx.trx, "passes"), cents: -use.value_cents }]);
  return toCredit;
}
/** A use that was waiting for a sub to pay is due: the pass's again (or club credit, the pass refunded meanwhile). */
export async function passUseDue(ctx: ApplyCtx, refundId: string) {
  const r = await ctx.trx.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id")
    .select(["refund.payment_id", "payment.person_id", "payment.booking_player_id", "payment.membership_id", "payment.membership_plan_id"]).where("refund.id", "=", refundId).executeTakeFirstOrThrow();
  const use = await ctx.trx.selectFrom("pass_use").selectAll().where("payment_id", "=", r.payment_id).executeTakeFirst();
  if (!use || use.returned_at) { await ctx.update("refund", refundId, { status: "sent" }); return; }
  const toCredit = await returnUse(ctx, r, use);
  await ctx.update("refund", refundId, { status: "sent", ...(toCredit ? { destination: "credit", ...(use.value_cents > 0 ? { amount_cents: use.value_cents } : {}) } : {}) });
}

/** The owner or a manager refunds a pass's unused uses, pro rata (what's left of its price), the way it was paid
 *  for: to the card, or waiting at the desk. The pass is used up after. Money going back, so read-only allows it. */
export const passRefund = defineAction({
  name: "pass.refund", version: 1, clubWide: true,
  input: z.object({ pass_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: pass, read } = await readRow(ctx.db, "pass", i.pass_id, "thing.pass");
    if (pass.status !== "active" || pass.uses_left <= 0) throw new KumiError("error.pass_nothing_to_refund");
    const cents = await valueLeft(ctx.db, pass as { id: string; price_cents: number }), name = (await ctx.db.selectFrom("person").select("display_name").where("id", "=", pass.person_id).executeTakeFirstOrThrow()).display_name;
    return { title: both("action.pass.refund"), reads: [read], ownerIds: [pass.person_id], moneyCents: cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both("plan.pass.refund", { pass: pass.name, name, uses: String(pass.uses_left), amount: usd(cents) }), details: { cents } };
  },
  async apply(ctx, i, plan) {
    await lockPass(ctx.trx, i.pass_id);
    const pass = await ctx.trx.selectFrom("pass").selectAll().where("id", "=", i.pass_id).forUpdate().executeTakeFirstOrThrow();
    const cents = await valueLeft(ctx.trx, pass);
    if (pass.status !== "active" || pass.uses_left <= 0 || cents !== (plan.details as { cents: number }).cents) throw new KumiError("error.changed");
    await ctx.update("pass", pass.id, { status: "refunded", uses_left: 0, refunded_at: ctx.now });
    const pay = await ctx.trx.selectFrom("payment").select("id").where("pass_id", "=", pass.id).where("status", "=", "succeeded").executeTakeFirstOrThrow();
    const r = await refundTo(ctx, pay.id, cents);
    return { refund_id: r?.id ?? null, cents };
  },
});

// ---- Reads ----
/** A person's passes, newest first, with what each covers and how many uses are left. */
export async function passesOf(db: Db | Trx, personId: string) {
  return db.selectFrom("pass").select(["id", "name", "covers", "uses", "uses_left", "expires_at", "status", "price_cents", "created_at", "program_kinds", "max_minutes"])
    .where("person_id", "=", personId).where("status", "!=", "pending").orderBy("created_at", "desc").execute();
}
/** The passes the club sells now, for members to buy. */
export async function passProducts(db: Db | Trx, o: { all?: boolean } = {}) {
  return db.selectFrom("pass_product").selectAll().$if(!o.all, (q) => q.where("on_sale", "=", true)).orderBy("created_at").execute();
}
/** What the club owes on passes not used up: the price of each active pass less the uses taken. */
export async function outstandingPasses(db: Db | Trx): Promise<{ cents: number; count: number }> {
  const r = await db.selectFrom("pass").select([sql<string>`coalesce(sum(price_cents - coalesce((SELECT sum(u.value_cents) FROM pass_use u WHERE u.pass_id = pass.id AND u.returned_at IS NULL), 0)), 0)`.as("c"), sql<string>`count(*)`.as("n")])
    .where("status", "=", "active").where("uses_left", ">", 0).executeTakeFirstOrThrow();
  return { cents: Number(r.c), count: Number(r.n) };
}
