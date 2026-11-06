// Promo codes (promo_codes.ts): made by the owner, applied before the card form opens (the payment asked again for
// what's left, or paid when it's all off), held to their dates, areas, smallest spend and uses, never on gift cards
// or passes, one per payment, the last use never taken twice, refunds never more than was paid, and on the receipt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, court: string, clinic: string, drills: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function cardPaid(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const code = async (input: object) => ((await run(db, "promo_code.set", input, owner, opts)).result as { promo_code_id: string }).promo_code_id;
const join = async (who: string, program = clinic) => (await run(db, "enrolment.join", { program_id: program, person_id: people[who] }, as(who), opts)).result as { enrolment_id: string; payment_id: string };
const use = async (paymentId: string, c: string, who: string) => (await run(db, "payment.use_promo", { payment_id: paymentId, code: c }, as(who), opts)).result as { paid: boolean; payment_id: string; rest_cents?: number };

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true, gift_cards: true }, owner, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 8, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  drills = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Drills", capacity: 8, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: drills, starts_at: "2026-12-11T18:00:00-08:00", ends_at: "2026-12-11T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: drills }, owner, opts);
});
after(async () => drop());

test("25% off a clinic place: asked again for $45, paid by card, the receipt names the discount; leaving gets back only what was paid", async () => {
  await rejects(plan(db, "promo_code.set", { code: "BAD", kind: "percent", applies_to: ["programs"] }, owner, opts), "error.promo_amount");
  await code({ code: "WELCOME25", kind: "percent", percent: 25, applies_to: ["programs"], max_per_person: 1 });
  await rejects(plan(db, "promo_code.set", { code: "welcome25", kind: "amount", amount_cents: 500, applies_to: ["courts"] }, owner, opts), "error.promo_taken");
  const e = await join("Ann");
  const p = await plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "welcome25" }, as("Ann"), opts);
  assert.match(p.plan.summary.en, /^Use the code WELCOME25 on .*: \$15\.00 off, \$45\.00 left to pay\.$/);
  const r = (await apply(db, p.runId, as("Ann"), opts)) as { paid: boolean; payment_id: string; rest_cents: number };
  assert.deepEqual([r.paid, r.rest_cents], [false, 4500]);
  const old = await db.selectFrom("payment").select("status").where("id", "=", e.payment_id).executeTakeFirstOrThrow();
  assert.equal(old.status, "failed", "the old ask is called off: the card is never asked for $60");
  // One code per payment.
  await rejects(plan(db, "payment.use_promo", { payment_id: r.payment_id, code: "WELCOME25" }, as("Ann"), opts), "error.promo_one");
  assert.equal(await cardPaid(r.payment_id, "Ann"), "succeeded");
  // Once per person.
  const again = await join("Ann", drills);
  await rejects(plan(db, "payment.use_promo", { payment_id: again.payment_id, code: "WELCOME25" }, as("Ann"), opts), "error.promo_used_by_you");
  // The receipt (issued for the payment) says what was taken off.
  await runAsSystem(db, "receipt.issue", { payment_id: r.payment_id }, "test", opts);
  const line = await db.selectFrom("receipt").innerJoin("receipt_payment", "receipt_payment.receipt_id", "receipt.id").select("receipt.lines").where("receipt_payment.payment_id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.match(JSON.stringify(line.lines), /promo code: \$15\.00 off/);
  // Leaving in time: $45 back, what was paid, never $60.
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Ann"), opts);
  const back = await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.equal(back.amount_cents, 4500);
});

test("all of it off goes through with nothing to pay; codes keep to their areas, smallest spend and dates; never on a gift card or a pass", async () => {
  await code({ code: "FREECOURT", kind: "amount", amount_cents: 10000, applies_to: ["courts"] });
  await code({ code: "BIG", kind: "amount", amount_cents: 1000, applies_to: ["courts", "programs"], min_spend_cents: 5000 });
  await code({ code: "OVER", kind: "percent", percent: 10, applies_to: ["programs"], ends_at: "2026-11-01T00:00:00-07:00" });
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T10:00:00-08:00", minutes: 60, person_id: people.Ben, pay: "whole" }, as("Ben"), opts)).result as { booking_id: string; payment_id: string };
  await rejects(plan(db, "payment.use_promo", { payment_id: b.payment_id, code: "BIG" }, as("Ben"), opts), "error.promo_min_spend");
  const e = await join("Ben");
  await rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "FREECOURT" }, as("Ben"), opts), "error.promo_not_for_this");
  await rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "OVER" }, as("Ben"), opts), "error.promo_dates");
  await rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "NOPE" }, as("Ben"), opts), "error.promo_unknown");
  const r = await use(b.payment_id, "freecourt", "Ben");
  assert.equal(r.paid, true);
  const paid = await db.selectFrom("payment").select(["status", "method", "discount_cents"]).where("id", "=", b.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([paid.status, paid.method, paid.discount_cents], ["succeeded", "promo", 4000]);
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", b.booking_id).executeTakeFirstOrThrow()).status, "confirmed");
  // Cancelled: nothing was paid, so nothing goes back.
  await run(db, "booking.cancel", { booking_id: b.booking_id }, as("Ben"), opts);
  assert.equal((await db.selectFrom("refund").select("id").where("payment_id", "=", b.payment_id).execute()).length, 0);
  const g = (await run(db, "gift_card.buy", { person_id: people.Ben, cents: 5000 }, as("Ben"), opts)).result as { payment_id: string };
  await rejects(plan(db, "payment.use_promo", { payment_id: g.payment_id, code: "BIG" }, as("Ben"), opts), "error.promo_not_for_this");
  const product = ((await run(db, "pass_product.set", { name: "10 courts", covers: "courts", price_cents: 30000, uses: 10 }, owner, opts)).result as { product_id: string }).product_id;
  const pass = (await run(db, "pass.buy", { person_id: people.Ben, product_id: product }, as("Ben"), opts)).result as { payment_id: string };
  await rejects(plan(db, "payment.use_promo", { payment_id: pass.payment_id, code: "BIG" }, as("Ben"), opts), "error.promo_not_for_this");
});

test("two checkouts take a code's last use at once: one gets it, the other is refused and still owes in full; a use never paid doesn't count", async () => {
  await code({ code: "LAST", kind: "amount", amount_cents: 1000, applies_to: ["programs"], max_uses: 1, max_per_person: 5 });
  const c = await join("Cal"), d = await join("Dee");
  const pc = await plan(db, "payment.use_promo", { payment_id: c.payment_id, code: "LAST" }, as("Cal"), opts);
  const pd = await plan(db, "payment.use_promo", { payment_id: d.payment_id, code: "LAST" }, as("Dee"), opts);
  const results = await Promise.allSettled([apply(db, pc.runId, as("Cal"), opts), apply(db, pd.runId, as("Dee"), opts)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as KumiError).code, "error.changed");
  const won = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ payment_id: string }>).value;
  assert.equal(Number((await db.selectFrom("promo_use").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n) >= 1, true);
  // The winner gives up their place before paying: their lowered ask is called off, and the use comes free again.
  const winner = won.payment_id === (await db.selectFrom("payment").select("id").where("enrolment_id", "=", c.enrolment_id).where("status", "=", "pending").executeTakeFirst())?.id ? c : d;
  await run(db, "enrolment.leave", { enrolment_id: winner.enrolment_id }, as(winner === c ? "Cal" : "Dee"), opts);
  const e = await join("Eve");
  const r = await use(e.payment_id, "LAST", "Eve");
  assert.equal(r.rest_cents, 5000);
});

test("read-only takes no code", async () => {
  await code({ code: "QUIET", kind: "percent", percent: 10, applies_to: ["programs"], max_per_person: 5 });
  const e = await join("Eve", drills);
  await runAsSystem(db, "club.read_only", { on: true }, "host", opts);
  try { await rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "QUIET" }, as("Eve"), opts), "error.read_only"); }
  finally { await runAsSystem(db, "club.read_only", { on: false }, "host", opts); }
});
