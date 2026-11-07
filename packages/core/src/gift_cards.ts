// Gift cards: when the club sells them (Settings), a member buys one in the app by card, or the desk sells one for a
// member (cash, the card reader, another way). Any amount the club allows; they never expire, carry no fees, and
// aren't taxed when sold (tax is on what they're spent on). Until redeemed a card is the club's liability (a
// gift_cards account, money.ts); redeemed, its value becomes the redeemer's club credit (credit.ts), once.
// The code goes to whoever bought it, in the app: they give it (or print it) to whoever it's for. It's never in an
// email or a message, sealed in the database with the club's key, and found by a fingerprint under that key (so a
// copy of the database alone can't test guesses); it's never kept in the change log or with a preview. Wrong codes
// are counted per person, the person redeeming, so codes can't be guessed. Staff can void a card nobody has redeemed (the buyer gets the money back
// the way they paid) and remind the buyer it's there.
import * as z from "zod/mini";
import { createHash, randomInt } from "node:crypto";
import { sql } from "kysely";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post } from "./money.ts";
import { keyedHash, openText, sealText } from "./sealed.ts";
import { callOff, deskPaid, paidHow, recordAtDesk, refundTo, stillUnpaid } from "./desk_pay.ts";
import { lockCredit } from "./credit.ts";
import { plainName, plainText } from "./plain_text.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
/** No 0/O, 1/I/L, 2/Z, 5/S or 8/B to misread: 26 letters and digits, 16 of them (about 75 bits). */
const ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY";
export function newGiftCode(): string {
  const c = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`;
}
/** A code as typed: case, spaces and dashes don't matter. */
export const giftCodeNorm = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");
/** A code's fingerprint under the server's key (sealed.ts keyedHash), the one stored. */
export const giftCodeHash = (code: string) => keyedHash(giftCodeNorm(code))!;
/** Every fingerprint a stored card may still carry for this code: under the key in use, the key before (while it's
 *  being rotated), or the plain SHA-256 of cards made before keyed fingerprints (made again at the next start). */
function codeHashes(code: string): string[] {
  const n = giftCodeNorm(code);
  return [keyedHash(n), keyedHash(n, "previous"), createHash("sha256").update(n).digest("hex")].filter((h): h is string => Boolean(h));
}
/** Work on one person's tries one change at a time (a lock held until it commits), inside a change of its own when
 *  the caller isn't in one. */
export async function oneAtATime<T>(db: Db | Trx, key: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  const go = async (trx: Trx) => { await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx); return fn(trx); };
  return (db as Trx).isTransaction ? go(db as Trx) : (db as Db).transaction().execute(go);
}
/** Wrong codes a person may try in an hour before redeeming is refused for a while. */
export const GIFT_TRIES_PER_HOUR = 10;

async function clubCards(db: Db | Trx) {
  return db.selectFrom("club").select(["gift_cards", "gift_card_min_cents", "gift_card_max_cents"]).executeTakeFirstOrThrow();
}
async function amountAllowed(db: Db | Trx, cents: number) {
  const c = await clubCards(db);
  if (!c.gift_cards) throw new KumiError("error.gift_cards_off");
  if (cents < c.gift_card_min_cents || cents > c.gift_card_max_cents) throw new KumiError("error.gift_card_amount", { min: usd(c.gift_card_min_cents), max: usd(c.gift_card_max_cents) });
}
/** A new card, waiting for its money (bought in the app) or already paid (at the desk). */
async function makeCard(ctx: ApplyCtx, o: { buyer: string; cents: number; forName?: string; message?: string; via: "app" | "desk"; status: "pending" | "active" }) {
  const id = uuidv7(), code = newGiftCode();
  await ctx.insert("gift_card", { id, code_hash: giftCodeHash(code), code_sealed: sealText(code), last4: code.slice(-4), amount_cents: o.cents, buyer_id: o.buyer,
    for_name: o.forName?.trim() || null, message: o.message?.trim() || null, sold_via: o.via, status: o.status });
  return id;
}
// Typed by a member: made plain (plain_text.ts), so no control or invisible formatting character (a bidi override
// that turns "Sam" around on a receipt) reaches the receipt, its email or the club's download.
const forWhom = { for_name: z.optional(z.string().check(z.overwrite(plainName), z.maxLength(80))), message: z.optional(z.string().check(z.overwrite(plainText), z.maxLength(300))) };

/** The payments of gift cards this person bought in the app that are still waiting for their card. */
export const waitingCards = (db: Db | Trx, personId: string) => db.selectFrom("payment").innerJoin("gift_card", "gift_card.id", "payment.gift_card_id")
  .select(["payment.id", "payment.provider_ref", "payment.provider_account"])
  .where("gift_card.buyer_id", "=", personId).where("gift_card.sold_via", "=", "app").where("gift_card.status", "=", "pending").where("payment.status", "=", "pending").execute();

/** A member buys a gift card in the app: the card waits for its payment, and is theirs to give once the card goes
 *  through (payment.settle -> giftCardPaid). Club credit can't pay for one. Only the member themselves (or their own
 *  assistant): the desk sells one with gift_card.sell. */
export const giftCardBuy = defineAction({
  name: "gift_card.buy", version: 1,
  selfOnly: async (_db, i: { person_id: string }) => i.person_id,
  input: z.object({ person_id: z.uuid(), cents: z.number().check(z.int(), z.minimum(1)), ...forWhom }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    await amountAllowed(ctx.db, i.cents);
    // One bought before and never paid (the card form closed, a card declined, a page that couldn't open its form)
    // is called off, so the list doesn't fill with cards waiting for a payment that isn't coming: unless its card went
    // through or is still being processed (the app says "Paid, thank you: confirming"), asked of the provider now.
    const callOffIds = await stillUnpaid(await waitingCards(ctx.db, i.person_id));
    return { title: both("action.gift_card.buy"), reads: [read], ownerIds: [i.person_id], moneyCents: i.cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both(i.for_name ? "plan.gift_card.buy_for" : "plan.gift_card.buy", { amount: usd(i.cents), name: i.for_name ?? "" }), details: { call_off: callOffIds } };
  },
  async apply(ctx, i, plan) {
    await amountAllowed(ctx.trx, i.cents);
    // Those the plan found unpaid, and any with no card form at all; one whose form opened since is left. If a card
    // called off went through after all, payment.settle records it and gives it all back (callOff).
    const off = new Set((plan.details as { call_off?: string[] } | undefined)?.call_off ?? []);
    for (const p of await waitingCards(ctx.trx, i.person_id)) if (!p.provider_ref || off.has(p.id)) await callOff(ctx, p.id);
    const card = await makeCard(ctx, { buyer: i.person_id, cents: i.cents, forName: i.for_name, message: i.message, via: "app", status: "pending" });
    const payment = uuidv7();
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: i.cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", gift_card_id: card });
    return { gift_card_id: card, payment_id: payment };
  },
});

/** The buyer takes back a card bought in the app that's still waiting for its payment (a card declined, the form
 *  closed): its payment is called off, so no card form opens for it again and it leaves their list. If the card went
 *  through after all (a form still open somewhere), payment.settle records it and gives it all back (callOff); the
 *  card is never theirs to give. Only the buyer, in the app or through their own assistant. */
export const giftCardDrop = defineAction({
  name: "gift_card.drop", version: 1,
  selfOnly: async (db, i: { gift_card_id: string }) => (await db.selectFrom("gift_card").select("buyer_id").where("id", "=", i.gift_card_id).executeTakeFirst())?.buyer_id ?? null,
  input: z.object({ gift_card_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: c, read } = await readRow(ctx.db, "gift_card", i.gift_card_id, "thing.gift_card");
    const waiting = await ctx.db.selectFrom("payment").select("id").where("gift_card_id", "=", i.gift_card_id).where("status", "=", "pending").executeTakeFirst();
    if (c.status !== "pending" || c.sold_via !== "app" || !waiting) throw new KumiError("error.gift_card_not_waiting");
    return { title: both("action.gift_card.drop"), reads: [read], ownerIds: [c.buyer_id], undo: { kind: "none", note: both("reason.buy_again") },
      summary: both(c.for_name ? "plan.gift_card.drop_for" : "plan.gift_card.drop", { amount: usd(c.amount_cents), name: c.for_name ?? "" }) };
  },
  async apply(ctx, i) {
    // Its payments first, then the card: the order payment.settle locks them in (paidNow -> giftCardPaid).
    const pays = await ctx.trx.selectFrom("payment").select(["id", "status"]).where("gift_card_id", "=", i.gift_card_id).orderBy("id").forUpdate().execute();
    const c = await ctx.trx.selectFrom("gift_card").select("status").where("id", "=", i.gift_card_id).forUpdate().executeTakeFirstOrThrow();
    if (c.status !== "pending" || !pays.some((p) => p.status === "pending")) throw new KumiError("error.changed");   // paid meanwhile
    for (const p of pays.filter((x) => x.status === "pending")) await callOff(ctx, p.id);
    return null;
  },
});

/** The desk sells a gift card for a member, paid there: it's theirs at once. */
export const giftCardSell = defineAction({
  name: "gift_card.sell", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), ...deskPaid, ...forWhom }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    await amountAllowed(ctx.db, i.cents);
    return { title: both("action.gift_card.sell"), reads: [read], ownerIds: [i.person_id], moneyCents: i.cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both(i.for_name?.trim() ? "plan.gift_card.sell_for" : "plan.gift_card.sell", { amount: usd(i.cents), name: p.display_name, how: paidHow(i.method), for: i.for_name?.trim() ?? "" }) };
  },
  async apply(ctx, i) {
    await amountAllowed(ctx.trx, i.cents);
    const card = await makeCard(ctx, { buyer: i.person_id, cents: i.cents, forName: i.for_name, message: i.message, via: "desk", status: "active" });
    const payment = await recordAtDesk(ctx, { personId: i.person_id, cents: i.cents, method: i.method, note: i.note, revenue: "gift_cards", memo: "gift card", link: { gift_card_id: card } });
    await ctx.emit("gift_card.ready", { gift_card_id: card });
    return { gift_card_id: card, payment_id: payment };
  },
});

/** The card bought in the app went through: it's ready to give. The payment is locked by its settle. */
export async function giftCardPaid(ctx: ApplyCtx, giftCardId: string) {
  const c = await ctx.trx.selectFrom("gift_card").select("status").where("id", "=", giftCardId).forUpdate().executeTakeFirstOrThrow();
  if (c.status !== "pending") return;
  await ctx.update("gift_card", giftCardId, { status: "active" });
  await ctx.emit("gift_card.ready", { gift_card_id: giftCardId });
}

/** Someone redeems a code into their own club credit, once. Only for themselves: the person asking is the person
 *  named, checked before the code is looked at (nobody can spend someone else's tries or learn whether a code is
 *  live through them). A wrong code counts against them, one try at a time; after GIFT_TRIES_PER_HOUR wrong ones in
 *  an hour, they wait. The code is read by the preview and never kept (planOnly). App only, never support access:
 *  words an assistant reads could hold a code. */
export const giftCardRedeem = defineAction({
  name: "gift_card.redeem", version: 1, planOnly: ["code"], selfOnly: async (_db, i: { person_id: string }) => i.person_id,
  input: z.object({ person_id: z.uuid(), code: z.string().check(z.minLength(4), z.maxLength(40)) }),
  async plan(ctx, i) {
    if (!ctx.actor.personId || ctx.actor.personId !== i.person_id) throw new KumiError("error.forbidden", {}, 403);
    const { read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const found = await oneAtATime(ctx.db, `gift_try:${i.person_id}`, async (trx) => {
      const tries = await trx.selectFrom("gift_card_try").select(sql<string>`count(*)`.as("n")).where("person_id", "=", i.person_id).where("at", ">", new Date(ctx.now.getTime() - 3600_000)).executeTakeFirstOrThrow();
      if (Number(tries.n) >= GIFT_TRIES_PER_HOUR) return "tries" as const;
      const hashes = codeHashes(i.code);
      const card = await trx.selectFrom("gift_card").select(["id", "status", "amount_cents", "code_hash"]).where("code_hash", "in", hashes).executeTakeFirst();
      if (!card || card.status === "pending" || card.status === "void") {
        await trx.insertInto("gift_card_try").values({ person_id: i.person_id, at: ctx.now }).execute();
        return "unknown" as const;
      }
      // A card found by an older fingerprint gets the one under the key in use.
      if (card.code_hash !== hashes[0]) await trx.updateTable("gift_card").set({ code_hash: hashes[0]! }).where("id", "=", card.id).execute();
      return card;
    });
    if (found === "tries") throw new KumiError("error.gift_card_tries");
    if (found === "unknown") throw new KumiError("error.gift_card_unknown");
    const card = found;
    if (card.status === "redeemed") throw new KumiError("error.gift_card_redeemed");
    return { title: both("action.gift_card.redeem"), reads: [read], ownerIds: [i.person_id], moneyCents: card.amount_cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both("plan.gift_card.redeem", { amount: usd(card.amount_cents) }), details: { gift_card_id: card.id } };
  },
  async apply(ctx, i, plan) {
    const id = (plan.details as { gift_card_id: string }).gift_card_id;
    await lockCredit(ctx.trx, i.person_id);
    const c = await ctx.trx.selectFrom("gift_card").select(["status", "amount_cents"]).where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
    // Again under the lock: the same code redeemed twice at once goes to one person, once.
    if (c.status !== "active") throw new KumiError("error.gift_card_redeemed");
    await ctx.update("gift_card", id, { status: "redeemed", redeemed_by: i.person_id, redeemed_at: ctx.now });
    await post(ctx.trx, ctx.runId, "gift_card_redeemed", "gift card redeemed as club credit", [
      { account: await account(ctx.trx, "gift_cards"), cents: c.amount_cents },
      { account: await account(ctx.trx, "member_credit", { personId: i.person_id }), cents: -c.amount_cents }]);
    return { cents: c.amount_cents };
  },
});

/** A manager voids a card nobody has redeemed: the buyer gets the money back the way they paid (to the card, or at
 *  the desk). Never through support access or an assistant. */
export const giftCardVoid = defineAction({
  name: "gift_card.void", version: 1, clubWide: true,
  input: z.object({ gift_card_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: c, read } = await readRow(ctx.db, "gift_card", i.gift_card_id, "thing.gift_card");
    if (c.status !== "active") throw new KumiError(c.status === "redeemed" ? "error.gift_card_redeemed" : "error.gift_card_not_active");
    const buyer = (await ctx.db.selectFrom("person").select("display_name").where("id", "=", c.buyer_id).executeTakeFirstOrThrow()).display_name;
    return { title: both("action.gift_card.void"), reads: [read], ownerIds: [c.buyer_id], moneyCents: c.amount_cents, undo: { kind: "none", note: both("reason.refund_sent") },
      summary: both("plan.gift_card.void", { amount: usd(c.amount_cents), last4: c.last4, name: buyer }) };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("gift_card").select(["status", "amount_cents"]).where("id", "=", i.gift_card_id).forUpdate().executeTakeFirstOrThrow();
    if (c.status !== "active") throw new KumiError("error.changed");   // redeemed meanwhile
    await ctx.update("gift_card", i.gift_card_id, { status: "void", voided_at: ctx.now });
    const pay = await ctx.trx.selectFrom("payment").select("id").where("gift_card_id", "=", i.gift_card_id).where("status", "=", "succeeded").executeTakeFirstOrThrow();
    const r = await refundTo(ctx, pay.id, c.amount_cents);
    return { refund_id: r?.id ?? null };
  },
});

/** Remind the buyer their card is waiting in the app (nothing new is made). */
export const giftCardResend = defineAction({
  name: "gift_card.resend", version: 1, clubWide: true,
  input: z.object({ gift_card_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: c, read } = await readRow(ctx.db, "gift_card", i.gift_card_id, "thing.gift_card");
    if (c.status !== "active") throw new KumiError("error.gift_card_not_active");
    return { title: both("action.gift_card.resend"), reads: [read], ownerIds: [c.buyer_id], undo: { kind: "none", note: both("reason.message_sent") },
      summary: both("plan.gift_card.resend", { last4: c.last4 }) };
  },
  async apply(ctx, i) { await ctx.emit("gift_card.ready", { gift_card_id: i.gift_card_id }); return null; },
});

/** The cards a person bought (with their codes, theirs to give) and redeemed. */
export async function giftCardsOf(db: Db | Trx, personId: string) {
  // One waiting for its payment is listed while that payment still can be made (with its id, for "confirming");
  // one whose payment was called off or failed was never theirs, and isn't.
  const rows = await db.selectFrom("gift_card").selectAll()
    .select((eb) => eb.selectFrom("payment").select("payment.id").whereRef("payment.gift_card_id", "=", "gift_card.id").where("payment.status", "=", "pending").limit(1).as("pending_payment_id"))
    .where((w) => w.or([w("buyer_id", "=", personId), w("redeemed_by", "=", personId)])).orderBy("created_at", "desc").execute();
  return rows.filter((c) => c.status !== "pending" || c.pending_payment_id).map((c) => ({ id: c.id, amount_cents: c.amount_cents, status: c.status, for_name: c.for_name, message: c.message, last4: c.last4, created_at: c.created_at,
    bought: c.buyer_id === personId, code: c.buyer_id === personId && c.status === "active" ? openText(c.code_sealed) : null, redeemed_at: c.redeemed_at, pending_payment_id: c.pending_payment_id ?? null }));
}
/** The club's cards, for staff: never the code. */
export async function clubGiftCards(db: Db | Trx) {
  return db.selectFrom("gift_card").innerJoin("person", "person.id", "gift_card.buyer_id").leftJoin("person as r", "r.id", "gift_card.redeemed_by")
    .select(["gift_card.id", "gift_card.amount_cents", "gift_card.status", "gift_card.last4", "gift_card.sold_via", "gift_card.created_at", "gift_card.redeemed_at", "person.display_name as buyer", "r.display_name as redeemed_by"])
    .where("gift_card.status", "!=", "pending").orderBy("gift_card.created_at", "desc").limit(200).execute();
}
/** What the club owes on cards sold and not yet redeemed (for its books, and any unclaimed-property rules). */
export async function outstandingGiftCards(db: Db | Trx): Promise<{ cents: number; count: number }> {
  const r = await db.selectFrom("gift_card").select([sql<string>`coalesce(sum(amount_cents), 0)`.as("c"), sql<string>`count(*)`.as("n")]).where("status", "=", "active").executeTakeFirstOrThrow();
  return { cents: Number(r.c), count: Number(r.n) };
}
