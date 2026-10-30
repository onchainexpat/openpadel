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
