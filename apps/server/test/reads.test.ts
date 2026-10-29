import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, programId: string, sessionId: string, players: string[] = [];
const mailer = new MemoryMailer();
const as = (id: string): Actor => ({ personId: id, via: "test", lang: "en" });
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const get = async (path: string, cookie: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, json: await r.json() as any }; };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const courts = [];
  for (const name of ["Court 1", "Court 2"]) courts.push(((await run(db, "court.create", { location_id: loc, name }, owner)).result as any).court_id);
  programId = ((await run(db, "program.create", { location_id: loc, kind: "social", format: "americano", name: "Friday Americano", capacity: 8, price_cents: 2500, rated: true }, owner)).result as any).program_id;
  sessionId = ((await run(db, "session.add", { program_id: programId, starts_at: new Date(Date.now() + 864e5).toISOString(), ends_at: new Date(Date.now() + 864e5 + 7200_000).toISOString(), court_ids: courts }, owner)).result as any).session_id;
  await run(db, "program.publish", { program_id: programId }, owner);
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  for (let i = 0; i < 9; i++) {
    const id = uuidv7();
    await db.insertInto("person").values({ id, display_name: `P${i}`, email: `p${i}@example.test`, locale: i === 0 ? "es" : "en", created_via: "desk" }).execute();
    await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: member.id, location_id: null }).execute();
    const j = (await run(db, "enrolment.join", { program_id: programId, person_id: id }, as(id))).result as any;
    if (j.payment_id) await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "webhook");
    players.push(id);
  }
  await run(db, "draw.generate", { session_id: sessionId, rounds: 2 }, owner);
  const first = await db.selectFrom("game").select("id").where("session_id", "=", sessionId).where("round", "=", 1).execute();
  for (const g of first) await run(db, "game.score", { game_id: g.id, a: 14, b: 10 }, owner);
});
after(async () => drop());

test("staff see programs with places taken and the waitlist", async () => {
  const cookie = await signIn("robin@example.test");
  const r = await get("/staff/programs", cookie);
  assert.equal(r.status, 200);
  const p = r.json.find((x: any) => x.id === programId);
  assert.equal(p.booked, 8); assert.equal(p.waitlisted, 1);
});

test("a program's page: its date, its courts, and the roster with what each person paid", async () => {
  const cookie = await signIn("robin@example.test");
  const r = (await get(`/staff/programs/${programId}`, cookie)).json;
  assert.deepEqual(r.sessions[0].courts.sort(), ["Court 1", "Court 2"]); assert.equal(r.sessions[0].has_draw, true);
  const booked = r.roster.filter((x: any) => x.status === "booked");
  assert.equal(booked.length, 8); assert.ok(booked.every((x: any) => x.paid_cents === 2500));
  assert.equal(r.roster.find((x: any) => x.status === "waitlisted").paid_cents, 0);
});

test("the night: rounds by court, odds capped at 80/20, scores and standings", async () => {
  const cookie = await signIn("robin@example.test");
  const r = (await get(`/staff/sessions/${sessionId}/night`, cookie)).json;
  assert.equal(r.rounds.length, 2); assert.equal(r.rounds[0].games.length, 2);
  for (const round of r.rounds) for (const g of round.games) assert.ok(g.odds_a >= 20 && g.odds_a <= 80);
  assert.deepEqual(r.rounds[0].games[0].score, { a: 14, b: 10 });
  assert.equal(r.standings[0].points, 14); assert.equal(r.standings.length, 8);
});

test("a player's level, with why it moved, in the reader's language", async () => {
  const cookie = await signIn("robin@example.test");
  const played = (await get(`/staff/sessions/${sessionId}/night`, cookie)).json.rounds[0].games[0].a[0];
  const who = await db.selectFrom("person").select("id").where("display_name", "=", played).executeTakeFirstOrThrow();
  const r = (await get(`/staff/people/${who.id}/level`, cookie)).json;
  assert.equal(r.rating.rated_games, 1);
  assert.match(r.events[0].explanation, /^Won 14 to 10 with /);
});

test("members can't read staff pages", async () => {
  const cookie = await signIn("p1@example.test");
  const r = await get("/staff/programs", cookie);
  assert.equal(r.status, 403); assert.equal(r.json.error, "error.staff_only");
});

test("staff see the Playtomic mirror: courts to link and bookings that clash", async () => {
  const cookie = await signIn("robin@example.test");
  let r = await get("/staff/mirror", cookie);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, null);   // not connected yet
  const courts = await db.selectFrom("court").select(["id", "name"]).orderBy("name").execute();
  await db.insertInto("connector_status").values({ system: "playtomic", last_sync_at: new Date(), last_ok_at: new Date(), last_error: null, fetched: 3, unmapped: JSON.stringify([{ courtRef: "pt-2", courtName: "Padel 2", bookings: 2 }]) }).execute();
  await run(db, "connector.map_court", { resource_id: "pt-1", resource_name: "Padel 1", court_id: courts[0]!.id }, owner);
  // A player's Playtomic booking on top of Friday's Americano.
  const ct = await db.selectFrom("court_time").select(["id", "court_id"]).where("session_id", "=", sessionId).where("court_id", "=", courts[0]!.id).executeTakeFirstOrThrow();
  const s = new Date(Date.now() + 864e5 + 1800_000), e = new Date(s.getTime() + 5400_000);
  await db.insertInto("mirror_booking").values({ ref: "b9:pt-1", court_id: ct.court_id, during: `[${s.toISOString()},${e.toISOString()})`, booking_type: "OPEN_MATCH", status: "conflict", clash_id: ct.id, court_time_id: null }).execute();
  r = await get("/staff/mirror", cookie);
  assert.equal(r.json.status.failed, false);
  assert.deepEqual(r.json.unmapped, [{ courtRef: "pt-2", courtName: "Padel 2", bookings: 2 }]);
  assert.deepEqual(r.json.linked.map((l: any) => [l.resource_id, l.court]), [["pt-1", "Court 1"]]);
  assert.equal(r.json.conflicts.length, 1);
  assert.equal(r.json.conflicts[0].kind, "Open match");
  assert.equal(r.json.conflicts[0].event, "Friday Americano");
  assert.equal(r.json.conflicts[0].session_id, sessionId);
  const member = await signIn("p1@example.test");
  assert.equal((await get("/staff/mirror", member)).status, 403);
});
