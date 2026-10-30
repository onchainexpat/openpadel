import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { freeCourts, openingOn, plan, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, guestDesk: Actor;
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am in Los Angeles
const DAY = "2026-12-01";                         // Tuesday
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-08:00`).toISOString();   // December: Pacific standard time
const opts = { now: NOW };
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const book = (court: string, start: string, minutes = 90, who: Record<string, string> = { guest_name: "Walk-in" }) =>
  run(db, "booking.create", { court_id: court, starts_at: at(start), minutes, ...who }, owner, opts);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  const days = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })).concat([6, 0].map((weekday) => ({ weekday, opens: "08:00", closes: "20:00" })));
  await run(db, "hours.set", { location_id: loc, days }, owner, opts);
  const desk = uuidv7();
  await db.insertInto("person").values({ id: desk, display_name: "Lee", email: "lee@example.test", created_via: "desk" }).execute();
  await run(db, "role.assign", { person_id: desk, role: "front_desk" }, owner, opts);
  guestDesk = { personId: desk, via: "test", lang: "en" };
});
after(async () => drop());

test("opening hours, said the way a club would", async () => {
  const p = await plan(db, "hours.set", { location_id: loc, days: [{ weekday: 1, opens: "07:00", closes: "22:00" }, { weekday: 2, opens: "07:00", closes: "22:00" }, { weekday: 3, opens: "07:00", closes: "22:00" }, { weekday: 6, opens: "08:00", closes: "20:00" }] }, owner, opts);
  assert.equal(p.plan.summary.en, "Set the opening hours at Eastside: Mon to Wed 07:00 to 22:00; Thu, Fri closed; Sat 08:00 to 20:00; Sun closed.");
  assert.match(p.plan.summary.es, /^Definir el horario de Eastside: lun\.? a mié\.? 07:00 a 22:00/);
  await rejects(plan(db, "hours.set", { location_id: loc, days: [{ weekday: 1, opens: "22:00", closes: "07:00" }] }, owner, opts), "error.bad_hours");
  const open = await openingOn(db, loc, DAY);
  assert.equal(open?.opens.toISOString(), "2026-12-01T15:00:00.000Z"); assert.equal(open?.closes.toISOString(), "2026-12-02T06:00:00.000Z");
});

test("special days: closed, or different hours", async () => {
  await run(db, "hours.exception_set", { location_id: loc, date: "2026-12-25", note: "Christmas" }, owner, opts);
  assert.equal(await openingOn(db, loc, "2026-12-25"), null);
  await run(db, "hours.exception_set", { location_id: loc, date: "2026-12-24", opens: "08:00", closes: "14:00" }, owner, opts);
  assert.equal((await openingOn(db, loc, "2026-12-24"))?.closes.toISOString(), "2026-12-24T22:00:00.000Z");
  assert.equal((await freeCourts(db, { locationId: loc, date: "2026-12-25", minutes: 60, now: NOW })).open, null);
});

test("free courts: every start, half-hourly, that fits before closing and around what's there", async () => {
  await book(c1, "18:00", 120);
  const f = await freeCourts(db, { locationId: loc, date: DAY, minutes: 60, now: NOW });
  const c1Starts = f.courts.find((c) => c.id === c1)!.starts.map((s) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(s)));
  assert.equal(c1Starts[0], "07:00"); assert.equal(c1Starts.at(-1), "21:00");
  assert.ok(c1Starts.includes("17:00") && !c1Starts.includes("17:30") && !c1Starts.includes("19:30") && c1Starts.includes("20:00"));
  assert.equal(f.courts.find((c) => c.id === c2)!.starts.length, 29);   // 07:00 to 21:00
});

test("a desk booking: confirmed, with a short code; and every way it can't be made", async () => {
  const r = await run(db, "booking.create", { court_id: c2, starts_at: at("09:00"), minutes: 90, guest_name: "Sam (walk-in)", price_cents: 4800 }, guestDesk, opts);
  assert.match((r.result as any).code, /^KP-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(r.plan.summary.en, "Book Court 2, Tue, Dec 1, 9:00 AM, for 90 minutes, for Sam (walk-in): $48.00.");
  const b = await db.selectFrom("booking").selectAll().where("id", "=", (r.result as any).booking_id).executeTakeFirstOrThrow();
  assert.equal(b.status, "confirmed"); assert.equal(b.source, "desk"); assert.equal(b.price_cents, 4800);
  await rejects(book(c2, "10:00"), "error.court_taken");           // overlaps 9:00 to 10:30
  await rejects(book(c2, "21:00"), "error.closed_then");           // runs past 22:00
  await rejects(book(c2, "12:00", 45), "error.bad_length");
  await rejects(run(db, "booking.create", { court_id: c2, starts_at: "2026-11-29T18:00:00Z", minutes: 60, guest_name: "Late" }, owner, opts), "error.in_the_past");
  await rejects(run(db, "booking.create", { court_id: c2, starts_at: at("12:00"), minutes: 60 }, owner, opts), "error.booking_who");
});

test("two bookings racing for one slot: exactly one gets it", async () => {
  const tries = await Promise.allSettled(Array.from({ length: 6 }, (_, k) => run(db, "booking.create", { court_id: c1, starts_at: at("12:00"), minutes: 60, guest_name: `Racer ${k}` }, owner, opts)));
  assert.equal(tries.filter((t) => t.status === "fulfilled").length, 1);
  for (const t of tries) if (t.status === "rejected") assert.equal((t.reason as KumiError).code, "error.court_taken");
});

test("a checkout hold that ran out doesn't keep the court", async () => {
  const held = uuidv7();
  await db.insertInto("booking").values({ id: held, code: "KP-HOLD", location_id: loc, status: "held", source: "app" }).execute();
  await db.insertInto("court_time").values({ id: uuidv7(), court_id: c1, during: `[${at("14:00")},${at("15:00")})`, kind: "hold", booking_id: held, hold_until: new Date(NOW.getTime() - 60_000) }).execute();
  const starts = (await freeCourts(db, { locationId: loc, date: DAY, minutes: 60, now: NOW })).courts.find((c) => c.id === c1)!.starts;
  assert.ok(starts.includes(at("14:00").replace(".000", "")) || starts.some((s) => new Date(s).getTime() === new Date(at("14:00")).getTime()));
  await book(c1, "14:00", 60);   // and the booking frees the old hold first
});

test("blocking a court; it can't cover a booking; opening it again; cancelling and undoing", async () => {
  await rejects(run(db, "court.block", { court_ids: [c2], starts_at: at("09:30"), ends_at: at("11:00"), reason: "maintenance" }, guestDesk, opts), "error.court_taken");
  const blk = await run(db, "court.block", { court_ids: [c1, c2], starts_at: at("06:00"), ends_at: at("08:00"), reason: "resurfacing", note: "Lines" }, guestDesk, opts);
  assert.equal(blk.plan.summary.en, "Block Court 1, Court 2 from Tue, Dec 1, 6:00 AM to Tue, Dec 1, 8:00 AM (resurfacing).");
  await rejects(book(c1, "07:00", 60), "error.court_taken");
  await run(db, "court.unblock", { block_id: (blk.result as any).block_id }, guestDesk, opts);
  const b = await book(c1, "07:00", 60);
  const cancel = await run(db, "booking.cancel", { booking_id: (b.result as any).booking_id, reason: "rain" }, owner, opts);
  assert.ok((await freeCourts(db, { locationId: loc, date: DAY, minutes: 60, now: NOW })).courts.find((c) => c.id === c1)!.starts.some((s) => new Date(s).getTime() === new Date(at("07:00")).getTime()));
  await run(db, "action.undo", { run_id: cancel.runId }, owner, opts);
  await rejects(book(c1, "07:00", 60), "error.court_taken");
});
