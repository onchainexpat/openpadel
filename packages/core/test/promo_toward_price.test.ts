// What a promo code took off a court booking counts as paid toward its price, on every path that weighs the
// booking's payments against it (promo_off.ts): the deadline's charge to the organiser, a declined card's balance,
// the desk's limit, the code's own price basis and an assistant's weekly spend. Found by the 0.3.0 money review.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, settleShares, weekSpent, KumiError, TestProvider, uuidv7, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, courts: string[] = [], grant: string, grant2: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z"), opts = { now: NOW };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const bot = (): Actor => ({ personId: people.Fay!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: grant });
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const booking = (id: string) => db.selectFrom("booking").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
/** A $60 split court for four (90 minutes at $40 an hour), `who` organising and paying their $15 now. */
async function splitCourt(court: string, day: string, who = "Dee", actor: Actor = as(who)) {
  const r = (await run(db, "booking.request", { court_id: court, starts_at: at(day, "18:00"), minutes: 90, pay: "split", person_id: people[who] }, actor, opts)).result as { booking_id: string; payment_id: string };
  await pay(r.payment_id, who);
  return { ...r, code: (await booking(r.booking_id)).invite_code! };
}
async function join(code: string, who: string, promo?: string) {
  const j = (await run(db, "booking.join", { invite_code: code, person_id: people[who] }, as(who), opts)).result as { payment_id: string };
  let id = j.payment_id;
  if (promo) id = ((await run(db, "payment.use_promo", { payment_id: id, code: promo }, as(who), opts)).result as { payment_id: string }).payment_id;
  await pay(id, who);
}
/** Just past the 24-hour deadline of a court on `day` at 6 PM. */
const deadline = (day: string) => new Date(new Date(at(day, "18:00")).getTime() - 24 * 3600_000 + 60_000);

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  for (const n of [1, 2, 3, 4, 5]) courts.push(((await run(db, "court.create", { location_id: loc, name: `Court ${n}` }, owner)).result as any).court_id);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true, weekly_bookings: true }, owner, opts);
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
  await run(db, "promo_code.set", { code: "SAVE20", kind: "percent", percent: 20, applies_to: ["courts"], max_per_person: 20 }, owner, opts);
  await db.insertInto("oauth_client").values({ client_id: "kc_test", kind: "registered", name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], secret_hash: null, metadata: null }).execute();
  grant = uuidv7();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: people.Fay!, client_id: "kc_test", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 100000 }).execute();
  grant2 = uuidv7();
  await db.insertInto("oauth_grant").values({ id: grant2, person_id: people.Gus!, client_id: "kc_test", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 100000 }).execute();
});
after(async () => drop());

test("everyone paid, one share with a code: at the deadline the organiser's card is charged nothing, and nothing is owed", async () => {
  const r = await splitCourt(courts[0]!, "2026-12-06");
  for (const who of ["Ann", "Ben"]) await join(r.code, who);
  await join(r.code, "Cal", "SAVE20");   // $15 less 20% of the $60 court, capped at the share: $12 paid, $3 off
  const before = stripe.charges.length;
  await settleShares(db, deadline("2026-12-06"));
  assert.equal(stripe.charges.length, before, "nobody is charged the code's discount");
  const b = await booking(r.booking_id);
  assert.ok(b.settled_at);
  assert.equal(b.balance_cents ?? 0, 0);
  const due = await db.selectFrom("event_outbox").select("id").where("topic", "=", "booking.balance_due").where(({ ref }) => sql`${ref("payload")}->>'booking_id' = ${r.booking_id}`).execute();
  assert.equal(due.length, 0, "no staff alert to collect a discount at the desk");
});

test("the organiser's own code on their share is never charged back to their card at the deadline", async () => {
  const r = (await run(db, "booking.request", { court_id: courts[1], starts_at: at("2026-12-07", "18:00"), minutes: 90, pay: "split", person_id: people.Dee }, as("Dee"), opts)).result as { booking_id: string; payment_id: string };
  const rest = ((await run(db, "payment.use_promo", { payment_id: r.payment_id, code: "SAVE20" }, as("Dee"), opts)).result as { payment_id: string; rest_cents: number });
  assert.ok(rest.rest_cents > 0 && rest.rest_cents < 1500);
  await pay(rest.payment_id, "Dee");
  const code = (await booking(r.booking_id)).invite_code!;
  for (const who of ["Ann", "Ben", "Cal"]) await join(code, who);
  const before = stripe.charges.length;
  await settleShares(db, deadline("2026-12-07"));
  assert.equal(stripe.charges.length, before);
  assert.equal((await booking(r.booking_id)).balance_cents ?? 0, 0);
});

test("a seat nobody paid for is charged at its share alone: a code on another share isn't added to it", async () => {
  const r = await splitCourt(courts[2]!, "2026-12-08");
  await join(r.code, "Ann", "SAVE20");
  await join(r.code, "Ben");
  const before = stripe.charges.length;
  await settleShares(db, deadline("2026-12-08"));
  assert.equal(stripe.charges.length, before + 1);
  assert.equal(stripe.charges.at(-1)!.amountCents, 1500, "the fourth seat's $15, not $18");
});

test("the desk can't take what a code took off as money: a whole court paid after a code is paid in full", async () => {
  const r = (await run(db, "booking.request", { court_id: courts[3], starts_at: at("2026-12-03", "10:00"), minutes: 60, pay: "whole", person_id: people.Ann }, as("Ann"), opts)).result as { booking_id: string; payment_id: string };
  const promo = (await run(db, "payment.use_promo", { payment_id: r.payment_id, code: "SAVE20" }, as("Ann"), opts)).result as { payment_id: string; rest_cents: number };
  assert.equal(promo.rest_cents, 3200);
  await pay(promo.payment_id, "Ann");
  await rejects(plan(db, "booking.record_payment", { booking_id: r.booking_id, cents: 800, method: "cash" }, desk, opts), "error.booking_paid_in_full");
});

test("on a split court with a code, the desk may take only what's really still owed", async () => {
  const r = await splitCourt(courts[3]!, "2026-12-09", "Eve");
  await join(r.code, "Ann", "SAVE20");   // $12 paid, $3 off: $60 - $15 - $12 - $3 = $30 still owed
  await rejects(plan(db, "booking.record_payment", { booking_id: r.booking_id, cents: 3300, method: "cash" }, desk, opts), "error.more_than_owed");
  const p = await plan(db, "booking.record_payment", { booking_id: r.booking_id, cents: 3000, method: "cash" }, desk, opts);
  assert.equal(p.status, "planned");
});

test("an assistant's shared court counts the court less the others' shares and what codes took off", async () => {
  const r = await splitCourt(courts[4]!, "2026-12-10", "Fay", bot());
  for (const who of ["Ann", "Ben"]) await join(r.code, who);
  await join(r.code, "Cal", "SAVE20");
  // $60 less Ann's and Ben's $15, Cal's $12 and the code's $3: Fay's own $15 is all she can be charged.
  assert.equal(await weekSpent(db, grant, NOW), 1500);
});

test("an assistant's weekly court counts a week a code took part off at what's charged for it, not its full price", async () => {
  const gus: Actor = { personId: people.Gus!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: grant2 };
  const r = (await run(db, "booking.repeat_request", { court_id: courts[0], starts_at: at("2026-12-01", "10:00"), minutes: 90, person_id: people.Gus, weeks: 4 }, gus, opts)).result as { payment_id: string };
  const promo = (await run(db, "payment.use_promo", { payment_id: r.payment_id, code: "SAVE20" }, as("Gus"), opts)).result as { payment_id: string; rest_cents: number };
  assert.equal(promo.rest_cents, 4800);   // $60 a week, 20% off the first
  await pay(promo.payment_id, "Gus");
  // The first week's $48, and the three weeks still to come at $60 each.
  assert.equal(await weekSpent(db, grant2, NOW), 4800 + 3 * 6000);
});
