import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
/** Hal opens a match three days from now and pays his part. */
async function openMatch(hour: number, open: Record<string, unknown>) {
  const start = new Date(Date.now() + 3 * 86400_000); start.setUTCHours(hour, 0, 0, 0);
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "split", person_id: people.Hal, open },
    { personId: people.Hal!, via: "test", lang: "en" })).result as { booking_id: string; payment_id: string };
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  return r.booking_id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4], ["Ben", 4.2]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner);
    await signIn(`${name.toLowerCase()}@example.test`);
  }
});
after(async () => drop());

test("the Play page lists open matches with who's in and what each player can do", async () => {
  const id = await openMatch(18, { level_min: 3, level_max: 4 });
  const [m] = (await get("/open-matches", "ann@example.test")).json;
  assert.equal(m.id, id);
  assert.deepEqual(m.players, [{ name: "Hal", level: 3.5, host: true, paying: false, saved: false, leaving: false }]);
  assert.deepEqual([m.spots_left, m.share_cents, m.can, m.my_level, m.rated], [3, 1500, "join", 3.4, true]);
  assert.equal(m.invite_code, null);   // only the host sees the link
  const ben = (await get(`/matches/${id}`, "ben@example.test")).json;
  assert.equal(ben.can, "ask");
  await run(db, "booking.ask", { booking_id: id, person_id: people.Ben, note: "I play Tuesdays here" }, { personId: people.Ben!, via: "test", lang: "en" });
  const host = (await get(`/matches/${id}`, "hal@example.test")).json;
  assert.deepEqual(host.requests.map((r: any) => [r.display_name, r.level, r.note]), [["Ben", 4.2, "I play Tuesdays here"]]);
  assert.ok(host.invite_code); assert.equal(host.host_is_me, true); assert.equal(host.can, null);
  assert.deepEqual((await get(`/matches/${id}`, "ben@example.test")).json.request.status, "requested");
});

test("a match kept to its link: not listed, and only seen with the link", async () => {
  const id = await openMatch(20, { level_min: 3, level_max: 4, listed: false });
  assert.ok(!(await get("/open-matches", "ann@example.test")).json.some((m: any) => m.id === id));
  assert.equal((await get(`/matches/${id}`, "ann@example.test")).status, 404);
  const code = (await get(`/matches/${id}`, "hal@example.test")).json.invite_code;
  assert.equal((await get(`/matches/${id}?code=${code}`, "ann@example.test")).status, 200);
  assert.equal((await get(`/bookings/invite/${code}`, "ann@example.test")).json.open_match, true);
});

test("after a match: fair teams, then the score on the match page and on the staff Scores page", async () => {
  const start = new Date(Date.now() - 2 * 3600_000); start.setUTCMinutes(0, 0, 0);
  const before = { now: new Date(start.getTime() - 2 * 86400_000) };
  const ann = { personId: people.Ann!, via: "test", lang: "en" as const }, hal = { personId: people.Hal!, via: "test", lang: "en" as const };
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 5 } }, hal, before)).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test", before);
  for (const name of ["Ann", "Ben", "Cal"]) {
    if (!people[name]) {
      people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
      await run(db, "level.set", { person_id: people[name], level: 3.8, reason: "Starting level" }, owner);
    }
    const j = (await run(db, "booking.join", { booking_id: r.booking_id, person_id: people[name] }, { personId: people[name]!, via: "test", lang: "en" }, before)).result as any;
    await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "test", before);
  }
  const m = (await get(`/matches/${r.booking_id}`, "ann@example.test")).json;
  assert.equal(m.can_score, true); assert.equal(m.result, null);
  assert.match(m.teams.odds, /^\d+\/\d+$/);
  await run(db, "result.enter", { booking_id: r.booking_id, person_id: people.Ann, partner_id: people.Hal, sets: [{ us: 6, them: 4 }, { us: 7, them: 5 }] }, ann);
  const after = (await get(`/matches/${r.booking_id}`, "ben@example.test")).json;
  assert.deepEqual([after.result.status, after.result.my_side, after.result.can_confirm, after.can_score], ["awaiting_confirmation", "b", true, false]);
  assert.deepEqual(after.result.sets, [{ a: 6, b: 4 }, { a: 7, b: 5 }]);
  const staff = (await get("/staff/scores", "hal@example.test")).status;
  assert.equal(staff, 403);   // Hal is a member, not staff
  await signIn("robin@example.test");
  const scores = (await get("/staff/scores", "robin@example.test")).json;
  assert.deepEqual(scores[0].answers.map((x: any) => [x.display_name, x.answer]), [["Ann", "entered"]]);
});

test("a match that didn't fill shows as cancelled to its players, with nothing left to do in it", async () => {
  const id = await openMatch(16, { level_min: 3, level_max: 4 });
  const j = (await run(db, "booking.join", { booking_id: id, person_id: people.Ann }, { personId: people.Ann!, via: "test", lang: "en" })).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "test");
  await runAsSystem(db, "booking.settle_shares", { booking_id: id }, "jobs");   // what the job does at the deadline: only two are in
  assert.ok(!(await get("/open-matches", "ben@example.test")).json.some((m: any) => m.id === id));
  const m = (await get(`/matches/${id}`, "ann@example.test")).json;
  assert.deepEqual([m.cancelled, m.open, m.can, m.spots_left, m.late_window, m.can_score, m.stakes, m.teams], [true, false, null, 0, false, false, null, null]);
});

test("taking over a place: the take link, the sub's own view, and a late leaver's place that staff open again", async () => {
  const actor = (name: string) => ({ personId: people[name]!, via: "test", lang: "en" as const });
  for (const name of ["Dot", "Eli", "Flo"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await run(db, "level.set", { person_id: people[name], level: 3.5, reason: "Starting level" }, owner);
    await signIn(`${name.toLowerCase()}@example.test`);
  }
  // Dot's match tonight, booked two days ago: it's past its deadline, and full.
  const start = new Date(Date.now() + 10 * 3600_000); start.setUTCMinutes(0, 0, 0);
  // Not across midnight: the club's day ends at 24:00, so a 90-minute game can't start after 22:30.
  while (Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(start)) >= 22) start.setTime(start.getTime() - 3600_000);
  const then = { now: new Date(Date.now() - 2 * 86400_000) };
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "split", person_id: people.Dot, open: { level_min: 3, level_max: 4 } }, actor("Dot"), then)).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test", then);
  for (const name of ["Ann", "Hal", "Eli"]) {
    const j = (await run(db, "booking.join", { booking_id: r.booking_id, person_id: people[name] }, actor(name), then)).result as any;
    await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "test", then);
  }
  await runAsSystem(db, "booking.settle_shares", { booking_id: r.booking_id }, "jobs");
  // Ann makes a take-my-place link.
  const code = ((await run(db, "booking.offer_place", { booking_id: r.booking_id, person_id: people.Ann }, actor("Ann"))).result as any).code;
  assert.equal((await get(`/matches/${r.booking_id}`, "ann@example.test")).json.me.offer.code, code);
  assert.deepEqual([(await get(`/my/place-offers/${code}`, "flo@example.test")).json.can, (await get(`/my/place-offers/${code}`, "ben@example.test")).json.can,
    (await get(`/my/place-offers/${code}`, "dot@example.test")).json.can], ["take", "outside", "in"]);
  assert.equal((await get(`/my/place-offers/${code}`, "flo@example.test")).json.from, "Ann");
  await run(db, "booking.take_place", { code, person_id: people.Flo }, actor("Flo"));
  const flo = (await get(`/matches/${r.booking_id}`, "flo@example.test")).json;
  assert.deepEqual([flo.me.sub, Boolean(flo.me.pending_payment_id), flo.spots_left, flo.players.length], [true, true, 0, 4]);   // paying for Ann's place, not a fifth
  // Eli backs out: the place is empty; the desk sees it, and opens it again in the app.
  await run(db, "booking.leave", { booking_id: r.booking_id, person_id: people.Eli }, actor("Eli"));
  await signIn("robin@example.test");
  const loc = (await get("/staff/locations", "robin@example.test")).json[0].id;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(start);
  const grid = (await get(`/staff/grid?location_id=${loc}&date=${day}`, "robin@example.test")).json;
  const item = grid.courts.flatMap((c: any) => c.items).find((x: any) => x.booking_id === r.booking_id);
  assert.deepEqual(item.empty_places.map((e: any) => [e.name, e.open]), [["Eli", false]]);
  assert.equal(item.open_match, true);   // coloured as an open match on the Schedule
  assert.ok(!(await get("/open-matches", "ben@example.test")).json.some((m: any) => m.id === r.booking_id));
  await run(db, "booking.reopen_place", { booking_player_id: item.empty_places[0].id }, owner);
  const listed = (await get("/open-matches", "ben@example.test")).json.find((m: any) => m.id === r.booking_id);
  assert.deepEqual([listed.open, listed.spots_left], [true, 1]);
});

test("a court booked in full has its own page for its players: the booker names them or shares the players link", async () => {
  const start = new Date(Date.now() + 3 * 86400_000); start.setUTCHours(15, 0, 0, 0);
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "whole", person_id: people.Hal },
    { personId: people.Hal!, via: "test", lang: "en" })).result as { booking_id: string; payment_id: string };
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  const host = (await get(`/matches/${r.booking_id}`, "hal@example.test")).json;
  assert.deepEqual([host.is_match, host.whole, host.can_name, host.can_rate, host.rated, host.spots_left, host.can], [false, true, true, true, false, 3, null]);
  assert.ok(host.players_link);
  assert.equal((await get(`/matches/${r.booking_id}`, "ann@example.test")).status, 404);   // not a player, no link
  const inv = (await get(`/bookings/invite/${host.players_link}`, "ann@example.test")).json;
  assert.deepEqual([inv.pay_mode, inv.share_cents, inv.open, inv.spots_left], ["whole", 0, true, 3]);
  await run(db, "booking.join_players", { invite_code: host.players_link, person_id: people.Ann }, { personId: people.Ann!, via: "test", lang: "en" });
  const ann = (await get(`/matches/${r.booking_id}`, "ann@example.test")).json;
  assert.deepEqual([ann.me.added, ann.players_link, ann.can_name], [true, null, false]);
  assert.deepEqual((await get("/my/players/find?q=an", "hal@example.test")).json, [{ id: people.Ann, display_name: "Ann", friend: false }]);   // they've played together
});

test("Play and Learn: a program's coach, length and dates, and Home's 14-day counts, only of what members can see", async () => {
  const loc = (await db.selectFrom("location").select("id").executeTakeFirstOrThrow()).id;
  people.Kim = ((await run(db, "person.create", { display_name: "Kim Coach", email: "kim@example.test", phone: "+15555550123" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner);
  const day = (n: number) => { const d = new Date(Date.now() + n * 86400_000); d.setUTCHours(12, 0, 0, 0); return d; };   // morning at the club, clear of the matches above
  const program = async (kind: string, name: string, n: number, more: { coach?: boolean; weeks?: number; publish?: boolean } = {}) => {
    const id = ((await run(db, "program.create", { location_id: loc, kind, name, capacity: 8, price_cents: 2000 }, owner)).result as any).program_id;
    await run(db, "session.add", { program_id: id, starts_at: day(n).toISOString(), ends_at: new Date(day(n).getTime() + 90 * 60_000).toISOString(), court_ids: [court],
      ...(more.coach ? { coach_id: people.Kim } : {}), ...(more.weeks ? { weeks: more.weeks } : {}) }, owner);
    if (more.publish !== false) await run(db, "program.publish", { program_id: id }, owner);
    return id;
  };
  const before = (await get("/my/whats-on/counts", "ann@example.test")).json;
  await program("clinic", "Volley drills", 2, { coach: true });
  const course = await program("course", "Smash course", 5, { coach: true, weeks: 4 });
  await program("social", "Friday Americano", 3);
  await program("tournament", "Winter Cup", 20);                 // past the 14 days
  await program("league", "Draft league", 4, { publish: false }); // not published: no member sees it
  const progs = (await get("/open-programs", "ann@example.test")).json;
  const c = progs.find((p: any) => p.id === course);
  assert.deepEqual([c.coach.name, c.coach.photo, c.minutes, c.sessions, c.kind], ["Kim Coach", null, 90, 4, "course"]);
  // Four weeks: the last date three weeks after the first (give or take a clock change).
  assert.ok(Math.abs(new Date(c.last_start).getTime() - new Date(c.first_start).getTime() - 21 * 86400_000) <= 3600_000);
  assert.ok(c.next_session_id);
  // A coach no longer active isn't named (as on the private lessons page).
  await db.insertInto("coach").values({ person_id: people.Kim!, active: false }).onConflict((oc) => oc.column("person_id").doUpdateSet({ active: false })).execute();
  assert.equal((await get("/open-programs", "ann@example.test")).json.find((p: any) => p.id === course).coach, null);
  await db.updateTable("coach").set({ active: true }).where("person_id", "=", people.Kim!).execute();
  assert.equal((await get("/open-programs", "ann@example.test")).json.find((p: any) => p.id === course).coach.name, "Kim Coach");
  assert.equal(progs.find((p: any) => p.name === "Friday Americano").coach, null);
  assert.ok(!progs.some((p: any) => p.name === "Draft league"));
  // The coach is a name (and a photo, if any): never their email or phone.
  assert.doesNotMatch(JSON.stringify(progs), /kim@example|5555550123/);

  assert.equal((await app.request("/my/whats-on/counts")).status, 401);
  const after = (await get("/my/whats-on/counts", "ann@example.test")).json;
  assert.deepEqual([after.events - before.events, after.clinics - before.clinics, after.courses - before.courses], [1, 1, 1]);
  // The matches counted are the listed ones on Play with a place left, starting in the next 14 days.
  const soon = (await get("/open-matches", "ann@example.test")).json.filter((m: any) => m.open && m.spots_left > 0 && new Date(m.start).getTime() <= Date.now() + 14 * 86400_000);
  assert.ok(soon.length >= 1);
  assert.equal(after.matches, soon.length);
  assert.deepEqual(Object.keys(after).sort(), ["clinics", "courses", "events", "matches"]);
});
