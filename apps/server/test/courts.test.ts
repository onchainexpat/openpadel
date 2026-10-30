import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, c1: string, cookie: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles";
// Tomorrow in the club's time, so the test works on any day.
const day = () => localDate(new Date(Date.now() + 86400_000), TZ);
const get = async (path: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, json: await r.json() as any }; };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => drop());

test("the day's grid: each court's bookings and blocks, labelled, in the location's time", async () => {
  const free = (await get(`/availability?location_id=${loc}&date=${day()}&minutes=90`)).json;
  const start = free.courts[0].starts[4];   // 10:00
  await run(db, "booking.create", { court_id: c1, starts_at: start, minutes: 90, guest_name: "Sam (walk-in)" }, owner);
  await run(db, "court.block", { court_ids: [c1], starts_at: free.courts[0].starts[10], ends_at: free.courts[0].starts[12], reason: "maintenance", note: "Net" }, owner);
  const g = (await get(`/staff/grid?location_id=${loc}&date=${day()}`)).json;
  assert.equal(g.time_zone, TZ); assert.ok(g.open);
  const items = g.courts.find((c: any) => c.id === c1).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].who, "Sam (walk-in)"); assert.match(items[0].code, /^KP-/);
  assert.equal(items[1].label, "maintenance: Net");
  // The free list now skips what's taken.
  const after = (await get(`/availability?location_id=${loc}&date=${day()}&minutes=90`)).json;
  assert.ok(!after.courts.find((c: any) => c.id === c1).starts.includes(start));
  assert.equal((await get(`/availability?location_id=${loc}&date=nope&minutes=90`)).status, 400);
});

test("settings carry each location's week of hours and its special days to come", async () => {
  await run(db, "hours.exception_set", { location_id: loc, date: "2099-12-25", note: "Christmas" }, owner);
  const s = (await get("/staff/settings")).json;
  const l = s.locations[0];
  assert.equal(l.hours.length, 7); assert.deepEqual(l.hours[3], { weekday: 3, opens: "08:00", closes: "22:00" });
  assert.deepEqual(l.special_days.map((x: any) => [x.on_date, x.opens, x.note]), [["2099-12-25", null, "Christmas"]]);
});

test("prices and booking rules: in settings, and a quote for the desk's form", async () => {
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { tax_rate_bp: 500, court_bookings: true }, owner);
  const s = (await get("/staff/settings")).json;
  assert.deepEqual(s.locations[0].prices.map((p: any) => [p.name, p.cents_per_hour]), [["Standard", 4000]]);
  assert.equal(s.policy.version_no, 1); assert.deepEqual(s.policy.lengths, [60, 90, 120]);
  assert.equal(s.club.tax_rate_bp, 500); assert.equal(s.club.court_bookings, true);
  const start = (await get(`/availability?location_id=${loc}&date=${day()}&minutes=60`)).json.courts[1].starts[0];
  const q = (await get(`/staff/quote?court_id=${c1}&starts_at=${encodeURIComponent(start)}&minutes=90`)).json;
  assert.deepEqual([q.subtotal_cents, q.tax_cents, q.total_cents, q.priced], [6000, 300, 6300, true]);
});
