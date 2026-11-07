import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { durationMs, farSlice, mirrorHorizon, normalize, plan, run, runAsSystem, syncMirror, syncMirrorFar, uuidv7, KumiError, PlaytomicClient, PLAYTOMIC_TYPES, FAR_MAX_DAYS, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, member: Actor, locationId: string, court1: string, court2: string, programId: string;
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
const H = 3600_000, base = Math.ceil(Date.now() / H) * H;
const at = (h: number) => new Date(base + h * H);
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

/** A Playtomic booking as the Third Party API returns it: naive UTC start, duration in milliseconds. */
function booking(id: string, h: number, o: { court?: string; type?: string; minutes?: number; cancelled?: boolean } = {}) {
  const court = o.court ?? "pt-1";
  return { booking_id: id, booking_type: o.type ?? "REGULAR_BOOKING", booking_start_date: at(h).toISOString().slice(0, 19), duration: (o.minutes ?? 90) * 60_000,
    resource_id: court, resource_name: `Padel ${court.slice(-1)}`, is_canceled: o.cancelled ?? false, payment_status: "PAID", participant_info: { owner_id: "u-1" } };
}

/** Stands in for thirdparty.playtomic.io: a token, then bookings filtered by start and paged. */
class FakePlaytomic {
  bookings: ReturnType<typeof booking>[] = [];
  tokenCalls = 0; pageCalls = 0; pageTimes: number[] = []; windows: [string, string][] = [];
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/oauth/token") {
      this.tokenCalls++;
      return JSON.parse(String(init?.body)).secret === "s3cret" ? Response.json({ token: "tok", expires_in: 3600 }) : new Response("no", { status: 401 });
    }
    if (u.pathname === "/api/v1/bookings") {
      this.pageCalls++; this.pageTimes.push(Date.now());
      this.windows.push([u.searchParams.get("start_booking_date")!, u.searchParams.get("end_booking_date")!]);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer tok");
      assert.equal(u.searchParams.get("tenant_id"), "tenant-1");
      const from = Date.parse(`${u.searchParams.get("start_booking_date")}Z`), to = Date.parse(`${u.searchParams.get("end_booking_date")}Z`);
      const size = Number(u.searchParams.get("size")), page = Number(u.searchParams.get("page"));
      const hits = this.bookings.filter((b) => { const t = Date.parse(`${b.booking_start_date}Z`); return t >= from && t < to; });
      return Response.json(hits.slice(page * size, (page + 1) * size));
    }
    return new Response("not found", { status: 404 });
  };
}
const pt = new FakePlaytomic();
const client = (secret = "s3cret") => new PlaytomicClient({ clientId: "kumi", secret, tenantId: "tenant-1", fetch: pt.fetch, pageDelayMs: 0 });
const sync = () => syncMirror(db, client(), { now: new Date(base) });
const mirrorRuns = async () => Number((await db.selectFrom("action_run").select((eb) => eb.fn.countAll<string>().as("n")).where("action", "=", "mirror.apply").executeTakeFirstOrThrow()).n);
const mb = (ref: string) => db.selectFrom("mirror_booking").selectAll().where("ref", "=", ref).executeTakeFirstOrThrow();
const active = async (id: string | null) => id ? (await db.selectFrom("court_time").select("active").where("id", "=", id).executeTakeFirstOrThrow()).active : null;
const addSession = (h: number, hours: number, court = court1) =>
  run(db, "session.add", { program_id: programId, starts_at: at(h).toISOString(), ends_at: at(h + hours).toISOString(), court_ids: [court] }, owner);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  const m = uuidv7();
  await db.insertInto("person").values({ id: m, display_name: "Sam", email: "sam@example.test", created_via: "desk" }).execute();
  const role = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: m, role_id: role.id, location_id: null }).execute();
  member = as(m);
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
  court1 = ((await run(db, "court.create", { location_id: locationId, name: "Court 1" }, owner)).result as { court_id: string }).court_id;
  court2 = ((await run(db, "court.create", { location_id: locationId, name: "Court 2" }, owner)).result as { court_id: string }).court_id;
  programId = ((await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name: "Friday Americano", capacity: 8, price_cents: 2500 }, owner)).result as { program_id: string }).program_id;
});
after(async () => drop());

test("durations arrive in milliseconds, seconds or minutes, and times without a zone are UTC", () => {
  for (const d of [5_400_000, 5_400, 90]) assert.equal(durationMs(d), 5_400_000);
  assert.equal(durationMs(0), null);
  assert.equal(durationMs("soon"), null);
  const b = normalize({ booking_id: "b", resource_id: "r", booking_start_date: "2026-11-06T18:00:00", duration: 90 })!;
  assert.equal(b.start.toISOString(), "2026-11-06T18:00:00.000Z");
  assert.equal(b.end.toISOString(), "2026-11-06T19:30:00.000Z");
  assert.equal(b.ref, "b:r");
  assert.equal(normalize({ booking_id: "b", resource_id: "r", booking_start_date: "2026-11-06T18:00:00-08:00", duration: 60 })!.start.toISOString(), "2026-11-07T02:00:00.000Z");
  assert.equal(normalize({ booking_id: "b", resource_id: "r", resource_name: "Padel 4 ", booking_start_date: "2026-11-06T18:00:00", duration: 60 })!.courtName, "Padel 4");
  assert.equal(normalize({ booking_id: "b", booking_start_date: "2026-11-06T18:00:00", duration: 60 }), null);   // no court
  assert.equal(normalize({ booking_id: "b", resource_id: "r", booking_start_date: "not a date", duration: 60 }), null);
});

test("the client pages until a short page, keeps its token, and fails loudly on a bad secret", async () => {
  pt.bookings = [1, 2, 3, 4, 5].map((n) => booking(`p${n}`, 200 + n));
  pt.tokenCalls = 0; pt.pageCalls = 0;
  const c = client();
  assert.equal((await c.bookings(at(0), at(400), 2)).length, 5);
  assert.equal(pt.pageCalls, 3);
  await c.bookings(at(0), at(400), 2);
  assert.equal(pt.tokenCalls, 1);
  await assert.rejects(client("wrong").bookings(at(0), at(400)), /auth failed: 401/);
  pt.bookings = [];
});

test("bookings on an unlinked court are listed, not copied; once linked they hold the court", async () => {
  pt.bookings = [booking("b1", 10), booking("b2", 12), booking("b3", 14), booking("x1", 10, { court: "pt-9" })];
  let r = await sync();
  assert.ok(r.ok);
  assert.deepEqual(r.unmapped.map((u) => [u.courtRef, u.bookings]).sort(), [["pt-1", 3], ["pt-9", 1]]);
  assert.equal(r.changes, 0);
  assert.equal(await mirrorRuns(), 0);

  await rejects(run(db, "connector.map_court", { resource_id: "pt-1", resource_name: "Padel 1", court_id: court1 }, member), "error.forbidden_reason");
  await run(db, "connector.map_court", { resource_id: "pt-1", resource_name: "Padel 1", court_id: court1 }, owner);
  await rejects(plan(db, "connector.map_court", { resource_id: "pt-1", court_id: court2 }, owner), "error.already_mapped");
  await rejects(plan(db, "connector.map_court", { resource_id: "pt-2", court_id: court1 }, owner), "error.already_mapped");

  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.held, 3);
  assert.deepEqual(r.unmapped.map((u) => u.courtRef), ["pt-9"]);
  const b1 = await mb("b1:pt-1");
  assert.equal(b1.status, "held");
  assert.equal((await db.selectFrom("court_time").select("kind").where("id", "=", b1.court_time_id!).executeTakeFirstOrThrow()).kind, "mirror");
  // Kumi can't put an event where Playtomic has sold the court.
  await rejects(plan(db, "session.add", { program_id: programId, starts_at: at(10.5).toISOString(), ends_at: at(11).toISOString(), court_ids: [court1] }, owner), "error.court_taken");

  // Nothing changed in Playtomic: no action run at all.
  const runs = await mirrorRuns();
  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.changes, 0);
  assert.equal(await mirrorRuns(), runs);
  const st = await db.selectFrom("connector_status").selectAll().where("system", "=", "playtomic").executeTakeFirstOrThrow();
  assert.equal(st.fetched, 4);
  assert.equal(st.last_error, null);
  assert.deepEqual((st.courts as { courtRef: string; courtName: string }[]).map((c) => [c.courtRef, c.courtName]).sort(), [["pt-1", "Padel 1"], ["pt-9", "Padel 9"]]);
});

test("a moved booking moves its hold; a cancelled or vanished one lets the court go", async () => {
  const before = await mb("b1:pt-1");
  pt.bookings = [booking("b1", 11), booking("b2", 12, { cancelled: true }), booking("x1", 10, { court: "pt-9" }), booking("b1", 11)];   // b3 is gone; b1 read twice
  const r = await sync();
  assert.ok(r.ok);
  assert.equal(r.changes, 3);
  assert.equal(r.gone, 2);
  const moved = await mb("b1:pt-1");
  assert.equal(moved.status, "held");
  assert.notEqual(moved.court_time_id, before.court_time_id);
  assert.equal(await active(before.court_time_id), false);
  assert.equal(await active(moved.court_time_id), true);
  for (const ref of ["b2:pt-1", "b3:pt-1"]) assert.equal((await mb(ref)).status, "gone");
  await addSession(14, 1.5);   // where b3 was
});

test("a player's booking over a Kumi event is a conflict, said once, and holds the court once the event goes", async () => {
  const s = await addSession(50, 2);
  pt.bookings = [booking("c1", 50.5), booking("c2", 51, { type: "PUBLIC_CLASS", minutes: 60 })];
  let r = await sync();
  assert.ok(r.ok);
  assert.equal(r.conflict, 2);   // a clinic on Playtomic's side is real use too
  const c1 = await mb("c1:pt-1");
  assert.equal(c1.status, "conflict");
  assert.equal(c1.court_time_id, null);
  const said = () => db.selectFrom("event_outbox").select("payload").where("topic", "=", "mirror.conflict").execute();
  assert.equal((await said()).length, 2);
  assert.deepEqual((await said()).map((e) => (e.payload as any).ref).sort(), ["c1:pt-1", "c2:pt-1"]);

  const runs = await mirrorRuns();
  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.changes, 0);
  assert.equal(await mirrorRuns(), runs);
  assert.equal((await said()).length, 2);

  await run(db, "action.undo", { run_id: s.runId }, owner);   // the event is taken off the court
  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.held, 1);
  assert.equal((await mb("c1:pt-1")).status, "held");
});

test("the club's own block over a Kumi event is covered, and an event takes over a block that came first", async () => {
  const s = await addSession(60, 2);
  pt.bookings = [booking("k1", 60, { type: "TOURNAMENT", minutes: 120 }), booking("k2", 70, { type: "OPEN_PLAY", minutes: 120 }), booking("k3", 80, { type: "TOURNAMENT", minutes: 180 }), booking("k4", 90, { minutes: 120 })];
  let r = await sync();
  assert.ok(r.ok);
  assert.equal(r.covered, 1);
  assert.equal(r.held, 3);
  const k1 = await mb("k1:pt-1");
  assert.equal(k1.status, "covered");
  assert.equal(k1.court_time_id, null);
  const sessionTime = await db.selectFrom("court_time").select("id").where("session_id", "=", (s.result as { session_id: string }).session_id).executeTakeFirstOrThrow();
  assert.equal(k1.clash_id, sessionTime.id);

  // k2 was blocked in Playtomic first; the event lands inside it and takes the hold over.
  const s2 = await addSession(70, 2);
  const k2 = await mb("k2:pt-1");
  assert.equal(k2.status, "covered");
  assert.equal(k2.court_time_id, null);
  const s2Time = await db.selectFrom("court_time").select("id").where("session_id", "=", (s2.result as { session_id: string }).session_id).executeTakeFirstOrThrow();
  assert.equal(k2.clash_id, s2Time.id);
  // Only inside a block, and only a block: a player's booking or a longer event still can't take the court.
  await rejects(plan(db, "session.add", { program_id: programId, starts_at: at(79).toISOString(), ends_at: at(82).toISOString(), court_ids: [court1] }, owner), "error.court_taken");
  await rejects(plan(db, "session.add", { program_id: programId, starts_at: at(90).toISOString(), ends_at: at(91).toISOString(), court_ids: [court1] }, owner), "error.court_taken");

  // The next sync agrees with what the event did, so it changes nothing.
  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.changes, 0);

  // Undoing the event hands the hold back to the block, and the sync agrees with that too.
  await run(db, "action.undo", { run_id: s2.runId }, owner);
  const back = await mb("k2:pt-1");
  assert.equal(back.status, "held");
  assert.equal(await active(back.court_time_id), true);
  assert.equal(await active(s2Time.id), false);
  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.changes, 0);
});

test("the end comes from booking_end_date; the duration only when there's no end to read", () => {
  const row = { booking_id: "e", resource_id: "r", booking_start_date: "2026-11-06T18:00:00" };
  assert.equal(normalize({ ...row, booking_end_date: "2026-11-06T20:00:00", duration: 90 })!.end.toISOString(), "2026-11-06T20:00:00.000Z");
  assert.equal(normalize({ ...row, booking_end_date: "2026-11-06T11:00:00-08:00", duration: 90 })!.end.toISOString(), "2026-11-06T19:00:00.000Z");
  for (const end of [undefined, "2026-11-06T17:00:00", "later"]) assert.equal(normalize({ ...row, booking_end_date: end, duration: 90 })!.end.toISOString(), "2026-11-06T19:30:00.000Z");
  assert.equal(normalize({ ...row, booking_end_date: "2026-11-06T20:00:00" })!.end.toISOString(), "2026-11-06T20:00:00.000Z");   // no duration needed
});

test("only the club's own tournaments and open play are taken as its own; every other type, and one Kumi doesn't know, is a clash", async () => {
  assert.equal(PLAYTOMIC_TYPES.length, 9);
  const s = await addSession(100, 2);
  const types = [...PLAYTOMIC_TYPES, "SOMETHING_NEW", ""];
  pt.bookings = types.flatMap((type, i) => [booking(`over${i}`, 100.5, { type, minutes: 60 }), booking(`free${i}`, 110 + 2 * i, { type, minutes: 60 })]);
  const r = await sync();
  assert.ok(r.ok);
  for (const [i, type] of types.entries()) {
    assert.equal((await mb(`over${i}:pt-1`)).status, type === "TOURNAMENT" || type === "OPEN_PLAY" ? "covered" : "conflict", `over a Kumi event: ${type || "(no type)"}`);
    assert.equal((await mb(`free${i}:pt-1`)).status, "held", `on a free court: ${type || "(no type)"}`);
  }
  assert.equal(r.covered, 2);
  assert.equal(r.conflict, types.length - 2);
  const said = (await db.selectFrom("event_outbox").select("payload").where("topic", "=", "mirror.conflict").execute()).map((e) => (e.payload as any).ref);
  for (const [i, type] of types.entries()) assert.equal(said.filter((x) => x === `over${i}:pt-1`).length, type === "TOURNAMENT" || type === "OPEN_PLAY" ? 0 : 1);

  // A Kumi event can be put inside the club's own tournament, never inside a player's recurring booking.
  const t = types.indexOf("TOURNAMENT"), rec = types.indexOf("RECURRING_BOOKING");
  await plan(db, "session.add", { program_id: programId, starts_at: at(110 + 2 * t).toISOString(), ends_at: at(111 + 2 * t).toISOString(), court_ids: [court1] }, owner);
  await rejects(plan(db, "session.add", { program_id: programId, starts_at: at(110 + 2 * rec).toISOString(), ends_at: at(111 + 2 * rec).toISOString(), court_ids: [court1] }, owner), "error.court_taken");
  await run(db, "action.undo", { run_id: s.runId }, owner);
});

test("a recurring booking an older Kumi took as the club's own is judged again: a clash, said once", async () => {
  const s = await addSession(140, 2);
  const sessionTime = await db.selectFrom("court_time").select("id").where("session_id", "=", (s.result as { session_id: string }).session_id).executeTakeFirstOrThrow();
  // As the copy before this fix left it: covered, holding nothing, against the event.
  await db.insertInto("mirror_booking").values({ ref: "r1:pt-1", system: "playtomic", court_id: court1, during: `[${at(140.5).toISOString()},${at(141.5).toISOString()})`,
    booking_type: "RECURRING_BOOKING", status: "covered", court_time_id: null, clash_id: sessionTime.id }).execute();
  pt.bookings = [booking("r1", 140.5, { type: "RECURRING_BOOKING", minutes: 60 })];
  const said = async () => (await db.selectFrom("event_outbox").select("payload").where("topic", "=", "mirror.conflict").execute()).filter((e) => (e.payload as any).ref === "r1:pt-1").length;
  let r = await sync();
  assert.ok(r.ok);
  assert.equal(r.conflict, 1);
  assert.equal((await mb("r1:pt-1")).status, "conflict");
  assert.equal(await said(), 1);
  r = await sync();
  assert.ok(r.ok);
  assert.equal(r.changes, 0);
  assert.equal(await said(), 1);
  await run(db, "action.undo", { run_id: s.runId }, owner);
});

test("further ahead is read a 30-day slice a sync, as far as Kumi has anything on a court, at the same pace", async () => {
  const D = 24;   // hours in a day
  // Nothing on a court past the near window yet: no far read at all.
  pt.bookings = [];
  const quiet = new Map<number, number>();
  assert.ok((await mirrorHorizon(db, new Date(base))).getTime() <= base + 31 * D * H);
  const far = await addSession(100 * D, 2);   // a program date 100 days out
  assert.equal((await mirrorHorizon(db, new Date(base))).getTime(), base + (100 * D + 2) * H);
  pt.bookings = [booking("f45", 45 * D), booking("f95", 95 * D), booking("f200", 200 * D)];

  const pace = 40, c = new PlaytomicClient({ clientId: "kumi", secret: "s3cret", tenantId: "tenant-1", fetch: pt.fetch, pageDelayMs: pace });
  pt.pageTimes = []; pt.windows = [];
  const now = new Date(base), lastRead = quiet, every = 6 * H;
  const status = () => db.selectFrom("connector_status").select(["last_sync_at", "fetched", "unmapped", "courts"]).where("system", "=", "playtomic").executeTakeFirstOrThrow();
  assert.ok((await syncMirror(db, c, { now })).ok);
  const nearStatus = await status();
  const f1 = await syncMirrorFar(db, c, { now, everyMs: every, lastRead });
  assert.ok(f1?.ok);
  assert.equal(f1.from.getTime(), base + 30 * D * H);
  assert.equal(f1.to.getTime(), base + 60 * D * H);
  assert.equal(f1.held, 1);
  assert.equal((await mb("f45:pt-1")).status, "held");
  // The far read went at the near read's pace, and left the staff screen's status to the near read.
  assert.equal(pt.pageTimes.length, 2);
  assert.ok(pt.pageTimes[1]! - pt.pageTimes[0]! >= pace - 2, `pages ${pt.pageTimes[1]! - pt.pageTimes[0]!} ms apart`);
  assert.deepEqual(await status(), nearStatus);
  assert.equal(nearStatus.fetched, 0);   // nothing near; the far booking isn't counted there

  const f2 = await syncMirrorFar(db, c, { now, everyMs: every, lastRead });
  assert.deepEqual([f2?.from.getTime(), f2?.to.getTime()], [base + 60 * D * H, base + 90 * D * H]);
  const f3 = await syncMirrorFar(db, c, { now, everyMs: every, lastRead });
  assert.deepEqual([f3?.from.getTime(), f3?.to.getTime()], [base + 90 * D * H, base + (100 * D + 2) * H]);
  assert.equal((await mb("f95:pt-1")).status, "held");
  // Then three months back, for the archive only (playtomic_archive.ts): a past booking holds nothing.
  for (let k = 1; k <= 3; k++) {
    const p = await syncMirrorFar(db, c, { now, everyMs: every, lastRead });
    assert.ok(p?.ok && p.from < now && p.held === 0 && p.changes === 0, JSON.stringify(p));
  }
  assert.equal(await syncMirrorFar(db, c, { now, everyMs: every, lastRead }), null);   // all read lately
  assert.equal((await db.selectFrom("mirror_booking").select("ref").where("ref", "=", "f200:pt-1").executeTakeFirst()), undefined);   // past anything Kumi has
  for (let i = 1; i < pt.pageTimes.length; i++) assert.ok(pt.pageTimes[i]! - pt.pageTimes[i - 1]! >= pace - 2);

  // Six hours on, the nearest slice is due again; a booking cancelled there lets the court go.
  pt.bookings = [booking("f45", 45 * D, { cancelled: true }), booking("f95", 95 * D)];
  const later = new Date(base + every);
  const f4 = await syncMirrorFar(db, c, { now: later, everyMs: every, lastRead });
  assert.ok(f4?.ok);
  assert.equal(f4.from.getTime(), later.getTime() + 30 * D * H);
  assert.equal((await mb("f45:pt-1")).status, "gone");

  // A booking still held keeps its slice read, even once Kumi's own date is gone; one still on record (a clash, say) too; and a year is as far as it goes.
  await run(db, "action.undo", { run_id: far.runId }, owner);
  assert.ok((await mirrorHorizon(db, new Date(base))).getTime() >= base + 95 * D * H);
  await db.insertInto("mirror_booking").values({ ref: "y1:pt-1", system: "playtomic", court_id: court2, during: `[${at(400 * D).toISOString()},${at(401 * D).toISOString()})`, booking_type: "REGULAR_BOOKING", status: "conflict", court_time_id: null, clash_id: null }).execute();
  assert.equal((await mirrorHorizon(db, new Date(base))).getTime(), base + FAR_MAX_DAYS * D * H);
  await db.deleteFrom("mirror_booking").where("ref", "=", "y1:pt-1").execute();

  // A failed slice isn't marked read, so the next sync tries it again.
  const marks = new Map<number, number>();
  const bad = await syncMirrorFar(db, client("wrong"), { now, everyMs: every, lastRead: marks });
  assert.equal(bad?.ok, false);
  assert.equal(marks.size, 0);
  assert.deepEqual(farSlice({ nearEnd: new Date(0), horizon: new Date(10), now: new Date(0), everyMs: 1, lastRead: new Map() }), { k: 0, from: new Date(0), to: new Date(10) });
  pt.bookings = [];
});

test("a sync that can't reach Playtomic is recorded, not thrown", async () => {
  const r = await syncMirror(db, client("wrong"), { now: new Date(base) });
  assert.equal(r.ok, false);
  const st = await db.selectFrom("connector_status").selectAll().where("system", "=", "playtomic").executeTakeFirstOrThrow();
  assert.match(st.last_error ?? "", /401/);
  assert.ok(st.last_ok_at);   // the last good sync is kept
});
