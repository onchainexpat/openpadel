// What the sixth phone check found, in the core. A gift card whose card was declined stayed "Waiting for payment" on the
// buyer's list with no way to pay or remove it: the buyer can now take it back (gift_card.drop), and nothing can be
// charged for it after. And a profile preview with nothing changed read "Change  on your profile."
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, giftCardsOf, openPayment, plan, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const stripe = new TestProvider();
const NOW = new Date("2026-11-06T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const payment = (id: string) => db.selectFrom("payment").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
/** Ann buys a card for Maya in the app and opens its card form, which the bank declines: it's left waiting. */
async function declined(cents: number) {
  const r = (await run(db, "gift_card.buy", { person_id: people.Ann, cents, for_name: "Maya" }, as("Ann"), opts)).result as { gift_card_id: string; payment_id: string };
  await openPayment(db, r.payment_id, people.Ann!);
  return { ...r, ref: (await payment(r.payment_id)).provider_ref! };
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Ann", "Ben"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor, opts);
});
after(async () => drop());

test("a card waiting for its payment is taken back by its buyer only, and nothing can be charged for it after", async () => {
  const { gift_card_id, payment_id, ref } = await declined(5000);
  const listed = (await giftCardsOf(db, people.Ann!)).find((c) => c.id === gift_card_id);
  assert.equal(listed?.status, "pending");
  assert.equal(listed?.pending_payment_id, payment_id, "listed with the payment its Pay button opens again");
  // Someone else can't, not even to learn it's there.
  await rejects(plan(db, "gift_card.drop", { gift_card_id }, as("Ben"), opts), "error.forbidden_reason");
  const p = await plan(db, "gift_card.drop", { gift_card_id }, as("Ann"), opts);
  assert.equal(p.plan.summary.en, "Remove the $50.00 gift card for Maya that's waiting for payment. It can't be paid after this; buy another if you want one.");
  assert.equal(p.plan.summary.es, "Quitar la tarjeta regalo de $50.00 para Maya que espera el pago. Ya no se podrá pagar; compra otra si la quieres.");
  await apply(db, p.runId, as("Ann"), opts);
  assert.equal((await payment(payment_id)).status, "failed", "its payment is called off");
  const offs = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "payment.call_off").execute();
  assert.ok(offs.some((e) => (e.payload as { payment_id?: string } | null)?.payment_id === payment_id), "and the card form's intent is cancelled at the provider");
  assert.equal((await giftCardsOf(db, people.Ann!)).find((c) => c.id === gift_card_id), undefined, "it leaves the list");
  // No card form opens for it again: Pay can't charge it.
  await rejects(openPayment(db, payment_id, people.Ann!), "error.not_pending");
  await rejects(plan(db, "gift_card.drop", { gift_card_id }, as("Ann"), opts), "error.gift_card_not_waiting");
  // A form still open somewhere took the card anyway: recorded, then all of it goes back, and the card is never live.
  stripe.settle(ref, "succeeded");
  await checkPayment(db, payment_id, "test", NOW);
  assert.equal((await payment(payment_id)).status, "succeeded");
  const back = await db.selectFrom("refund").select(["amount_cents"]).where("payment_id", "=", payment_id).execute();
  assert.deepEqual(back.map((r) => r.amount_cents), [5000], "all of it back, once");
  assert.equal((await db.selectFrom("gift_card").select("status").where("id", "=", gift_card_id).executeTakeFirstOrThrow()).status, "pending", "never ready to give");
  assert.equal((await giftCardsOf(db, people.Ann!)).find((c) => c.id === gift_card_id), undefined);
});

test("a card that's paid can't be taken back this way, nor one paid while its preview was open", async () => {
  // Paid: the club voids it (gift_card.void), the money going back the way it came.
  const paid = await declined(3000);
  stripe.settle(paid.ref, "succeeded");
  assert.equal(await checkPayment(db, paid.payment_id, "test", NOW), "succeeded");
  await rejects(plan(db, "gift_card.drop", { gift_card_id: paid.gift_card_id }, as("Ann"), opts), "error.gift_card_not_waiting");
  // Previewed while waiting, then the card went through before Confirm: refused, and it stays theirs.
  const racing = await declined(2000);
  const p = await plan(db, "gift_card.drop", { gift_card_id: racing.gift_card_id }, as("Ann"), opts);
  stripe.settle(racing.ref, "succeeded");
  assert.equal(await checkPayment(db, racing.payment_id, "test", NOW), "succeeded");
  await assert.rejects(apply(db, p.runId, as("Ann"), opts));
  assert.equal((await db.selectFrom("gift_card").select("status").where("id", "=", racing.gift_card_id).executeTakeFirstOrThrow()).status, "active");
  assert.equal(await db.selectFrom("refund").select("id").where("payment_id", "=", racing.payment_id).executeTakeFirst(), undefined, "nothing given back");
});

test("a profile preview with nothing changed says so plainly, with nothing to confirm", async () => {
  const me = await db.selectFrom("person").select(["display_name", "locale"]).where("id", "=", people.Ann!).executeTakeFirstOrThrow();
  await rejects(plan(db, "person.update_profile", { person_id: people.Ann, display_name: me.display_name, locale: me.locale as "en" }, as("Ann"), opts), "error.nothing_changed");
  await rejects(plan(db, "person.update_profile", { person_id: people.Ann }, as("Ann"), opts), "error.nothing_changed");
  const p = await plan(db, "person.update_profile", { person_id: people.Ann, display_name: "Ann Lee", locale: me.locale as "en" }, as("Ann"), opts);
  assert.doesNotMatch(p.plan.summary.en, /Change\s{2}/);
  assert.match(p.plan.summary.en, /name/i);
});
