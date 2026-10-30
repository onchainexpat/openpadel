import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { areFriends, checkPayment, findFriends, friendsOf, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const code = async (who: string) => (await db.selectFrom("person").select("friend_code").where("id", "=", people[who]!).executeTakeFirstOrThrow()).friend_code;
const add = (who: string, friend: string) => run(db, "friend.add", { person_id: people[who], friend_id: people[friend] }, as(who), { now: NOW });

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  for (const name of ["Ann", "Ben", "Cal", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  // Ann and Ben share a court; Cal and Dee have never played with either.
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-12-02T18:00:00-08:00", minutes: 90, pay: "split", players: 2, person_id: people.Ann }, as("Ann"), { now: NOW })).result as any;
  await pay(b.payment_id, "Ann");
  const invite = (await db.selectFrom("booking").select("invite_code").where("id", "=", b.booking_id).executeTakeFirstOrThrow()).invite_code!;
  await pay(((await run(db, "booking.join", { invite_code: invite, person_id: people.Ben }, as("Ben"), { now: NOW })).result as any).payment_id, "Ben");
});
after(async () => drop());

test("adding someone you've played with; friends once both have added each other", async () => {
  const a = await add("Ann", "Ben");
  assert.equal(a.plan.summary.en, "Add Ben as a friend. Once they add you back, you can save match places for each other.");
  assert.equal(await areFriends(db, people.Ann!, people.Ben!), false);
  await rejects(plan(db, "friend.add", { person_id: people.Ann, friend_id: people.Ben }, as("Ann"), { now: NOW }), "error.friend_already", "You've already added Ben.");
  await rejects(plan(db, "friend.add", { person_id: people.Ann, friend_id: people.Ann }, as("Ann"), { now: NOW }), "error.friend_self");
  assert.deepEqual(await friendsOf(db, people.Ben!, NOW), { friends: [], added_you: [{ id: people.Ann, display_name: "Ann" }], you_added: [], played_with: [] });
  const b = await add("Ben", "Ann");
  assert.equal(b.plan.summary.en, "Add Ann back as a friend. They've added you, so you'll be friends and can save match places for each other.");
  assert.equal(await areFriends(db, people.Ann!, people.Ben!), true);
  await processOutbox(db, messageHandlers);
  const msg = async (who: string, kind: string) => (await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").executeTakeFirstOrThrow());
  assert.deepEqual(await msg("Ben", "friend_added"), { subject: "Ann added you as a friend", body: "Ann added you as a friend. Add them back in the app and you can save match places for each other." });
  assert.deepEqual(await msg("Ann", "friend_added_back"), { subject: "You and Ben are friends", body: "Ben added you back. You're friends now, so you can save match places for each other." });
});

test("a stranger only by their link; nobody adds for someone else", async () => {
  await rejects(plan(db, "friend.add", { person_id: people.Ann, friend_id: people.Cal }, as("Ann"), { now: NOW }), "error.friend_not_played",
    "You can add people you've played with, or anyone who gives you their friend link.");
  await rejects(plan(db, "friend.add_by_code", { person_id: people.Ann, code: "nothing-like-it" }, as("Ann"), { now: NOW }), "error.friend_link_unknown");
  const c = await run(db, "friend.add_by_code", { person_id: people.Ann, code: await code("Cal") }, as("Ann"), { now: NOW });
  assert.equal(c.plan.summary.en, "Add Cal as a friend. Once they add you back, you can save match places for each other.");
  await rejects(plan(db, "friend.add_by_code", { person_id: people.Ann, code: await code("Dee") }, as("Cal"), { now: NOW }), "error.forbidden_reason");
  // Cal can add Ann back without having played: Ann added Cal first.
  await add("Cal", "Ann");
  assert.equal(await areFriends(db, people.Ann!, people.Cal!), true);
});

test("finding friends to save a place for finds friends only; removing ends it until both add again", async () => {
  await run(db, "friend.add_by_code", { person_id: people.Ann, code: await code("Dee") }, as("Ann"), { now: NOW });   // Dee hasn't added Ann back
  assert.deepEqual((await findFriends(db, people.Ann!, "e")).map((p) => p.display_name), ["Ben"]);   // not Dee, and nobody who isn't a friend
  assert.deepEqual((await friendsOf(db, people.Ann!, NOW)).you_added.map((p) => p.display_name), ["Dee"]);
  const r = await run(db, "friend.remove", { person_id: people.Ann, friend_id: people.Ben }, as("Ann"), { now: NOW });
  assert.equal(r.plan.summary.en, "Remove Ben from your friends. You can't save match places for each other until you've both added each other again.");
  assert.equal(await areFriends(db, people.Ann!, people.Ben!), false);
  assert.equal((await plan(db, "friend.remove", { person_id: people.Ann, friend_id: people.Dee }, as("Ann"), { now: NOW })).plan.summary.en, "Take back adding Dee as a friend.");
  assert.equal((await add("Ann", "Ben")).plan.summary.en, "Add Ben back as a friend. They've added you, so you'll be friends and can save match places for each other.");
  assert.equal(await areFriends(db, people.Ann!, people.Ben!), true);
});
