// Getting started (getting_started.ts): a new club's owner and managers see its steps on Today, each ticked from the club
// itself (details and logo, courts and hours, prices, staff, members) or from the server's settings as doctor reads them
// (card payments, email, practice mode); the front desk doesn't. It can be put away only once every required step is done
// (a membership plan is optional), through an action like every write, and agents read the same list in Connectors.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { KumiError, run, runAsSystem, setStartOutside, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { gettingStartedView } from "../src/getting_started.ts";
import { MemoryMailer } from "../src/mailer.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const ball = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="70" fill="none" stroke="#0b5a55" stroke-width="16"/></svg>`;
let outside = { payments: false, email: false, live: false };
const ticks = (g: any) => Object.fromEntries(g.items.map((x: any) => [x.key, x.done]));

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  // The server's settings, as the test says they stand (the app reads doctor's checks).
  setStartOutside(async () => outside);
  await signIn("robin@example.test");
  const desk = ((await run(db, "person.create", { display_name: "Dana Desk", email: "dana@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: desk, role: "front_desk" }, owner);
  await signIn("dana@example.test");
});
after(async () => { await drop(); });

test("a brand-new club: every step to do, each with its words and the page that does it; the front desk doesn't see it", async () => {
  const r = await get("/staff/today", "robin@example.test");
  const g = r.json.getting_started;
  assert.deepEqual(g.items.map((x: any) => x.key), ["club", "courts", "prices", "payments", "email", "membership", "staff", "members", "live"]);
  // Dana is the second staff member: inviting staff is done; the rest is to do.
  assert.deepEqual(ticks(g), { club: false, courts: false, prices: false, payments: false, email: false, membership: false, staff: true, members: false, live: false });
  assert.equal(g.ready, false); assert.equal(g.required, 8);
  const by = Object.fromEntries(g.items.map((x: any) => [x.key, x]));
  assert.equal(by.membership.optional, true); assert.equal(by.prices.optional, false);
  assert.equal(by.courts.page, "/settings#new-location", "no location yet: courts start with adding one");
  assert.equal(by.club.page, "/settings#club-details"); assert.equal(by.payments.page, "/connectors#connector-stripe"); assert.equal(by.live.page, null);
  assert.equal(by.courts.title, "Courts and opening hours");
  assert.match(by.live.how, /owner's call/);
  const es = await gettingStartedView(db, "es");
  assert.equal(es.items.find((x) => x.key === "courts")!.title, "Canchas y horario");
  assert.equal((await get("/staff/today", "dana@example.test")).json.getting_started, null, "the front desk doesn't set the club up");
});

test("it can't be put away while a required step is left", async () => {
  await assert.rejects(run(db, "getting_started.hide", {}, owner), (e: unknown) => e instanceof KumiError && e.code === "error.getting_started_not_done");
});

test("each tick comes from the club: details and logo, courts and hours, prices, members, and the server's settings", async () => {
  await run(db, "club.set_logo", { logo: Buffer.from(ball).toString("base64") }, owner);
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner);
  let g = (await get("/staff/today", "robin@example.test")).json.getting_started;
  assert.equal(ticks(g).courts, false, "courts but no opening hours yet");
  assert.equal(g.items.find((x: any) => x.key === "courts").page, "/settings#courts");
  await run(db, "hours.set", { location_id: loc, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 3200 }, owner);
  await run(db, "person.create", { display_name: "Sam Player", email: "sam@example.test" }, owner);
  g = (await get("/staff/today", "robin@example.test")).json.getting_started;
  assert.deepEqual(ticks(g), { club: true, courts: true, prices: true, payments: false, email: false, membership: false, staff: true, members: true, live: false });
  outside = { payments: true, email: true, live: false };
  g = (await get("/staff/today", "robin@example.test")).json.getting_started;
  assert.equal(g.ready, false, "still in practice");
  outside = { payments: true, email: true, live: true };
  g = (await get("/staff/today", "robin@example.test")).json.getting_started;
  assert.equal(g.ready, true, "a membership plan is optional");
  assert.equal(g.required_done, 8); assert.equal(ticks(g).membership, false);
});

test("put away through its action (previewed, audited, undoable), it leaves Today; agents still read it in Connectors", async () => {
  const p = await run(db, "getting_started.hide", {}, owner);
  assert.deepEqual(p.result, { hidden: true });
  assert.equal((await get("/staff/today", "robin@example.test")).json.getting_started, null);
  const c = await get("/staff/connectors", "robin@example.test");
  assert.equal(c.status, 200);
  assert.ok(c.json.getting_started.hidden_at, "put away, and when");
  assert.equal(c.json.getting_started.ready, true);
  await assert.rejects(run(db, "getting_started.hide", {}, owner), (e: unknown) => e instanceof KumiError && e.code === "error.nothing_changed");
  const audit = await db.selectFrom("action_run").select(["status", "undo_kind"]).where("action", "=", "getting_started.hide").where("status", "=", "applied").executeTakeFirstOrThrow();
  assert.equal(audit.undo_kind, "reversible");
  // Undone, it's back on Today.
  await run(db, "action.undo", { run_id: p.runId }, owner);
  assert.ok((await get("/staff/today", "robin@example.test")).json.getting_started);
  // A manager puts it away too, without asking the owner (it changes none of the club's settings).
  const mid = ((await run(db, "person.create", { display_name: "Max Manager", email: "max@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: mid, role: "manager" }, owner);
  const m = await run(db, "getting_started.hide", {}, { personId: mid, via: "test", lang: "en" });
  assert.deepEqual(m.result, { hidden: true });
});
