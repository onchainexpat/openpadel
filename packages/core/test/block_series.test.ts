import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, extendBlockSeries, freeCourts, plan, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, c1: string, c2: string, c3: string, ann: string;
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am in Los Angeles
const opts = { now: NOW };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();   // December: Pacific standard time
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
/** The courts free for 60 minutes at that time, by name. */
async function freeAt(day: string, hhmm: string) {
  const f = await freeCourts(db, { locationId: loc, date: day, minutes: 60, now: NOW });
  return f.courts.filter((c) => c.starts.some((s) => new Date(s).getTime() === new Date(at(day, hhmm)).getTime())).map((c) => c.name);
}
const blockOn = async (court: string, day: string) => (await db.selectFrom("court_time").innerJoin("court_block", "court_block.id", "court_time.block_id").select(["court_block.id", "court_block.series_id"])
  .where("court_time.court_id", "=", court).where("court_time.active", "=", true).where("court_block.on_date", "=", day).executeTakeFirst());

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  c3 = ((await run(db, "court.create", { location_id: loc, name: "Court 3" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner, opts);
  const lee = uuidv7();
  await db.insertInto("person").values({ id: lee, display_name: "Lee", email: "lee@example.test", created_via: "desk" }).execute();
  await run(db, "role.assign", { person_id: lee, role: "front_desk" }, owner, opts);
  desk = { personId: lee, via: "test", lang: "en" };
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner, opts)).result as any).person_id;
});
after(async () => drop());

let league: string;
test("a weekly block: its dates hold the courts, and a booking in the way stays (the block leaves that court then)", async () => {
  const b = await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-08", "18:30"), minutes: 60, person_id: ann }, desk, opts);
  const input = { court_ids: [c1, c2], weekdays: [2], starts: "18:00", ends: "20:00", from_date: "2026-12-01", until_date: "2026-12-29", reason: "event" as const, note: "League" };
  const p = await plan(db, "court.block_repeat", input, desk, opts);
  assert.match(p.plan.summary.en, /^Block Court 1, Court 2 every Tue, 18:00 to 20:00 \(an event\), from Tue, Dec 1 until Tue, Dec 29: 5 dates\. One booking is in the way \(KP-\w{4} Tue, Dec 8\): it stays, and the block leaves that court free then\.$/);
  assert.match(p.plan.summary.es, /^Bloquear Court 1, Court 2 cada mar\.?, de 18:00 a 20:00 \(un evento\), desde el /);
  const r = await run(db, "court.block_repeat", input, desk, opts);
  league = (r.result as any).series_id;
  assert.equal((r.result as any).dates, 5);
  assert.deepEqual(await freeAt("2026-12-01", "18:00"), ["Court 3"]);
  assert.deepEqual(await freeAt("2026-12-08", "18:00"), ["Court 3"]);   // Court 1 has Ann's booking, Court 2 the block
  assert.ok(await blockOn(c2, "2026-12-08")); assert.equal(await blockOn(c1, "2026-12-08"), undefined);
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", (b.result as any).booking_id).executeTakeFirstOrThrow()).status, "confirmed");
  assert.deepEqual(await freeAt("2026-12-01", "20:00"), ["Court 1", "Court 2", "Court 3"]);   // only 18:00 to 20:00
  assert.deepEqual(await freeAt("2026-12-02", "18:00"), ["Court 1", "Court 2", "Court 3"]);   // only Tuesdays
  // Nothing else can take a blocked court: the database refuses it.
  await rejects(run(db, "booking.create", { court_id: c2, starts_at: at("2026-12-15", "18:00"), minutes: 60, guest_name: "Walk-in" }, desk, opts), "error.court_taken");
  await rejects(plan(db, "court.block_repeat", { ...input, weekdays: [3], until_date: "2026-11-30", from_date: "2026-12-01" }, desk, opts), "error.bad_dates");
  await rejects(plan(db, "court.block_repeat", { ...input, from_date: "2026-12-02", until_date: "2026-12-07" }, desk, opts), "error.no_dates");
  await rejects(plan(db, "court.block_repeat", { ...input, starts: "20:00", ends: "18:00" }, desk, opts), "error.bad_times");
});

test("ending one date, then changing this and the following ones", async () => {
  const dec15 = (await blockOn(c1, "2026-12-15"))!;
  const end = await plan(db, "court.block_repeat_end", { block_id: dec15.id, scope: "this" }, desk, opts);
  assert.equal(end.plan.summary.en, "Open Court 1, Court 2 again on Tue, Dec 15. The block's other dates stay.");
  await run(db, "court.block_repeat_end", { block_id: dec15.id, scope: "this" }, desk, opts);
  assert.deepEqual(await freeAt("2026-12-15", "18:00"), ["Court 1", "Court 2", "Court 3"]);
  assert.deepEqual((await db.selectFrom("block_series").select("skip_dates").where("id", "=", league).executeTakeFirstOrThrow()).skip_dates, ["2026-12-15"]);
  // From the 22nd the league plays 19:00 to 21:00 on Court 2 and Court 3.
  const dec22 = (await blockOn(c1, "2026-12-22"))!;
  const edit = { block_id: dec22.id, scope: "following" as const, starts: "19:00", ends: "21:00", court_ids: [c2, c3] };
  const p = await plan(db, "court.block_repeat_edit", edit, desk, opts);
  assert.equal(p.plan.summary.en, "Change the repeating block from Tue, Dec 22 on: Court 2, Court 3 every Tue, 19:00 to 21:00 (an event), 2 dates.");
  const r = await run(db, "court.block_repeat_edit", edit, desk, opts);
  assert.deepEqual(await freeAt("2026-12-22", "18:00"), ["Court 1", "Court 2", "Court 3"]);
  assert.deepEqual(await freeAt("2026-12-29", "19:00"), ["Court 1"]);
  assert.deepEqual(await freeAt("2026-12-01", "18:00"), ["Court 3"]);   // dates before stay as they were
  const old = await db.selectFrom("block_series").select(["until_date", "active"]).where("id", "=", league).executeTakeFirstOrThrow();
  assert.deepEqual(old, { until_date: "2026-12-21", active: true });
  const next = await db.selectFrom("block_series").selectAll().where("id", "=", (r.result as any).series_id).executeTakeFirstOrThrow();
  assert.deepEqual([next.from_date, next.until_date, next.court_ids, next.note], ["2026-12-22", "2026-12-29", [c2, c3], "League"]);
  // Changing one date on its own: it stays part of its series, and ending the series ends it too.
  const dec29 = (await blockOn(c2, "2026-12-29"))!;
  await run(db, "court.block_repeat_edit", { block_id: dec29.id, scope: "this", starts: "20:00", ends: "22:00" }, desk, opts);
  assert.deepEqual(await freeAt("2026-12-29", "19:00"), ["Court 1", "Court 2", "Court 3"]);
  assert.deepEqual(await freeAt("2026-12-29", "20:00"), ["Court 1"]);
  const moved = (await blockOn(c2, "2026-12-29"))!;
  const all = await plan(db, "court.block_repeat_end", { block_id: moved.id, scope: "all" }, desk, opts);
  assert.equal(all.plan.summary.en, "End the repeating block on Court 2, Court 3: the 2 dates still to come open again.");
  await run(db, "court.block_repeat_end", { block_id: moved.id, scope: "all" }, desk, opts);
  assert.deepEqual(await freeAt("2026-12-29", "20:00"), ["Court 1", "Court 2", "Court 3"]);
  await rejects(plan(db, "court.block_repeat_end", { block_id: moved.id, scope: "all" }, desk, opts), "error.not_found");
});

test("bookings in the way can be called off instead: their players are told, and the refund is the staff's choice", async () => {
  const b = await run(db, "booking.create", { court_id: c3, starts_at: at("2026-12-03", "10:00"), minutes: 90, person_id: ann }, desk, opts);
  const input = { court_ids: [c3], weekdays: [4], starts: "09:00", ends: "12:00", from_date: "2026-12-03", until_date: "2026-12-10", reason: "resurfacing" as const, in_the_way: "cancel" as const, refund: "full" as const };
  const p = await plan(db, "court.block_repeat", input, owner, opts);
  assert.match(p.plan.summary.en, /One booking is in the way \(KP-\w{4} Thu, Dec 3\): it's cancelled, its players are told, and \$0\.00 goes back to them\.$/);
  await run(db, "court.block_repeat", input, owner, opts);
  assert.equal((await db.selectFrom("booking").select(["status", "cancel_reason"]).where("id", "=", (b.result as any).booking_id).executeTakeFirstOrThrow()).cancel_reason, "court_blocked");
  const told = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "booking.cancelled").execute();
  assert.ok(told.some((e) => (e.payload as any).booking_id === (b.result as any).booking_id));
  assert.deepEqual(await freeAt("2026-12-03", "10:00"), ["Court 1", "Court 2"]);
  // Opening one date from the Today view (court.unblock) takes it out of the series the same way.
  const dec10 = (await blockOn(c3, "2026-12-10"))!;
  const u = await plan(db, "court.unblock", { block_id: dec10.id }, desk, opts);
  assert.equal(u.plan.summary.en, "Open Court 3 again on Thu, Dec 10. The block's other dates stay.");
  await run(db, "court.unblock", { block_id: dec10.id }, desk, opts);
  assert.deepEqual((await db.selectFrom("block_series").select("skip_dates").where("id", "=", dec10.series_id!).executeTakeFirstOrThrow()).skip_dates, ["2026-12-10"]);
});

test("with no end date: made a year ahead, and the job makes each new date as the year moves on", async () => {
  const r = await run(db, "court.block_repeat", { court_ids: [c1], weekdays: [0], starts: "07:00", ends: "09:00", from_date: "2026-12-06", reason: "maintenance" }, owner, opts);
  assert.match(r.plan.summary.en, /from Sun, Dec 6, with no end date \(its dates are made a year ahead, and on\): 52 dates\.$/);
  const s = await db.selectFrom("block_series").select(["made_until"]).where("id", "=", (r.result as any).series_id).executeTakeFirstOrThrow();
  assert.equal(s.made_until, "2027-11-30");
  assert.deepEqual(await extendBlockSeries(db, NOW), { dates: 0 });
  // A week later the year reaches one more Sunday.
  assert.deepEqual(await extendBlockSeries(db, new Date(NOW.getTime() + 7 * 86400_000)), { dates: 1 });
  assert.ok(await blockOn(c1, "2027-12-05"));
  assert.deepEqual(await extendBlockSeries(db, new Date(NOW.getTime() + 7 * 86400_000)), { dates: 0 });
});

test("a booking made between the preview and the confirm stays: the block leaves that court that day", async () => {
  const p = await plan(db, "court.block_repeat", { court_ids: [c2, c3], weekdays: [4], starts: "13:00", ends: "14:00", from_date: "2027-01-07", until_date: "2027-01-14", reason: "event" }, owner, opts);
  assert.match(p.plan.summary.en, /2 dates/);
  // A moment later someone books Court 2 for the first Thursday, before the staff confirm.
  const walkIn = ((await run(db, "booking.create", { court_id: c2, starts_at: at("2027-01-07", "13:00"), minutes: 60, guest_name: "Pat (walk-in)" }, owner, opts)).result as any).booking_id;
  const r = await apply(db, p.runId, owner, opts) as { series_id: string; dates: number };
  assert.equal(r.dates, 2);
  assert.equal(await blockOn(c2, "2027-01-07"), undefined);   // the booking keeps Court 2 that day
  assert.ok(await blockOn(c3, "2027-01-07")); assert.ok(await blockOn(c2, "2027-01-14"));
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", walkIn).executeTakeFirstOrThrow()).status, "confirmed");
});
