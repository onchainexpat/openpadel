// What the 0.3.0 money review found in club credit's pay-out warning, buying a gift card or a pass again, who may buy
// one for a member, and the restore alert that stays until handled.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "./helpers.ts";
import { checkMoneyAfterRestore, checkPayment, creditBalance, giftCardsOf, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, setSecretKeys, staffAlerts,
  KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, court: string, clinic: string, clinicPass: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const ref = async (paymentId: string) => (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
async function cardPaid(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle(await ref(paymentId), "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const status = async (t: "payment" | "gift_card" | "pass", id: string) => (await db.selectFrom(t).select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  setSecretKeys({ current: randomBytes(32).toString("base64") });
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve", "Mia"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  await run(db, "role.assign", { person_id: people.Mia, role: "manager" }, owner, opts);
  desk = as("Lee");
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 6, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  clinicPass = ((await run(db, "pass_product.set", { name: "3 clinic places", covers: "programs", program_kinds: ["clinic"], price_cents: 15000, uses: 3 }, owner, opts)).result as { product_id: string }).product_id;
});
after(async () => { await drop(); setSecretKeys({}); });

test("credit from a use of a pass bought by card is card money: paying it out in cash is warned of", async () => {
  // Cal buys a pass by card and spends a use on a clinic place; the owner refunds the pass; Cal leaves the clinic in
  // time, and the use's $50 goes to Cal's club credit (the pass is gone).
  const r = (await run(db, "pass.buy", { person_id: people.Cal, product_id: clinicPass }, as("Cal"), opts)).result as { pass_id: string; payment_id: string };
  assert.equal(await cardPaid(r.payment_id, "Cal"), "succeeded");
  const e = (await run(db, "enrolment.join", { program_id: clinic, person_id: people.Cal }, as("Cal"), opts)).result as { enrolment_id: string; payment_id: string };
  await run(db, "payment.use_pass", { payment_id: e.payment_id, pass_id: r.pass_id }, as("Cal"), opts);
  await run(db, "pass.refund", { pass_id: r.pass_id }, owner, opts);
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Cal"), opts);
  assert.equal(await creditBalance(db, people.Cal!), 5000);
  const out = await plan(db, "credit.pay_out", { person_id: people.Cal, cents: 5000, method: "cash" }, owner, opts);
  assert.equal((out.plan.details as any).card_refunds, 5000);
  assert.match(out.plan.summary.en, /stolen card/);
});

test("credit spent is taken from what wasn't card money first, so the warning can't be spent away", async () => {
  // Dee: $40 paid in cash at the desk and $40 paid by card, both refunded as credit. $80 of credit.
  const cash = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-28T10:00:00-08:00", minutes: 60, person_id: people.Dee }, desk, opts)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: cash, cents: 4000, method: "cash" }, desk, opts);
  await run(db, "booking.cancel", { booking_id: cash, refund: "credit" }, desk, opts);
  const card = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T10:00:00-08:00", minutes: 60, person_id: people.Dee, pay: "whole" }, as("Dee"), opts)).result as { booking_id: string; payment_id: string };
  assert.equal(await cardPaid(card.payment_id, "Dee"), "succeeded");
  await run(db, "booking.cancel", { booking_id: card.booking_id, refund: "credit" }, desk, opts);
  // Dee spends $40 of it on a court: the $40 left may as well be the card's.
  const spend = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-13T10:00:00-08:00", minutes: 60, person_id: people.Dee, pay: "whole" }, as("Dee"), opts)).result as { payment_id: string };
  await run(db, "payment.use_credit", { payment_id: spend.payment_id }, as("Dee"), opts);
  assert.equal(await creditBalance(db, people.Dee!), 4000);
  const out = await plan(db, "credit.pay_out", { person_id: people.Dee, cents: 4000, method: "cash" }, owner, opts);
  assert.equal((out.plan.details as any).card_refunds, 4000);
  assert.match(out.plan.summary.en, /stolen card/);
});

test("buying a gift card again leaves an earlier one whose card went through: it's recorded and the card is theirs", async () => {
  const a = (await run(db, "gift_card.buy", { person_id: people.Ann, cents: 5000, for_name: "Maya" }, as("Ann"), opts)).result as { gift_card_id: string; payment_id: string };
  await openPayment(db, a.payment_id, people.Ann!);
  stripe.settle(await ref(a.payment_id), "succeeded");   // the card went through; the app says "Paid, thank you: confirming"
  await run(db, "gift_card.buy", { person_id: people.Ann, cents: 3000, for_name: "Sam" }, as("Ann"), opts);
  assert.equal(await status("payment", a.payment_id), "pending", "not called off");
  assert.equal(await checkPayment(db, a.payment_id, "test", NOW), "succeeded");
  assert.equal((await db.selectFrom("refund").select("id").where("payment_id", "=", a.payment_id).execute()).length, 0, "nothing given back");
  assert.equal(await status("gift_card", a.gift_card_id), "active");
  assert.ok((await giftCardsOf(db, people.Ann!)).some((c) => c.id === a.gift_card_id));
});

test("buying a gift card again leaves an earlier one still being processed, and still calls off one whose card was declined", async () => {
  const slow = (await run(db, "gift_card.buy", { person_id: people.Eve, cents: 5000 }, as("Eve"), opts)).result as { payment_id: string };
  await openPayment(db, slow.payment_id, people.Eve!);
  stripe.processing(await ref(slow.payment_id));
  await run(db, "gift_card.buy", { person_id: people.Eve, cents: 4000 }, as("Eve"), opts);
  assert.equal(await status("payment", slow.payment_id), "pending", "a card being processed isn't called off");
  // A card declined stays a pending intent at the provider (another card may be tried): buying again calls it off.
  const declined = (await run(db, "gift_card.buy", { person_id: people.Ben, cents: 5000 }, as("Ben"), opts)).result as { payment_id: string };
  await openPayment(db, declined.payment_id, people.Ben!);
  await run(db, "gift_card.buy", { person_id: people.Ben, cents: 4000 }, as("Ben"), opts);
  assert.equal(await status("payment", declined.payment_id), "failed");
});

test("buying a pass again leaves an earlier one whose card went through: it's recorded and the pass is theirs", async () => {
  const a = (await run(db, "pass.buy", { person_id: people.Ann, product_id: clinicPass }, as("Ann"), opts)).result as { pass_id: string; payment_id: string };
  await openPayment(db, a.payment_id, people.Ann!);
  stripe.settle(await ref(a.payment_id), "succeeded");
  await run(db, "pass.buy", { person_id: people.Ann, product_id: clinicPass }, as("Ann"), opts);
  assert.equal(await status("payment", a.payment_id), "pending");
  assert.equal(await checkPayment(db, a.payment_id, "test", NOW), "succeeded");
  assert.equal(await status("pass", a.pass_id), "active");
});

test("only the member buys a gift card or a pass in the app: not a manager, nor support access; the desk sells them its own way", async () => {
  const a = (await run(db, "gift_card.buy", { person_id: people.Cal, cents: 5000 }, as("Cal"), opts)).result as { payment_id: string };
  await rejects(plan(db, "gift_card.buy", { person_id: people.Cal, cents: 2000 }, as("Mia"), opts), "error.forbidden_reason");
  await rejects(plan(db, "pass.buy", { person_id: people.Cal, product_id: clinicPass }, as("Mia"), opts), "error.forbidden_reason");
  const g = (await run(db, "support.grant", { email: "ada@help.test", name: "ada", reason: "Looking at the booking rules", level: "manager", hours: 24 }, { ...owner, auth: "passkey" } as Actor, opts)).result as { person_id: string };
  const sup = { personId: g.person_id, via: "test", lang: "en", auth: "two_factor" } as Actor;
  await rejects(plan(db, "gift_card.buy", { person_id: people.Cal, cents: 2000 }, sup, opts), "error.forbidden_reason");
  assert.equal(await status("payment", a.payment_id), "pending", "Cal's waiting card is untouched");
  // The desk still sells both, paid there.
  const sold = (await run(db, "gift_card.sell", { person_id: people.Cal, cents: 2000, method: "cash" }, desk, opts)).result as { gift_card_id: string };
  assert.equal(await status("gift_card", sold.gift_card_id), "active");
  const pass = (await run(db, "pass.sell", { person_id: people.Cal, product_id: clinicPass, cents: 15000, method: "cash" }, desk, opts)).result as { pass_id: string };
  assert.equal(await status("pass", pass.pass_id), "active");
});

test("an alert a restore left stays on Today past the usual 14 days until someone handles it", async () => {
  class Cut extends TestProvider { override async listSince() { return { intents: [], refunds: [], cut: true }; } }
  setPaymentProvider(new Cut());
  try {
    const now = new Date();
    await db.insertInto("restore_check").values({ since: new Date(now.getTime() - 86400_000) }).execute();
    await checkMoneyAfterRestore(db, now);
    await processOutbox(db, messageHandlers);
    const open = (at: Date) => staffAlerts(db, owner.personId!, at).then((x) => x.open.filter((o) => o.kind === "ops_restore_staff"));
    assert.equal((await open(now)).length, 1);
    assert.equal((await open(new Date(now.getTime() + 30 * 86400_000))).length, 1, "still there a month later");
    const a = (await open(now))[0]!;
    await run(db, "alert.handle", { event_id: a.event_id, kind: "ops_restore_staff" }, owner, { now });
    assert.equal((await open(new Date(now.getTime() + 30 * 86400_000))).length, 0, "gone once handled");
  } finally { setPaymentProvider(stripe); }
});
