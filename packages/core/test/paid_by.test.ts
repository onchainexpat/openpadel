// Who gets a junior's refund as club credit (7c511f6, payment.paid_by): the parent who really paid, then the family
// card's saver, then the household's first parent; never the junior, and never the other parent by mistake.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb } from "./helpers.ts";
import { checkPayment, creditBalance, openPayment, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "../src/index.ts";
import { creditee } from "../src/desk_pay.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, clinic: string, tim: string, household: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Cal", "Dee", "Ann"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  // Cal's household: Cal first, Dee joins as the second parent, then their junior Tim.
  const code = ((await run(db, "household.invite", { person_id: people.Cal }, as("Cal"), opts)).result as any).code;
  await run(db, "household.accept_invite", { person_id: people.Dee, code }, as("Dee"), opts);
  tim = ((await run(db, "household.add_junior", { person_id: people.Cal, display_name: "Tim", birth_year: 2015 }, as("Cal"), opts)).result as { person_id: string }).person_id;
  household = (await db.selectFrom("household_member").select("household_id").where("person_id", "=", tim).executeTakeFirstOrThrow()).household_id;
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Juniors", capacity: 6, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-10T16:00:00-08:00", ends_at: "2026-12-10T17:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
});
after(async () => drop());

test("a parent who pays a junior's place in the app gets its refund as credit: not the junior, not the other parent", async () => {
  // Cal signs Tim up; Dee, the second parent, opens the card form and pays.
  const r = (await run(db, "enrolment.join", { program_id: clinic, person_id: tim }, as("Cal"), opts)).result as { enrolment_id: string; payment_id: string };
  await openPayment(db, r.payment_id, people.Dee!);
  const pay = await db.selectFrom("payment").select(["paid_by", "provider_ref"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.equal(pay.paid_by, people.Dee, "payment.open records who opened the card form");
  stripe.settle(pay.provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, r.payment_id, "test", NOW), "succeeded");
  const before = { cal: await creditBalance(db, people.Cal!), dee: await creditBalance(db, people.Dee!) };
  await run(db, "enrolment.remove", { enrolment_id: r.enrolment_id, reason: "club", refund: { outcome: "credit", note: "the club cancelled the place" } }, owner, opts);
  assert.deepEqual(
    [await creditBalance(db, tim), await creditBalance(db, people.Cal!) - before.cal, await creditBalance(db, people.Dee!) - before.dee],
    [0, 0, 6000], "the $60 goes to Dee, who paid");
});

test("without paid_by: the family card's saver, then the household's first parent; an adult's own credit stays theirs", async () => {
  const card = randomUUID();
  await db.insertInto("family_card").values({ id: card, household_id: household, saved_by: people.Dee!, status: "saved", provider: "test" }).execute();
  assert.equal(await creditee(db, { person_id: tim, family_card_id: card }), people.Dee, "the card's saver");
  assert.equal(await creditee(db, { person_id: tim, family_card_id: card, paid_by: people.Cal! }), people.Cal, "who really paid comes first");
  assert.equal(await creditee(db, { person_id: tim }), people.Cal, "nothing known: the household's first parent");
  assert.equal(await creditee(db, { person_id: tim, paid_by: tim }), people.Cal, "a junior's own paid_by never keeps the credit on the junior");
  assert.equal(await creditee(db, { person_id: people.Ann!, paid_by: people.Cal! }), people.Ann, "an adult's refund is their own");
});
