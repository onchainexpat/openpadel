// Limits that have to count what money really leaves a card: a kid's monthly limit and an assistant's weekly
// one, for a shared court (the others' shares land on the organiser's card at the deadline), one more person
// on a family plan, a membership resumed, and a junior signed up by a parent's assistant.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkFamilyCard, checkPayment, monthSpent, openFamilyCardSetup, openPayment, payKidRun, plan, run, runAsSystem, setPaymentProvider, settleShares, weekSpent,
  KumiError, TestProvider, uuidv7, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, courts: string[] = [], mia: string, mid: string, grant: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const asMia = (): Actor => ({ personId: mia, via: "test", lang: "en" });
const bot = (): Actor => ({ personId: people.Pat!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: grant });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  for (const n of [1, 2, 3]) courts.push(((await run(db, "court.create", { location_id: loc, name: `Court ${n}` }, owner, opts)).result as any).court_id);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Pat", "Sam"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  mia = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2012 }, as("Pat"), opts)).result as any).person_id;
  people.Mia = mia;
  await run(db, "kid.give_login", { person_id: mia, email: "mia@example.test" }, as("Pat"), opts);
  await run(db, "kid.set_rules", { person_id: mia, monthly_limit_cents: 5000 }, as("Pat"), opts);   // $50 a month
  const r = await openFamilyCardSetup(db, as("Pat"));
  stripe.settleSetup((await db.selectFrom("family_card").select("provider_ref").where("id", "=", r.cardId).executeTakeFirstOrThrow()).provider_ref!);
  await checkFamilyCard(db, r.cardId, "test", NOW);
  // Sam joins Pat's household; Pat's family plan covers two.
  const code = ((await run(db, "household.invite", { person_id: people.Pat }, as("Pat"), opts)).result as any).code;
  await run(db, "household.accept_invite", { person_id: people.Sam, code }, as("Sam"), opts);
  const planId = ((await run(db, "membership.plan_set", { name: "Family", price_cents: 20000, period: "month", family_size: 2, extra_person_cents: 3000 }, owner, opts)).result as any).plan_id;
  const pay = ((await run(db, "membership.join", { plan_id: planId, person_id: people.Pat }, as("Pat"), opts)).result as any).payment_id;
  await openPayment(db, pay, people.Pat!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", pay).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, pay, "test", NOW);
  mid = (await db.selectFrom("membership").select("id").where("person_id", "=", people.Pat!).executeTakeFirstOrThrow()).id;
  await db.insertInto("oauth_client").values({ client_id: "kc_test", kind: "registered", name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], secret_hash: null, metadata: null }).execute();
  grant = uuidv7();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: people.Pat!, client_id: "kc_test", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0 }).execute();
});
after(async () => drop());

test("a kid's shared court counts in full against their monthly limit: over it, a parent is asked first", async () => {
  // $60 a court, 8 players: $7.50 now, but up to $60 on the family card at the deadline. Over $50: ask.
  const r = await run(db, "booking.request", { court_id: courts[0], starts_at: "2026-12-07T18:00:00-08:00", minutes: 90, pay: "split", players: 4, person_id: mia }, asMia(), opts);
  assert.equal((r.result as any).asked_parent, true);
});

test("a kid's court the parent let through: at the deadline, what's over the limit goes to a parent, not the card", async () => {
  await run(db, "kid.set_rules", { person_id: mia, monthly_limit_cents: 6000 }, as("Pat"), opts);   // room for one court
  const r = await run(db, "booking.request", { court_id: courts[1], starts_at: "2026-12-07T18:00:00-08:00", minutes: 90, pay: "split", players: 4, person_id: mia }, asMia(), opts);
  assert.equal(r.status, "planned");
  await payKidRun(db, r.runId, mia, NOW);   // the $15 share on the family card
  await run(db, "kid.set_rules", { person_id: mia, monthly_limit_cents: 3000 }, as("Pat"), opts);   // the parent lowers it meanwhile
  const before = stripe.charges.length;
  await settleShares(db, new Date("2026-12-06T19:00:00-08:00"));
  assert.equal(stripe.charges.length, before);   // nothing more on the card
  const b = await db.selectFrom("booking").select(["balance_cents", "id"]).where("id", "=", (r.result as any).booking_id).executeTakeFirstOrThrow();
  assert.equal(b.balance_cents, 4500);
  const asked = await db.selectFrom("payment").select(["amount_cents", "parent_to_pay_at"]).where("person_id", "=", mia).where("status", "=", "pending").executeTakeFirstOrThrow();
  assert.equal(asked.amount_cents, 4500);
  assert.ok(asked.parent_to_pay_at);
  assert.ok(await monthSpent(db, mia, NOW) <= 6000);
});

test("an assistant can't charge one more person to the family plan past its $0 cap, again and again", async () => {
  await run(db, "membership.add_person", { membership_id: mid, person_id: people.Mia }, as("Pat"), opts);   // fills the plan
  await rejects(plan(db, "membership.add_person", { membership_id: mid, person_id: people.Sam }, bot(), opts), "error.assistant_over_cap");
  assert.equal(await weekSpent(db, grant, NOW), 0);
});

test("one more person removed and added back in the same period: covered again, not charged again", async () => {
  await run(db, "membership.add_person", { membership_id: mid, person_id: people.Sam }, as("Pat"), opts);
  await run(db, "membership.remove_person", { membership_id: mid, person_id: people.Sam }, as("Pat"), opts);
  const again = await run(db, "membership.add_person", { membership_id: mid, person_id: people.Sam }, as("Pat"), opts);
  assert.match(again.plan.summary.en, /no charge/i);
  const extra = await db.selectFrom("payment").select("amount_cents").where("membership_member_id", "is not", null).execute();
  assert.equal(extra.length, 1);
});

test("an assistant resuming a paid membership counts its next period against the cap", async () => {
  await run(db, "membership.cancel", { membership_id: mid }, as("Pat"), opts);
  await rejects(plan(db, "membership.resume", { membership_id: mid }, bot(), opts), "error.assistant_over_cap");
});

test("a parent's assistant signing their junior up for a paid clinic counts against the cap", async () => {
  const loc = (await db.selectFrom("location").select("id").executeTakeFirstOrThrow()).id;
  const id = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Juniors", capacity: 8, price_cents: 9000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: id, starts_at: "2026-12-12T10:00:00-08:00", ends_at: "2026-12-12T11:00:00-08:00", court_ids: [courts[2]] }, owner, opts);
  await run(db, "program.publish", { program_id: id }, owner, opts);
  await rejects(plan(db, "enrolment.join", { program_id: id, person_id: people.Mia }, bot(), opts), "error.assistant_over_cap");
});
