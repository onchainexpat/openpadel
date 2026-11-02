import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, c1: string, ann: string, plan: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {};
const day = () => localDate(new Date(Date.now() + 86400_000), TZ);
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  plan = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month", days_ahead: 30, description: "Play more, pay less" }, owner)).result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Members", cents_per_hour: 3000, plan_ids: [plan] }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner)).result as any).person_id;
  await run(db, "membership.grant", { person_id: ann, plan_id: plan, note: "Founding member" }, owner);
  await signIn("robin@example.test"); await signIn("ann@example.test");
});
after(async () => drop());

test("staff see the plans, who has one, and a member's price at the desk", async () => {
  const m = (await get("/staff/memberships", "robin@example.test")).json;
  assert.deepEqual(m.plans.map((p: any) => [p.name, p.members]), [["Monthly", 1]]);
  assert.deepEqual(m.members.map((x: any) => [x.display_name, x.plan, x.source, x.note]), [["Ann", "Monthly", "desk", "Founding member"]]);
  const p = (await get(`/staff/people/${ann}`, "robin@example.test")).json;
  assert.equal(p.membership.name, "Monthly"); assert.equal(p.plans.length, 1);
  assert.deepEqual((await get("/staff/settings", "robin@example.test")).json.plans.map((x: any) => x.name), ["Monthly"]);
  const free = (await get(`/availability?location_id=${loc}&date=${day()}&minutes=60`, "ann@example.test")).json;
  const start = encodeURIComponent(free.courts[0].starts[4]);
  const anyone = (await get(`/staff/quote?court_id=${c1}&starts_at=${start}&minutes=60`, "robin@example.test")).json;
  const member = (await get(`/staff/quote?court_id=${c1}&starts_at=${start}&minutes=60&person_id=${ann}`, "robin@example.test")).json;
  assert.deepEqual([anyone.total_cents, anyone.member, member.total_cents, member.member], [4000, null, 3000, "Monthly"]);
  assert.equal((await get(`/staff/quote?court_id=${c1}&starts_at=${start}&minutes=60&person_id=nope`, "robin@example.test")).status, 400);
  // Members don't see the staff pages.
  assert.equal((await get("/staff/memberships", "ann@example.test")).status, 403);
});

test("a member sees their membership, their price and their longer booking window", async () => {
  const m = (await get("/my/membership", "ann@example.test")).json.membership;
  assert.deepEqual([m.name, m.description, m.days_ahead, m.member_prices, m.source, m.ends_on, m.pay_now], ["Monthly", "Play more, pay less", 30, true, "desk", null, null]);
  // What can be joined in the app, and whether the members' app shows Membership at all.
  const offers = (await get("/membership-plans", "ann@example.test")).json;
  assert.deepEqual(offers.map((o: any) => [o.name, o.price_cents, o.period, o.member_prices]), [["Monthly", 8000, "month", true]]);
  assert.equal((await get("/club", "ann@example.test")).json.memberships, true);
  assert.equal((await get("/booking-options", "ann@example.test")).json.days_ahead, 30);
  assert.equal((await get("/booking-options", "robin@example.test")).json.days_ahead, 14);
  assert.equal((await get("/my/membership", "robin@example.test")).json.membership, null);
  const free = (await get(`/availability?location_id=${loc}&date=${day()}&minutes=60`, "ann@example.test")).json;
  const q = (await get(`/quote?court_id=${c1}&starts_at=${encodeURIComponent(free.courts[0].starts[4])}&minutes=60`, "ann@example.test")).json;
  assert.deepEqual([q.total_cents, q.member], [3000, "Monthly"]);
});

test("a founding offer: places left and the start date, then saving the card for a place", async () => {
  const start = localDate(new Date(Date.now() + 40 * 86400_000), TZ);
  const founding = ((await run(db, "membership.plan_set", { name: "Founding", price_cents: 6000, period: "month", max_members: 10, starts_on: start }, owner)).result as any).plan_id;
  const bea = ((await run(db, "person.create", { display_name: "Bea", email: "bea@example.test" }, owner)).result as any).person_id;
  await signIn("bea@example.test");
  const offer = (await get("/membership-plans", "bea@example.test")).json.find((o: any) => o.name === "Founding");
  assert.deepEqual([offer.places_left, offer.starts_on], [10, start]);
  const id = ((await run(db, "membership.join", { plan_id: founding, person_id: bea }, { personId: bea, via: "test", lang: "en" })).result as any).membership_id;
  const post = async (path: string, who: string) => { const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: "{}" }); return { status: r.status, json: await r.json() as any }; };
  const before = (await get("/my/membership", "bea@example.test")).json.membership;
  assert.match((await post(`/my/memberships/${id}/card`, "bea@example.test")).json.client_secret, /^seti_test_/);
  assert.equal((await post(`/my/memberships/${id}/card`, "ann@example.test")).status, 404);   // not Ann's
  assert.equal((await post(`/my/memberships/${id}/card/check`, "bea@example.test")).json.status, "pending");
  assert.equal((await post(`/dev/memberships/${id}/card`, "bea@example.test")).json.status, "succeeded");   // the stand-in card form
  assert.equal(before.perks_now, false);   // no card yet: nothing applies
  const m = (await get("/my/membership", "bea@example.test")).json.membership;
  assert.deepEqual([m.status, m.starts_on, m.card_saved, m.perks_now], ["upcoming", start, true, true]);   // the app says the perks apply already
  assert.equal((await get("/membership-plans", "ann@example.test")).json.find((o: any) => o.name === "Founding").places_left, 9);
});

test("What's On shows each person their own price: an included session, a member price, or what members pay", async () => {
  await run(db, "membership.plan_set", { plan_id: plan, name: "Monthly", price_cents: 8000, period: "month", days_ahead: 30, description: "Play more, pay less", program_percent_off: 10, included_sessions: 1, included_kinds: ["clinic"] }, owner);
  const clinic = async (name: string, h: number) => {
    const id = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name, capacity: 6, price_cents: 3000 }, owner)).result as any).program_id;
    const start = new Date(Date.now() + h * 3600_000);
    await run(db, "session.add", { program_id: id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [c1] }, owner);
    await run(db, "program.publish", { program_id: id }, owner);
    return id as string;
  };
  const a = await clinic("Drills", 50), b = await clinic("Volleys", 75);
  const mine = async (who: string, id: string) => (await get("/open-programs", who)).json.find((p: any) => p.id === id);
  assert.deepEqual(await mine("ann@example.test", a).then((p: any) => [p.my_basis, p.my_price_cents, p.included, p.members_cents]), ["included", 0, { n: 1, of: 1 }, null]);
  assert.deepEqual(await mine("robin@example.test", a).then((p: any) => [p.my_basis, p.my_price_cents, p.members_cents]), ["full", 3000, 2700]);
  const m1 = (await get("/my/membership", "ann@example.test")).json.membership;
  assert.deepEqual([m1.program_percent_off, m1.included_sessions, m1.included_kinds, m1.included_used], [10, 1, ["clinic"], 0]);
  await run(db, "enrolment.join", { program_id: a, person_id: ann }, { personId: ann, via: "test", lang: "en" });
  assert.deepEqual(await mine("ann@example.test", b).then((p: any) => [p.my_basis, p.my_price_cents]), ["member", 2700]);
  assert.deepEqual(await mine("ann@example.test", a).then((p: any) => [p.my_status, p.my_basis, p.my_price_cents, p.included]), ["booked", "included", 0, null]);   // the price the place was taken at
  assert.equal((await get("/my/membership", "ann@example.test")).json.membership.included_used, 1);
});
