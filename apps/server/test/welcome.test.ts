// The members' app's welcome for someone who moved in from Playtomic (welcome.ts): only for them, once, and seeing it
// records nothing else (no yes to texts, no news). And the preview of a change that charges money carries its lines.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, gold: string, court: string;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => { const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
const personBy = async (email: string) => (await db.selectFrom("person").select("id").where("email", "=", email).executeTakeFirstOrThrow()).id;
const consents = (id: string) => db.selectFrom("channel_consent").select(["channel", "purpose", "granted"]).where("person_id", "=", id).execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner)).result as any).plan_id;
  // Two members from the club's Playtomic list (one says yes to club news in it), and one the desk added by hand.
  await run(db, "person.import", { rows: [{ display_name: "Ivy Moss", email: "ivy@example.test", playtomic_id: "pt-1", level: { value: 3.25 } },
    { display_name: "Jo Park", email: "jo@example.test", club_news: true }] }, owner);
  await run(db, "person.create", { display_name: "Dana Ruiz", email: "dana@example.test" }, owner);
  // Ivy's membership came across too: renewing here from a card she hasn't added yet.
  await db.insertInto("membership").values({ id: uuidv7(), person_id: await personBy("ivy@example.test"), plan_id: gold, status: "active", source: "app", brought_from: "playtomic", brought_ref: "b-1",
    started_at: new Date(Date.now() - 20 * 864e5), current_period_end: new Date(Date.now() + 10 * 864e5), price_cents: 6000, period: "month" } as any).execute();
});
after(async () => drop());

test("an imported member sees the welcome at first sign-in, once: what came across, then never again", async () => {
  const cookie = await signIn("ivy@example.test"), id = await personBy("ivy@example.test");
  assert.equal((await call("/me", cookie)).json.welcome, true);
  const w = (await call("/my/welcome", cookie, {})).json;
  assert.equal(w.moved_in, true);
  assert.equal(w.first, true);
  assert.deepEqual(w.bookings, []);
  assert.equal(Number(w.level), 3.25);
  assert.equal(w.credit_cents, 0);
  assert.equal(w.membership.name, "Gold");
  assert.equal(w.membership.renews, true);
  assert.equal(w.membership.needs_card, true);
  assert.match(w.membership.date, /^\d{4}-\d{2}-\d{2}$/);
  // Seen: /me no longer sends the app there, and asking again says it's not the first time.
  assert.equal((await call("/me", cookie)).json.welcome, false);
  assert.equal((await call("/my/welcome", cookie, {})).json.first, false);
  // Signing in again on another device doesn't bring it back.
  assert.equal((await call("/me", await signIn("ivy@example.test"))).json.welcome, false);
  // Seeing it recorded no yes to anything: texts are asked only when ticked, through consent.texts.
  assert.deepEqual((await consents(id)).filter((c) => c.channel === "sms"), []);
});

test("another imported member gets it too, with honest empty parts; their club news yes from the list is the import's, not the welcome's", async () => {
  const cookie = await signIn("jo@example.test"), id = await personBy("jo@example.test");
  assert.equal((await call("/me", cookie)).json.welcome, true);
  const before = await consents(id);
  const w = (await call("/my/welcome", cookie, {})).json;
  assert.deepEqual([w.level, w.membership, w.credit_cents, w.bookings], [null, null, 0, []]);
  assert.deepEqual(await consents(id), before);
});

test("someone who didn't move in never sees it", async () => {
  const cookie = await signIn("dana@example.test");
  assert.equal((await call("/me", cookie)).json.welcome, false);
  assert.deepEqual((await call("/my/welcome", cookie, {})).json, { moved_in: false });
  assert.equal((await db.selectFrom("person").select("welcomed_at").where("email", "=", "dana@example.test").executeTakeFirstOrThrow()).welcomed_at, null);
});

test("the preview of a change that charges money carries its lines; one that charges nothing has none", async () => {
  const cookie = await signIn("dana@example.test"), id = await personBy("dana@example.test");
  const starts = new Date(Date.now() + 3 * 864e5); starts.setUTCHours(18, 0, 0, 0);
  const p = (await call("/actions/booking.request/plan", cookie, { court_id: court, starts_at: starts.toISOString(), minutes: 90, pay: "whole", person_id: id })).json;
  assert.deepEqual(p.charge.lines, [{ kind: "item", label: "Court 1, 90 minutes", cents: 6000 }, { kind: "total", label: "Total", cents: 6000 }]);
  assert.equal(p.charge.due_cents, 6000);
  assert.equal(typeof p.summary, "string");   // the summary is still there, for the staff app and older apps
  const r = (await call(`/runs/${p.run_id}/apply`, cookie, {})).json;
  assert.equal((await db.selectFrom("payment").select("amount_cents").where("id", "=", r.result.payment_id).executeTakeFirstOrThrow()).amount_cents, p.charge.due_cents);
  const none = (await call("/actions/consent.club_news/plan", cookie, { person_id: id, granted: true })).json;
  assert.equal(none.charge, undefined);
});

test("staff previewing a member's paid change at the desk see the summary, not the member's charge sheet", async () => {
  const cookie = await signIn("robin@example.test"), id = await personBy("jo@example.test");
  const p = (await call("/actions/membership.join/plan", cookie, { plan_id: gold, person_id: id })).json;
  assert.equal(typeof p.summary, "string");
  assert.equal(p.charge, undefined);
});
