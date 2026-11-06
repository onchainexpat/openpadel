// Gift cards (gift_cards.ts): bought by card or at the desk, a liability until redeemed, redeemed once into club credit,
// codes unguessable and tried a limited number of times, voided back to the buyer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, creditBalance, deskLines, giftCardsOf, issueReceipts, messageHandlers, receiptView, openPayment, outstandingGiftCards, plan, processOutbox, run, runAsSystem, setPaymentProvider,
  GIFT_TRIES_PER_HOUR, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor;
const stripe = new TestProvider();
const NOW = new Date("2026-11-04T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function held(kind: string, personId?: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind as any).$if(Boolean(personId), (q) => q.where("ledger_account.person_id", "=", personId!)).executeTakeFirst();
  return Number(r?.c ?? 0);
}
/** A card bought in the app by `who`, paid by card: its code. */
async function bought(who: string, cents: number) {
  const r = (await run(db, "gift_card.buy", { person_id: people[who], cents, for_name: "Sam" }, as(who), opts)).result as { gift_card_id: string; payment_id: string };
  assert.equal((await giftCardsOf(db, people[who]!)).find((c) => c.id === r.gift_card_id)?.code, null, "no code before it's paid");
  await openPayment(db, r.payment_id, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, r.payment_id, "test", NOW), "succeeded");
  const card = (await giftCardsOf(db, people[who]!)).find((c) => c.id === r.gift_card_id)!;
  assert.equal(card.status, "active");
  assert.match(card.code!, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return { ...r, code: card.code! };
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
});
after(async () => drop());

test("off until the club sells them; then within its amounts; paid, it's owed (not revenue) and the buyer hears where the code is", async () => {
  await rejects(plan(db, "gift_card.buy", { person_id: people.Ann, cents: 5000 }, as("Ann"), opts), "error.gift_cards_off");
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor, opts);
  await rejects(plan(db, "gift_card.buy", { person_id: people.Ann, cents: 500 }, as("Ann"), opts), "error.gift_card_amount");
  const { payment_id } = await bought("Ann", 5000);
  // Its receipt says what it was for, written when read: "Gift card for Sam", not "Payment".
  await issueReceipts(db, { now: NOW });
  const rc = await db.selectFrom("receipt_payment").select("receipt_id").where("payment_id", "=", payment_id).executeTakeFirst();
  assert.ok(rc, "a receipt for the gift card");
  assert.deepEqual((await receiptView(db, rc.receipt_id))!.lines[0]!.what, { en: "Gift card for Sam", es: "Tarjeta regalo para Sam" });
  assert.deepEqual([await held("gift_cards"), await held("revenue")], [-5000, 0], "a liability until it's used");
  // Club credit can't buy one.
  await rejects(plan(db, "payment.use_credit", { payment_id }, as("Ann"), opts), "error.credit_paid");
  await processOutbox(db, messageHandlers);
  const m = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Ann!).where("kind", "=", "gift_card_ready").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(m.subject, "Your $50.00 gift card is ready");
  const code = (await giftCardsOf(db, people.Ann!))[0]!.code!;
  assert.ok(!m.body.includes(code), "the code is never in an email");
});

test("redeemed once into the redeemer's credit, even twice at once; its value leaves the liability", async () => {
  const { code } = await bought("Ann", 4000);
  const p1 = await plan(db, "gift_card.redeem", { person_id: people.Ben, code: code.toLowerCase().replace(/-/g, " ") }, as("Ben"), opts);
  assert.equal(p1.plan.summary.en, "Add $40.00 to your club credit from this gift card.");
  const p2 = await plan(db, "gift_card.redeem", { person_id: people.Cal, code }, as("Cal"), opts);
  const out = await Promise.allSettled([apply(db, p1.runId, as("Ben"), opts), apply(db, p2.runId, as("Cal"), opts)]);
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await creditBalance(db, people.Ben!)) + (await creditBalance(db, people.Cal!)), 4000);
  await rejects(plan(db, "gift_card.redeem", { person_id: people.Dee, code }, as("Dee"), opts), "error.gift_card_redeemed");
  assert.equal((await outstandingGiftCards(db)).cents, 5000, "only the first card is still owed");
});

test("wrong codes are limited per person; an assistant can't redeem", async () => {
  for (let i = 0; i < GIFT_TRIES_PER_HOUR; i++) await rejects(plan(db, "gift_card.redeem", { person_id: people.Dee, code: `WRONG-CODE-${i}` }, as("Dee"), opts), "error.gift_card_unknown");
  const { code } = await bought("Ann", 2000);
  await rejects(plan(db, "gift_card.redeem", { person_id: people.Dee, code }, as("Dee"), opts), "error.gift_card_tries");
  await assert.rejects(plan(db, "gift_card.redeem", { person_id: people.Cal, code }, { ...as("Cal"), agentId: "00000000-0000-7000-8000-00000000abcd", auth: "oauth" } as Actor, opts));
});

test("voided before it's used: back to the buyer's card; sold at the desk, it's on the desk's day", async () => {
  const { gift_card_id } = await bought("Ann", 3000);
  await assert.rejects(plan(db, "gift_card.void", { gift_card_id }, desk, opts), "the front desk can't void");
  await run(db, "gift_card.void", { gift_card_id }, owner, opts);
  const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(["refund.destination", "refund.amount_cents"]).where("payment.gift_card_id", "=", gift_card_id).executeTakeFirstOrThrow();
  assert.deepEqual([r.destination, r.amount_cents], ["card", 3000]);
  // The preview names who it's for when the desk says (phone check 5: it was stored, but the preview didn't say).
  const forMaya = await plan(db, "gift_card.sell", { person_id: people.Dee, cents: 2500, method: "cash", for_name: "Maya" }, desk, opts);
  assert.match(forMaya.plan.summary.en, /^Sell Dee a \$25\.00 gift card for Maya, paid in cash\./);
  assert.match(forMaya.plan.summary.es, /para Maya/);
  const sold = (await run(db, "gift_card.sell", { person_id: people.Dee, cents: 2500, method: "cash" }, desk, opts)).result as { gift_card_id: string };
  assert.equal((await giftCardsOf(db, people.Dee!)).find((c) => c.id === sold.gift_card_id)?.status, "active");
  const lines = await deskLines(db, "2026-11-04", "2026-11-04");
  assert.ok(lines.some((l) => l.kind === "in" && l.cents === 2500 && l.method === "cash"), JSON.stringify(lines));
});

test("read-only: nothing is sold or redeemed", async () => {
  const { code } = await bought("Ann", 1500);
  await db.updateTable("club").set({ read_only_since: NOW }).execute();
  await assert.rejects(plan(db, "gift_card.buy", { person_id: people.Ann, cents: 2000 }, as("Ann"), opts));
  await assert.rejects(plan(db, "gift_card.redeem", { person_id: people.Ben, code }, as("Ben"), opts));
  await db.updateTable("club").set({ read_only_since: null }).execute();
});
