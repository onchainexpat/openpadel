import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { apply, messageHandlers, plan, processOutbox, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, c1: string, c2: string, c3: string, out: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const DAY = "2026-12-01";                                                    // Tuesday
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const opts = { now: NOW };
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const plain = (s: string) => s.replace(/\b[A-Z]{2}-[A-Z0-9]{4}\b/g, "KP-0000");
const courtOf = async (bookingId: string) => (await db.selectFrom("court_time").select("court_id").where("booking_id", "=", bookingId).where("active", "=", true).executeTakeFirstOrThrow()).court_id;
const book = async (court: string, start: string, who: string, minutes = 60) =>
  ((await run(db, "booking.create", { court_id: court, starts_at: at(start), minutes, person_id: people[who]! }, owner, opts)).result as any).booking_id as string;
const blockTimes = (blockId: string) => db.selectFrom("court_time").select(["court_id", sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")])
  .where("block_id", "=", blockId).where("active", "=", true).orderBy(sql`lower(during)`).execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  c3 = ((await run(db, "court.create", { location_id: loc, name: "Court 3" }, owner)).result as any).court_id;
  out = ((await run(db, "court.create", { location_id: loc, name: "Outdoor 1", kind: "outdoor" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  for (const name of ["Ann", "Ben", "Cat", "Dan", "Lee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
});
after(async () => drop());

test("blocking a court with bookings on it: each moves to a free court like it, same time; one with nowhere to go stays and the block leaves its time", async () => {
  const ann = await book(c1, "18:00", "Ann"), ben = await book(c1, "20:00", "Ben");
  // At 20:00 the other indoor courts are taken; the outdoor court is free but isn't like it.
  await book(c2, "20:00", "Cat"); await book(c3, "19:30", "Dan", 90);
  const input = { court_ids: [c1], starts_at: at("17:00"), ends_at: at("23:00"), reason: "fault", note: "The light is out", move_bookings: true };
  // Without moving them, a court with bookings can't be blocked, as before.
  await rejects(plan(db, "court.block", { ...input, move_bookings: undefined }, desk, opts), "error.court_taken");
  const p = await plan(db, "court.block", input, desk, opts);
  assert.equal(plain(p.plan.summary.en), "Block Court 1 from Tue, Dec 1, 5:00 PM to Tue, Dec 1, 11:00 PM (something broken)."
    + " KP-0000 (Ann) at 6:00 PM moves from Court 1 to Court 2, same time."
    + " KP-0000 (Ben) at 8:00 PM stays on Court 1: no other court like it is free then, so the block leaves that time free."
    + " Court 2 is free at 9:00 PM if they'd take another time."
    + " From the booking, move it or cancel it; what goes back is your choice there, by the club's rule unless you change it."
    + " 1 player is told about the new court. No money moves: every booking keeps its price.");
  assert.deepEqual(p.plan.rows!.map((r) => r.label.en), ["Block", "Moves", "Stays", "Messages", "Money"]);
  assert.match(p.plan.summary.es, /pasa de Court 1 a Court 2, a la misma hora/);
  assert.equal(p.plan.undo.kind, "compensating");
  const r = await run(db, "court.block", input, desk, opts);
  assert.equal(await courtOf(ann), c2);
  assert.equal(await courtOf(ben), c1);
  // The block: 17:00 to 20:00 and 21:00 to 23:00 on Court 1, around Ben's booking.
  const times = await blockTimes((r.result as any).block_id);
  assert.deepEqual(times.map((x) => [new Date(x.start).toISOString(), new Date(x.end).toISOString()]),
    [[at("17:00"), at("20:00")], [at("21:00"), at("23:00")]].map((x) => x.map((y) => new Date(y).toISOString())));
  // Ann hears where her booking is now; nothing about money. Ben hears nothing yet: staff decide.
  await processOutbox(db, messageHandlers);
  const msgs = await db.selectFrom("outbound_message").select(["person_id", "body"]).where("kind", "=", "booking_moved").where("channel", "=", "inbox").execute();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.person_id, people.Ann);
  assert.equal(plain(msgs[0]!.body).trim(), "The club moved booking KP-0000 from Court 1, Tue, Dec 1, 6:00 PM to Court 2, Tue, Dec 1, 6:00 PM.");
  // Undone: the court opens and Ann's booking goes back, as the undo's preview says.
  const u = await plan(db, "action.undo", { run_id: r.runId }, owner, opts);
  assert.equal(u.plan.summary.en, "Open the courts again, and put the moved booking back where it was. Its players aren't told again.");
  await run(db, "action.undo", { run_id: r.runId }, owner, opts);
  assert.equal(await courtOf(ann), c1);
  assert.equal((await blockTimes((r.result as any).block_id)).length, 0);
});

test("a block's preview is done again if something was booked in its way before the yes", async () => {
  const input = { court_ids: [c1], starts_at: at("07:00", "2026-12-02"), ends_at: at("12:00", "2026-12-02"), reason: "maintenance", move_bookings: true };
  const p = await plan(db, "court.block", input, desk, opts);
  assert.equal(p.plan.rows, undefined);   // nothing in the way: the one sentence
  assert.equal(p.plan.undo.kind, "reversible");
  await run(db, "booking.create", { court_id: c1, starts_at: at("10:00", "2026-12-02"), minutes: 60, person_id: people.Dan! }, owner, opts);
  await rejects(apply(db, p.runId, desk, opts), "error.changed");
});

test("checking in a booking's players, some or all, and taking it back", async () => {
  const id = ((await run(db, "booking.create", { court_id: c3, starts_at: at("09:00"), minutes: 90, places: [{ person_id: people.Ann! }, { person_id: people.Ben! }, { guest_name: "Jo" }] }, owner, opts)).result as any).booking_id as string;
  const early = new Date(new Date(at("09:00")).getTime() - 3 * 3600_000);
  await rejects(plan(db, "booking.check_in", { booking_id: id }, desk, { now: early }), "error.check_in_window");
  const now = { now: new Date(new Date(at("09:00")).getTime() - 10 * 60_000) };
  const seats = await db.selectFrom("booking_player").select(["id", "person_id"]).where("booking_id", "=", id).orderBy("id").execute();
  const annSeat = seats.find((x) => x.person_id === people.Ann)!.id;
  const r = await run(db, "booking.check_in", { booking_id: id, booking_player_ids: [annSeat] }, desk, now);
  assert.equal(plain(r.plan.summary.en), "Check in Ann for Court 3 at 9:00 AM (KP-0000). Nobody is told, and no money moves.");
  const row = await db.selectFrom("booking_player").select(["checked_in_at", "checked_in_by"]).where("id", "=", annSeat).executeTakeFirstOrThrow();
  assert.ok(row.checked_in_at); assert.equal(row.checked_in_by, people.Lee);
  await rejects(plan(db, "booking.check_in", { booking_id: id, booking_player_ids: [annSeat] }, desk, now), "error.already_checked_in");
  await rejects(plan(db, "booking.check_in", { booking_id: id }, as("Ann"), now), "error.forbidden_reason");
  const back = await run(db, "booking.check_in", { booking_id: id, checked_in: false }, desk, now);
  assert.equal(plain(back.plan.summary.en), "Take back the check-in of Ann for Court 3 at 9:00 AM (KP-0000). Nobody is told, and no money moves.");
  await rejects(plan(db, "booking.check_in", { booking_id: id, checked_in: false }, desk, now), "error.not_checked_in");
  const all = await run(db, "booking.check_in", { booking_id: id }, desk, now);
  assert.match(plain(all.plan.summary.en), /^Check in all 3 players for Court 3 at 9:00 AM \(KP-0000\): .+\. Nobody is told, and no money moves\.$/);
  for (const n of ["Ann", "Ben", "Jo (guest)"]) assert.ok(all.plan.summary.en.includes(n));
  assert.ok(all.plan.summary.es.includes("Jo (visita)"));
  assert.equal((await db.selectFrom("booking_player").select("id").where("booking_id", "=", id).where("checked_in_at", "is not", null).execute()).length, seats.length);
  await run(db, "action.undo", { run_id: all.runId }, owner, now);
  assert.equal((await db.selectFrom("booking_player").select("id").where("booking_id", "=", id).where("checked_in_at", "is not", null).execute()).length, 0);
});
