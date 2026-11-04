// Paid at the desk for a membership or a program place, as for a court booking: never more than is owed, part now
// and the rest later, in the books and on receipts like any payment. What goes back of it goes back at the desk.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, deskDays, deskLines, endLapsedMemberships, issueReceipts, messageHandlers, moneyHandlers, onDate, openPayment, plan, processOutbox, remindMembershipEnds, renewMemberships, run, runAsSystem,
  setPaymentProvider, staffAlerts, toGiveBack, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, monthly: string, annual: string, deskOnly: string, loc: string, court: string, clinic: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");   // Wed 4 Nov, 10 am
const la = (day: string, hhmm: string) => onDate(day, hhmm, TZ);
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string, now = NOW) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test", now);
}
const membership = (who: string) => db.selectFrom("membership").selectAll().where("person_id", "=", people[who]!).orderBy("started_at", "desc").executeTakeFirstOrThrow();
const email = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email")
  .orderBy("created_at", "desc").executeTakeFirstOrThrow();
/** What a ledger account holds: the cash drawer, or a kind of revenue (negative: what the club earned). */
async function held(kind: "cash_drawer" | "revenue", revenueType?: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind).$if(Boolean(revenueType), (q) => q.where("ledger_account.revenue_type", "=", revenueType!)).executeTakeFirst();
  return Number(r?.c ?? 0);
}
const enrol = async (who: string, programId = clinic) => ((await run(db, "enrolment.join", { program_id: programId, person_id: people[who] }, desk, opts)).result as { enrolment_id: string; payment_id: string });
const pending = (enrolmentId: string) => db.selectFrom("payment").select(["id", "amount_cents", "status"]).where("enrolment_id", "=", enrolmentId).where("provider", "!=", "none").orderBy("created_at").execute();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month", days_ahead: 21 }, owner, opts)).result as any).plan_id;
  annual = ((await run(db, "membership.plan_set", { name: "Annual", price_cents: 80000, period: "year" }, owner, opts)).result as any).plan_id;
  deskOnly = ((await run(db, "membership.plan_set", { name: "Desk", price_cents: 5000, period: "month", join_in_app: false }, owner, opts)).result as any).plan_id;
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit", "Max", "Ned"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 6, price_cents: 3000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
});
after(async () => drop());

test("a membership sold at the desk: one period, in the books as cash, and it doesn't renew by itself", async () => {
  const p = await plan(db, "membership.sell", { person_id: people.Ann, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts);
  assert.equal(p.plan.summary.en, "Ann becomes a Monthly member until December 3, 2026: $80.00 paid in cash. It doesn't renew by itself.");
  await rejects(plan(db, "membership.sell", { person_id: people.Ann, plan_id: monthly, cents: 9000, method: "cash" }, desk, opts), "error.more_than_owed_membership",
    "Only $80.00 is owed on this membership, so $90.00 can't be recorded. Record $80.00 or less; Kumi keeps no credit for later.");
  const r = (await run(db, "membership.sell", { person_id: people.Ann, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts)).result as { membership_id: string; payment_id: string };
  const m = await membership("Ann");
  assert.deepEqual([m.status, m.source, m.price_cents, m.period, m.balance_cents], ["active", "desk", 8000, "month", 0]);
  assert.equal(m.current_period_end!.toISOString(), la("2026-12-04", "00:00").toISOString());
  const pay = await db.selectFrom("payment").selectAll().where("id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([pay.method, pay.provider, pay.status, pay.amount_cents, pay.membership_id], ["cash", "none", "succeeded", 8000, m.id]);
  assert.deepEqual([await held("cash_drawer"), await held("revenue", "memberships")], [8000, -8000]);
  await rejects(plan(db, "membership.sell", { person_id: people.Ann, plan_id: annual, cents: 100, method: "cash" }, desk, opts), "error.already_member");
  // A receipt, as for any payment.
  await issueReceipts(db);
  assert.equal((await db.selectFrom("receipt").select("method").where("payment_id", "=", r.payment_id).executeTakeFirstOrThrow()).method, "cash");

  // No card is ever charged for it, and it ends when its period does.
  const charges = stripe.charges.length;
  assert.deepEqual(await renewMemberships(db, la("2026-12-04", "00:00")), { renewed: 0, failed: 0, ended: 0 });
  assert.equal(stripe.charges.length, charges);
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ann", "membership_started")).body, "Your Monthly membership runs from today until December 3, 2026. You can book courts up to 21 days ahead.");
});

test("the reminder before it ends: a week before, once; the next period paid at the desk moves the end on a period", async () => {
  assert.equal(await remindMembershipEnds(db, la("2026-11-26", "23:00")), 0);
  assert.equal(await remindMembershipEnds(db, la("2026-11-27", "09:00")), 1);
  assert.equal(await remindMembershipEnds(db, la("2026-11-28", "09:00")), 0);   // once
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await email("Ann", "membership_ending"), { subject: "Your membership ends soon: Monthly",
    body: "Your Monthly membership runs until December 3, 2026. To keep it, pay the next period ($80.00) at the desk or in the app." });

  // Too early for the next period; then, within two weeks of the end, it's taken.
  const m = await membership("Ann");
  await rejects(plan(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, opts), "error.next_period_later", "The next period can be paid from November 20, 2026.");
  const at = { now: la("2026-11-28", "11:00") };
  const p = await plan(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "terminal" }, desk, at);
  assert.equal(p.plan.summary.en, "Ann's Monthly membership is paid until January 3, 2027: $80.00 paid on the club's card reader.");
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "terminal" }, desk, at);
  assert.equal((await membership("Ann")).current_period_end!.toISOString(), la("2027-01-04", "00:00").toISOString());
  await rejects(plan(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at), "error.next_period_later");
  // The card reader's money isn't in the cash drawer.
  assert.deepEqual([await held("cash_drawer"), await held("revenue", "memberships")], [8000, -16000]);
  await processOutbox(db, messageHandlers, 100, at.now);
  assert.equal((await email("Ann", "membership_paid_until")).body, "Your Monthly membership is paid until January 3, 2027: $80.00 paid.");
  // A new period: a new reminder before it ends.
  assert.equal(await remindMembershipEnds(db, la("2026-12-28", "09:00")), 1);
  // Not paid in time: it ends.
  assert.equal(await endLapsedMemberships(db, la("2027-01-04", "00:01")), 1);
  assert.equal((await membership("Ann")).status, "ended");
});

test("part now, the rest later: owed at the desk, never more than that, and two desks at once can't both take it", async () => {
  await run(db, "membership.sell", { person_id: people.Ben, plan_id: monthly, cents: 3000, method: "cash", note: "rest Friday" }, desk, opts);
  const m = await membership("Ben");
  assert.equal(m.balance_cents, 5000);
  await processOutbox(db, messageHandlers);
  assert.match((await email("Ben", "membership_started")).body, /\$50\.00 is still to pay at the desk\.$/);
  await rejects(plan(db, "membership.record_payment", { membership_id: m.id, cents: 6000, method: "cash" }, desk, opts), "error.more_than_owed_membership");
  assert.equal((await plan(db, "membership.record_payment", { membership_id: m.id, cents: 2000, method: "cash" }, desk, opts)).plan.summary.en,
    "Record $20.00 paid in cash for Ben's Monthly membership. $30.00 is still to pay at the desk.");
  // Two desks at once, each for all of it: one gets it, the other is refused.
  const a = await plan(db, "membership.record_payment", { membership_id: m.id, cents: 5000, method: "cash" }, desk, opts);
  const b = await plan(db, "membership.record_payment", { membership_id: m.id, cents: 5000, method: "cash" }, owner, opts);
  const { apply } = await import("../src/index.ts");
  const both = await Promise.allSettled([apply(db, a.runId, desk, opts), apply(db, b.runId, owner, opts)]);
  assert.deepEqual(both.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await membership("Ben")).balance_cents, 0);
  assert.equal(Number((await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("membership_id", "=", m.id).executeTakeFirstOrThrow()).c), 8000);
  await rejects(plan(db, "membership.record_payment", { membership_id: m.id, cents: 100, method: "cash" }, desk, opts), "error.next_period_later");
});

test("a card member pays the next period at the desk: the card isn't charged for it, and renews after", async () => {
  const join = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Cal }, as("Cal"), opts)).result as { payment_id: string };
  await pay(join.payment_id, "Cal");
  const m = await membership("Cal");
  const end = m.current_period_end!;
  const at = { now: new Date(end.getTime() - 3 * 86400_000) };
  const p = await plan(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at);
  assert.match(p.plan.summary.en, /The card isn't charged for that period; it renews from the card after it\.$/);
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at);
  const charges = stripe.charges.length;
  assert.equal((await renewMemberships(db, end)).renewed, 0);
  assert.equal(stripe.charges.length, charges);
  const after = await membership("Cal");
  assert.equal((await renewMemberships(db, after.current_period_end!)).renewed, 1);   // by card, a period later
  assert.equal(stripe.charges.length, charges + 1);
});

test("a renewal whose card failed, paid in cash at the desk: the membership carries on and the staff alert closes", async () => {
  const join = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Dee }, as("Dee"), opts)).result as { payment_id: string };
  await pay(join.payment_id, "Dee");
  const m = await membership("Dee");
  stripe.failNextCharge = "card_declined";
  assert.equal((await renewMemberships(db, m.current_period_end!)).failed, 1);
  await processOutbox(db, messageHandlers, 100, m.current_period_end!);
  const at = { now: new Date(m.current_period_end!.getTime() + 3600_000) };
  assert.equal((await membership("Dee")).status, "past_due");
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at);
  const now = await membership("Dee");
  assert.deepEqual([now.status, now.next_attempt_at], ["active", null]);
  // The card form it was asked to pay meanwhile isn't wanted any more.
  assert.equal((await db.selectFrom("payment").select("status").where("membership_id", "=", m.id).where("provider_ref", "is", null).where("provider", "!=", "none").executeTakeFirstOrThrow()).status, "failed");
  await processOutbox(db, messageHandlers, 100, at.now);
  assert.ok(!(await staffAlerts(db, owner.personId!, new Date())).open.some((x) => x.kind === "membership_payment_failed_staff"));
});

test("the next period by card in the app, for a plan joined there; a plan only sold at the desk is paid at the desk", async () => {
  await run(db, "membership.sell", { person_id: people.Eve, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts);
  const m = await membership("Eve");
  const at = { now: la("2026-11-25", "12:00") };
  const p = await plan(db, "membership.pay_next", { membership_id: m.id }, as("Eve"), at);
  assert.equal(p.plan.summary.en, "Pay $80.00 by card for Monthly, until January 3, 2027.");
  // Nobody else's (theirs to pay, or a parent's).
  await rejects(plan(db, "membership.pay_next", { membership_id: m.id }, as("Fay"), at), "error.forbidden_reason");
  const { payment_id } = (await run(db, "membership.pay_next", { membership_id: m.id }, as("Eve"), at)).result as { payment_id: string };
  assert.equal(((await run(db, "membership.pay_next", { membership_id: m.id }, as("Eve"), at)).result as { payment_id: string }).payment_id, payment_id);   // a second tap
  await pay(payment_id, "Eve", at.now);
  const now = await membership("Eve");
  assert.deepEqual([now.source, now.saved_method, now.current_period_end!.toISOString()], ["desk", null, la("2027-01-04", "00:00").toISOString()]);
  // Never a card member's: theirs renews by itself.
  const cal = await membership("Cal");
  await rejects(plan(db, "membership.pay_next", { membership_id: cal.id }, as("Cal"), at), "error.membership_renews_itself");
  await run(db, "membership.sell", { person_id: people.Fay, plan_id: deskOnly, cents: 5000, method: "cash" }, desk, opts);
  await rejects(plan(db, "membership.pay_next", { membership_id: (await membership("Fay")).id }, as("Fay"), at), "error.pay_next_at_desk", "The next period of Desk is paid at the desk.");
});

test("a program place paid at the desk: part now, what the app asks for comes down, the rest closes it", async () => {
  const e = await enrol("Gus");
  assert.deepEqual((await pending(e.enrolment_id)).map((x) => [x.amount_cents, x.status]), [[3000, "pending"]]);
  const p = await plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 1000, method: "cash" }, desk, opts);
  assert.equal(p.plan.summary.en, "Record $10.00 paid in cash for Gus's place in Beginners. $20.00 is still owed: at the desk, or by card in the app.");
  await run(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 1000, method: "cash" }, desk, opts);
  assert.deepEqual((await pending(e.enrolment_id)).map((x) => [x.amount_cents, x.status]), [[2000, "pending"]]);
  await rejects(plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 2500, method: "cash" }, desk, opts), "error.more_than_owed_place");
  // Two desks at once: one fits.
  const a = await plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 2000, method: "cash" }, desk, opts);
  const b = await plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 2000, method: "cash" }, owner, opts);
  const { apply } = await import("../src/index.ts");
  assert.deepEqual((await Promise.allSettled([apply(db, a.runId, desk, opts), apply(db, b.runId, owner, opts)])).map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.deepEqual((await pending(e.enrolment_id)).map((x) => x.status), ["failed"]);
  await rejects(plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 1, method: "cash" }, desk, opts), "error.place_paid_up");
  assert.equal(await held("revenue", "programs"), -3000);
  const row = await db.selectFrom("enrolment").select("paid_by").where("id", "=", e.enrolment_id).executeTakeFirstOrThrow();
  assert.equal(row.paid_by, "desk");
});

test("cash goes back at the desk, never to a card: waiting there until it's handed over, then out of the drawer", async () => {
  const e = (await db.selectFrom("enrolment").select("id").where("person_id", "=", people.Gus!).executeTakeFirstOrThrow()).id;
  const refunds = stripe.refunds.size, drawer = await held("cash_drawer");
  await run(db, "enrolment.leave", { enrolment_id: e }, as("Gus"), opts);
  await processOutbox(db, { ...messageHandlers, ...moneyHandlers });
  assert.equal(stripe.refunds.size, refunds);   // nothing went to a card
  const waiting = await toGiveBack(db, people.Gus);
  assert.deepEqual(waiting.map((r) => r.amount_cents).sort((x, y) => x - y), [1000, 2000]);
  assert.equal(await held("cash_drawer"), drawer);   // still in the drawer until it's handed over
  assert.equal((await email("Gus", "left")).body, "You're no longer signed up for Beginners, Thu, Dec 10, 6:00 PM. $30.00 is yours to collect at the desk.");
  const p = await plan(db, "refund.give_back", { refund_id: waiting[0]!.id }, desk, opts);
  assert.match(p.plan.summary.en, /^Give Gus \$[0-9.]+ back in cash, for Beginners, Thu, Dec 10, 6:00 PM\.$/);
  for (const r of waiting) await run(db, "refund.give_back", { refund_id: r.id }, desk, opts);
  await rejects(plan(db, "refund.give_back", { refund_id: waiting[0]!.id }, desk, opts), "error.not_to_give_back");
  assert.deepEqual([await toGiveBack(db, people.Gus), await held("cash_drawer")], [[], drawer - 3000]);
  // A refund receipt for each, as for a card's.
  await issueReceipts(db);
  assert.equal((await db.selectFrom("receipt").select("id").where("kind", "=", "refund").where("person_id", "=", people.Gus!).execute()).length, 2);
});

test("a court booking paid in cash and cancelled: its money goes back at the desk, and the preview says so", async () => {
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-20T10:00:00-08:00", minutes: 60, person_id: people.Hal }, desk, opts)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, opts);
  const c = await plan(db, "booking.cancel", { booking_id: b }, desk, opts);
  assert.match(c.plan.summary.en, /\$40\.00 goes back at the desk\.$/);
  const refunds = stripe.refunds.size;
  await run(db, "booking.cancel", { booking_id: b }, desk, opts);
  await processOutbox(db, { ...messageHandlers, ...moneyHandlers });
  assert.equal(stripe.refunds.size, refunds);
  assert.deepEqual((await toGiveBack(db, people.Hal)).map((r) => r.amount_cents), [4000]);
  assert.match((await email("Hal", "booking_cancelled")).body, /\$40\.00 is yours to collect at the desk\.$/);
});

test("paid at the desk while a card form was open, and the card went through too: the extra goes back to the card", async () => {
  const e = await enrol("Ann");
  await openPayment(db, e.payment_id, people.Ann!);
  await run(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 3000, method: "cash" }, desk, opts);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", e.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  await checkPayment(db, e.payment_id, "test", NOW);
  const back = await db.selectFrom("refund").select(["amount_cents", "destination", "payment_id"]).where("enrolment_id", "=", e.enrolment_id).execute();
  assert.deepEqual(back.map((r) => [r.amount_cents, r.destination, r.payment_id]), [[3000, "card", e.payment_id]]);
});

const refundsOf = (paymentId: string) => db.selectFrom("refund").select(["amount_cents", "destination", "status"]).where("payment_id", "=", paymentId).execute()
  .then((r) => r.map((x) => [x.amount_cents, x.destination, x.status]));
const settleCard = (paymentId: string, now: Date) => db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()
  .then((p) => { stripe.settle(p.provider_ref!, "succeeded"); return checkPayment(db, paymentId, "test", now); });

test("the next period paid at the desk while its card form was open, and the card went through too: back to the card, once, and no second period", async () => {
  await run(db, "membership.sell", { person_id: people.Ivy, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts);
  const m = await membership("Ivy"), at = { now: la("2026-11-25", "12:00") };
  const { payment_id } = (await run(db, "membership.pay_next", { membership_id: m.id }, as("Ivy"), at)).result as { payment_id: string };
  await openPayment(db, payment_id, people.Ivy!);   // the card form is open
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at);
  const end = (await membership("Ivy")).current_period_end!;
  assert.equal(end.toISOString(), la("2027-01-04", "00:00").toISOString());
  assert.equal(await settleCard(payment_id, at.now), "succeeded");
  // The news again (the webhook and the minute job both): nothing more happens.
  assert.equal(await checkPayment(db, payment_id, "test", at.now), "succeeded");
  assert.deepEqual((await runAsSystem(db, "payment.settle", { payment_id, outcome: "succeeded" }, "test", at)).result, { already: "succeeded" });
  const now = await membership("Ivy");
  assert.deepEqual([now.current_period_end!.toISOString(), now.balance_cents], [end.toISOString(), 0]);   // no second period
  assert.deepEqual(await refundsOf(payment_id), [[8000, "card", "pending"]]);
  for (let i = 0; i < 2; i++) await processOutbox(db, { ...messageHandlers, ...moneyHandlers }, 100, at.now);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", payment_id).executeTakeFirstOrThrow()).provider_ref;
  assert.deepEqual([...stripe.refunds.values()].filter((r) => r.paymentRef === ref).map((r) => r.amountCents), [8000]);   // asked of the provider once
  assert.deepEqual(await refundsOf(payment_id), [[8000, "card", "sent"]]);
  assert.deepEqual(await email("Ivy", "membership_paid_twice"), { subject: "$80.00 back to your card: Monthly",
    body: "Your card payment of $80.00 for your Monthly membership came in after this period was already paid, so $80.00 goes back to your card. Your membership is paid until January 3, 2027." });
});

test("part of the next period at the desk, then the card for all of it: it pays what's owed there, and the rest goes back", async () => {
  await run(db, "membership.sell", { person_id: people.Jo, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts);
  const m = await membership("Jo"), at = { now: la("2026-11-25", "12:00") };
  const { payment_id } = (await run(db, "membership.pay_next", { membership_id: m.id }, as("Jo"), at)).result as { payment_id: string };
  await openPayment(db, payment_id, people.Jo!);
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 3000, method: "cash" }, desk, at);
  assert.equal((await membership("Jo")).balance_cents, 5000);
  await settleCard(payment_id, at.now);
  const now = await membership("Jo");
  assert.deepEqual([now.current_period_end!.toISOString(), now.balance_cents], [la("2027-01-04", "00:00").toISOString(), 0]);
  assert.deepEqual(await refundsOf(payment_id), [[3000, "card", "pending"]]);
  await processOutbox(db, messageHandlers, 100, at.now);
  assert.equal((await email("Jo", "membership_paid_twice")).body,
    "Your card payment of $80.00 for your Monthly membership came in after this period was already paid, so $30.00 goes back to your card. $50.00 of it paid what was still owed at the desk. Your membership is paid until January 3, 2027.");
});

test("the card first, then the desk: the desk's payment is refused, and nothing goes back", async () => {
  await run(db, "membership.sell", { person_id: people.Kit, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts);
  const m = await membership("Kit"), at = { now: la("2026-11-25", "12:00") };
  const { payment_id } = (await run(db, "membership.pay_next", { membership_id: m.id }, as("Kit"), at)).result as { payment_id: string };
  await openPayment(db, payment_id, people.Kit!);
  // The desk previews the next period while the member's card is going through.
  const p = await plan(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at);
  await settleCard(payment_id, at.now);
  const { apply } = await import("../src/index.ts");
  const drawer = await held("cash_drawer");
  await rejects(apply(db, p.runId, desk, at), "error.changed");   // what it read changed
  const now = await membership("Kit");
  assert.deepEqual([now.current_period_end!.toISOString(), now.balance_cents], [la("2027-01-04", "00:00").toISOString(), 0]);
  assert.deepEqual([await refundsOf(payment_id), await held("cash_drawer")], [[], drawer]);
});

test("a declined renewal paid at the desk while the member had its card form open: the card's money goes back", async () => {
  const join = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Max }, as("Max"), opts)).result as { payment_id: string };
  await pay(join.payment_id, "Max");
  const m = await membership("Max");
  stripe.failNextCharge = "card_declined";
  assert.equal((await renewMemberships(db, m.current_period_end!)).failed, 1);
  const at = { now: new Date(m.current_period_end!.getTime() + 3600_000) };
  const ask = await db.selectFrom("payment").select("id").where("membership_id", "=", m.id).where("status", "=", "pending").executeTakeFirstOrThrow();
  await openPayment(db, ask.id, people.Max!);
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 8000, method: "cash" }, desk, at);
  const end = (await membership("Max")).current_period_end!;
  await settleCard(ask.id, at.now);
  assert.equal((await membership("Max")).current_period_end!.toISOString(), end.toISOString());
  assert.deepEqual(await refundsOf(ask.id), [[8000, "card", "pending"]]);
});

test("the desk's day: what came in at the desk by how it was paid, what was given back there, and the drawer, on the club's clock", async () => {
  const at = (day: string, hhmm: string) => ({ now: la(day, hhmm) });
  await run(db, "membership.sell", { person_id: people.Ned, plan_id: deskOnly, cents: 3000, method: "cash" }, desk, at("2027-02-10", "09:15"));
  const m = await membership("Ned");
  await run(db, "membership.record_payment", { membership_id: m.id, cents: 2000, method: "terminal" }, desk, at("2027-02-10", "11:40"));
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: "2027-02-20T10:00:00-08:00", minutes: 60, person_id: people.Ned }, desk, at("2027-02-10", "12:00"))).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, at("2027-02-10", "12:05"));
  // Late on the 10th in California is already the 11th in UTC: it's still the 10th's.
  await run(db, "booking.cancel", { booking_id: b }, desk, at("2027-02-10", "22:30"));
  const [r] = await toGiveBack(db, people.Ned);
  await run(db, "refund.give_back", { refund_id: r!.id }, owner, at("2027-02-11", "10:05"));
  assert.deepEqual(await deskDays(db, "2027-02-10", "2027-02-11"), [
    { date: "2027-02-10", in: { cash: 7000, terminal: 2000, other: 0 }, back: { cash: 0, terminal: 0, other: 0 }, drawer: 7000 },
    { date: "2027-02-11", in: { cash: 0, terminal: 0, other: 0 }, back: { cash: 4000, terminal: 0, other: 0 }, drawer: -4000 }]);
  assert.deepEqual(await deskDays(db, "2027-02-12", "2027-02-28"), []);
  // Each line: when, how, for what, and who recorded it.
  const lines = await deskLines(db, "2027-02-10", "2027-02-11", { what: true });
  assert.deepEqual(lines.map((l) => [l.date, l.time, l.kind, l.method, l.cents, l.person, l.by]), [
    ["2027-02-10", "09:15", "in", "cash", 3000, "Ned", "Lee"], ["2027-02-10", "11:40", "in", "terminal", 2000, "Ned", "Lee"],
    ["2027-02-10", "12:05", "in", "cash", 4000, "Ned", "Lee"], ["2027-02-11", "10:05", "back", "cash", 4000, "Ned", "Robin Hale"]]);
  assert.ok(lines.every((l) => l.what.en && l.what.es));
});

test("read-only: nothing is sold or taken at the desk, and what's owed back can still be handed over", async () => {
  const e = await enrol("Ben");
  await run(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 3000, method: "cash" }, desk, opts);
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Ben"), opts);
  await runAsSystem(db, "club.read_only", { on: true }, "host", opts);
  try {
    await rejects(plan(db, "membership.sell", { person_id: people.Hal, plan_id: monthly, cents: 8000, method: "cash" }, desk, opts), "error.read_only");
    await rejects(plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 100, method: "cash" }, desk, opts), "error.read_only");
    const [r] = await toGiveBack(db, people.Ben);
    await run(db, "refund.give_back", { refund_id: r!.id }, desk, opts);
    assert.equal(await remindMembershipEnds(db, NOW), 0);
  } finally { await runAsSystem(db, "club.read_only", { on: false }, "host", opts); }
});
