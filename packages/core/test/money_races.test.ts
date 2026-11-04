// Money paid at the desk and by card meeting at the same moment, and the paths around them that a review of the
// desk-cash change found wrong (4 Nov 2026): a payment settled twice at once, refunds worked out from what was paid
// rather than what's left of it, a sub paying at the desk, a card form opened while the desk took part, a pause
// between asking for a period and its card going through, a family member taken off, and who may do desk money.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { appOnly, apply, checkPayment, getAction, lapseUnpaidPlaces, messageHandlers, moneyHandlers, openPayment, paidFor, plan, processOutbox, renewMemberships, run, runAsSystem,
  setPaymentProvider, toGiveBack, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

/** A provider whose card form can be held open on its way there, as a slow network would. */
class SlowProvider extends TestProvider {
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;
  override async createIntent(i: Parameters<TestProvider["createIntent"]>[0]) {
    if (this.gate) { this.entered?.(); await this.gate; }
    return super.createIntent(i);
  }
}
let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, monthly: string, family: string, loc: string, west: string, court: string, westCourt: string;
const stripe = new SlowProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const refOf = async (paymentId: string) => (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
async function cardPaid(paymentId: string, who: string, now = NOW) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle(await refOf(paymentId), "succeeded");
  return checkPayment(db, paymentId, "test", now);
}
const membership = (who: string) => db.selectFrom("membership").selectAll().where("person_id", "=", people[who]!).orderBy("started_at", "desc").executeTakeFirstOrThrow();
const refunds = (paymentId: string) => db.selectFrom("refund").select(["amount_cents", "destination", "status"]).where("payment_id", "=", paymentId).execute();
async function held(kind: string, revenueType?: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind).$if(Boolean(revenueType), (q) => q.where("ledger_account.revenue_type", "=", revenueType!)).executeTakeFirst();
  return Number(r?.c ?? 0);
}
let clinics = 0;
async function clinic(name: string, at = loc, on = court, price = 3000) {
  const id = ((await run(db, "program.create", { location_id: at, kind: "clinic", name, capacity: 6, price_cents: price }, owner, opts)).result as { program_id: string }).program_id;
  const day = String(10 + clinics++).padStart(2, "0");   // each on a day of its own, so their courts don't clash
  await run(db, "session.add", { program_id: id, starts_at: `2026-12-${day}T18:00:00-08:00`, ends_at: `2026-12-${day}T19:30:00-08:00`, court_ids: [on] }, owner, opts);
  await run(db, "program.publish", { program_id: id }, owner, opts);
  return id;
}
const enrol = async (programId: string, who: string) => (await run(db, "enrolment.join", { program_id: programId, person_id: people[who] }, desk, opts)).result as { enrolment_id: string; payment_id: string };

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, opts)).result as any).plan_id;
  family = ((await run(db, "membership.plan_set", { name: "Family", price_cents: 12000, period: "month", family_size: 2, extra_person_cents: 3000 }, owner, opts)).result as any).plan_id;
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit", "Max", "Ned", "Oli", "Rae", "Sol", "Tia", "Uma", "Vic", "Wes"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  west = ((await run(db, "location.create", { name: "Westside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  westCourt = ((await run(db, "court.create", { location_id: west, name: "West 1" }, owner, opts)).result as any).court_id;
  for (const l of [loc, west]) {
    await run(db, "hours.set", { location_id: l, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
    await run(db, "price.rule_set", { location_id: l, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  }
});
after(async () => drop());

test("the card form's return and the webhook settle one payment at the same moment: one period, nothing back, the books once", async () => {
  const revenue = await held("revenue", "memberships");
  for (const who of ["Ann", "Ben", "Cal", "Uma", "Vic", "Wes"]) {
    await run(db, "membership.sell", { person_id: people[who], plan_id: monthly, cents: 8000, method: "cash" }, desk, opts);
    const m = await membership(who), at = new Date(m.current_period_end!.getTime() - 5 * 86400_000);
    const { payment_id } = (await run(db, "membership.pay_next", { membership_id: m.id }, as(who), { now: at })).result as { payment_id: string };
    await openPayment(db, payment_id, people[who]!);
    stripe.settle(await refOf(payment_id), "succeeded");
    assert.deepEqual(await Promise.all([checkPayment(db, payment_id, "card-form", at), checkPayment(db, payment_id, "webhook", at)]), ["succeeded", "succeeded"]);
    assert.deepEqual(await refunds(payment_id), [], `${who}: nothing goes back`);
    const after = await membership(who);
    assert.equal(after.current_period_end!.getTime() > m.current_period_end!.getTime(), true, `${who}: the next period is theirs`);
    assert.equal(after.period_no, m.period_no + 1, `${who}: one period added`);
  }
  assert.equal(await held("revenue", "memberships") - revenue, -6 * 16000, "each payment is in the books once");
});

test("a booking paid in cash, made shorter, then cancelled: the desk gives back what's left of it, never more than was paid", async () => {
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-20T10:00:00-08:00", minutes: 90, person_id: people.Dee }, desk, opts)).result as { booking_id: string }).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 6000, method: "cash" }, desk, opts);
  await run(db, "booking.extend", { booking_id: b, minutes: 60 }, desk, opts);   // $20 back at the desk
  const p = await plan(db, "booking.cancel", { booking_id: b }, desk, opts);
  assert.match(p.plan.summary.en, /\$40\.00 goes back at the desk/);
  await apply(db, p.runId, desk, opts);
  const waiting = await toGiveBack(db, people.Dee);
  assert.deepEqual(waiting.map((r) => r.amount_cents).sort(), [2000, 4000]);
  const drawer = await held("cash_drawer");
  for (const r of waiting) await run(db, "refund.give_back", { refund_id: r.id }, desk, opts);
  assert.equal(drawer - await held("cash_drawer"), 6000, "all of it, and no more, leaves the drawer");
});

test("a card payment partly refunded, then the booking cancelled with everything back: only what's left goes to the card", async () => {
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T10:00:00-08:00", minutes: 60, person_id: people.Eve, pay: "whole" }, as("Eve"), opts)).result as { booking_id: string; payment_id: string };
  await cardPaid(b.payment_id, "Eve");
  await run(db, "booking.refund", { booking_id: b.booking_id, payment_id: b.payment_id, cents: 3000 }, desk, opts);
  const p = await plan(db, "booking.cancel", { booking_id: b.booking_id, refund: "full" }, desk, opts);
  assert.match(p.plan.summary.en, /\$10\.00/);
  await apply(db, p.runId, desk, opts);
  assert.deepEqual((await refunds(b.payment_id)).map((r) => r.amount_cents).sort(), [1000, 3000]);
});

test("a place passed to a sub who pays all of it at the desk: the player they replaced gets their refund now", async () => {
  const c = await clinic("Sub at the desk");
  const e = await enrol(c, "Gus");
  await cardPaid(e.payment_id, "Gus");
  const t = (await run(db, "enrolment.transfer", { enrolment_id: e.enrolment_id, to_person_id: people.Hal, pay: "sub_pays" }, desk, opts)).result as { enrolment_id: string };
  assert.deepEqual((await refunds(e.payment_id)).map((r) => r.status), ["waiting_for_sub"]);
  await run(db, "enrolment.record_payment", { enrolment_id: t.enrolment_id, cents: 1000, method: "cash" }, desk, opts);
  assert.deepEqual((await refunds(e.payment_id)).map((r) => r.status), ["waiting_for_sub"], "part paid: still waiting");
  await run(db, "enrolment.record_payment", { enrolment_id: t.enrolment_id, cents: 2000, method: "cash" }, desk, opts);
  await processOutbox(db, { ...messageHandlers, ...moneyHandlers }, 100, NOW);
  assert.deepEqual(await refunds(e.payment_id), [{ amount_cents: 3000, destination: "card", status: "sent" }]);
});

test("the card form opened while the desk takes part of the place: the card isn't asked for the old amount, and a new ask is for the rest", async () => {
  const c = await clinic("Card form at the desk");
  const e = await enrol(c, "Ivy");
  let release!: () => void;
  stripe.gate = new Promise((r) => (release = r));
  const entered = new Promise<void>((r) => (stripe.entered = r)), known = new Set(stripe.intents.keys());
  const opening = openPayment(db, e.payment_id, people.Ivy!);
  await entered;   // the intent is on its way to the provider, for $30
  await run(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 1000, method: "cash" }, desk, opts);
  stripe.gate = null; release();
  await rejects(opening, "error.not_pending");
  const made = [...stripe.intents.entries()].filter(([ref]) => !known.has(ref)).map(([, it]) => [it.amountCents, it.status]);
  assert.deepEqual(made, [[3000, "failed"]], "the $30 intent is called off, never shown");
  const asks = await db.selectFrom("payment").select(["id", "amount_cents", "status", "provider_ref"]).where("enrolment_id", "=", e.enrolment_id).where("provider", "!=", "none").orderBy("created_at").execute();
  assert.deepEqual(asks.map((a) => [a.amount_cents, a.status, a.provider_ref]), [[3000, "failed", null], [2000, "pending", null]]);
  await cardPaid(asks[1]!.id, "Ivy");
  assert.equal(await paidFor(db, e.enrolment_id), 3000);
  assert.equal(stripe.intents.get(await refOf(asks[1]!.id))!.amountCents, 2000);
});

test("a place partly paid at the desk isn't let go for being unpaid; the rest stays owed, asked by card", async () => {
  const c = await clinic("Part paid");
  const e = await enrol(c, "Jo");
  await run(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 500, method: "cash" }, desk, opts);
  assert.deepEqual(await lapseUnpaidPlaces(db, new Date(NOW.getTime() + 3 * 86400_000)), { reminded: 0, lapsed: 0 });
  const en = await db.selectFrom("enrolment").select("status").where("id", "=", e.enrolment_id).executeTakeFirstOrThrow();
  assert.equal(en.status, "booked");
  const ask = await db.selectFrom("payment").select(["amount_cents"]).where("enrolment_id", "=", e.enrolment_id).where("status", "=", "pending").executeTakeFirstOrThrow();
  assert.equal(ask.amount_cents, 2500);
  assert.equal(3000 - await paidFor(db, e.enrolment_id), 2500);
});

for (const [what, pauseThen] of [["paused", false], ["paused and back early", true]] as const)
  test(`a declined renewal's card payment going through after the membership was ${what}: it renews, nothing goes back`, async () => {
    const who = pauseThen ? "Kit" : "Max";
    const join = (await run(db, "membership.join", { plan_id: monthly, person_id: people[who] }, as(who), opts)).result as { payment_id: string };
    await cardPaid(join.payment_id, who);
    const m0 = await membership(who);
    stripe.failNextCharge = "card_declined";
    await renewMemberships(db, m0.current_period_end!);
    const at = { now: new Date(m0.current_period_end!.getTime() + 3600_000) };
    const ask = await db.selectFrom("payment").select("id").where("membership_id", "=", m0.id).where("status", "=", "pending").executeTakeFirstOrThrow();
    await openPayment(db, ask.id, people[who]!);   // another card, in the app
    await run(db, "membership.pause", { membership_id: m0.id, until: "2026-12-20" }, desk, at);
    if (pauseThen) await run(db, "membership.unpause", { membership_id: m0.id }, desk, { now: new Date(at.now.getTime() + 60_000) });
    stripe.settle(await refOf(ask.id), "succeeded");
    await checkPayment(db, ask.id, "test", at.now);
    const m1 = await membership(who);
    assert.deepEqual(await refunds(ask.id), []);
    assert.deepEqual([m1.status, m1.failed_attempts, m1.period_no], ["active", 0, m0.period_no + 1]);
    assert.equal((await db.selectFrom("event_outbox").select("id").where("topic", "=", "membership.paid_twice").where(({ ref }) => ref("payload", "->>").key("membership_id" as never), "=", m0.id as never).execute()).length, 0);
  });

test("the next period by card in the app, the membership paused before the card goes through: it's paid, not sent back", async () => {
  const deskPlan = ((await run(db, "membership.plan_set", { name: "Desk monthly", price_cents: 6000, period: "month" }, owner, opts)).result as any).plan_id;
  await run(db, "membership.sell", { person_id: people.Ned, plan_id: deskPlan, cents: 6000, method: "cash" }, desk, opts);
  const m0 = await membership("Ned"), at = { now: new Date(m0.current_period_end!.getTime() - 3 * 86400_000) };
  const { payment_id } = (await run(db, "membership.pay_next", { membership_id: m0.id }, as("Ned"), at)).result as { payment_id: string };
  await openPayment(db, payment_id, people.Ned!);
  await run(db, "membership.pause", { membership_id: m0.id, until: "2026-12-20" }, desk, at);
  stripe.settle(await refOf(payment_id), "succeeded");
  await checkPayment(db, payment_id, "test", at.now);
  assert.deepEqual(await refunds(payment_id), []);
  assert.equal((await membership("Ned")).period_no, m0.period_no + 1);
});

test("a family member taken off a desk membership before their price is paid: it comes off what's owed; paid for, they stay to the end and come back free", async () => {
  // Oli's household: Oli pays, Pip and Quinn are the juniors.
  for (const [name, year] of [["Pip", 2014], ["Quinn", 2016]] as const)
    people[name] = ((await run(db, "household.add_junior", { person_id: people.Oli, display_name: name, birth_year: year }, as("Oli"), opts)).result as { person_id: string }).person_id;
  await run(db, "membership.sell", { person_id: people.Oli, plan_id: family, cents: 12000, method: "cash" }, desk, opts);
  const m = await membership("Oli");
  await run(db, "membership.add_person", { membership_id: m.id, person_id: people.Pip }, desk, opts);   // the second: included
  await run(db, "membership.add_person", { membership_id: m.id, person_id: people.Quinn }, desk, opts);  // the third: $30 owed at the desk
  assert.equal((await membership("Oli")).balance_cents, 3000);
  const off = await plan(db, "membership.remove_person", { membership_id: m.id, person_id: people.Quinn }, desk, opts);
  assert.match(off.plan.summary.en, /The \$30\.00 still owed for them at the desk comes off/);
  await apply(db, off.runId, desk, opts);
  assert.equal((await membership("Oli")).balance_cents, 0);
  // Added again: owed once, not twice.
  await run(db, "membership.add_person", { membership_id: m.id, person_id: people.Quinn }, desk, opts);
  assert.equal((await membership("Oli")).balance_cents, 3000);
  // Paid for this time: taken off, they stay to the period's end, and putting them back charges nothing again.
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 3000, method: "cash" }, desk, opts);
  const keep = await plan(db, "membership.remove_person", { membership_id: m.id, person_id: people.Quinn }, desk, opts);
  assert.match(keep.plan.summary.en, /They're paid for, so they keep its benefits until/);
  await apply(db, keep.runId, desk, opts);
  await run(db, "membership.add_person", { membership_id: m.id, person_id: people.Quinn }, desk, opts);
  assert.equal((await membership("Oli")).balance_cents, 0);
});

test("desk money: a front desk kept to one location gives back its own location's and sells memberships; support access and assistants never do it", async () => {
  await run(db, "role.assign", { person_id: people.Rae, role: "front_desk", location_id: loc }, owner, opts);
  const rae = as("Rae");
  const here = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-22T10:00:00-08:00", minutes: 60, person_id: people.Sol }, rae, opts)).result as { booking_id: string }).booking_id;
  const there = ((await run(db, "booking.create", { court_id: westCourt, starts_at: "2026-11-22T10:00:00-08:00", minutes: 60, person_id: people.Sol }, desk, opts)).result as { booking_id: string }).booking_id;
  for (const b of [here, there]) { await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, opts); await run(db, "booking.cancel", { booking_id: b }, desk, opts); }
  const waiting = await toGiveBack(db, people.Sol);
  const where = async (refundId: string) => (await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .innerJoin("booking", "booking.id", "booking_player.booking_id").select("booking.id").where("refund.id", "=", refundId).executeTakeFirstOrThrow()).id;
  for (const r of waiting) {
    if (await where(r.id) === here) await run(db, "refund.give_back", { refund_id: r.id }, rae, opts);
    else await rejects(plan(db, "refund.give_back", { refund_id: r.id }, rae, opts), "error.forbidden_reason");
  }
  await run(db, "membership.sell", { person_id: people.Tia, plan_id: monthly, cents: 8000, method: "cash" }, rae, opts);

  const g = (await run(db, "support.grant", { email: "helper@host.test", name: "Helper", reason: "Helping with the desk", level: "manager", hours: 4 }, { ...owner, auth: "passkey" }, opts)).result as { person_id: string };
  const sup: Actor = { personId: g.person_id, via: "test", lang: "en" };
  const left = (await toGiveBack(db, people.Sol))[0]!;
  await rejects(plan(db, "refund.give_back", { refund_id: left.id }, sup, opts), "error.forbidden_reason");
  const open = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-23T10:00:00-08:00", minutes: 60, person_id: people.Sol }, desk, opts)).result as { booking_id: string }).booking_id;
  await rejects(plan(db, "booking.record_payment", { booking_id: open, cents: 100, method: "cash" }, sup, opts), "error.forbidden_reason");
  for (const a of ["booking.record_payment", "enrolment.record_payment", "membership.sell", "membership.record_payment", "refund.give_back"]) assert.ok(appOnly(getAction(a)), `${a} is the app's alone`);
  await rejects(plan(db, "refund.give_back", { refund_id: left.id }, { ...owner, auth: "oauth" }, opts), "error.assistant_in_app");
});
