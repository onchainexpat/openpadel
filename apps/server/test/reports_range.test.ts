// Reports read the books by time and the courts once for all the days (a big club's year took 750 ms a request):
// the same days, the same money and the same hours as reading each day alone. Money at the edges of a club day,
// across the night the clocks go back, a block over midnight, and a request longer than the 92 days shown.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { onDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, court: string, cookie: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-20T16:00:00Z");
const get = async (path: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, json: await r.json() as any, text: "" }; };
const report = async (from: string, to: string) => (await get(`/staff/reports?location_id=${loc}&from=${from}&to=${to}`)).json.rows as Array<Record<string, any>>;
const at = (day: string, hhmm: string) => onDate(day, hhmm, TZ);
/** A court paid at the desk, its books then dated `when` (the books are dated as they happen: here, when it says). */
async function paidAt(day: string, hhmm: string, cents: number, when: Date) {
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: at(day, hhmm).toISOString(), minutes: 60, guest_name: "Walk-in", price_cents: cents }, owner, { now: NOW })).result as any).booking_id;
  const r = await run(db, "booking.record_payment", { booking_id: b, cents, method: "cash" }, owner, { now: NOW });
  await sql`UPDATE ledger_txn SET at = ${when} WHERE action_run_id = ${r.runId}`.execute(db);
  return b;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
  // Sunday 1 November: 1:00 to 2:00 happens twice, the second time on standard time.
  await paidAt("2026-10-31", "10:00", 1000, at("2026-10-31", "23:59"));                 // Saturday, a minute before midnight
  await paidAt("2026-10-31", "11:00", 2000, at("2026-11-01", "00:00"));                 // Sunday's first minute
  await paidAt("2026-11-01", "10:00", 4000, new Date("2026-11-01T08:30:00Z"));         // 1:30 am the first time (PDT)
  await paidAt("2026-11-01", "11:00", 8000, new Date("2026-11-01T09:30:00Z"));         // 1:30 am the second time (PST)
  await paidAt("2026-11-01", "12:00", 16000, at("2026-11-02", "00:00"));                // Monday's first minute
  await paidAt("2026-11-02", "10:00", 32000, at("2026-11-02", "23:59"));                // Monday's last
  await paidAt("2026-11-03", "10:00", 64000, at("2026-11-04", "00:01"));                // past the last day asked for below
  // Blocked from 9 pm Monday to 9 am Tuesday: an hour inside each day's hours.
  await run(db, "court.block", { court_ids: [court], starts_at: at("2026-11-02", "21:00").toISOString(), ends_at: at("2026-11-03", "09:00").toISOString(), reason: "maintenance" }, owner, { now: NOW });
});
after(async () => drop());

test("money lands on its club day at the edges, across the night the clocks go back, and nothing from outside the days asked for", async () => {
  const rows = await report("2026-10-31", "2026-11-03");
  assert.deepEqual(rows.map((r) => r.date), ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(rows.map((r) => r.court_revenue_cents), [1000, 2000 + 4000 + 8000, 16000 + 32000, 0]);
  // One day alone says the same as the same day in a longer report.
  for (const day of ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]) {
    const one = await report(day, day);
    assert.deepEqual(one, rows.filter((r) => r.date === day), day);
  }
  const csv = await (await app.request(`/staff/reports.csv?location_id=${loc}&from=2026-11-01&to=2026-11-01`, { headers: { cookie } })).text();
  assert.match(csv.split("\r\n")[1]!, /^2026-11-01,/);
  assert.match(csv.split("\r\n")[1]!, /,140\.00,/, "Sunday's 140.00 in the download too");
});

test("court use is each day's own, a block over midnight split between the days it covers", async () => {
  const rows = await report("2026-10-31", "2026-11-04");
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  assert.equal(by["2026-10-31"].booked_hours, 2);
  assert.equal(by["2026-11-01"].booked_hours, 3, "three bookings on the day the clocks go back");
  assert.equal(by["2026-11-01"].open_hours, 14, "8 am to 10 pm is 14 hours that day too (the extra hour is at night)");
  assert.equal(by["2026-11-02"].blocked_hours, 1, "Monday: the block's hour inside 8 am to 10 pm");
  assert.equal(by["2026-11-03"].blocked_hours, 1, "Tuesday: its hour from opening");
  assert.equal(by["2026-11-02"].booked_hours, 1);
  assert.equal(by["2026-11-03"].booked_hours, 1);
  assert.equal(by["2026-11-04"].blocked_hours, 0);
  assert.equal(by["2026-11-02"].occupancy_percent, Math.round(1 / 13 * 1000) / 10, "Monday: an hour booked of the 13 not blocked");
});

test("a request longer than 92 days shows 92, and the money of each of them", async () => {
  const rows = await report("2026-08-02", "2026-12-31");
  assert.equal(rows.length, 92);
  assert.equal(rows.at(-1)!.date, "2026-11-01");
  assert.equal(rows.at(-1)!.court_revenue_cents, 14000);
  assert.equal(rows.at(-2)!.court_revenue_cents, 1000);
  assert.equal(rows.reduce((n, r) => n + r.court_revenue_cents, 0), 15000, "nothing from after the last day shown");
});
