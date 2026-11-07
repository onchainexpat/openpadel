// A found card payment kept as paid elsewhere, the review of 103a1d1 (6 Nov 2026): the books match the payment
// provider's however it's put right, and whatever happens to the payment afterwards.
//   G1  put right at the desk (the court booked again, paid "another way") and then kept: the staff say it's already
//       in the books, and nothing is added, so one $40 card payment counts $40, not $80.
//   G2  refunded later in the provider's dashboard ("Refund it" is gone once it's kept): a job asks the provider about
//       kept ones, a few at a time, and takes the refund out of the books once; a dispute is told to the staff once.
//   G3  "Refund it" after a part refund was seen asks for what's left, and says so.
//   A refund still pending takes nothing out until it goes through; one that fails never does.
//   A take-out is dated on the refund's own day; one for a payment Kumi records later, on the day it was paid.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { checkKeptFound, checkMoneyAfterRestore, moneyHandlers, noteFound, plan, processOutbox, reviewFound, run, runAsSystem, setPaymentProvider, TestProvider, uuidv7, type Actor, type Db, type FoundIntent, type FoundRefund } from "../src/index.ts";

class Listing extends TestProvider {
  intentsSince: FoundIntent[] = [];
  refundsSince: FoundRefund[] = [];
  asked = 0;
  override async listSince() { return { intents: this.intentsSince, refunds: this.refundsSince }; }
  override async refundsOf(paymentRef: string) { this.asked++; return super.refundsOf(paymentRef); }
}
let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, court: string;
const stripe = new Listing(), TZ = "America/Los_Angeles";
const people: Record<string, string> = {};
const PAID = new Date(Date.now() - 2 * 86400_000);
let n = 0;
const found = (amountCents: number, o: Partial<FoundIntent> = {}): FoundIntent =>
  ({ ref: `pi_found_${++n}_${uuidv7().slice(-8)}`, status: "succeeded", amountCents, created: PAID, kumiPaymentId: null, kumiChargeId: null, email: "ann@example.test", description: "Court", ...o });
async function note(it: FoundIntent) {
  await noteFound(db, it, null, new Date(), { tell: false });
  return (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", it.ref).executeTakeFirstOrThrow()).id;
}
const sumOf = async (where: string) => Number((await sql<{ c: string }>`SELECT coalesce(sum(e.amount_cents), 0)::text AS c FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE ${sql.raw(where)}`.execute(db)).rows[0]!.c);
const revenue = () => sumOf("a.kind = 'revenue'").then((x) => -x);
const clearing = () => sumOf("a.kind = 'provider_clearing'");
const row = async (id: string) => (await db.selectFrom("payment_found").select(["status", "booked_cents", "kept_as"]).where("id", "=", id).executeTakeFirstOrThrow());
/** A refund in the provider's own records (its dashboard, say), as the provider has it now. */
const dashRefund = (paymentRef: string, amountCents: number, status: "succeeded" | "pending" | "failed", created = new Date()) => {
  const ref = `re_dash_${uuidv7().slice(-10)}`;
  stripe.refunds.set(`dash:${ref}`, { paymentRef, amountCents, ref, created, status });
  return ref;
};
const HOUR = 3600_000;
const disputeAlerts = async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM event_outbox WHERE topic = 'ops.failed' AND payload->>'job' = 'restore_disputed'`.execute(db)).rows[0]!.n);
const txnAt = async (memo: string) => (await sql<{ at: Date }>`SELECT at FROM ledger_txn WHERE memo LIKE ${memo + "%"} ORDER BY id DESC LIMIT 1`.execute(db)).rows[0]?.at;

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  for (const name of ["Lee", "Ann"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner);
  desk = { personId: people.Lee!, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "East", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
});
after(async () => { setPaymentProvider(new TestProvider()); await drop(); });

test("G1: put right at the desk, then kept as already in the books: one $40 card payment counts $40", async () => {
  const id = await note(found(4000));
  const r0 = await revenue(), c0 = await clearing();
  // The staff put it right by hand: Ann's lost court booked again at the desk, its payment recorded as paid another way.
  const start = new Date(Date.now() + 3 * 86400_000); start.setUTCHours(18, 0, 0, 0);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: start.toISOString(), minutes: 60, person_id: people.Ann }, desk)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "other", note: "paid by card before the restore" }, desk);
  // Two ways to keep it, each said plainly.
  const income = await plan(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.match(income.plan.summary.en, /counted as income: it's added to the books as other income on the day it was paid.*Choose this only if nothing else in Kumi counts it, such as a payment recorded at the desk for it/);
  const already = await plan(db, "payment_found.paid_elsewhere", { id, books: "already" }, owner);
  assert.equal(already.plan.summary.en, "Record $40.00 as paid for something put right by hand, and keep it, as already in the books (a payment recorded at the desk for it, say): nothing is added to them, so it isn't counted twice. Nothing is refunded.");
  assert.match(already.plan.summary.es, /como ya contado en la contabilidad .*no se anota nada, así que no cuenta dos veces/);
  await run(db, "payment_found.paid_elsewhere", { id, books: "already" }, owner);
  assert.equal(await revenue() - r0, 4000, "one $40 card payment, $40 of revenue: the desk's");
  assert.equal(await clearing() - c0, 4000, "and $40 expected from the provider, which took $40");
  assert.deepEqual(await row(id), { status: "handled", booked_cents: 0, kept_as: "already" });
});

test("G2: refunded later in the provider's dashboard: a job takes it out of the books once, on the refund's day; a dispute is told once", async () => {
  const it = found(3000), id = await note(it);
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.equal((await row(id)).booked_cents, 3000);
  await assert.rejects(plan(db, "payment_found.refund", { id }, owner), /changed/, "Refund it is gone once kept");
  const r0 = await revenue(), at = new Date(Date.now() - HOUR);
  dashRefund(it.ref, 3000, "succeeded", at);
  const now = new Date();
  const k = await checkKeptFound(db, now);
  assert.ok(k.checked >= 1 && k.unbooked >= 1, JSON.stringify(k));
  assert.equal(r0 - await revenue(), 3000, "taken out");
  assert.deepEqual(await row(id), { status: "handled", booked_cents: 0, kept_as: "income" });
  assert.equal((await txnAt("refund of a card payment kept as paid elsewhere"))!.getTime(), at.getTime(), "dated on the refund's own day");
  // A few at a time, each at most every 6 hours: asked again at once, nothing is asked.
  const asked = stripe.asked;
  assert.equal((await checkKeptFound(db, new Date(now.getTime() + 60_000))).checked, 0);
  assert.equal(stripe.asked, asked);
  // Seen again later: nothing more comes out.
  await checkKeptFound(db, new Date(now.getTime() + 7 * HOUR));
  assert.equal(r0 - await revenue(), 3000, "once");
  // Disputed at the provider: the staff hear once.
  stripe.disputes.add(it.ref);
  const d0 = await disputeAlerts();
  assert.equal((await checkKeptFound(db, new Date(now.getTime() + 14 * HOUR))).disputed, 1);
  assert.equal(await disputeAlerts() - d0, 1);
  const [e] = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "ops.failed").where(sql<string>`payload->>'job'`, "=", "restore_disputed").execute();
  assert.match((e!.payload as { words: { en: string } }).words.en, new RegExp(`\\$30\\.00, ${it.ref}\\) is disputed at the payment provider\\. Answer the dispute in the provider's own dashboard`));
  assert.ok((await db.selectFrom("payment_found").select("disputed_at").where("id", "=", id).executeTakeFirstOrThrow()).disputed_at);
  await checkKeptFound(db, new Date(now.getTime() + 21 * HOUR));
  assert.equal(await disputeAlerts() - d0, 1, "told once");
});

test("G3: \"Refund it\" after a part refund was seen asks for what's left, and says so; nothing left, it's refused", async () => {
  const it = found(5000);
  stripe.intentsSince = [it];
  stripe.refundsSince = [{ ref: `re_part_${uuidv7().slice(-8)}`, paymentRef: it.ref, amountCents: 2000, ok: true, created: new Date(), kumiRefundId: null, status: "succeeded" }];
  await db.insertInto("restore_check").values({ since: new Date(Date.now() - 30 * 86400_000) } as any).execute();
  await checkMoneyAfterRestore(db);
  stripe.intentsSince = []; stripe.refundsSince = [];
  const id = (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", it.ref).executeTakeFirstOrThrow()).id;
  const p = await plan(db, "payment_found.refund", { id }, owner);
  assert.match(p.plan.summary.en, /^Refund \$30\.00 to the card that paid it: what's left of \$50\.00, since \$20\.00 of it has gone back at the payment provider already\./);
  assert.equal(p.plan.moneyCents, 3000);
  await run(db, "payment_found.refund", { id }, owner);
  await processOutbox(db, moneyHandlers);
  const asked = [...stripe.refunds.values()].filter((r) => r.paymentRef === it.ref && !r.ref.startsWith("re_dash_"));
  assert.deepEqual(asked.map((r) => r.amountCents), [3000], "what's left, not the whole");
  // All of one given back at the provider already: nothing to refund.
  const all = found(1200);
  stripe.intentsSince = [all];
  stripe.refundsSince = [{ ref: `re_all_${uuidv7().slice(-8)}`, paymentRef: all.ref, amountCents: 1200, ok: true, created: new Date(), kumiRefundId: null, status: "succeeded" }];
  await db.insertInto("restore_check").values({ since: new Date(Date.now() - 30 * 86400_000) } as any).execute();
  await checkMoneyAfterRestore(db);
  stripe.intentsSince = []; stripe.refundsSince = [];
  const allId = (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", all.ref).executeTakeFirstOrThrow()).id;
  await assert.rejects(plan(db, "payment_found.refund", { id: allId }, owner), /Nothing is left of this payment to refund/);
});

test("a refund still pending takes nothing out until it goes through, once; one that fails never does; Refund it leaves room for one pending", async () => {
  const it = found(4000), id = await note(it);
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  const r0 = await revenue(), t0 = Date.now() + 30 * HOUR;
  const pending = dashRefund(it.ref, 1000, "pending");
  const failing = dashRefund(it.ref, 500, "pending");
  await checkKeptFound(db, new Date(t0));
  assert.equal(await revenue(), r0, "nothing out while they're on their way");
  assert.equal((await row(id)).booked_cents, 4000);
  stripe.refunds.get(`dash:${pending}`)!.status = "succeeded";
  stripe.refunds.get(`dash:${failing}`)!.status = "failed";
  await checkKeptFound(db, new Date(t0 + 7 * HOUR));
  assert.equal(r0 - await revenue(), 1000, "the one that went through, not the one that failed");
  assert.equal((await row(id)).booked_cents, 3000);
  await checkKeptFound(db, new Date(t0 + 14 * HOUR));
  assert.equal(r0 - await revenue(), 1000, "once");
  // Not kept yet, with one on its way: Refund it asks only for what the provider has room for.
  const open = found(5000), openId = await note(open);
  stripe.intentsSince = [open];
  stripe.refundsSince = [{ ref: `re_wait_${uuidv7().slice(-8)}`, paymentRef: open.ref, amountCents: 1000, ok: true, created: new Date(), kumiRefundId: null, status: "pending" }];
  await db.insertInto("restore_check").values({ since: new Date(Date.now() - 30 * 86400_000) } as any).execute();
  await checkMoneyAfterRestore(db);
  stripe.intentsSince = []; stripe.refundsSince = [];
  assert.equal((await plan(db, "payment_found.refund", { id: openId }, owner)).plan.moneyCents, 4000);
  // ...and keeping it counts all of it until that one goes through.
  assert.match((await plan(db, "payment_found.paid_elsewhere", { id: openId, books: "income" }, owner)).plan.summary.en, /^Record \$50\.00 as paid/);
});

test("a payment Kumi records later comes out on the day it was paid, where it was counted", async () => {
  const it = found(9000, { kumiChargeId: `renew:${uuidv7()}:x:0`, description: "Membership renewal" }), id = await note(it);
  await reviewFound(db, new Date(Date.now() + 16 * 60_000));
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  await db.insertInto("payment").values({ id: uuidv7(), person_id: owner.personId!, amount_cents: 9000, method: "card", provider: "test", provider_ref: it.ref, status: "succeeded" } as any).execute();
  await reviewFound(db, new Date(Date.now() + 17 * 60_000));
  assert.deepEqual(await row(id), { status: "recorded", booked_cents: 0, kept_as: "income" });
  const at = await txnAt("card payment kept as paid elsewhere, recorded by Kumi since");
  assert.equal(at!.getTime(), PAID.getTime(), "on the day it was paid");
});
