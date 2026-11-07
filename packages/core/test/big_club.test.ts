// What a big club (two years, 90,000 court bookings) needed, and that each way of reading faster reads the same:
// the indexes of 097 are there as named (a name already taken is skipped by IF NOT EXISTS without a word), the desk's
// index still matches the desk's money, a court's hours read for many days are the hours of each day, the outbox still
// sends the oldest event first with events nothing handles in front of it, a chat list's titles are gameOf's, and the
// clock reads the same with its formatter kept.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { courtOpenings, courtOpeningsOn, DESK_MONEY, gameHeads, gameOf, localParts, onDate, postChat, processOutbox, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, ann: string;
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-26T16:00:00Z");   // Mon 26 Oct, 9 am in Los Angeles; clocks go back on Sun 1 Nov
const opts = { now: NOW };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2", kind: "outdoor" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })).concat([{ weekday: 6, opens: "08:00", closes: "20:00" }, { weekday: 0, opens: null, closes: null }] as any) }, owner, opts);
  await run(db, "court.hours_set", { court_id: c2, days: [{ weekday: 2, opens: "09:00", closes: "17:00" }, { weekday: 6, opens: null, closes: null }] }, owner, opts);
  await run(db, "hours.exception_set", { location_id: loc, date: "2026-10-28", note: "Staff day" }, owner, opts);
  await run(db, "hours.exception_set", { location_id: loc, date: "2026-10-29", opens: "10:00", closes: "14:00", court_id: c1 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true, players_chat: true }, owner, opts);
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner, opts)).result as { person_id: string }).person_id;
});
after(async () => drop());

test("097's indexes are there under their own names, and the desk's matches DESK_MONEY", async () => {
  const defs = new Map((await sql<{ indexname: string; indexdef: string }>`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`.execute(db)).rows.map((r) => [r.indexname, r.indexdef]));
  const want: Record<string, RegExp> = {
    ledger_entry_txn: /ON public\.ledger_entry USING btree \(txn_id\)$/, ledger_txn_at: /ON public\.ledger_txn USING btree \(at\)$/,
    booking_organiser: /ON public\.booking USING btree \(organiser_id\) WHERE \(organiser_id IS NOT NULL\)$/,
    event_outbox_waiting_topic: /ON public\.event_outbox USING btree \(topic, id\) WHERE \(\(delivered_at IS NULL\) AND \(held_at IS NULL\)\)$/,
    refund_payment: /ON public\.refund USING btree \(payment_id\)$/, payment_enrolment: /ON public\.payment USING btree \(enrolment_id\) WHERE \(enrolment_id IS NOT NULL\)$/,
    payment_ref_lookup: /ON public\.payment USING btree \(provider_ref\) WHERE \(provider_ref IS NOT NULL\)$/,
    refund_provider_ref: /ON public\.refund USING btree \(provider_ref\) WHERE \(provider_ref IS NOT NULL\)$/, receipt_paid_at: /ON public\.receipt USING btree \(paid_at\)$/,
  };
  for (const [name, def] of Object.entries(want)) assert.match(defs.get(name) ?? "(missing)", def, name);
  const desk = defs.get("action_run_desk_money") ?? "";
  assert.match(desk, /ON public\.action_run USING btree \(applied_at\) WHERE/);
  assert.deepEqual([...desk.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]).sort(), [...DESK_MONEY].sort(), "a change that takes money at the desk is in the index the desk's day reads");
  assert.equal(defs.has("action_run_desk"), false, "076's five-action index is gone");
});

test("a court's hours read for many days are each day's own: special days, a court's own week, closed days, the clock change", async () => {
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 9, 25 + i, 12)).toISOString().slice(0, 10));   // 25 Oct to 7 Nov
  const many = await courtOpeningsOn(db, loc, [c1, c2], days);
  assert.equal(many.size, days.length);
  for (const day of days) assert.deepEqual(many.get(day), await courtOpenings(db, loc, [c1, c2], day), day);
  // And what they say, so the two can't be wrong together.
  const on = (day: string, id: string) => many.get(day)!.get(id);
  assert.equal(on("2026-10-25", c1), null, "Sunday: the location is closed");
  assert.deepEqual(on("2026-10-27", c2), { opens: onDate("2026-10-27", "09:00", TZ), closes: onDate("2026-10-27", "17:00", TZ) }, "Court 2's own Tuesday");
  assert.deepEqual(on("2026-10-27", c1), { opens: onDate("2026-10-27", "07:00", TZ), closes: onDate("2026-10-27", "22:00", TZ) });
  assert.equal(on("2026-10-28", c1), null, "a special day for the location closes every court");
  assert.equal(on("2026-10-28", c2), null);
  assert.deepEqual(on("2026-10-29", c1), { opens: onDate("2026-10-29", "10:00", TZ), closes: onDate("2026-10-29", "14:00", TZ) }, "Court 1's own special day");
  assert.deepEqual(on("2026-10-29", c2), { opens: onDate("2026-10-29", "07:00", TZ), closes: onDate("2026-10-29", "22:00", TZ) }, "the other court keeps the location's");
  assert.equal(on("2026-10-31", c2), null, "Court 2 is closed on its own Saturdays");
  assert.equal(on("2026-11-02", c1)!.opens.toISOString(), "2026-11-02T15:00:00.000Z", "after the clock change, 7 am is 15:00 UTC");
  assert.equal(on("2026-10-30", c1)!.opens.toISOString(), "2026-10-30T14:00:00.000Z", "before it, 14:00 UTC");
  assert.equal((await courtOpeningsOn(db, loc, [c1], [])).size, 0);
});

test("the outbox sends the oldest event of the topics it handles first, with events nothing handles in front of and between them", async () => {
  const add = (topic: string) => db.insertInto("event_outbox").values({ topic, payload: JSON.stringify({ topic }) } as any).returning("id").executeTakeFirstOrThrow();
  for (let i = 0; i < 30; i++) await add("nobody.handles_this");
  const first = await add("test.b");
  for (let i = 0; i < 10; i++) await add("nobody.handles_this");
  const second = await add("test.a"), third = await add("test.b");
  const seen: string[] = [];
  const handler = async (_db: Db, p: unknown) => { seen.push((p as { topic: string }).topic); };
  const r = await processOutbox(db, { "test.a": handler, "test.b": handler }, 100, NOW);
  assert.deepEqual(r, { delivered: 3, failed: 0 });
  assert.deepEqual(seen, ["test.b", "test.a", "test.b"], "oldest first, across topics");
  const left = await db.selectFrom("event_outbox").select(["id", "topic", "delivered_at"]).where("id", "in", [first.id, second.id, third.id]).execute();
  assert.ok(left.every((e) => e.delivered_at));
  assert.equal((await db.selectFrom("event_outbox").select(sql<string>`count(*)`.as("n")).where("topic", "=", "nobody.handles_this").where("delivered_at", "is", null).executeTakeFirstOrThrow()).n, "40", "what nothing handles stays as it was");
});

test("a chat list's titles and times are gameOf's: a booking moved to another court, a cancelled one, a program date, one that's gone", async () => {
  const at = (day: string, hhmm: string) => onDate(day, hhmm, TZ).toISOString();
  const moved = ((await run(db, "booking.create", { court_id: c1, starts_at: at("2026-10-30", "10:00"), minutes: 60, person_id: ann }, owner, opts)).result as any).booking_id;
  await run(db, "booking.move", { booking_id: moved, court_id: c2, starts_at: at("2026-10-30", "12:00") }, owner, opts);
  const gone = ((await run(db, "booking.create", { court_id: c1, starts_at: at("2026-10-30", "15:00"), minutes: 60, person_id: ann }, owner, opts)).result as any).booking_id;
  await run(db, "booking.cancel", { booking_id: gone, refund: "none" }, owner, opts);
  const program = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Tuesday clinic", capacity: 8, price_cents: 3000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: program, starts_at: at("2026-11-03", "18:00"), ends_at: at("2026-11-03", "19:30"), court_ids: [c1] }, owner, opts);
  const session = (await db.selectFrom("session").select("id").where("program_id", "=", program).executeTakeFirstOrThrow()).id;
  await postChat(db, ann, "booking", moved, "See you there", NOW);
  const chats = [{ kind: "booking", ref_id: moved }, { kind: "booking", ref_id: gone }, { kind: "session", ref_id: session }, { kind: "booking", ref_id: "00000000-0000-7000-8000-000000000999" }];
  const heads = await gameHeads(db, chats);
  for (const c of chats) {
    const g = await gameOf(db, c.kind as "booking" | "session", c.ref_id);
    assert.deepEqual(heads.get(`${c.kind}:${c.ref_id}`), g ? { title: g.title, starts_at: g.starts_at } : undefined, `${c.kind} ${c.ref_id}`);
  }
  assert.deepEqual(heads.get(`booking:${moved}`), { title: "Court 2", starts_at: new Date(at("2026-10-30", "12:00")) }, "where it is now, not where it was");
  assert.equal(heads.get(`booking:${gone}`)?.title, "Court 1", "a cancelled booking keeps its court and time");
  assert.equal(heads.get(`session:${session}`)?.title, "Tuesday clinic");
});

test("the clock reads the same with its formatter kept, in every zone, and a zone that isn't one is still refused", () => {
  for (const tz of ["America/Los_Angeles", "Europe/Madrid", "Asia/Kolkata", "Pacific/Chatham", "America/Santiago"]) {
    for (let i = 0; i < 50; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 7.3 * 86400_000 + i * 3_600_000);
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
        .formatToParts(d).map((x) => [x.type, x.type === "weekday" ? x.value : Number(x.value)]));
      assert.deepEqual(localParts(d, tz), { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday as string) }, `${tz} ${d.toISOString()}`);
    }
  }
  for (let i = 0; i < 2; i++) assert.throws(() => localParts(new Date(), "Not/AZone"), RangeError);
});
