// A booking moved, then cancelled: everything that says when it was says the time it was moved to, never the old one.
// A move retires the old court time and takes a new one; a cancel retires that too, so "the active one" is gone and
// the newest one is where it was.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { messageHandlers, processOutbox, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { sql } from "kysely";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, c1: string, c3: string;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const TZ = "America/Los_Angeles";
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[name] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
// Ten days ahead, so the hours and the booking window are not in the way; the times are the club's.
const day = new Date(Date.now() + 10 * 86400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const at = (hhmm: string) => { const d = new Date(`${day}T${hhmm}:00Z`), off = new Date(d.toLocaleString("en-US", { timeZone: TZ })).getTime() - new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime(); return new Date(d.getTime() - off).toISOString(); };
const told = async (who: string, kind: string) => { await processOutbox(db, messageHandlers); return db.selectFrom("outbound_message").select(["subject", "body", "status"]).where("person_id", "=", people[who]!).where("kind", "=", kind).orderBy("id").execute(); };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c3 = ((await run(db, "court.create", { location_id: loc, name: "Court 3" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  for (const [name, role] of [["Di", null], ["Dana", "front_desk"], ["Cora", "coach"]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) await run(db, "role.assign", { person_id: people[name], role }, owner);
    await signIn(name);
  }
});
after(async () => drop());

test("moved, then cancelled: the message, My places, the match page and the person page say the new time", async () => {
  const b = ((await run(db, "booking.create", { court_id: c1, starts_at: at("09:00"), minutes: 60, person_id: people.Di }, owner)).result as any).booking_id;
  await run(db, "booking.move", { booking_id: b, court_id: c3, starts_at: at("13:00") }, owner);
  const [moved] = await told("Di", "booking_moved");
  assert.match(moved!.subject, /^Moved: Court 3, .*1:00\s?PM$/);
  // Moved, still on: one place in My places, at its new time.
  const mine = (await get("/my/bookings", "Di")).json.filter((r: any) => r.id === b);
  assert.equal(mine.length, 1, "a moved booking is one place, not one per time it has had");
  assert.equal(new Date(mine[0].start).toISOString(), at("13:00"));
  await run(db, "booking.cancel", { booking_id: b }, owner);
  const [cancelled] = (await told("Di", "booking_cancelled")).filter((m) => m.status === "sent");
  assert.ok(cancelled, "Di is told");
  assert.match(cancelled!.subject + cancelled!.body, /Court 3/);
  assert.match(cancelled!.subject + cancelled!.body, /1:00\s?PM/);
  assert.doesNotMatch(cancelled!.subject + cancelled!.body, /9:00\s?AM|Court 1/);
  const m = (await get(`/matches/${b}`, "Di")).json;
  assert.equal(new Date(m.start).toISOString(), at("13:00"));
  assert.equal(m.court, "Court 3");
  const person = (await get(`/staff/people/${people.Di}`, "Dana")).json;
  const row = person.bookings.find((r: any) => r.id === b);
  assert.equal(new Date(row.starts_at).toISOString(), at("13:00"));
  assert.equal(row.court, "Court 3");
});

test("a move's news not sent yet when the booking is called off doesn't go; one not written yet isn't written", async () => {
  const kinds = async (id: string) => (await db.selectFrom("outbound_message").innerJoin("event_outbox", "event_outbox.id", "outbound_message.event_id")
    .select(["outbound_message.kind", "outbound_message.channel", "outbound_message.status", "outbound_message.failure"])
    .where(sql<string>`event_outbox.payload->>'booking_id'`, "=", id).where("outbound_message.person_id", "=", people.Di!).execute())
    .map((m) => `${m.kind} ${m.channel} ${m.status}${m.failure ? ` (${m.failure})` : ""}`).sort();
  // Moved and told in the app; the email of it is still waiting (the email service was down, say) when it's cancelled.
  const b = ((await run(db, "booking.create", { court_id: c1, starts_at: at("08:00"), minutes: 60, person_id: people.Di }, owner)).result as any).booking_id;
  await run(db, "booking.move", { booking_id: b, court_id: c3, starts_at: at("10:00") }, owner);
  await processOutbox(db, messageHandlers);
  await run(db, "booking.cancel", { booking_id: b }, owner);
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await kinds(b), ["booking_cancelled email waiting", "booking_cancelled inbox sent", "booking_moved email dropped (the booking was cancelled before it went)", "booking_moved inbox sent"]);
  // Moved and cancelled before the move's news was written at all: only the cancellation, at the time it had last.
  const b2 = ((await run(db, "booking.create", { court_id: c1, starts_at: at("15:00"), minutes: 60, person_id: people.Di }, owner)).result as any).booking_id;
  await run(db, "booking.move", { booking_id: b2, court_id: c3, starts_at: at("17:00") }, owner);
  await run(db, "booking.cancel", { booking_id: b2 }, owner);
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await kinds(b2), ["booking_cancelled email waiting", "booking_cancelled inbox sent"]);
  const last = await db.selectFrom("outbound_message").innerJoin("event_outbox", "event_outbox.id", "outbound_message.event_id").select("outbound_message.subject")
    .where(sql<string>`event_outbox.payload->>'booking_id'`, "=", b2).where("outbound_message.channel", "=", "inbox").executeTakeFirstOrThrow();
  assert.match(last.subject, /^Cancelled: Court 3, .*5:00\s?PM$/);
});
