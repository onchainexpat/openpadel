import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, weekSpent, assistantsOf, KumiError, TestProvider, uuidv7, type Actor, type Db } from "../src/index.ts";

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
