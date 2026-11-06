// Passes (passes.ts): made by the owner, sold at the desk or bought by card in the app, a use taken when a place or a
// court is paid with one (as a card would pay it), given back when the club's rules refund it in full and spent when
// they don't, never taken twice at once, refunded pro rata by a manager, and kept apart from read-only and assistants.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, weekSpent, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, court: string, clinic: string, clinicPass: string, courtPass: string;
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
const sell = async (who: string, product: string, price: number) =>
  ((await run(db, "pass.sell", { person_id: people[who], product_id: product, cents: price, method: "cash" }, desk, opts)).result as { pass_id: string }).pass_id;
const pass = (id: string) => db.selectFrom("pass").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const join = async (who: string) => (await run(db, "enrolment.join", { program_id: clinic, person_id: people[who] }, as(who), opts)).result as { enrolment_id: string; payment_id: string };
async function held(kind: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind as any).executeTakeFirst();
  return -Number(r?.c ?? 0);
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 6, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  const make = async (input: object) => ((await run(db, "pass_product.set", input, owner, opts)).result as { product_id: string }).product_id;
  clinicPass = await make({ name: "3 clinic places", covers: "programs", program_kinds: ["clinic"], price_cents: 15000, uses: 3 });
  courtPass = await make({ name: "5 courts up to an hour", covers: "courts", max_minutes: 60, price_cents: 17500, uses: 5 });
});
after(async () => drop());

test("a pass sold at the desk pays a clinic place; leaving in time gives the use back; the books follow each use", async () => {
  await rejects(plan(db, "pass_product.set", { name: "Expires soon", covers: "courts", price_cents: 1000, uses: 2, valid_days: 30 }, owner, opts), "error.invalid_input");
  await rejects(plan(db, "pass.sell", { person_id: people.Ann, product_id: clinicPass, cents: 10000, method: "cash" }, desk, opts), "error.pass_price");
  const id = await sell("Ann", clinicPass, 15000);
  assert.equal(await held("passes"), 15000, "owed until used");
  const e = await join("Ann");
  const p = await plan(db, "payment.use_pass", { payment_id: e.payment_id, pass_id: id }, as("Ann"), opts);
  assert.match(p.plan.summary.en, /^Pay for .* with one use of 3 clinic places\. 2 left after this\./);
  await apply(db, p.runId, as("Ann"), opts);
  const paid = await db.selectFrom("payment").select(["status", "method"]).where("id", "=", e.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([paid.status, paid.method], ["succeeded", "pass"]);
  assert.equal((await pass(id)).uses_left, 2);
  assert.equal(await held("passes"), 10000, "one use's share ($50) moved to revenue");
  // Leaving in time refunds a card in full: the use comes back instead, and nothing goes to a card.
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Ann"), opts);
  assert.equal((await pass(id)).uses_left, 3);
  const back = await db.selectFrom("refund").select(["destination", "status"]).where("payment_id", "=", e.payment_id).execute();
  assert.deepEqual(back.map((r) => [r.destination, r.status]), [["pass", "sent"]]);
  assert.equal(await held("passes"), 15000);
});

test("a court pass covers a court paid whole up to its length; cancelled in time the use comes back, late it's spent", async () => {
  const id = await sell("Ben", courtPass, 17500);
  const long = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T10:00:00-08:00", minutes: 90, person_id: people.Ben, pay: "whole" }, as("Ben"), opts)).result as { payment_id: string };
  await rejects(plan(db, "payment.use_pass", { payment_id: long.payment_id, pass_id: id }, as("Ben"), opts), "error.pass_not_for_this");
  // Someone else's pass can't pay it; a clinic pass doesn't cover courts.
  const clinics = await sell("Cal", clinicPass, 15000);
  const hour = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-13T10:00:00-08:00", minutes: 60, person_id: people.Ben, pay: "whole" }, as("Ben"), opts)).result as { booking_id: string; payment_id: string };
  await rejects(plan(db, "payment.use_pass", { payment_id: hour.payment_id, pass_id: clinics }, as("Ben"), opts), "error.pass_not_theirs");
  await run(db, "payment.use_pass", { payment_id: hour.payment_id, pass_id: id }, as("Ben"), opts);
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", hour.booking_id).executeTakeFirstOrThrow()).status, "confirmed");
  assert.equal((await pass(id)).uses_left, 4);
  await run(db, "booking.cancel", { booking_id: hour.booking_id }, as("Ben"), opts);
  assert.equal((await pass(id)).uses_left, 5, "in time: the use is back");
  // Too late for a refund (tomorrow morning, well inside the club's free-cancel time): the use is spent.
  const soon = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-05T09:00:00-08:00", minutes: 60, person_id: people.Ben, pay: "whole" }, as("Ben"), opts)).result as { booking_id: string; payment_id: string };
  await run(db, "payment.use_pass", { payment_id: soon.payment_id, pass_id: id }, as("Ben"), opts);
  await run(db, "booking.cancel", { booking_id: soon.booking_id }, as("Ben"), opts);
  assert.equal((await pass(id)).uses_left, 4, "late: spent, as a card would get nothing back");
  assert.equal((await db.selectFrom("refund").select("id").where("payment_id", "=", soon.payment_id).execute()).length, 0);
});

test("two checkouts take a pass's last use at once: one is paid with it, the other is refused and still owes", async () => {
  const p = await db.selectFrom("pass_product").select("id").where("id", "=", clinicPass).executeTakeFirstOrThrow();
  const one = ((await run(db, "pass_product.set", { name: "1 drop-in", covers: "programs", price_cents: 2500, uses: 1 }, owner, opts)).result as { product_id: string }).product_id;
  assert.ok(p.id);
  const id = await sell("Dee", one, 2500);
  const second = (await run(db, "program.create", { location_id: loc, kind: "social", name: "Friday social", capacity: 8, price_cents: 2000 }, owner, opts)).result as any;
  await run(db, "session.add", { program_id: second.program_id, starts_at: "2026-12-11T18:00:00-08:00", ends_at: "2026-12-11T20:00:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: second.program_id }, owner, opts);
  const a = await join("Dee");
  const b = (await run(db, "enrolment.join", { program_id: second.program_id, person_id: people.Dee }, as("Dee"), opts)).result as { payment_id: string };
  const pa = await plan(db, "payment.use_pass", { payment_id: a.payment_id, pass_id: id }, as("Dee"), opts);
  const pb = await plan(db, "payment.use_pass", { payment_id: b.payment_id, pass_id: id }, as("Dee"), opts);
  const results = await Promise.allSettled([apply(db, pa.runId, as("Dee"), opts), apply(db, pb.runId, as("Dee"), opts)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((lost.reason as KumiError).code, "error.changed");
  assert.equal((await pass(id)).uses_left, 0);
  const statuses = await db.selectFrom("payment").select("status").where("id", "in", [a.payment_id, b.payment_id]).execute();
  assert.deepEqual(statuses.map((s) => s.status).sort(), ["pending", "succeeded"]);
  // The last use took all of what was left of the price: the drop-in's $25 is all revenue now.
  assert.equal(Number((await db.selectFrom("pass_use").select("value_cents").where("pass_id", "=", id).executeTakeFirstOrThrow()).value_cents), 2500);
});

test("bought by card in the app; a manager refunds the unused uses pro rata, to the card", async () => {
  const r = (await run(db, "pass.buy", { person_id: people.Cal, product_id: clinicPass }, as("Cal"), opts)).result as { pass_id: string; payment_id: string };
  assert.equal((await pass(r.pass_id)).status, "pending");
  await rejects(plan(db, "payment.use_credit", { payment_id: r.payment_id }, as("Cal"), opts), "error.credit_pass");
  assert.equal(await cardPaid(r.payment_id, "Cal"), "succeeded");
  assert.equal((await pass(r.pass_id)).status, "active");
  const e = await join("Cal");
  await run(db, "payment.use_pass", { payment_id: e.payment_id, pass_id: r.pass_id }, as("Cal"), opts);
  // The desk can't refund a pass; the owner can: 2 of 3 uses left, $100 of $150.
  await rejects(plan(db, "pass.refund", { pass_id: r.pass_id }, desk, opts), "error.forbidden_reason");
  const p = await plan(db, "pass.refund", { pass_id: r.pass_id }, owner, opts);
  assert.match(p.plan.summary.en, /2 unused uses, \$100\.00 back the way it was paid/);
  await apply(db, p.runId, owner, opts);
  const refund = await db.selectFrom("refund").select(["destination", "amount_cents"]).where("payment_id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([refund.destination, refund.amount_cents], ["card", 10000]);
  assert.deepEqual([(await pass(r.pass_id)).status, (await pass(r.pass_id)).uses_left], ["refunded", 0]);
  // The place it paid, left in time after the pass was refunded: its share goes to club credit, since the pass is gone.
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Cal"), opts);
  const credit = await db.selectFrom("refund").select("destination").where("payment_id", "=", e.payment_id).executeTakeFirstOrThrow();
  assert.equal(credit.destination, "credit");
});

test("read-only sells and uses no pass, but refunds; an assistant's buying counts on its limit, and it can't spend a pass", async () => {
  const id = await sell("Ann", courtPass, 17500);
  const hour = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-14T10:00:00-08:00", minutes: 60, person_id: people.Ann, pay: "whole" }, as("Ann"), opts)).result as { payment_id: string };
  await runAsSystem(db, "club.read_only", { on: true }, "host", opts);
  try {
    await rejects(plan(db, "payment.use_pass", { payment_id: hour.payment_id, pass_id: id }, as("Ann"), opts), "error.read_only");
    await rejects(plan(db, "pass.sell", { person_id: people.Ann, product_id: courtPass, cents: 17500, method: "cash" }, desk, opts), "error.read_only");
    await plan(db, "pass.refund", { pass_id: id }, owner, opts);
  } finally { await runAsSystem(db, "club.read_only", { on: false }, "host", opts); }
  const grant = "00000000-0000-7000-9000-0000000000b1";
  await db.insertInto("oauth_client").values({ client_id: "kc_pass", kind: "registered", name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], secret_hash: null, metadata: null }).execute();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: people.Ann!, client_id: "kc_pass", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 10000 }).execute();
  const bot: Actor = { personId: people.Ann!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: grant };
  await assert.rejects(plan(db, "pass.buy", { person_id: people.Ann, product_id: clinicPass }, bot, opts), (e: unknown) => e instanceof KumiError && e.code === "error.assistant_over_cap");
  await assert.rejects(plan(db, "payment.use_pass", { payment_id: hour.payment_id, pass_id: id }, bot, opts), (e: unknown) => e instanceof KumiError && /assistant/.test(e.code));
  assert.equal(await weekSpent(db, grant, NOW), 0);
});
