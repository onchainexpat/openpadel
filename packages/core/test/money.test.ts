import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { approve, checkPayment, creditBalance, moneyHandlers, openPayment, plan, processOutbox, reconcilePayments, run, runAsSystem, setPaymentProvider, uuidv7, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, monica: Actor, locationId: string;
const stripe = new TestProvider();
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
let courtSlot = 0;
async function person(name: string) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}${courtSlot}@example.test`, created_via: "desk" }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  return id;
}
async function program(price: number, startsIn: number) {
  courtSlot += 3;
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", name: `Event ${courtSlot}`, capacity: 4, price_cents: price }, owner)).result as { program_id: string };
  const own = ((await run(db, "court.create", { location_id: locationId, name: `Court ${courtSlot}` }, owner)).result as { court_id: string }).court_id;   // its own court, so test events never clash
  await run(db, "session.add", { program_id: p.program_id, starts_at: hours(startsIn), ends_at: hours(startsIn + 2), court_ids: [own] }, owner);
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  return p.program_id;
}
async function joinAndPay(programId: string, personId: string) {
  const r = (await run(db, "enrolment.join", { program_id: programId, person_id: personId }, as(personId))).result as { enrolment_id: string; payment_id: string };
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "webhook");
  return r;
}
const balances = async () => {
  const rows = await sql<{ kind: string; cents: string }>`SELECT a.kind, sum(e.amount_cents) cents FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE a.kind IN ('revenue','provider_clearing') GROUP BY a.kind`.execute(db);
  return Object.fromEntries(rows.rows.map((r) => [r.kind, Number(r.cents)]));
};
const refundOf = (enrolmentId: string) => db.selectFrom("refund").selectAll().where("enrolment_id", "=", enrolmentId).executeTakeFirst();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  const m = uuidv7();
  await db.insertInto("person").values({ id: m, display_name: "Monica", email: "monica@example.test", created_via: "desk" }).execute();
  const mr = await db.selectFrom("role").select("id").where("key", "=", "manager").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: m, role_id: mr.id, location_id: null }).execute();
  monica = as(m);
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
});
after(async () => drop());

test("joining asks for payment; nothing is charged until the provider confirms; then it's in the ledger", async () => {
  const p = await program(2500, 100);
  const ana = await person("Ana");
  const intentsBefore = stripe.intents.size;
  const r = (await run(db, "enrolment.join", { program_id: p, person_id: ana }, as(ana))).result as { payment_id: string };
  const pay = () => db.selectFrom("payment").select(["status", "provider_ref"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual(await pay(), { status: "pending", provider_ref: null });
  assert.equal(stripe.intents.size, intentsBefore, "nothing asked of the provider inside the change");
  // Ana goes to pay: one intent, opened once and reused.
  const form = await openPayment(db, r.payment_id, ana);
  assert.match(form.clientSecret, /^pi_test_/);
  assert.equal((await openPayment(db, r.payment_id, ana)).clientSecret, form.clientSecret);
  assert.equal(stripe.intents.size, intentsBefore + 1);
  const ref = (await pay()).provider_ref!;
  assert.equal(await checkPayment(db, r.payment_id), "pending");
  const before = await balances();
  stripe.settle(ref, "succeeded");   // the card went through
  assert.equal(await checkPayment(db, r.payment_id), "succeeded");
  assert.equal(await checkPayment(db, r.payment_id), "succeeded");   // asked again, e.g. by a webhook
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "webhook");   // a repeated webhook
  const after = await balances();
  assert.equal(after.provider_clearing! - (before.provider_clearing ?? 0), 2500, "counted once");
  assert.equal(after.revenue! - (before.revenue ?? 0), -2500);
  await assert.rejects(openPayment(db, r.payment_id, ana), (e: unknown) => e instanceof KumiError && e.code === "error.not_pending");
});

test("only the person who owes a payment can open it, and the minute job settles what nobody reported", async () => {
  const p = await program(2500, 110);
  const cal = await person("Cal"), dee = await person("Dee");
  const r = (await run(db, "enrolment.join", { program_id: p, person_id: cal }, as(cal))).result as { payment_id: string };
  await assert.rejects(openPayment(db, r.payment_id, dee), (e: unknown) => e instanceof KumiError && e.code === "error.not_found");
  await openPayment(db, r.payment_id, cal);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");   // paid, but the app closed and the webhook never came
  const job = await reconcilePayments(db);
  assert.ok(job.settled >= 1);
  assert.equal((await db.selectFrom("payment").select("status").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).status, "succeeded");
});

test("leaving days ahead: the card refund goes out through the outbox, once", async () => {
  const p = await program(2500, 200);
  const ben = await person("Ben");
  const e = await joinAndPay(p, ben);
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as(ben));
  assert.equal((await refundOf(e.enrolment_id))!.status, "pending", "nothing sent before the change commits and the worker runs");
  const sentBefore = stripe.refunds.size;
  await processOutbox(db, moneyHandlers);
  await processOutbox(db, moneyHandlers);
  assert.equal(stripe.refunds.size - sentBefore, 1);
  assert.equal((await refundOf(e.enrolment_id))!.status, "sent");
});

test("a refund the provider refuses is recorded as failed", async () => {
  const p = await program(2500, 300);
  const cy = await person("Cy");
  const e = await joinAndPay(p, cy);
  stripe.failNextRefund = true;
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as(cy));
  await processOutbox(db, moneyHandlers);
  const r = (await refundOf(e.enrolment_id))!;
  assert.equal(r.status, "failed"); assert.equal(r.failure, "card_declined");
});

test("Monica's late drop moves no money at all", async () => {
  const p = await program(2500, 4);
  const dana = await person("Dana");
  const e = await joinAndPay(p, dana);
  await run(db, "enrolment.remove", { enrolment_id: e.enrolment_id, reason: "late_cancel" }, monica);
  assert.equal(await refundOf(e.enrolment_id), undefined);
});

test("a refund as club credit lands at once, with no card refund", async () => {
  const p = await program(2500, 6);
  const dee = await person("Dee");
  const e = await joinAndPay(p, dee);
  const sent = stripe.refunds.size;
  await run(db, "enrolment.remove", { enrolment_id: e.enrolment_id, reason: "club", refund: { outcome: "credit", note: "Rain on the outdoor courts" } }, monica);
  assert.equal(await creditBalance(db, dee), 2500);
  assert.equal(stripe.refunds.size, sent);
});

test("a sub who pays: the original player is refunded only once the sub's payment lands", async () => {
  const p = await program(2500, 400);
  const ivy = await person("Ivy"), joe = await person("Joe");
  const e = await joinAndPay(p, ivy);
  const t = (await run(db, "enrolment.transfer", { enrolment_id: e.enrolment_id, to_person_id: joe, pay: "sub_pays" }, as(ivy))).result as { payment_id: string };
  assert.equal((await refundOf(e.enrolment_id))!.status, "waiting_for_sub");
  await processOutbox(db, moneyHandlers);
  assert.equal((await refundOf(e.enrolment_id))!.status, "waiting_for_sub", "no refund before the sub pays");
  await runAsSystem(db, "payment.settle", { payment_id: t.payment_id, outcome: "succeeded" }, "webhook");
  await processOutbox(db, moneyHandlers);
  assert.equal((await refundOf(e.enrolment_id))!.status, "sent");
});

test("a refund over $500 outside the rule needs a second person", async () => {
  const p = await program(60_000, 5);
  const kim = await person("Kim");
  const e = await joinAndPay(p, kim);
  const pr = await plan(db, "enrolment.remove", { enrolment_id: e.enrolment_id, reason: "late_cancel", refund: { outcome: "full", note: "Injury" } }, monica);
  assert.equal(pr.status, "awaiting_approval");
  await assert.rejects(approve(db, pr.runId, monica), (err: unknown) => err instanceof KumiError && err.code === "error.own_approval");
  await approve(db, pr.runId, owner);
  assert.equal((await refundOf(e.enrolment_id))!.amount_cents, 60_000);
});

test("the database rejects a ledger transaction that doesn't balance", async () => {
  const runId = (await db.selectFrom("action_run").select("id").limit(1).executeTakeFirstOrThrow()).id;
  const acct = (await db.selectFrom("ledger_account").select("id").limit(1).executeTakeFirstOrThrow()).id;
  await assert.rejects(db.transaction().execute(async (trx) => {
    const id = uuidv7();
    await trx.insertInto("ledger_txn").values({ id, kind: "test", action_run_id: runId, memo: "unbalanced" }).execute();
    await trx.insertInto("ledger_entry").values({ txn_id: id, account_id: acct, amount_cents: "100" }).execute();
  }), /does not balance/);
});
