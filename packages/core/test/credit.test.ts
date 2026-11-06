// Club credit (credit.ts): given by staff as a refund, spent by the member before a card form opens (all of it, or part
// of a program place), back to credit when what it paid for is refunded, paid out at the desk, and never spent twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, creditBalance, deskLines, messageHandlers, onDate, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, court: string, clinic: string;
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
let slot = 0;
/** A court booked and paid by card, then cancelled by the desk with everything back as club credit: $40 of credit. */
async function creditOf40(who: string) {
  const day = String(5 + slot++).padStart(2, "0");
  const b = (await run(db, "booking.request", { court_id: court, starts_at: `2026-11-${day}T10:00:00-08:00`, minutes: 60, person_id: people[who], pay: "whole" }, as(who), opts)).result as { booking_id: string; payment_id: string };
  assert.equal(await cardPaid(b.payment_id, who), "succeeded");
  const p = await plan(db, "booking.cancel", { booking_id: b.booking_id, refund: "credit" }, desk, opts);
  assert.equal(p.plan.summary.en.includes("$40.00 goes to the players' club credit."), true, p.plan.summary.en);
  await apply(db, p.runId, desk, opts);
}
const book = async (who: string, day: string, hour = "12") => (await run(db, "booking.request", { court_id: court, starts_at: `2026-11-${day}T${hour}:00:00-08:00`, minutes: 60, person_id: people[who], pay: "whole" }, as(who), opts)).result as { booking_id: string; payment_id: string };
const status = async (bookingId: string) => (await db.selectFrom("booking").select("status").where("id", "=", bookingId).executeTakeFirstOrThrow()).status;
async function held(kind: string, personId?: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind as any).$if(Boolean(personId), (q) => q.where("ledger_account.person_id", "=", personId!)).executeTakeFirst();
  return Number(r?.c ?? 0);
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve"])
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
});
after(async () => drop());

test("staff give a refund as club credit; the member pays a court with it; cancelled, it goes back to credit", async () => {
  await creditOf40("Ann");
  assert.equal(await creditBalance(db, people.Ann!), 4000);
  // Only staff choose credit over the card.
  const own = await book("Ann", "12");
  await rejects(plan(db, "booking.cancel", { booking_id: own.booking_id, refund: "credit" }, as("Ann"), opts), "error.refund_choice_staff");
  // All of a court from credit: it's booked, as by card, and the card form never opens.
  const p = await plan(db, "payment.use_credit", { payment_id: own.payment_id }, as("Ann"), opts);
  assert.equal(p.plan.summary.en.startsWith("Pay $40.00 for "), true, p.plan.summary.en);
  await apply(db, p.runId, as("Ann"), opts);
  assert.equal(await status(own.booking_id), "confirmed");
  const pay = await db.selectFrom("payment").selectAll().where("id", "=", own.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([pay.method, pay.provider, pay.status], ["credit", "none", "succeeded"]);
  assert.equal(await creditBalance(db, people.Ann!), 0);
  await rejects(plan(db, "payment.use_credit", { payment_id: (await book("Ann", "13")).payment_id }, as("Ann"), opts), "error.credit_none");
  // Cancelled in time: everything back, to credit (not a card that was never used, not the desk).
  await run(db, "booking.cancel", { booking_id: own.booking_id }, as("Ann"), opts);
  assert.equal(await creditBalance(db, people.Ann!), 4000);
  const r = await db.selectFrom("refund").selectAll().where("payment_id", "=", own.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([r.destination, r.status, r.amount_cents], ["credit", "sent", 4000]);
  await processOutbox(db, messageHandlers);
  const msg = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).where("kind", "=", "booking_cancelled").where("channel", "=", "email")
    .orderBy("created_at", "desc").executeTakeFirstOrThrow();
  assert.match(msg.body, /\$40\.00 goes to your club credit\./);
});

test("part of a program place from credit: the card is asked for the rest; a court is paid from credit only all at once", async () => {
  await creditOf40("Ben");
  const court2 = await book("Ben", "14");
  await run(db, "booking.cancel", { booking_id: court2.booking_id }, as("Ben"), opts);   // nothing paid, nothing back
  const e = (await run(db, "enrolment.join", { program_id: clinic, person_id: people.Ben }, as("Ben"), opts)).result as { enrolment_id: string; payment_id: string };
  const p = await plan(db, "payment.use_credit", { payment_id: e.payment_id }, as("Ben"), opts);
  assert.match(p.plan.summary.en, /Pay \$40\.00 for .* from your club credit\. \$20\.00 is left to pay by card\./);
  const r = (await apply(db, p.runId, as("Ben"), opts)) as { paid: boolean; payment_id: string; rest_cents: number };
  assert.deepEqual([r.paid, r.rest_cents], [false, 2000]);
  assert.equal(await creditBalance(db, people.Ben!), 0);
  assert.equal(await cardPaid(r.payment_id, "Ben"), "succeeded");
  const rows = await db.selectFrom("payment").select(["method", "amount_cents", "status"]).where("enrolment_id", "=", e.enrolment_id).where("status", "=", "succeeded").orderBy("created_at").execute();
  assert.deepEqual(rows.map((x) => [x.method, x.amount_cents]), [["credit", 4000], ["card", 2000]]);
  // Leaving in time: the card's part back to the card, the credit's to credit.
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Ben"), opts);
  assert.equal(await creditBalance(db, people.Ben!), 4000);
  const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(["refund.destination", "refund.amount_cents"]).where("payment.enrolment_id", "=", e.enrolment_id).orderBy("refund.destination").execute();
  assert.deepEqual(back.map((x) => [x.destination, x.amount_cents]), [["card", 2000], ["credit", 4000]]);
  // $40 of credit can't pay part of a $60 court... it's $40 here, so a 90-minute one ($60) is refused.
  const long = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-14T15:00:00-08:00", minutes: 90, person_id: people.Ben, pay: "whole" }, as("Ben"), opts)).result as { payment_id: string };
  await rejects(plan(db, "payment.use_credit", { payment_id: long.payment_id }, as("Ben"), opts), "error.credit_part_court");
});

test("two checkouts spend the same credit at once: one is paid from credit, the other is refused and still owes its card", async () => {
  await creditOf40("Cal");
  const a = await book("Cal", "15"), b = await book("Cal", "16");
  const pa = await plan(db, "payment.use_credit", { payment_id: a.payment_id }, as("Cal"), opts), pb = await plan(db, "payment.use_credit", { payment_id: b.payment_id }, as("Cal"), opts);
  const out = await Promise.allSettled([apply(db, pa.runId, as("Cal"), opts), apply(db, pb.runId, as("Cal"), opts)]);
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(out.map((x) => x.status)));
  assert.equal(await creditBalance(db, people.Cal!), 0);
  const paid = await db.selectFrom("payment").select(["method", "status"]).where("id", "in", [a.payment_id, b.payment_id]).execute();
  assert.deepEqual(paid.map((x) => `${x.method}:${x.status}`).sort(), ["card:pending", "credit:succeeded"]);
  assert.equal(await held("member_credit", people.Cal), 0, "the books hold no credit for Cal either");
});

test("a card form already open, a membership, or someone else's payment: credit isn't used", async () => {
  await creditOf40("Dee");
  const b = await book("Dee", "17");
  await openPayment(db, b.payment_id, people.Dee!);
  await rejects(plan(db, "payment.use_credit", { payment_id: b.payment_id }, as("Dee"), opts), "error.credit_card_open");
  const c = await book("Dee", "17", "15");
  await assert.rejects(plan(db, "payment.use_credit", { payment_id: c.payment_id }, as("Eve"), opts));
  const monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 3000, period: "month" }, owner, opts)).result as any).plan_id;
  const j = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Dee }, as("Dee"), opts)).result as { payment_id: string };
  await rejects(plan(db, "payment.use_credit", { payment_id: j.payment_id }, as("Dee"), opts), "error.credit_membership");
});

test("paid out at the desk by a manager, never more than held, on the desk's day; the account can't be deleted while credit is held", async () => {
  await creditOf40("Eve");
  // Deleting the account first would leave the credit owed to nobody.
  await assert.rejects(plan(db, "privacy.erase", { person_id: people.Eve }, as("Eve"), opts), (e: any) => /club credit/.test(JSON.stringify(e.params ?? e.text ?? e.message)));
  // The front desk can't pay credit out; a manager or the owner can, up to what's held.
  await assert.rejects(plan(db, "credit.pay_out", { person_id: people.Eve, cents: 1000, method: "cash" }, desk, opts));
  await rejects(plan(db, "credit.pay_out", { person_id: people.Eve, cents: 5000, method: "cash" }, owner, opts), "error.credit_more_than_held");
  const p = await plan(db, "credit.pay_out", { person_id: people.Eve, cents: 4000, method: "cash" }, owner, opts);
  // Her credit is a card payment the club gave back as credit: paying it out in cash is warned of, as a card-bought
  // gift card's is (Kelly, 6 Nov).
  assert.equal(p.plan.summary.en, "Pay Eve $40.00 of their club credit, in cash. $0.00 of credit is left. $40.00 of their credit came from card payments the club refunded as credit: paying it out in cash can be a way to cash out a stolen card.");
  assert.match(p.plan.summary.es, /pagos con tarjeta que el club devolvió como crédito/);
  assert.equal((p.plan.details as any).card_refunds, 4000);
  await apply(db, p.runId, owner, opts);
  assert.equal(await creditBalance(db, people.Eve!), 0);
  const day = onDate("2026-11-04", "00:00", TZ).toISOString().slice(0, 10);
  const lines = await deskLines(db, "2026-11-04", "2026-11-04");
  assert.ok(lines.some((l) => l.kind === "back" && l.method === "cash" && l.cents === 4000 && l.person === "Eve"), `${day} ${JSON.stringify(lines)}`);
  // Now nothing stands in the way of deleting the account (for credit).
  const erase = await plan(db, "privacy.erase", { person_id: people.Eve }, as("Eve"), opts).catch((e) => e);
  assert.ok(!/club credit/.test(JSON.stringify(erase?.params ?? erase?.plan ?? {})));
});

test("read-only: credit isn't spent (nothing new is taken), but it's still paid out", async () => {
  await creditOf40("Ann");
  const b = await book("Ann", "13", "15");
  await run(db, "club.read_only", { on: true, reason: "test" }, { ...owner, auth: "passkey" } as Actor, opts).catch(async () => {
    await db.updateTable("club").set({ read_only_since: NOW }).execute();
  });
  await assert.rejects(plan(db, "payment.use_credit", { payment_id: b.payment_id }, as("Ann"), opts));
  const before = await creditBalance(db, people.Ann!);
  await run(db, "credit.pay_out", { person_id: people.Ann, cents: 1000, method: "other" }, owner, opts);
  assert.equal(await creditBalance(db, people.Ann!), before - 1000);
  await db.updateTable("club").set({ read_only_since: null }).execute();
});
