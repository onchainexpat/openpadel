import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, expireHolds, openPayment, plan, run, runAsSystem, setPaymentProvider, weekSpent, assistantsOf, KumiError, TestProvider, uuidv7, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, ann: string, grant: string, ownerGrant: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // a Monday, 8 AM
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const web = (id: string): Actor => ({ personId: id, via: "web", lang: "en", auth: "email_code" });
const bot = (id: string, grantId: string): Actor => ({ personId: id, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId });
const book = (who: Actor, personId: string, day: string, hhmm: string, now = NOW) =>
  plan(db, "booking.request", { court_id: court, starts_at: at(day, hhmm), minutes: 90, pay: "whole", person_id: personId }, who, { now });
async function rejects(p: Promise<unknown>, code: string, text?: RegExp) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.match(e.text.en, text); return true; });
}
async function connect(personId: string, capCents: number) {
  const id = uuidv7();
  await db.insertInto("oauth_grant").values({ id, person_id: personId, client_id: "kc_test", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: capCents }).execute();
  return id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const opts = { now: NOW };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner, opts)).result as { person_id: string }).person_id;
  await db.insertInto("oauth_client").values({ client_id: "kc_test", kind: "registered", name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], secret_hash: null, metadata: null }).execute();
  grant = await connect(ann, 0);
  ownerGrant = await connect(owner.personId!, 0);
});
after(async () => drop());

test("with no limit set, an assistant can't book anything that costs money; it says what's left and where to do it", async () => {
  await rejects(book(bot(ann, grant), ann, "2026-12-02", "10:00"), "error.assistant_over_cap",
    /^This costs \$60\.00, and Test Agent has \$0\.00 left of the \$0\.00 a week you let it spend\. Do it in the club's app/);
  const p = await book(web(ann), ann, "2026-12-02", "10:00");   // the person themselves, in the app: no limit
  assert.equal(p.status, "planned");
});

test("the person raises the limit; the assistant books within it, and the rest of the week is what's left", async () => {
  const bea = ((await run(db, "person.create", { display_name: "Bea", email: "bea@example.test" }, owner, { now: NOW })).result as { person_id: string }).person_id;
  await rejects(plan(db, "assistant.set_cap", { grant_id: grant, weekly_cap_cents: 10_000 }, web(bea), { now: NOW }), "error.forbidden_reason");   // only their own
  const r = await run(db, "assistant.set_cap", { grant_id: grant, weekly_cap_cents: 10_000 }, web(ann), { now: NOW });
  assert.equal(r.plan.summary.en, "Let Test Agent spend up to $100.00 a week for you.");
  const p = await book(bot(ann, grant), ann, "2026-12-03", "10:00");
  const done = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-03", "10:00"), minutes: 90, pay: "whole", person_id: ann }, bot(ann, grant), { now: NOW });
  assert.ok(p.runId && done);
  assert.equal(await weekSpent(db, grant, NOW), 6000);
  await rejects(book(bot(ann, grant), ann, "2026-12-04", "10:00"), "error.assistant_over_cap", /has \$40\.00 left of the \$100\.00 a week/);
  const [a] = await assistantsOf(db, ann, NOW);
  assert.deepEqual({ name: a!.name, cap: a!.weekly_cap_cents, spent: a!.spent_cents }, { name: "Test Agent", cap: 10_000, spent: 6000 });
  // Next Monday, the week starts again.
  assert.equal(await weekSpent(db, grant, new Date("2026-12-07T09:00:00Z")), 0);
});

test("a planned booking is checked again when it's confirmed: two previews can't both fit", async () => {
  await run(db, "assistant.set_cap", { grant_id: grant, weekly_cap_cents: 16_000 }, web(ann), { now: NOW });   // $100 left
  const one = await book(bot(ann, grant), ann, "2026-12-05", "10:00"), two = await book(bot(ann, grant), ann, "2026-12-05", "12:00");
  const { apply } = await import("../src/index.ts");
  await apply(db, one.runId, bot(ann, grant), { now: NOW });
  await rejects(apply(db, two.runId, bot(ann, grant), { now: NOW }), "error.assistant_over_cap", /has \$40\.00 left/);
});

test("money that comes back to the card from the assistant's own bookings frees the limit again", async () => {
  const r = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-06", "15:00"), minutes: 60, pay: "whole", person_id: ann }, web(ann), { now: NOW });
  assert.ok(r);   // the person's own booking, in the app: never counts
  const before = await weekSpent(db, grant, NOW);
  const paid = await db.selectFrom("action_run").innerJoin("entity_change", (j) => j.onRef("entity_change.action_run_id", "=", "action_run.id").on("entity_change.entity", "=", "payment").on("entity_change.op", "=", "insert"))
    .select(["entity_change.entity_id as payment", "action_run.result"]).where("action_run.oauth_grant_id", "=", grant).where("action_run.status", "=", "applied").orderBy("action_run.applied_at").executeTakeFirstOrThrow();
  await openPayment(db, paid.payment, ann);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paid.payment).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, paid.payment, "test", NOW);
  await run(db, "booking.cancel", { booking_id: (paid.result as any).booking_id, refund: "full" }, owner, { now: NOW });
  assert.equal(await weekSpent(db, grant, NOW), before - 6000);
});

test("staff work through an assistant isn't the person's own money: a booking for someone else doesn't count", async () => {
  const p = await book(bot(owner.personId!, ownerGrant), ann, "2026-12-08", "10:00");
  assert.equal(p.status, "planned");
});

async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, who);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, paymentId, "test", NOW);
}

const newPerson = async (name: string) =>
  ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;

test("a shared court counts in full until the others pay: the preview says so, and each share paid frees the limit", async () => {
  const dot = await newPerson("Dot"), g = await connect(dot, 6000);
  const input = { court_id: court, starts_at: at("2026-12-10", "18:00"), minutes: 90, pay: "split", person_id: dot };
  const p = await plan(db, "booking.request", input, bot(dot, g), { now: NOW });
  assert.match(p.plan.summary.en, /You pay your part, \$15\.00, now.* It counts \$60\.00 against your assistant's weekly limit until the others pay\.$/);
  const r = await apply(db, p.runId, bot(dot, g), { now: NOW }) as { booking_id: string; payment_id: string };
  assert.equal(await weekSpent(db, g, NOW), 6000, "their share and what the others still owe");
  await rejects(plan(db, "booking.request", { ...input, starts_at: at("2026-12-11", "18:00") }, bot(dot, g), { now: NOW }), "error.assistant_over_cap_shared",
    /^This court counts \$60\.00 until the others pay their part, and Test Agent has \$0\.00 left/);
  await pay(r.payment_id, dot);
  assert.equal(await weekSpent(db, g, NOW), 6000, "paying their own part doesn't change what they're on the hook for");
  const cy = await newPerson("Cy");
  const invite = (await db.selectFrom("booking").select("invite_code").where("id", "=", r.booking_id).executeTakeFirstOrThrow()).invite_code!;
  const joined = (await run(db, "booking.join", { invite_code: invite, person_id: cy }, web(cy), { now: NOW })).result as { payment_id: string };
  assert.equal(await weekSpent(db, g, NOW), 6000, "a share not paid yet still counts");
  await pay(joined.payment_id, cy);
  assert.equal(await weekSpent(db, g, NOW), 4500, "Cy's $15 came off");
});

test("only what's charged counts: a hold that lapses unpaid gives the limit back, and a preview never confirmed never counted", async () => {
  const eli = await newPerson("Eli"), g = await connect(eli, 6000);
  const p = await book(bot(eli, g), eli, "2026-12-12", "10:00");
  assert.equal(await weekSpent(db, g, NOW), 0, "a preview is no spending");
  await apply(db, p.runId, bot(eli, g), { now: NOW });
  assert.equal(await weekSpent(db, g, NOW), 6000, "a booking waiting to be paid counts while it's held");
  const later = new Date(NOW.getTime() + 20 * 60_000);
  await expireHolds(db, later);
  assert.equal(await weekSpent(db, g, later), 0, "it lapsed unpaid: nothing was charged");
});

test("the person's own say stays in the app: waivers, their own level, their data, the family card, saying yes to messages, and anything that needs a strong sign-in", async () => {
  const fay = await newPerson("Fay"), g = await connect(fay, 0), inApp = "error.assistant_in_app";
  await rejects(plan(db, "waiver.accept", { person_id: fay }, bot(fay, g), { now: NOW }), inApp);
  await rejects(plan(db, "level.self_adjust", { person_id: fay, level: 3 }, bot(fay, g), { now: NOW }), inApp);
  await rejects(plan(db, "privacy.export", { person_id: fay }, bot(fay, g), { now: NOW }), inApp);
  await rejects(plan(db, "family_card.remove", { person_id: fay }, bot(fay, g), { now: NOW }), inApp);
  await rejects(plan(db, "consent.club_news", { person_id: fay, granted: true }, bot(fay, g), { now: NOW }), inApp, /Do it in the club's app/);
  await rejects(plan(db, "consent.texts", { person_id: fay, granted: true }, bot(fay, g), { now: NOW }), inApp);
  await run(db, "consent.club_news", { person_id: fay, granted: true }, web(fay), { now: NOW });   // in the app
  const off = await plan(db, "consent.club_news", { person_id: fay, granted: false }, bot(fay, g), { now: NOW });
  assert.equal(off.status, "planned", "an assistant may still turn club news off");
  const og = await connect(owner.personId!, 0);
  await rejects(plan(db, "club.update", { name: "Kestrel" }, bot(owner.personId!, og), { now: NOW }), inApp, undefined);   // strongAuth, whatever the sign-in
  const inAppOwner = await plan(db, "club.update", { name: "Kestrel" }, web(owner.personId!), { now: NOW });
  assert.equal(inAppOwner.status, "planned");
});

test("a parent's say over their children stays in the app too: a junior's login and rules, and who else is in the family", async () => {
  const pat = await newPerson("Pat"), g = await connect(pat, 0), inApp = "error.assistant_in_app";
  const mia = ((await run(db, "household.add_junior", { person_id: pat, display_name: "Mia", birth_year: 2011 }, web(pat), { now: NOW })).result as { person_id: string }).person_id;
  await rejects(plan(db, "kid.give_login", { person_id: mia, email: "stranger@example.test" }, bot(pat, g), { now: NOW }), inApp);
  await rejects(plan(db, "kid.set_rules", { person_id: mia, monthly_limit_cents: 100000 }, bot(pat, g), { now: NOW }), inApp);
  await rejects(plan(db, "household.invite", { person_id: pat }, bot(pat, g), { now: NOW }), inApp);
  await rejects(plan(db, "household.remove_junior", { person_id: mia }, bot(pat, g), { now: NOW }), inApp);
});

test("disconnecting ends it at once: its tokens stop working, and a preview it made can't be confirmed", async () => {
  const p = await book(bot(ann, grant), ann, "2026-12-09", "18:00");
  await db.insertInto("oauth_token").values({ token_hash: "h1", kind: "access", grant_id: grant, family: uuidv7(), resource: "x", expires_at: new Date(NOW.getTime() + 3600_000), used_at: null, revoked_at: null }).execute();
  const r = await run(db, "assistant.disconnect", { grant_id: grant }, web(ann), { now: NOW });
  assert.match(r.plan.summary.en, /^Disconnect Test Agent\. It can't see or change anything for you/);
  assert.ok((await db.selectFrom("oauth_token").select("revoked_at").where("token_hash", "=", "h1").executeTakeFirstOrThrow()).revoked_at);
  const { apply } = await import("../src/index.ts");
  await rejects(apply(db, p.runId, bot(ann, grant), { now: NOW }), "error.assistant_disconnected");
  assert.deepEqual(await assistantsOf(db, ann, NOW), []);
});
