import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { currentPolicy, plan, quote, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z"), opts = { now: NOW };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);   // December: Pacific standard time
const q = (court: string, day: string, hhmm: string, minutes: number) => quote(db, { courtId: court, start: at(day, hhmm), minutes });

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Show court" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Off-peak", cents_per_hour: 4000 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Peak", weekdays: [1, 2, 3, 4, 5], starts: "17:00", ends: "22:00", cents_per_hour: 6000, priority: 1 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Show court", court_ids: [c2], cents_per_hour: 7000, priority: 2 }, owner, opts);
});
after(async () => drop());

test("a booking from off-peak into peak pays each part at its own rate", async () => {
  const r = await q(c1, "2026-12-01", "16:30", 90);   // Tuesday
  assert.deepEqual(r.lines.map((l) => [l.name, l.cents]), [["Off-peak", 2000], ["Peak", 6000]]);
  assert.equal(r.total_cents, 8000); assert.ok(r.priced);
  assert.equal((await q(c1, "2026-12-05", "18:00", 60)).total_cents, 4000);   // Saturday: no peak
  assert.equal((await q(c2, "2026-12-01", "18:00", 90)).total_cents, 10500);  // the show court's own price wins
});

test("a season, and the club's sales tax", async () => {
  await run(db, "price.rule_set", { location_id: loc, name: "Holidays", valid_from: "2026-12-20", valid_to: "2026-12-31", cents_per_hour: 3000, priority: 3 }, owner, opts);
  assert.equal((await q(c1, "2026-12-22", "18:00", 60)).total_cents, 3000);
  assert.equal((await q(c1, "2027-01-05", "18:00", 60)).total_cents, 6000);
  await run(db, "club.update", { tax_rate_bp: 825 }, owner, opts);
  const t = await q(c1, "2026-12-01", "16:30", 90);
  assert.deepEqual([t.subtotal_cents, t.tax_cents, t.total_cents], [8000, 660, 8660]);
  await run(db, "club.update", { tax_rate_bp: 0 }, owner, opts);
});

test("a location without prices says so, and the preview says what a rule is", async () => {
  const other = ((await run(db, "location.create", { name: "Riverside", time_zone: TZ }, owner)).result as any).location_id;
  const c = ((await run(db, "court.create", { location_id: other, name: "R1" }, owner)).result as any).court_id;
  const r = await q(c, "2026-12-01", "10:00", 60);
  assert.equal(r.priced, false); assert.equal(r.total_cents, 0);
  const p = await plan(db, "price.rule_set", { location_id: loc, name: "Early bird", weekdays: [1, 2, 3, 4, 5], starts: "07:00", ends: "09:00", cents_per_hour: 3500, priority: 1 }, owner, opts);
  assert.equal(p.plan.summary.en, "Price Early bird at Eastside: $35.00 an hour, Mon, Tue, Wed, Thu, Fri, 07:00 to 09:00.");
});

test("desk bookings take the quote's price; booking rules change by version and old bookings keep theirs", async () => {
  const b = await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-01", "16:30").toISOString(), minutes: 90, guest_name: "Pat" }, owner, opts);
  assert.match(b.plan.summary.en, /for Pat: \$80\.00\.$/);
  const row = await db.selectFrom("booking").selectAll().where("id", "=", (b.result as any).booking_id).executeTakeFirstOrThrow();
  assert.equal(row.price_cents, 8000); assert.equal((row.quote as any).lines.length, 2);
  const v1 = await currentPolicy(db);
  assert.equal(row.policy_id, v1.id);
  const p = await run(db, "policy.set", { free_cancel_hours: 12, late_refund_percent: 50 }, owner, opts);
  assert.match(p.plan.summary.en, /^New booking rules \(version 2\): book up to 14 days ahead; 3 upcoming bookings each; free cancellation until 12 hours before, then 50% back;/);
  assert.equal((await currentPolicy(db)).free_cancel_hours, 12);
  assert.equal((await db.selectFrom("booking").select("policy_id").where("id", "=", row.id).executeTakeFirstOrThrow()).policy_id, v1.id);
  await run(db, "action.undo", { run_id: p.runId }, owner, opts);
  assert.equal((await currentPolicy(db)).version_no, 1);   // undoing a change goes back to the rules before it
});
