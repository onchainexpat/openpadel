// The members' "Check before you confirm" sheet (charge.ts): for every change a member makes that charges money, the
// preview's lines say what apply then asks the card for, to the cent. The lines come from the same quote, shares and
// program price apply charges, so a test per kind holds each one to the payment it makes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, openPayment, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Charge, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, gold: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const opts = { now: NOW };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const payment = (id: string) => db.selectFrom("payment").select(["amount_cents", "save_card"]).where("id", "=", id).executeTakeFirstOrThrow();
const kinds = (c: Charge) => c.lines.map((l) => [l.kind, l.label.en, l.cents]);
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test");
}
/** Plan and apply as the member, the way the app does: the preview's charge, and the payment its apply made. */
async function charged(action: string, input: Record<string, unknown>, who: string) {
  const r = await run(db, action, input, as(who), opts);
  const c = r.plan.charge!;
  assert.ok(c, `${action} has a charge`);
  const id = (r.result as { payment_id?: string }).payment_id;
  return { c, result: r.result as Record<string, any>, paid: id ? await payment(id) : null };
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  // Tax on top, 8.25%: the lines carry it as its own line.
  await run(db, "club.update", { court_bookings: true, tax_rate_bp: 825 }, owner, opts);
  gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Gold members", cents_per_hour: 3000, plan_ids: [gold] }, owner, opts);
  for (const [name, level] of [["Ann", 3.5], ["Ben", 3.5], ["Cal", 3.5], ["Dee", 3.5], ["Kim", null]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
    if (level !== null) await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner, opts);
  }
  await run(db, "membership.grant", { person_id: people.Dee, plan_id: gold }, owner, opts);
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner, opts);
});
after(async () => drop());

test("a whole court: price, tax on top, total; the total is what the card is asked for", async () => {
  const { c, paid } = await charged("booking.request", { court_id: c1, starts_at: at("2026-12-02", "10:00"), minutes: 90, pay: "whole", person_id: people.Ann }, "Ann");
  assert.deepEqual(kinds(c), [["item", "Court 1, 90 minutes", 6000], ["tax", "Sales tax (8.25%)", 495], ["total", "Total", 6495]]);
  assert.equal(c.due_cents, 6495);
  assert.equal(paid!.amount_cents, c.due_cents);
  assert.equal(c.how.en, "By card, in the next step.");
  assert.equal(c.when!.en, "Charged now, in the next step. The court is held for 10 minutes while you pay.");
});

test("a member price shows as money off the price for everyone, and the card is asked for the member's total", async () => {
  const { c, paid } = await charged("booking.request", { court_id: c2, starts_at: at("2026-12-02", "10:00"), minutes: 90, pay: "whole", person_id: people.Dee }, "Dee");
  assert.deepEqual(kinds(c), [["item", "Court 2, 90 minutes", 6000], ["member", "Member price (Gold)", -1500], ["tax", "Sales tax (8.25%)", 371], ["total", "Total", 4871]]);
  assert.equal(paid!.amount_cents, 4871);
  assert.equal(c.due_cents, paid!.amount_cents);
  // The lines add up to the total.
  assert.equal(c.lines.filter((l) => ["item", "member", "tax"].includes(l.kind)).reduce((n, l) => n + l.cents!, 0), 4871);
});

test("split: your part now, the others their own, the rest once on your saved card at the deadline, nothing held", async () => {
  const { c, paid } = await charged("booking.request", { court_id: c1, starts_at: at("2026-12-04", "10:00"), minutes: 90, pay: "split", person_id: people.Ben }, "Ben");
  assert.deepEqual(kinds(c).slice(-2), [["your_part", "Your part, split between 4 players", 1626], ["others", "Each of the other 3 players pays their own part", 1623]]);
  assert.equal(paid!.amount_cents, 1626);
  assert.equal(paid!.save_card, true);
  assert.equal(c.due_cents, 1626);
  assert.equal(c.how.en, "By card, in the next step.");   // a saved card can't be club credit
  assert.match(c.when!.en, /^Your part is charged now\. .*at the deadline, Thu, Dec 3, 10:00 AM, goes once on the card you pay with now.*Nothing is held on it before then\.$/);
});

test("an open match: the host's part and the joiner's place, each what their payment asks; not full by the deadline, all back", async () => {
  const host = await charged("booking.request", { court_id: c2, starts_at: at("2026-12-05", "18:00"), minutes: 90, pay: "split", person_id: people.Ann, open: { level_min: 3, level_max: 4 } }, "Ann");
  assert.equal(host.paid!.amount_cents, host.c.due_cents);
  assert.equal(host.paid!.save_card, false);
  assert.match(host.c.when!.en, /If the match isn't full by the deadline, Fri, Dec 4, 6:00 PM, it's cancelled and everyone gets their money back\./);
  await pay(host.result.payment_id, "Ann");
  const j = await charged("booking.join", { booking_id: host.result.booking_id, person_id: people.Cal }, "Cal");
  assert.deepEqual(kinds(j.c), [["item", "Your part of the court, split between 4 players", 1623], ["total", "Total", 1623]]);
  assert.equal(j.paid!.amount_cents, j.c.due_cents);
  assert.equal(j.c.when!.en, "Charged now, in the next step. If the match isn't full by the deadline, Fri, Dec 4, 6:00 PM, it's cancelled and you get it all back.");
});

test("several courts: each at its own total, the sum is what the payments add up to", async () => {
  const { c, result } = await charged("booking.request_courts", { person_id: people.Cal, courts: [
    { court_id: c1, starts_at: at("2026-12-07", "10:00"), minutes: 60 }, { court_id: c2, starts_at: at("2026-12-07", "10:00"), minutes: 60 }] }, "Cal");
  const pays = await db.selectFrom("payment").select("amount_cents").where("id", "in", (result.bookings as { payment_id: string }[]).map((b) => b.payment_id)).execute();
  assert.equal(pays.reduce((n, p) => n + p.amount_cents, 0), c.due_cents);
  assert.equal(c.lines.at(-1)!.cents, c.due_cents);
});

test("a program: a member price as money off, and the card asked for the member's price", async () => {
  const p = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley clinic", capacity: 4, price_cents: 3000, member_price_cents: 2000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: p, starts_at: at("2026-12-09", "18:00"), ends_at: at("2026-12-09", "19:30"), court_ids: [c1] }, owner, opts);
  await run(db, "program.publish", { program_id: p }, owner, opts);
  const member = await charged("enrolment.join", { program_id: p, person_id: people.Dee }, "Dee");
  assert.deepEqual(kinds(member.c), [["item", "Volley clinic", 3000], ["member", "Member price", -1000], ["total", "Total", 2000]]);
  assert.equal(member.paid!.amount_cents, 2000);
  const full = await charged("enrolment.join", { program_id: p, person_id: people.Ann }, "Ann");
  assert.deepEqual(kinds(full.c), [["item", "Volley clinic", 3000], ["total", "Total", 3000]]);
  assert.equal(full.paid!.amount_cents, full.c.due_cents);
});

test("a lesson, split: the coach's rate with tax, and the organiser's part is what the card is asked for", async () => {
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Coach.", level_min: 1.5, level_max: 5, languages: ["en"], rates: [{ minutes: 60, cents: 8000 }], lessons: true, max_players: 4 }, as("Kim"), opts);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 4, starts: "09:00", ends: "12:00" }] }, as("Kim"), opts);
  const { c, paid } = await charged("lesson.request", { coach_id: people.Kim, starts_at: at("2026-12-03", "09:00"), minutes: 60, pay: "split", players: 2, person_id: people.Ann }, "Ann");
  assert.deepEqual(kinds(c).slice(0, 3), [["item", "Lesson with Kim, 60 minutes, court included", 8000], ["tax", "Sales tax (8.25%)", 660], ["total", "Total", 8660]]);
  assert.equal(paid!.amount_cents, c.due_cents);
  assert.equal(c.due_cents, 4330);
});

test("a membership and a pass: card only, the price is what's charged", async () => {
  const m = await charged("membership.join", { plan_id: gold, person_id: people.Cal }, "Cal");
  assert.deepEqual(kinds(m.c), [["item", "Gold, $60.00 a month", 6000], ["total", "Total", 6000]]);
  assert.equal(m.paid!.amount_cents, m.c.due_cents);
  assert.equal(m.c.how.en, "By card, in the next step.");
  assert.equal(m.c.when!.en, "Charged now, in the next step, then every month on the same card until you cancel.");
  const product = ((await run(db, "pass_product.set", { name: "5 drop-ins", covers: "programs", price_cents: 10000, uses: 5 }, owner, opts)).result as any).product_id;
  const p = await charged("pass.buy", { person_id: people.Ben, product_id: product }, "Ben");
  assert.deepEqual(kinds(p.c), [["item", "5 drop-ins, 5 uses", 10000], ["total", "Total", 10000]]);
  assert.equal(p.paid!.amount_cents, p.c.due_cents);
});

test("a weekly court: the first week now (what its payment asks), the later weeks on the saved card nearer their day", async () => {
  await run(db, "club.update", { weekly_bookings: true }, owner, opts);
  const { c, paid } = await charged("booking.repeat_request", { court_id: c1, starts_at: at("2026-12-01", "20:00"), minutes: 60, person_id: people.Ben, weeks: 3 }, "Ben");
  assert.deepEqual(kinds(c).map((k) => k[0]), ["item", "tax", "total", "later"]);
  assert.equal(c.lines[0]!.cents! + c.lines[1]!.cents!, c.lines[2]!.cents);   // tax on top adds up
  assert.equal(c.lines.find((l) => l.kind === "total")!.cents, paid!.amount_cents);
  assert.equal(c.due_cents, paid!.amount_cents);
  assert.equal(paid!.save_card, true);
  assert.deepEqual(c.lines.find((l) => l.kind === "later")!.label.en, "2 later weeks, each charged nearer its day");
});

test("a free place still shows its lines, and says there's nothing to pay", async () => {
  const p = ((await run(db, "program.create", { location_id: loc, kind: "social", name: "Free social", capacity: 4, price_cents: 0 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: p, starts_at: at("2026-12-10", "18:00"), ends_at: at("2026-12-10", "19:30"), court_ids: [c2] }, owner, opts);
  await run(db, "program.publish", { program_id: p }, owner, opts);
  const r = await run(db, "enrolment.join", { program_id: p, person_id: people.Ann }, as("Ann"), opts);
  assert.equal(r.plan.charge!.due_cents, 0);
  assert.equal(r.plan.charge!.how.en, "Nothing to pay.");
  assert.equal(r.plan.charge!.when, null);
});

test("club credit is offered only where it can pay: all of a court, or part of a program place", async () => {
  // A court paid and then cancelled by the desk, all back as credit: $43.30 (an hour with tax).
  const desk = owner;
  const b = (await run(db, "booking.request", { court_id: c2, starts_at: at("2026-12-08", "10:00"), minutes: 60, pay: "whole", person_id: people.Kim }, as("Kim"), opts)).result as { booking_id: string; payment_id: string };
  await pay(b.payment_id, "Kim");
  await run(db, "booking.cancel", { booking_id: b.booking_id, refund: "credit" }, desk, opts);
  const court = await run(db, "booking.request", { court_id: c2, starts_at: at("2026-12-08", "12:00"), minutes: 90, pay: "whole", person_id: people.Kim }, as("Kim"), opts);
  assert.equal(court.plan.charge!.how.en, "By card, in the next step.");   // $43.30 can't pay part of a $64.95 court
  const small = await run(db, "booking.request", { court_id: c2, starts_at: at("2026-12-08", "14:00"), minutes: 60, pay: "whole", person_id: people.Kim }, as("Kim"), opts);
  assert.equal(small.plan.charge!.how.en, "By card or from your club credit ($43.30 to use), in the next step.");
  // Staff (not the member) planning it: no credit offered in the member's name.
  const forThem = await run(db, "booking.request", { court_id: c1, starts_at: at("2026-12-08", "16:00"), minutes: 60, pay: "whole", person_id: people.Kim }, owner, opts);
  assert.equal(forThem.plan.charge!.how.en, "By card, in the next step.");
});
