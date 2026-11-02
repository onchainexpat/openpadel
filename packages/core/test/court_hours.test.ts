import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { courtOpenings, dateClashes, freeCourts, plan, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, c3: string;
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am in Los Angeles
const opts = { now: NOW };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function freeAt(day: string, hhmm: string) {
  const f = await freeCourts(db, { locationId: loc, date: day, minutes: 60, now: NOW });
  return f.courts.filter((c) => c.starts.some((s) => new Date(s).getTime() === new Date(at(day, hhmm)).getTime())).map((c) => c.name);
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  c3 = ((await run(db, "court.create", { location_id: loc, name: "Court 3", kind: "outdoor" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner, opts);
});
after(async () => drop());

test("a court's own week: the days listed are its own, the rest follow the location", async () => {
  const days = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "08:00", closes: "17:00" })).concat([{ weekday: 6, opens: null as any, closes: null as any }]);
  const p = await plan(db, "court.hours_set", { court_id: c3, days }, owner, opts);
  assert.equal(p.plan.summary.en, "Set Court 3's own hours: Mon to Fri 08:00 to 17:00; Sat closed. Other days follow Eastside's hours.");
  assert.match(p.plan.summary.es, /^Definir el horario propio de Court 3: lun\.? a vie\.? 08:00 a 17:00; sáb\.? cerrado\. Los demás días sigue el horario de Eastside\.$/);
  await run(db, "court.hours_set", { court_id: c3, days }, owner, opts);
  assert.deepEqual(await freeAt("2026-12-01", "07:00"), ["Court 1", "Court 2"]);              // Tuesday: Court 3 opens at 8
  assert.deepEqual(await freeAt("2026-12-01", "16:00"), ["Court 1", "Court 2", "Court 3"]);
  assert.deepEqual(await freeAt("2026-12-01", "17:00"), ["Court 1", "Court 2"]);              // and it closes at 5
  assert.deepEqual(await freeAt("2026-12-05", "10:00"), ["Court 1", "Court 2"]);              // Saturday: closed
  assert.deepEqual(await freeAt("2026-12-06", "20:00"), ["Court 1", "Court 2", "Court 3"]);   // Sunday: the location's hours
  await rejects(run(db, "booking.create", { court_id: c3, starts_at: at("2026-12-01", "16:30"), minutes: 60, guest_name: "Walk-in" }, owner, opts), "error.closed_then");
  // Changing a day back, and leaving a court on the location's hours altogether.
  await rejects(plan(db, "court.hours_set", { court_id: c3, days: [{ weekday: 1, opens: "17:00", closes: "08:00" }] }, owner, opts), "error.bad_hours");
  const follow = await plan(db, "court.hours_set", { court_id: c2, days: [] }, owner, opts);
  assert.equal(follow.plan.summary.en, "Court 2 follows Eastside's hours every day.");
});

test("a court open outside the location's hours: its own hours count, for booking and for the day's span", async () => {
  await run(db, "court.hours_set", { court_id: c2, days: [{ weekday: 5, opens: "07:00", closes: "24:00" }] }, owner, opts);
  assert.deepEqual(await freeAt("2026-12-04", "22:30"), ["Court 2"]);
  const f = await freeCourts(db, { locationId: loc, date: "2026-12-04", minutes: 60, now: NOW });
  assert.equal(f.open?.closes.toISOString(), "2026-12-05T08:00:00.000Z");   // midnight, Court 2's closing
  assert.equal(f.courts.find((c) => c.id === c3)!.open?.closes.toISOString(), "2026-12-05T01:00:00.000Z");
  await run(db, "booking.create", { court_id: c2, starts_at: at("2026-12-04", "22:30"), minutes: 60, guest_name: "Late game" }, owner, opts);
});

test("special days: the location's apply to every court, unless a court has its own for that date", async () => {
  await run(db, "hours.exception_set", { location_id: loc, date: "2026-12-25", note: "Christmas" }, owner, opts);
  const own = await plan(db, "hours.exception_set", { location_id: loc, court_id: c3, date: "2026-12-25", opens: "10:00", closes: "14:00", note: "Christmas morning hit" }, owner, opts);
  assert.equal(own.plan.summary.en, "On 2026-12-25, Court 3 is open 10:00 to 14:00.");
  await run(db, "hours.exception_set", { location_id: loc, court_id: c3, date: "2026-12-25", opens: "10:00", closes: "14:00" }, owner, opts);
  assert.deepEqual(await freeAt("2026-12-25", "10:00"), ["Court 3"]);
  const h = await courtOpenings(db, loc, [c1, c3], "2026-12-25");
  assert.equal(h.get(c1), null); assert.equal(h.get(c3)?.opens.toISOString(), "2026-12-25T18:00:00.000Z");
  // The location's own special day is still one per date; the court's sits beside it.
  await run(db, "hours.exception_set", { location_id: loc, date: "2026-12-25", opens: "09:00", closes: "12:00" }, owner, opts);
  assert.deepEqual(await freeAt("2026-12-25", "09:00"), ["Court 1", "Court 2"]);
});

test("a program date on a court that's closed then is a warning, not a block", async () => {
  const slots = [{ start: new Date(at("2026-12-01", "18:00")), end: new Date(at("2026-12-01", "19:30")), courtIds: [c1, c3], coachId: null }];
  const clashes = await dateClashes(db, { programId: uuidv7(), locationId: loc, levelMin: null, levelMax: null, slots, skipSessions: [], now: NOW, tz: TZ });
  assert.deepEqual(clashes.map((c) => [c.kind, c.blocks, c.text.en]), [["court_closed", false, "Court 3 is closed at Tue, Dec 1, 6:00 PM (a warning: it can still go ahead)."]]);
});

test("new hours that leave a booking outside them: the plan names it, and it stays booked", async () => {
  const b = (await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-03", "19:00"), minutes: 60, guest_name: "Evening game" }, owner, opts)).result as any;
  const code = (await db.selectFrom("booking").select("code").where("id", "=", b.booking_id).executeTakeFirstOrThrow()).code;
  const days = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "18:00" }));
  const p = await plan(db, "court.hours_set", { court_id: c1, days }, owner, opts);
  assert.equal(p.plan.summary.en, `Set Court 1's own hours: Mon to Fri 07:00 to 18:00. Other days follow Eastside's hours. Already on the court and outside these hours: ${code} Thu, Dec 3, 7:00 PM. They stay as they are; move or cancel them on the courts day if they shouldn't.`);
  assert.match(p.plan.summary.es, /Ya en la cancha y fuera de este horario: KP-/);
  const fine = await plan(db, "court.hours_set", { court_id: c1, days: [{ weekday: 4, opens: "07:00", closes: "22:00" }] }, owner, opts);
  assert.ok(!fine.plan.summary.en.includes("outside"), fine.plan.summary.en);
  await run(db, "court.hours_set", { court_id: c1, days }, owner, opts);
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", b.booking_id).executeTakeFirstOrThrow()).status, "confirmed");
});
