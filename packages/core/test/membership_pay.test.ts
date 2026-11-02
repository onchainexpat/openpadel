import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, declineReason, memberPlan, onDate, messageHandlers, moneyHandlers, openPayment, plan, processOutbox, renewMemberships, run, runAsSystem, setPaymentProvider, staffAlerts, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, monthly: string, annual: string, deskOnly: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-01-31T18:00:00Z");   // Sat 31 Jan, 10 am: the month's last day
const la = (day: string, hhmm: string) => onDate(day, hhmm, TZ);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
/** What the card form and Stripe do: open the payment, the person pays, and the app checks. */
async function pay(paymentId: string, who: string, now = NOW) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test", now);
}
const join = async (who: string, planId: string, now = NOW) => (await run(db, "membership.join", { plan_id: planId, person_id: people[who] }, as(who), { now })).result as { payment_id: string };
const membership = (who: string) => db.selectFrom("membership").selectAll().where("person_id", "=", people[who]!).orderBy("started_at", "desc").executeTakeFirstOrThrow();
/** What the owner was told: every copy of one kind (each email, or each inbox message). */
const toOwner = (kind: string, channel: "email" | "inbox" = "email") => db.selectFrom("outbound_message").select(["subject", "body", "link"]).where("person_id", "=", owner.personId!).where("kind", "=", kind)
  .where("channel", "=", channel).orderBy("created_at").execute();
/** The owner's Today view: its alerts (the list looks back from the real clock, when the messages were written). */
const today = async () => staffAlerts(db, owner.personId!, new Date());
const email = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").orderBy("created_at", "desc").executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const opts = { now: NOW };
  monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month", days_ahead: 21 }, owner, opts)).result as any).plan_id;
  annual = ((await run(db, "membership.plan_set", { name: "Annual", price_cents: 80000, period: "year" }, owner, opts)).result as any).plan_id;
  deskOnly = ((await run(db, "membership.plan_set", { name: "Staff family", price_cents: 0, period: "year", join_in_app: false }, owner, opts)).result as any).plan_id;
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  }
});
after(async () => drop());

test("joining: the preview, paying by card, and the membership starts with that card saved", async () => {
  const p = await plan(db, "membership.join", { plan_id: monthly, person_id: people.Ann }, as("Ann"), { now: NOW });
  assert.equal(p.plan.summary.en, "Join the Monthly membership: $80.00 a month, paid now and then every month from the same card until you cancel. Cancelling stops the next payment; it runs to the end of what's paid.");
  const { payment_id } = await join("Ann", monthly);
  assert.equal((await join("Ann", monthly)).payment_id, payment_id);   // a second tap: the same payment
  assert.equal(await memberPlan(db, people.Ann!, NOW), null);          // not a member until it's paid
  assert.equal(await pay(payment_id, "Ann"), "succeeded");
  const m = await membership("Ann");
  assert.deepEqual([m.status, m.source, m.price_cents, m.period], ["active", "app", 8000, "month"]);
  assert.equal(m.current_period_end!.toISOString(), la("2026-02-28", "10:00").toISOString());   // the month's last day, at the same time
  assert.match(m.saved_customer!, /^cus_test_/); assert.match(m.saved_method!, /^pm_test_/);
  assert.equal((await memberPlan(db, people.Ann!, NOW))!.name, "Monthly");
  const revenue = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id")
    .select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c")).where("ledger_account.revenue_type", "=", "memberships").executeTakeFirstOrThrow();
  assert.equal(Number(revenue.c), -8000);
  await rejects(plan(db, "membership.join", { plan_id: annual, person_id: people.Ann }, as("Ann"), { now: NOW }), "error.already_a_member", "You already have a membership.");
  await rejects(plan(db, "membership.join", { plan_id: deskOnly, person_id: people.Ben }, as("Ben"), { now: NOW }), "error.plan_not_in_app", "The Staff family membership can't be joined in the app. Ask the club.");

  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ann", "membership_started")).body,
    "Your Monthly membership runs from today. You can book courts up to 21 days ahead. It renews on February 28, 2026 for $80.00; you can cancel any time in the app.");
});

test("renewals: on the day, from the saved card, at the price joined at, on the membership's own day of the month", async () => {
  assert.deepEqual(await renewMemberships(db, la("2026-02-28", "09:59")), { renewed: 0, failed: 0, ended: 0 });
  const before = stripe.charges.length;
  assert.equal((await renewMemberships(db, la("2026-02-28", "10:00"))).renewed, 1);
  const m = await membership("Ann");
  assert.equal(stripe.charges.length, before + 1);
  assert.deepEqual([stripe.charges.at(-1)!.amountCents, stripe.charges.at(-1)!.customer], [8000, m.saved_customer]);
  assert.equal(m.current_period_end!.toISOString(), la("2026-03-31", "10:00").toISOString());   // back on the 31st
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ann", "membership_renewed")).body, "Your Monthly membership has renewed: $80.00 paid. The next renewal is on March 31, 2026.");
  // The club raises the plan's price: Ann keeps hers.
  await run(db, "membership.plan_set", { plan_id: monthly, name: "Monthly", price_cents: 9000, period: "month", days_ahead: 21 }, owner, { now: la("2026-03-01", "12:00") });
  await renewMemberships(db, la("2026-03-31", "10:00"));
  assert.equal(stripe.charges.at(-1)!.amountCents, 8000);
  await run(db, "membership.end", { membership_id: (await membership("Ann")).id }, owner, { now: la("2026-03-31", "11:00") });   // out of the later tests' way
});

test("a failed renewal: still a member, tried again later, or paid by hand with another card", async () => {
  await pay((await join("Ben", annual)).payment_id, "Ben");
  // A year on, the card is declined.
  stripe.failNextCharge = "card_declined";
  assert.equal((await renewMemberships(db, la("2027-01-31", "10:00"))).failed, 1);
  let m = await membership("Ben");
  assert.deepEqual([m.status, m.failed_attempts, m.next_attempt_at!.toISOString()], ["past_due", 1, la("2027-02-02", "10:00").toISOString()]);
  assert.equal((await memberPlan(db, people.Ben!, la("2027-02-01", "10:00")))!.name, "Annual");   // it carries on meanwhile
  const payNow = await db.selectFrom("payment").selectAll().where("membership_id", "=", m.id).where("status", "=", "pending").executeTakeFirstOrThrow();
  assert.deepEqual([payNow.amount_cents, payNow.save_card], [80000, true]);
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ben", "membership_payment_failed")).body,
    "We couldn't take $800.00 for your Annual membership. Your membership carries on: we'll try your card again on February 2, 2027, or you can pay now with another card in the app.");
  // The owner and managers hear too, once: why, what happens next, and a link to Ben's page. It waits on Today.
  const [alert] = await toOwner("membership_payment_failed_staff");
  assert.deepEqual(alert, { subject: "A membership renewal didn't go through: Ben", link: `/people/${people.Ben}`,
    body: "Ben's Annual membership couldn't renew: the $800.00 payment didn't go through (the card was declined). They stay a member meanwhile. The card is tried again on February 2, 2027, and they can pay with another card in the app. If it's still not paid on February 5, 2027, the membership ends. You're told once, not at every try." });
  assert.deepEqual((await today()).open.map((a) => a.kind), ["membership_payment_failed_staff"]);
  assert.equal((await renewMemberships(db, la("2027-02-01", "10:00"))).failed, 0);   // not before the retry
  // Ben pays it himself with another card: renewed for a year from when it was due, on the new card.
  await pay(payNow.id, "Ben", la("2027-02-01", "11:00"));
  m = await membership("Ben");
  assert.deepEqual([m.status, m.failed_attempts, m.next_attempt_at], ["active", 0, null]);
  assert.equal(m.current_period_end!.toISOString(), la("2028-01-31", "10:00").toISOString());
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", payNow.id).executeTakeFirstOrThrow()).provider_ref!;
  assert.equal(m.saved_method, stripe.intents.get(ref)!.paymentMethod);
  assert.equal((await renewMemberships(db, la("2027-02-02", "10:00"))).renewed, 0);
  // The owner hears it's sorted, and the alert needs nobody now: closed with no one's name.
  await processOutbox(db, messageHandlers);
  // Only Ben's: Ann's renewals, paid on the day, told the staff nothing.
  assert.deepEqual((await toOwner("membership_renewal_paid_staff")).map((m) => m.body), ["Ben's Annual membership is paid after all ($800.00), so nothing more is needed about its failed renewal."]);
  const t = await today();
  assert.deepEqual([t.open.length, t.handled.map((a) => [a.kind, a.handled_by])], [0, [["membership_payment_failed_staff", ""]]]);
});

test("why a card was declined, as the staff read it: a bank's reason, or nothing when it means nothing to a person", () => {
  assert.deepEqual(declineReason("insufficient_funds"), { en: " (the card doesn't have enough funds)", es: " (la tarjeta no tiene fondos suficientes)" });
  assert.equal(declineReason("stolen_card").en, " (the card was declined)");   // as Stripe advises
  assert.equal(declineReason("authentication_required").en, " (the bank wants the cardholder to approve it)");
  assert.deepEqual([declineReason("idempotency_error").en, declineReason(null).en], ["", ""]);
});

test("three failed tries end it; a cancelled membership ends at its period without a charge; keeping it after all", async () => {
  await pay((await join("Cal", monthly, la("2026-03-01", "12:00"))).payment_id, "Cal", la("2026-03-01", "12:00"));
  for (const [day, hhmm] of [["2026-04-01", "12:00"], ["2026-04-03", "12:00"]]) { stripe.failNextCharge = day === "2026-04-01" ? "expired_card" : "card_declined"; assert.equal((await renewMemberships(db, la(day!, hhmm!))).failed, 1); }
  stripe.failNextCharge = "card_declined";
  assert.equal((await renewMemberships(db, la("2026-04-06", "12:00"))).ended, 1);
  const cal = await membership("Cal");
  assert.deepEqual([cal.status, cal.end_reason, cal.failed_attempts], ["ended", "not_paid", 3]);
  assert.equal((await db.selectFrom("payment").select("status").where("membership_id", "=", cal.id).where("provider_ref", "is", null).executeTakeFirstOrThrow()).status, "failed");
  assert.equal(await memberPlan(db, people.Cal!, la("2026-04-06", "12:01")), null);

  await pay((await join("Dee", monthly, la("2026-03-01", "12:00"))).payment_id, "Dee", la("2026-03-01", "12:00"));
  const dee = await membership("Dee");
  const c = await run(db, "membership.cancel", { membership_id: dee.id }, as("Dee"), { now: la("2026-03-10", "09:00") });
  assert.equal(c.plan.summary.en, "Cancel your Monthly membership. It won't be charged again, and it runs until April 1, 2026.");
  await rejects(plan(db, "membership.cancel", { membership_id: dee.id }, as("Dee")), "error.membership_already_cancelled");
  await rejects(plan(db, "membership.cancel", { membership_id: (await membership("Ben")).id }, as("Dee")), "error.forbidden_reason");   // not hers
  const r = await run(db, "membership.resume", { membership_id: dee.id }, as("Dee"), { now: la("2026-03-11", "09:00") });
  assert.equal(r.plan.summary.en, "Keep your Monthly membership. It renews on April 1, 2026 for $90.00.");
  await run(db, "membership.cancel", { membership_id: dee.id }, as("Dee"), { now: la("2026-03-12", "09:00") });
  const charges = stripe.charges.length;
  assert.equal((await renewMemberships(db, la("2026-04-01", "12:00"))).ended, 1);
  assert.equal(stripe.charges.length, charges);
  const ended = await membership("Dee");
  assert.deepEqual([ended.status, ended.ended_at!.toISOString()], ["ended", la("2026-04-01", "12:00").toISOString()]);

  await processOutbox(db, messageHandlers);
  assert.equal((await email("Cal", "membership_ended_unpaid")).body, "Your Monthly membership has ended because its payment didn't go through. You can join again in the app any time.");
  // The owner heard once of the failure (not at the second try), then that it ended; the ending takes the failure's place on Today.
  const failed = (await toOwner("membership_payment_failed_staff", "inbox")).filter((m) => m.subject.endsWith(": Cal"));
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.body, /^Cal's Monthly membership couldn't renew: the \$\d+\.\d{2} payment didn't go through \(the card has expired\)\. .* tried again on April 3, 2026, .* not paid on April 6, 2026, the membership ends\./);
  // Only Cal's: Dee's, cancelled, told the staff nothing.
  assert.deepEqual((await toOwner("membership_ended_unpaid_staff")).map((m) => [m.subject, m.body, m.link]), [["A membership ended unpaid: Cal",
    "Cal's Monthly membership has ended: its renewal still didn't go through on the last try. They can join again in the app.", `/people/${people.Cal}`]]);
  assert.deepEqual((await today()).open.map((a) => [a.kind, a.subject]), [["membership_ended_unpaid_staff", "A membership ended unpaid: Cal"]]);
  assert.equal((await email("Dee", "membership_cancelled")).body,
    "Your Monthly membership is cancelled. It won't be charged again, and it runs until April 1, 2026. Changed your mind? You can keep it in the app until then.");
  assert.equal((await email("Dee", "membership_ended")).subject, "Your membership has ended: Monthly");

  // A membership given at the desk doesn't renew, so there's nothing for the member to cancel.
  await run(db, "membership.grant", { person_id: people.Eve, plan_id: deskOnly }, owner, { now: NOW });
  await rejects(plan(db, "membership.cancel", { membership_id: (await membership("Eve")).id }, as("Eve")), "error.membership_not_renewing");
});

test("paid for twice: the second payment goes back to the card", async () => {
  const first = await join("Fay", monthly), second = await join("Fay", annual);
  assert.notEqual(first.payment_id, second.payment_id);
  await pay(first.payment_id, "Fay"); await pay(second.payment_id, "Fay");
  assert.equal((await membership("Fay")).plan_id, monthly);
  const back = await db.selectFrom("refund").select(["amount_cents", "status"]).where("payment_id", "=", second.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([back.amount_cents, back.status], [80000, "pending"]);
  assert.equal((await db.selectFrom("membership").select("id").where("person_id", "=", people.Fay!).execute()).length, 1);
});

test("the club pauses a membership: no benefits and no charge meanwhile, and the renewal moves with it", async () => {
  const m = await membership("Fay");   // Monthly, joined 31 January, renews 28 February
  const p = await run(db, "membership.pause", { membership_id: m.id, until: "2026-02-19" }, owner, { now: la("2026-02-10", "10:00") });
  assert.equal(p.plan.summary.en, "Pause Fay's Monthly membership until February 19, 2026. Its benefits stop and nothing is charged meanwhile; the paid time left moves to after the pause, so it renews on March 10, 2026.");
  assert.equal(await memberPlan(db, people.Fay!, la("2026-02-15", "12:00")), null);
  assert.equal((await memberPlan(db, people.Fay!, la("2026-02-21", "12:00")))!.name, "Monthly");
  const before = stripe.charges.length;
  await renewMemberships(db, la("2026-02-28", "10:00"));
  assert.equal(stripe.charges.length, before);   // not due yet: the pause moved it
  await rejects(plan(db, "membership.pause", { membership_id: m.id, until: "2026-03-01" }, owner, { now: la("2026-02-12", "10:00") }), "error.membership_paused_already");
  // Back after five days instead of nine: the pause she didn't use comes off again.
  await run(db, "membership.unpause", { membership_id: m.id }, owner, { now: la("2026-02-15", "10:00") });
  assert.equal((await membership("Fay")).current_period_end!.toISOString(), new Date(m.current_period_end!.getTime() + 5 * 86400_000).toISOString());
  assert.equal((await memberPlan(db, people.Fay!, la("2026-02-15", "12:00")))!.name, "Monthly");
  await rejects(plan(db, "membership.pause", { membership_id: m.id, until: "2026-03-01" }, as("Fay"), { now: la("2026-02-16", "10:00") }), "error.forbidden_reason");   // the club pauses
  await processOutbox(db, messageHandlers);
  assert.match((await email("Fay", "membership_paused")).body, /^Your Monthly membership is paused through February 19, 2026\. Nothing is charged meanwhile, and the time you'd paid for is kept for after\. It now renews on March 10, 2026\.$/);
});

test("a membership refund that doesn't go through: the managers hear which membership, on the person's page", async () => {
  people.Gus = ((await run(db, "person.create", { display_name: "Gus", email: "gus@example.test" }, owner, { now: NOW })).result as { person_id: string }).person_id;
  const first = await join("Gus", monthly), second = await join("Gus", annual);
  await pay(first.payment_id, "Gus");
  await processOutbox(db, moneyHandlers);   // the refunds earlier tests asked for go first
  await pay(second.payment_id, "Gus");
  stripe.failNextRefund = true;
  await processOutbox(db, moneyHandlers);
  await processOutbox(db, messageHandlers);
  const [told] = await toOwner("refund_failed");
  assert.equal(told!.body, "The $800.00 refund to Gus for the Annual membership didn't go through (the card's bank turned it down). Look at it on Gus's page.");
  assert.equal(told!.link, `/people/${people.Gus}`);
});
