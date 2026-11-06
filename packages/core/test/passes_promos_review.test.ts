// The review of passes and promo codes (5 Nov 2026): each of its proved findings, the right way round. They failed
// on 965c89a/d46f427 and pass with the fixes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, creditBalance, deleteCheck, exportData, periodCents, clubPromoCodes, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, court: string, court2: string, soon: string, pricey: string, clinicPass: string, courtPass: string, lessonPass: string, later: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function cardPaid(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const sell = async (who: string, product: string, price: number) =>
  ((await run(db, "pass.sell", { person_id: people[who], product_id: product, cents: price, method: "cash" }, desk, opts)).result as { pass_id: string }).pass_id;
const pass = (id: string) => db.selectFrom("pass").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const join = async (who: string, program: string) => (await run(db, "enrolment.join", { program_id: program, person_id: people[who] }, as(who), opts)).result as { enrolment_id: string; payment_id: string };
const usePass = async (paymentId: string, passId: string, who: string) => (await run(db, "payment.use_pass", { payment_id: paymentId, pass_id: passId }, as(who), opts)).result;
const usePromo = async (paymentId: string, c: string, who: string) => (await run(db, "payment.use_promo", { payment_id: paymentId, code: c }, as(who), opts)).result as { paid: boolean; payment_id: string; rest_cents?: number };
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => { assert.equal(e?.code, code); return true; });
const code = async (input: object) => ((await run(db, "promo_code.set", input, owner, opts)).result as { promo_code_id: string }).promo_code_id;

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Lee", "Kim", "Ann", "Ben", "Cal", "Dee", "Eve", "Fin", "Gus", "Hal", "Ivy", "Jo"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner, opts);
  desk = as("Lee");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  // A clinic tomorrow evening whose rule gives club credit inside 48 hours.
  soon = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Tomorrow", capacity: 8, price_cents: 6000, refund_window_hours: 48, refund_inside_window: "credit" }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: soon, starts_at: "2026-11-05T18:00:00-08:00", ends_at: "2026-11-05T19:30:00-08:00", court_ids: [court2] }, owner, opts);
  await run(db, "program.publish", { program_id: soon }, owner, opts);
  pricey = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Camp", capacity: 8, price_cents: 20000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: pricey, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court2] }, owner, opts);
  await run(db, "program.publish", { program_id: pricey }, owner, opts);
  later = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Later", capacity: 8, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: later, starts_at: "2026-12-12T18:00:00-08:00", ends_at: "2026-12-12T19:30:00-08:00", court_ids: [court2] }, owner, opts);
  await run(db, "program.publish", { program_id: later }, owner, opts);
  const make = async (input: object) => ((await run(db, "pass_product.set", input, owner, opts)).result as { product_id: string }).product_id;
  clinicPass = await make({ name: "3 clinic places", covers: "programs", program_kinds: ["clinic"], price_cents: 15000, uses: 3 });
  courtPass = await make({ name: "5 courts up to an hour", covers: "courts", max_minutes: 60, price_cents: 17500, uses: 5 });
  lessonPass = await make({ name: "5 lessons", covers: "lessons", max_minutes: 60, price_cents: 40000, uses: 5 });
  // A coach who gives 60-minute lessons for $90 on Wednesday mornings.
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Kim has coached for ten years.", level_min: 1.5, level_max: 5, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }], lessons: true, max_players: 4 }, as("Kim"), opts);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 3, starts: "09:00", ends: "12:00" }] }, as("Kim"), opts);
});
after(async () => drop());

test("R1: a courts pass doesn't pay a coach's lesson (nor does a courts code); a pass made for lessons does", async () => {
  const id = await sell("Ann", courtPass, 17500);
  const l = (await run(db, "lesson.request", { coach_id: people.Kim, starts_at: "2026-11-11T10:00:00-08:00", minutes: 60, pay: "whole", person_id: people.Ann }, as("Ann"), opts)).result as { booking_id: string; payment_id: string };
  await rejects(usePass(l.payment_id, id, "Ann"), "error.pass_not_for_this");
  await code({ code: "COURTS10", kind: "percent", percent: 10, applies_to: ["courts"] });
  await rejects(plan(db, "payment.use_promo", { payment_id: l.payment_id, code: "COURTS10" }, as("Ann"), opts), "error.promo_unknown");
  const lp = await sell("Ann", lessonPass, 40000);
  await usePass(l.payment_id, lp, "Ann");
  const b = await db.selectFrom("booking").select(["status", "kind"]).where("id", "=", l.booking_id).executeTakeFirstOrThrow();
  assert.deepEqual([b.kind, b.status], ["lesson", "confirmed"]);
});

test("R2: 'credit inside the window' gives a pass use back to the pass, not money as credit; a free promo place gives nothing", async () => {
  const id = await sell("Ben", clinicPass, 15000);
  const e = await join("Ben", soon);
  await usePass(e.payment_id, id, "Ben");
  assert.equal((await pass(id)).uses_left, 2);
  await run(db, "enrolment.leave", { enrolment_id: e.enrolment_id }, as("Ben"), opts);
  assert.equal(await creditBalance(db, people.Ben!), 0, "no club credit for a pass use");
  assert.equal((await pass(id)).uses_left, 3, "the use is the pass's again");
  await code({ code: "FREECLINIC", kind: "percent", percent: 100, applies_to: ["programs"] });
  const f = await join("Fin", soon);
  assert.equal((await usePromo(f.payment_id, "FREECLINIC", "Fin")).paid, true);
  await run(db, "enrolment.leave", { enrolment_id: f.enrolment_id }, as("Fin"), opts);
  assert.equal(await creditBalance(db, people.Fin!), 0, "a free place gives nothing back");
});

test("R3 and LOW 6: a code then part credit keeps the code (it counts, can't be stacked); worked out on the whole price", async () => {
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T10:00:00-08:00", minutes: 60, person_id: people.Cal, pay: "whole" }, as("Cal"), opts)).result as { booking_id: string; payment_id: string };
  assert.equal(await cardPaid(b.payment_id, "Cal"), "succeeded");
  await run(db, "booking.cancel", { booking_id: b.booking_id, refund: "credit" }, desk, opts);
  await code({ code: "HALF", kind: "percent", percent: 50, applies_to: ["programs"], max_uses: 1, max_per_person: 1 });
  const e = await join("Cal", pricey);
  const a = await usePromo(e.payment_id, "HALF", "Cal");
  assert.equal(a.rest_cents, 10000);
  const c = (await run(db, "payment.use_credit", { payment_id: a.payment_id }, as("Cal"), opts)).result as { payment_id: string; rest_cents: number };
  assert.equal(c.rest_cents, 6000);
  assert.equal((await clubPromoCodes(db)).find((x) => x.code === "HALF")!.used, 1, "the use moved with the payment");
  await rejects(plan(db, "payment.use_promo", { payment_id: c.payment_id, code: "HALF" }, as("Cal"), opts), "error.promo_one");
  assert.equal(await cardPaid(c.payment_id, "Cal"), "succeeded");
  const paid = await db.selectFrom("payment").select((x) => x.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", e.enrolment_id).where("status", "=", "succeeded").executeTakeFirstOrThrow();
  assert.equal(Number(paid.c), 10000, "$100 paid for a $200 place with a 50% code");
  // Credit first, then a code: its percentage is of the whole price ($200), capped by what's left.
  const d = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T12:00:00-08:00", minutes: 60, person_id: people.Hal, pay: "whole" }, as("Hal"), opts)).result as { booking_id: string; payment_id: string };
  assert.equal(await cardPaid(d.payment_id, "Hal"), "succeeded");
  await run(db, "booking.cancel", { booking_id: d.booking_id, refund: "credit" }, desk, opts);
  await code({ code: "HALFTOO", kind: "percent", percent: 50, applies_to: ["programs"] });
  const h = await join("Hal", pricey);
  const hc = (await run(db, "payment.use_credit", { payment_id: h.payment_id }, as("Hal"), opts)).result as { payment_id: string; rest_cents: number };
  assert.equal(hc.rest_cents, 16000);
  assert.equal((await usePromo(hc.payment_id, "HALFTOO", "Hal")).rest_cents, 6000, "50% of $200 off the $160 left");
});

test("R4: a membership's first payment with a code renews at the plan's price", async () => {
  const monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 3000, period: "month" }, owner, opts)).result as any).plan_id;
  await code({ code: "JOIN50", kind: "percent", percent: 50, applies_to: ["memberships"] });
  const j = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Dee }, as("Dee"), opts)).result as { payment_id: string };
  const r = await usePromo(j.payment_id, "JOIN50", "Dee");
  assert.equal(r.rest_cents, 1500);
  assert.equal(await cardPaid(r.payment_id, "Dee"), "succeeded");
  const m = await db.selectFrom("membership").selectAll().where("person_id", "=", people.Dee!).executeTakeFirstOrThrow();
  assert.equal(m.price_cents, 3000);
  assert.equal(await periodCents(db, m as any, 3000, NOW), 3000);
});

test("R5: a pass with uses left stops deleting the account; the data download has passes and codes used", async () => {
  await sell("Eve", clinicPass, 15000);
  const c = await deleteCheck(db, people.Eve!, NOW);
  assert.ok(c.blockers.some((b) => b.kind === "passes" && b.how.en.includes("refund")));
  const data = await exportData(db, people.Eve!, NOW, "en") as any;
  assert.equal(data.passes.length, 1);
  assert.ok(Array.isArray(data.promo_codes_used));
});

test("R6: a pass-paid place passed to a sub who pays: the use waits for the sub, and is back once they pay", async () => {
  const id = await sell("Ann", clinicPass, 15000);
  const e = await join("Ann", later);
  await usePass(e.payment_id, id, "Ann");
  const t = (await run(db, "enrolment.transfer", { enrolment_id: e.enrolment_id, to_person_id: people.Gus, pay: "sub_pays" }, as("Ann"), opts)).result as { payment_id: string };
  assert.equal((await pass(id)).uses_left, 2, "not back before the sub has paid");
  assert.equal(await cardPaid(t.payment_id, "Gus"), "succeeded");
  assert.equal((await pass(id)).uses_left, 3, "back once they have");
});

test("R7: a place paid $45 after a 25% code is paid up: the desk can't take the discount again", async () => {
  await code({ code: "QUARTER", kind: "percent", percent: 25, applies_to: ["programs"] });
  const e = await join("Eve", later);
  const r = await usePromo(e.payment_id, "QUARTER", "Eve");
  assert.equal(await cardPaid(r.payment_id, "Eve"), "succeeded");
  await rejects(plan(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 1500, method: "cash" }, desk, opts), "error.place_paid_up");
});

test("R8 and R9: a code can't make a payment that saves the card free (a membership's first, a split court's organiser)", async () => {
  const plan2 = ((await run(db, "membership.plan_set", { name: "Free month", price_cents: 2500, period: "month" }, owner, opts)).result as any).plan_id;
  await code({ code: "FIRSTFREE", kind: "percent", percent: 100, applies_to: ["memberships"] });
  const j = (await run(db, "membership.join", { plan_id: plan2, person_id: people.Gus }, as("Gus"), opts)).result as { payment_id: string };
  await rejects(plan(db, "payment.use_promo", { payment_id: j.payment_id, code: "FIRSTFREE" }, as("Gus"), opts), "error.promo_saves_card");
  await code({ code: "COURTFREE", kind: "amount", amount_cents: 100000, applies_to: ["courts"] });
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-13T10:00:00-08:00", minutes: 60, person_id: people.Fin, pay: "split" }, as("Fin"), opts)).result as { booking_id: string; payment_id: string };
  await rejects(plan(db, "payment.use_promo", { payment_id: b.payment_id, code: "COURTFREE" }, as("Fin"), opts), "error.promo_saves_card");
});

test("L4: wrong promo codes are counted per person: ten an hour, then a wait", async () => {
  const e = await join("Ivy", later);
  for (let n = 0; n < 10; n++) await rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: `NOPE${n}` }, as("Ivy"), opts), "error.promo_unknown");
  await rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "QUARTER" }, as("Ivy"), opts), "error.promo_tries");
});

test("L1: support access never spends a member's pass or applies a code (in SUPPORT_NEVER)", async () => {
  const { SUPPORT_NEVER } = await import("../src/permissions.ts");
  assert.ok(SUPPORT_NEVER.includes("payment.use_pass") && SUPPORT_NEVER.includes("payment.use_promo"));
});

test("credit recheck LOW 1: someone else's redeem or credit is refused before the preview, and the refusal is logged without the code", async () => {
  await rejects(plan(db, "gift_card.redeem", { person_id: people.Ann, code: "ABCD-EFGH-JKLM-NPQR" }, as("Ben"), opts), "error.forbidden_reason");
  const r = await db.selectFrom("action_run").select(["status", "input"]).where("action", "=", "gift_card.redeem").where("actor_person_id", "=", people.Ben!).orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.equal(r.status, "failed");
  assert.ok(!JSON.stringify(r.input).includes("ABCD"), "no code kept");
});
