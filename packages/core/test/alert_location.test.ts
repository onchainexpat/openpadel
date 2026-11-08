// Where a staff alert is (alertLocation): a chat report is its game's location, also once the chat itself is gone
// (tidyChats deletes it 90 days after the game, and a report made late in its life is still on Today for 14 days).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { alertLocation, run, runAsSystem, uuidv7, type Actor, type Db } from "../src/index.ts";

const TZ = "America/Los_Angeles", NOW = new Date("2026-11-16T16:00:00Z");
let db: Db, drop: () => Promise<void>, owner: Actor, west: string, westCourt: string, wes: string;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner);
  west = ((await run(db, "location.create", { name: "Westside", time_zone: TZ }, owner)).result as any).location_id;
  westCourt = ((await run(db, "court.create", { location_id: west, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: west, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: west, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  wes = ((await run(db, "person.create", { display_name: "Wes", email: "wes@example.test" }, owner, { now: NOW })).result as any).person_id;
});
after(async () => drop());

test("a chat report is its game's location, before the chat is tidied away and after", async () => {
  const booking = ((await run(db, "booking.create", { court_id: westCourt, starts_at: new Date(NOW.getTime() + 30 * 3600_000).toISOString(), minutes: 90, person_id: wes }, owner, { now: NOW })).result as any).booking_id;
  const thread = uuidv7();
  await db.insertInto("chat_thread").values({ id: thread, kind: "booking", ref_id: booking, ends_at: new Date(NOW.getTime() + 90 * 864e5) } as any).execute();
  // As chat.ts emits it when a message is reported.
  const ev = (await sql<{ id: string }>`INSERT INTO event_outbox (topic, payload) VALUES ('chat.reported', ${JSON.stringify({ thread_id: thread, message_id: uuidv7(), kind: "booking", ref_id: booking, author: "Ann" })}::jsonb) RETURNING id::text AS id`.execute(db)).rows[0]!.id;
  assert.equal(await alertLocation(db, ev), west);
  await db.deleteFrom("chat_thread").where("id", "=", thread).execute();
  assert.equal(await alertLocation(db, ev), west, "the event still names the game");
});
