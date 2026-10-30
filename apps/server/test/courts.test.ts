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

test("members: book from the app, see it under my bookings with its calendar file, and share a split booking", async () => {
  const ann = (await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner)).result as { person_id: string };
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@example.test" }) });
  const code = mailer.last("ann@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const annCookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
  const as = async (path: string, body?: unknown) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { cookie: annCookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  const opts = (await as("/booking-options")).json;
  assert.deepEqual(opts.lengths, [60, 90, 120]);
  const later = localDate(new Date(Date.now() + 3 * 86400_000), TZ);
  const start = (await as(`/availability?location_id=${loc}&date=${later}&minutes=90`)).json.courts[0].starts[6];
  const plan = (await as("/actions/booking.request/plan", { court_id: c1, starts_at: start, minutes: 90, pay: "split", players: 4, person_id: ann.person_id })).json;
  const applied = (await as(`/runs/${plan.run_id}/apply`, {})).json.result;
  await as(`/dev/payments/${applied.payment_id}/settle`, {});
  const mine = (await as("/my/bookings")).json;
  assert.equal(mine.length, 1); assert.equal(mine[0].status, "confirmed"); assert.equal(mine[0].mine, true); assert.ok(mine[0].invite_code);
  const invite = (await as(`/bookings/invite/${mine[0].invite_code}`)).json;
  assert.equal(invite.organiser, "Ann"); assert.equal(invite.spots_left, 3); assert.equal(invite.open, true);
  const ics = await app.request(`/my/bookings/${mine[0].id}/calendar.ics`, { headers: { cookie: annCookie } });
  assert.match(ics.headers.get("content-type") ?? "", /text\/calendar/);
  const body = await ics.text();
  assert.match(body, /BEGIN:VEVENT/); assert.match(body, /SUMMARY:Court 1\\, Kestrel Padel \(KP-/);
});

test("occupancy and revenue for a day, and the same as a spreadsheet", async () => {
  const d = day();
  const r = (await get(`/staff/reports?location_id=${loc}&from=${d}&to=${d}`)).json;
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.courts, 2); assert.equal(row.court_hours, 28);   // 08:00 to 22:00 on two courts
  assert.ok(row.booked_hours >= 1.5); assert.equal(row.blocked_hours, 1);
  assert.ok(row.occupancy_percent > 0);
  const csv = await (await app.request(`/staff/reports.csv?location_id=${loc}&from=${d}&to=${d}`, { headers: { cookie } })).text();
  assert.match(csv, /^date,open hours,courts,court hours,booked hours,program hours,playtomic hours,blocked hours,occupancy %,court revenue,lesson revenue,program revenue\r\n/);
  assert.equal(csv.trim().split("\r\n").length, 2);
});

test("several courts in one checkout: two bookings under My bookings, paid together for their total", async () => {
  const ben = (await run(db, "person.create", { display_name: "Ben", email: "ben@example.test" }, owner)).result as { person_id: string };
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ben@example.test" }) });
  const code = mailer.last("ben@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const benCookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ben@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
  const as = async (path: string, body?: unknown) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { cookie: benCookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  const d = localDate(new Date(Date.now() + 4 * 86400_000), TZ);
  const free = (await as(`/availability?location_id=${loc}&date=${d}&minutes=60`)).json.courts;
  const plan = (await as("/actions/booking.request_courts/plan", { courts: [{ court_id: free[0].id, starts_at: free[0].starts[2], minutes: 60 }, { court_id: free[1].id, starts_at: free[1].starts[2], minutes: 60 }], person_id: ben.person_id })).json;
  assert.match(plan.summary, /^Book 2 courts: Court 1, .+ \$84\.00 in all, paid now in one card payment\./);
  const applied = (await as(`/runs/${plan.run_id}/apply`, {})).json.result;
  const held = (await as("/my/bookings")).json;
  assert.deepEqual(held.map((b: any) => [b.status, b.share_cents, b.group_cents]), [["held", 4200, 8400], ["held", 4200, 8400]]);   // paying either pays both (prices with the 5% tax)
  await as(`/dev/payments/${applied.payment_id}/settle`, {});
  assert.deepEqual((await as("/my/bookings")).json.map((b: any) => [b.status, b.paid_cents, b.group_cents]), [["confirmed", 4200, null], ["confirmed", 4200, null]]);
});
