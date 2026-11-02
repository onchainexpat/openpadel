// A place in a program taken and never paid for doesn't stay taken: the member is reminded once, halfway through
// the hold, and at its end the place goes to the next person on the waitlist.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { lapseUnpaidPlaces, messageHandlers, processOutbox, run, runAsSystem, setPaymentProvider, unpaidLapseAt, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, program: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new TestProvider());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  program = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 1, price_cents: 3000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: program, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: program }, owner, opts);
  for (const n of ["Ann", "Bob"]) people[n] = ((await run(db, "person.create", { display_name: n, email: `${n.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
});
after(async () => drop());

test("the hold: a day, or 2 hours before the date if sooner, never under an hour", () => {
  const t = new Date("2026-12-01T10:00:00Z");
  assert.equal(unpaidLapseAt(t, null).toISOString(), "2026-12-02T10:00:00.000Z");
  assert.equal(unpaidLapseAt(t, new Date("2026-12-01T20:00:00Z")).toISOString(), "2026-12-01T18:00:00.000Z");
  assert.equal(unpaidLapseAt(t, new Date("2026-12-01T11:30:00Z")).toISOString(), "2026-12-01T11:00:00.000Z");
});

test("an unpaid place: reminded once halfway, then freed for the next on the waitlist", async () => {
  const ann = (await run(db, "enrolment.join", { program_id: program, person_id: people.Ann }, as("Ann"), opts)).result as any;
  assert.equal(ann.status, "booked");
  const bob = (await run(db, "enrolment.join", { program_id: program, person_id: people.Bob }, as("Bob"), opts)).result as any;
  assert.equal(bob.status, "waitlisted");
  const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);
  assert.deepEqual(await lapseUnpaidPlaces(db, at(6)), { reminded: 0, lapsed: 0 });
  assert.deepEqual(await lapseUnpaidPlaces(db, at(13)), { reminded: 1, lapsed: 0 });
  assert.deepEqual(await lapseUnpaidPlaces(db, at(14)), { reminded: 0, lapsed: 0 });   // once
  assert.deepEqual(await lapseUnpaidPlaces(db, at(24.5)), { reminded: 0, lapsed: 1 });
  assert.equal((await db.selectFrom("enrolment").select("status").where("id", "=", ann.enrolment_id).executeTakeFirstOrThrow()).status, "cancelled");
  assert.ok(await db.selectFrom("waitlist_offer").select("id").where("enrolment_id", "=", bob.enrolment_id).executeTakeFirst(), "Bob is offered the place");
  await processOutbox(db, messageHandlers);
  const kinds = (await db.selectFrom("outbound_message").select("kind").where("person_id", "=", people.Ann!).where("channel", "=", "email").execute()).map((m) => m.kind);
  assert.ok(kinds.includes("unpaid_reminder") && kinds.includes("place_lapsed"), kinds.join(", "));
});
