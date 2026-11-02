import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { approveKidRequest, checkFamilyCard, checkPayment, combine, moneyHandlers, friendsOf, kidOf, messageHandlers, monthSpent, openFamilyCardSetup, openPayment, payKidRun, payWithFamilyCard, plan, processOutbox, run,
  runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, court2: string, clinic: string, mia: string, leo: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const asMia = (): Actor => ({ personId: mia, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const msg = async (to: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", to).where("kind", "=", kind).where("channel", "=", "inbox").orderBy("id").execute();
const court90 = (c: string, day: string, hhmm: string, person: string, extra: object = {}) => ({ court_id: c, starts_at: `${day}T${hhmm}:00-08:00`, minutes: 90, pay: "whole", person_id: person, ...extra });
/** A parent saves the family card through the card form (the test provider plays the form). */
async function saveCard(parent: string) {
  const r = await openFamilyCardSetup(db, as(parent));
  const ref = (await db.selectFrom("family_card").select("provider_ref").where("id", "=", r.cardId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settleSetup(ref);
  assert.equal(await checkFamilyCard(db, r.cardId, "test", NOW), "succeeded");
  return r.cardId;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner, opts)).result as any).court_id;
  const room = ((await run(db, "court.create", { location_id: loc, name: "Court 3" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  await run(db, "policy.set", { max_active: 10 }, owner, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Junior Clinic", capacity: 8, price_cents: 2500 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-05T10:00:00-08:00", ends_at: "2026-12-05T11:00:00-08:00", court_ids: [room] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  for (const name of ["Pat", "Sam", "Hal", "Ann", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Sam!).execute();
  mia = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2012 }, as("Pat"), opts)).result as any).person_id;
  leo = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Leo", birth_year: 2016 }, as("Pat"), opts)).result as any).person_id;
  const code = ((await run(db, "household.invite", { person_id: people.Pat }, as("Pat"), opts)).result as any).code;
  await run(db, "household.accept_invite", { person_id: people.Sam, code }, as("Sam"), opts);
  for (const [who, lv] of [["Hal", 3.5], ["Ann", 3.4], ["Dee", 3.6]] as const) await run(db, "level.set", { person_id: people[who], level: lv, reason: "Starting level" }, owner, opts);
  await run(db, "level.set", { person_id: mia, level: 3.3, reason: "Starting level" }, owner, opts);
  await processOutbox(db, messageHandlers);
});
after(async () => drop());

test("a parent turns on a login for a kid of 13 or more: their own email, the member role, and rules that start careful", async () => {
  await rejects(plan(db, "kid.give_login", { person_id: leo, email: "leo@example.test" }, as("Pat"), opts), "error.kid_too_young", "Leo can have a login of their own from 2029, the year they turn 13.");
  await rejects(plan(db, "kid.give_login", { person_id: mia, email: "mia@example.test" }, as("Ann"), opts), "error.forbidden_reason");   // not Ann's kid
  await rejects(plan(db, "kid.give_login", { person_id: mia, email: "ann@example.test" }, as("Pat"), opts), "error.duplicate_email");
  const r = await run(db, "kid.give_login", { person_id: mia, email: "Mia@Example.test" }, as("Pat"), opts);
  assert.equal(r.plan.summary.en, "Turn on a login for Mia, who signs in with mia@example.test. They can book open matches, courts, programs and lessons on their own, up to $100.00 a month on the family card, and friends stay off. Anything else comes to you to approve, and you can change the rules at any time.");
  const p = await db.selectFrom("person").select(["junior", "own_login", "email"]).where("id", "=", mia).executeTakeFirstOrThrow();
  assert.deepEqual(p, { junior: true, own_login: true, email: "mia@example.test" });
  assert.equal((await kidOf(db, mia))?.monthly_limit_cents, 10000);
  await rejects(plan(db, "kid.set_rules", { person_id: mia, monthly_limit_cents: 999_999 }, asMia(), opts), "error.invalid_input");
  await rejects(plan(db, "kid.set_rules", { person_id: mia, courts: false }, asMia(), opts), "error.forbidden_reason");   // a kid doesn't set their own rules
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(mia, "kid_login"), [{ subject: "Your login at Kestrel Padel",
    body: "Pat turned on a login for you at Kestrel Padel. Sign in with mia@example.test. What you book goes on the family card, and your parents see it." }]);
});

test("the waiver comes from a parent; memberships stay with the parents", async () => {
  await run(db, "waiver.set", { body: "Padel is a sport with risks. I play at my own risk and follow the club's rules." }, owner, opts);
  await rejects(plan(db, "booking.request", court90(court, "2026-12-03", "18:00", mia), asMia(), opts), "error.waiver_needed_parent", "One of your parents needs to accept the club's waiver for you first.");
  await rejects(plan(db, "waiver.accept", { person_id: mia }, asMia(), opts), "error.waiver_needed_parent");
  await run(db, "waiver.accept", { person_id: mia }, as("Sam"), opts);
  for (const p of ["Pat", "Hal", "Ann", "Dee"]) await run(db, "waiver.accept", { person_id: people[p] }, as(p), opts);
  const plan1 = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  await rejects(plan(db, "membership.join", { plan_id: plan1, person_id: mia }, asMia(), opts), "error.kid_parents_only", "Your parents look after memberships: ask one of them.");
});

test("with no family card, a kid's booking waits for a parent to pay it", async () => {
  const r = await run(db, "booking.request", court90(court, "2026-12-03", "18:00", mia), asMia(), opts);
  assert.equal(r.status, "planned");
  const paid = await payKidRun(db, r.runId, mia, NOW);
  assert.deepEqual(paid, { status: "parent", cents: 6000, why: "no_card" });
  const pay = await db.selectFrom("payment").select(["status", "parent_to_pay_at"]).where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow();
  assert.equal(pay.status, "pending"); assert.ok(pay.parent_to_pay_at);
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(people.Pat!, "kid_pay_needed"), [{ subject: "Mia: $60.00 for you to pay",
    body: "Mia booked Court 1, Thu, Dec 3, 6:00 PM, but there's no family card saved. Pay $60.00 on the Family page to keep it." }]);
  assert.deepEqual((await msg(people.Sam!, "kid_pay_needed")).map((m) => m.subject), ["Mia: $60.00 pendientes de que pagues"]);
  // A parent pays it with the usual card form, as for any junior.
  await openPayment(db, (r.result as any).payment_id, people.Pat!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  assert.equal(await checkPayment(db, (r.result as any).payment_id, "test", NOW), "succeeded");
});

test("with a family card, a kid's court goes on it at once; the parents hear what for", async () => {
  await saveCard("Pat");
  await run(db, "kid.set_rules", { person_id: mia, monthly_limit_cents: 15000 }, as("Sam"), opts);
  assert.equal(await monthSpent(db, mia, NOW), 6000);
  const r = await run(db, "booking.request", court90(court2, "2026-12-04", "18:00", mia), asMia(), opts);
  const charges = stripe.charges.length;
  assert.deepEqual(await payKidRun(db, r.runId, mia, NOW), { status: "paid", cents: 6000 });
  assert.equal(stripe.charges.length, charges + 1);
  assert.equal(stripe.charges.at(-1)!.customer, stripe.customers.get(people.Pat!));   // the parent's card, not a card of Mia's
  const pay = await db.selectFrom("payment").select(["status", "family_card_id"]).where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow();
  assert.equal(pay.status, "succeeded"); assert.ok(pay.family_card_id);
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", (r.result as any).booking_id).executeTakeFirstOrThrow()).status, "confirmed");
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(people.Pat!, "family_charged"), [{ subject: "Mia: $60.00 on the family card", body: "Mia booked Court 2, Fri, Dec 4, 6:00 PM: $60.00 on the family card." }]);
  assert.deepEqual((await msg(people.Sam!, "family_charged")).map((m) => m.body), ["Mia reservó Court 2, vie, 4 de dic, 6:00 p.m.: $60.00 en la tarjeta familiar."]);
  // A second try at the same payment does nothing: it's paid.
  assert.equal(await payWithFamilyCard(db, (r.result as any).payment_id, NOW), null);
});

test("over the monthly limit, the kid asks; a parent's yes books it then and puts it on the card", async () => {
  const r = await run(db, "booking.request", court90(court, "2026-12-05", "18:00", mia), asMia(), opts);
  assert.equal(r.plan.summary.en, "Ask your parents to approve this: Book Court 1, Sat, Dec 5, 6:00 PM, for 90 minutes: $60.00, paid now. It would take you over your monthly limit of $150.00 ($120.00 spent this month).");
  const id = (r.result as any).request_id;
  assert.deepEqual(r.result, { request_id: id, asked_parent: true });
  assert.equal((await db.selectFrom("booking").select("id").where("organiser_id", "=", mia).execute()).length, 2);   // nothing held while it waits
  await rejects(plan(db, "booking.request", court90(court, "2026-12-05", "18:00", mia), asMia(), opts), "error.kid_already_asked");
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(people.Pat!, "kid_asked"), [{ subject: "Mia asks for your OK",
    body: "Mia asks for your OK: Book Court 1, Sat, Dec 5, 6:00 PM, for 90 minutes: $60.00, paid now. It would take you over your monthly limit of $150.00 ($120.00 spent this month). Say yes or no on the Family page." }]);
  await rejects(approveKidRequest(db, id, as("Ann"), NOW), "error.forbidden_reason");
  await rejects(approveKidRequest(db, id, asMia(), NOW), "error.forbidden_reason");   // not their own
  const yes = await approveKidRequest(db, id, as("Pat"), NOW);
  assert.equal(yes.outcome, "done");
  assert.equal((yes as any).paid.status, "paid");
  const req = await db.selectFrom("kid_request").select(["status", "decided_by", "run_id"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.equal(req.status, "done"); assert.equal(req.decided_by, people.Pat); assert.ok(req.run_id);
  assert.equal(await monthSpent(db, mia, NOW), 18000);
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(mia, "kid_approved"), [{ subject: "Your request: yes", body: "Pat said yes, and it's done. You asked: Book Court 1, Sat, Dec 5, 6:00 PM, for 90 minutes: $60.00, paid now." }]);
});

test("a yes that can't be done any more is said, and nothing is charged", async () => {
  await run(db, "kid.set_rules", { person_id: mia, courts: false }, as("Pat"), opts);
  const r = await run(db, "booking.request", court90(court2, "2026-12-06", "09:00", mia), asMia(), opts);
  assert.match(r.plan.summary.en, /Your parents have courts switched off for you\.$/);
  // Meanwhile someone else books that court.
  const hal = await run(db, "booking.request", court90(court2, "2026-12-06", "09:00", people.Hal!), as("Hal"), opts);
  await openPayment(db, (hal.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (hal.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (hal.result as any).payment_id, "test", NOW);
  const charges = stripe.charges.length;
  const yes = await approveKidRequest(db, (r.result as any).request_id, as("Sam"), NOW);
  assert.equal(yes.outcome, "failed");
  assert.equal(stripe.charges.length, charges);
  await processOutbox(db, messageHandlers);
  assert.equal((await msg(people.Pat!, "kid_approval_failed_parent")).length, 1);
  assert.match((await msg(mia, "kid_approval_failed"))[0]!.body, /^Sam said yes, but it couldn't be done: .+ Nothing was charged\. You asked: Book Court 2/);
});

test("a parent's no; a kid takes back their own request", async () => {
  const r = await run(db, "booking.request", court90(court, "2026-12-07", "09:00", mia), asMia(), opts);
  const no = await run(db, "kid.decline_request", { request_id: (r.result as any).request_id }, as("Pat"), opts);
  assert.match(no.plan.summary.en, /^Say no to Mia: Book Court 1/);
  await rejects(approveKidRequest(db, (r.result as any).request_id, as("Pat"), NOW), "error.kid_request_closed");
  const again = await run(db, "booking.request", court90(court, "2026-12-07", "09:00", mia), asMia(), opts);
  await rejects(plan(db, "kid.withdraw_request", { request_id: (again.result as any).request_id }, as("Pat"), opts), "error.forbidden_reason");
  await run(db, "kid.withdraw_request", { request_id: (again.result as any).request_id }, asMia(), opts);
  await processOutbox(db, messageHandlers);
  assert.equal((await msg(mia, "kid_declined"))[0]!.subject, "Your request: no");
  await run(db, "kid.set_rules", { person_id: mia, courts: true, monthly_limit_cents: 50000 }, as("Pat"), opts);
});

test("a kid joins an open match and signs up for a clinic, each on the card", async () => {
  const om = await run(db, "booking.request", { court_id: court, starts_at: "2026-12-08T18:00:00-08:00", minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 4 } }, as("Hal"), opts);
  await openPayment(db, (om.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (om.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (om.result as any).payment_id, "test", NOW);
  const j = await run(db, "booking.join", { booking_id: (om.result as any).booking_id, person_id: mia }, asMia(), opts);
  assert.deepEqual(await payKidRun(db, j.runId, mia, NOW), { status: "paid", cents: 1500 });
  const e = await run(db, "enrolment.join", { program_id: clinic, person_id: mia }, asMia(), opts);
  assert.deepEqual(await payKidRun(db, e.runId, mia, NOW), { status: "paid", cents: 2500 });
  await processOutbox(db, messageHandlers);
  const bodies = (await msg(people.Pat!, "family_charged")).map((m) => m.body);
  assert.ok(bodies.includes("Mia booked a place in the match on Court 1, Tue, Dec 8, 6:00 PM: $15.00 on the family card."), bodies.join("\n"));
  assert.ok(bodies.includes("Mia booked Junior Clinic, Sat, Dec 5, 10:00 AM: $25.00 on the family card."), bodies.join("\n"));
});

test("a declined family card: a parent is asked to pay, and the next try uses a fresh charge", async () => {
  stripe.failNextCharge = "card_declined";
  const r = await run(db, "booking.request", court90(court2, "2026-12-09", "18:00", mia), asMia(), opts);
  assert.deepEqual(await payKidRun(db, r.runId, mia, NOW), { status: "parent", cents: 6000, why: "declined" });
  const pid = (r.result as any).payment_id;
  assert.equal((await db.selectFrom("payment").select("family_declines").where("id", "=", pid).executeTakeFirstOrThrow()).family_declines, 1);
  await processOutbox(db, messageHandlers);
  assert.deepEqual((await msg(people.Pat!, "kid_pay_needed")).at(-1), { subject: "Mia: $60.00 for you to pay",
    body: "Mia booked Court 2, Wed, Dec 9, 6:00 PM, but the family card didn't go through (the card was declined). Pay $60.00 on the Family page to keep it." });
  assert.equal((await msg(mia, "kid_parent_pays")).length, 2);
  // Asked again (the parent sorted out the card): a new key, so the decline isn't replayed.
  await db.updateTable("payment").set({ parent_to_pay_at: null }).where("id", "=", pid).execute();
  assert.deepEqual(await payWithFamilyCard(db, pid, NOW), { status: "paid", cents: 6000 });
});

test("a refund to the family card is told to the parents", async () => {
  const b = await db.selectFrom("booking").innerJoin("booking_player", "booking_player.booking_id", "booking.id").innerJoin("payment", "payment.booking_player_id", "booking_player.id")
    .select("booking.id").where("booking.organiser_id", "=", mia).where("booking.status", "=", "confirmed").where("payment.family_card_id", "is not", null).orderBy("booking.code").executeTakeFirstOrThrow();
  await run(db, "booking.cancel", { booking_id: b.id }, asMia(), opts);
  await processOutbox(db, combine(moneyHandlers, messageHandlers));
  await processOutbox(db, combine(moneyHandlers, messageHandlers));
  const back = await msg(people.Pat!, "family_refunded");
  assert.equal(back.length, 1);
  assert.match(back[0]!.body, /^\$60\.00 is going back to the family card for Mia: Court [12], /);
});

test("friends stay off until a parent turns them on; then a kid adds and is added like anyone", async () => {
  await rejects(plan(db, "friend.add", { person_id: mia, friend_id: people.Hal }, asMia(), opts), "error.kid_friends_off", "A parent hasn't turned on friends for you yet.");
  await rejects(plan(db, "friend.add", { person_id: people.Hal, friend_id: mia }, as("Hal"), opts), "error.not_found");
  assert.deepEqual((await friendsOf(db, people.Hal!, NOW)).played_with.map((p) => p.display_name).includes("Mia"), false);
  await run(db, "kid.set_rules", { person_id: mia, friends: true }, as("Pat"), opts);
  assert.ok((await friendsOf(db, people.Hal!, NOW)).played_with.some((p) => p.id === mia));
  await run(db, "friend.add", { person_id: people.Hal, friend_id: mia }, as("Hal"), opts);
  await run(db, "friend.add", { person_id: mia, friend_id: people.Hal }, asMia(), opts);
  assert.equal((await friendsOf(db, mia, NOW)).friends.length, 1);
  // Off again: they're not friends any more, for either of them.
  await run(db, "kid.set_rules", { person_id: mia, friends: false }, as("Pat"), opts);
  assert.equal((await friendsOf(db, people.Hal!, NOW)).friends.length, 0);
  // Nor does a kid take a place from someone's "take my place" link.
  const om = await db.selectFrom("booking").innerJoin("open_match", "open_match.booking_id", "booking.id").select("booking.id").where("booking.organiser_id", "=", people.Hal!).executeTakeFirstOrThrow();
  const j = await run(db, "booking.join", { booking_id: om.id, person_id: people.Ann }, as("Ann"), opts);
  await openPayment(db, (j.result as any).payment_id, people.Ann!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (j.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (j.result as any).payment_id, "test", NOW);
  const offer = await run(db, "booking.offer_place", { booking_id: om.id, person_id: people.Ann }, as("Ann"), opts);
  await rejects(plan(db, "booking.take_place", { code: (offer.result as any).code, person_id: mia }, asMia(), opts), "error.kid_link_off");
});

test("turning the login off signs the kid out and they're a junior booked by a parent again", async () => {
  const r = await run(db, "kid.remove_login", { person_id: mia }, as("Pat"), opts);
  assert.equal(r.plan.summary.en, "Turn off Mia's login. Mia is signed out everywhere, and you book for them again. Their bookings and places stay as they are.");
  const p = await db.selectFrom("person").select(["own_login", "email"]).where("id", "=", mia).executeTakeFirstOrThrow();
  assert.deepEqual(p, { own_login: false, email: null });
  assert.equal((await db.selectFrom("auth_identity").select("id").where("person_id", "=", mia).execute()).length, 0);
  assert.equal(await kidOf(db, mia), null);
  await rejects(plan(db, "booking.request", court90(court, "2026-12-10", "18:00", mia), asMia(), opts), "error.junior_no_courts");
});

test("at 18, a kid who already signs in keeps their address and becomes an adult account", async () => {
  const ivy = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Ivy", birth_year: 2009 }, as("Pat"), opts)).result as any).person_id;
  await run(db, "kid.give_login", { person_id: ivy, email: "ivy@example.test" }, as("Pat"), opts);
  await db.updateTable("person").set({ birth_year: 2008 }).where("id", "=", ivy).execute();   // the year they turn 18
  await run(db, "household.give_login", { person_id: ivy, email: "ivy@example.test" }, as("Pat"), opts);
  const p = await db.selectFrom("person").select(["junior", "own_login", "email"]).where("id", "=", ivy).executeTakeFirstOrThrow();
  assert.deepEqual(p, { junior: false, own_login: false, email: "ivy@example.test" });
  assert.equal((await db.selectFrom("auth_identity").select("value").where("person_id", "=", ivy).execute()).length, 1);
  assert.equal(await kidOf(db, ivy), null);
});
