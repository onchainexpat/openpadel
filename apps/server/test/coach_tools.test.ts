import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, onDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, date: string;
const TZ = "America/Los_Angeles";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const req = async (path: string, who: string, body?: unknown) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function signIn(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[name] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  for (const name of ["Ann", "Kim", "Lou", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(name);
  }
  await signIn("Robin");
  for (const [who, role] of [["Kim", "coach"], ["Lou", "coach"], ["Fay", "front_desk"]] as const) await run(db, "role.assign", { person_id: people[who], role }, owner);
  const clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley Clinic", capacity: 8, price_cents: 0 }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 2 * 864e5);
  date = ((await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court], coach_id: people.Kim }, owner)).result as any).session_id;
  await run(db, "program.publish", { program_id: clinic }, owner);
  await run(db, "enrolment.join", { program_id: clinic, person_id: people.Ann }, { personId: people.Ann!, via: "test", lang: "en" });
});
after(async () => drop());

test("a date's list: its coach and front desk see it, another coach doesn't", async () => {
  const r = await req(`/staff/roster/session/${date}`, "Kim");
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.item.name, r.json.players.map((p: any) => p.name), r.json.marking.open, r.json.hours], ["Volley Clinic", ["Ann"], false, 48]);
  assert.ok(!JSON.stringify(r.json).includes("@example.test"));
  assert.equal((await req(`/staff/roster/session/${date}`, "Fay")).status, 200);
  assert.equal((await req(`/staff/roster/session/${date}`, "Lou")).status, 403);
  assert.equal((await req(`/staff/roster/session/${date}`, "Ann")).status, 403);
  assert.equal((await req(`/staff/roster/other/${date}`, "Kim")).status, 404);
});

test("a date's levels and its night: its coach and front desk read them, another coach hears only that it isn't theirs", async () => {
  for (const path of [`/staff/sessions/${date}/levels`, `/staff/sessions/${date}/night`]) {
    assert.equal((await req(path, "Kim")).status, 200, path);
    assert.equal((await req(path, "Fay")).status, 200, path);
    assert.equal((await req(path, "Robin")).status, 200, path);
    const lou = await req(path, "Lou");
    assert.equal(lou.status, 403, path);
    assert.equal(lou.json.error, "error.forbidden_reason", path);
    assert.ok(!JSON.stringify(lou.json).includes("Ann"), path);
  }
  // A date that isn't there reads the same to a coach, so its existence isn't told either; the roster too.
  const gone = "00000000-0000-7000-8000-00000000dead";
  for (const path of [`/staff/sessions/${gone}/levels`, `/staff/sessions/${gone}/night`, `/staff/roster/session/${gone}`, `/staff/roster/lesson/${gone}`])
    assert.equal((await req(path, "Lou")).json.error, "error.forbidden_reason", path);
  assert.equal((await req(`/staff/sessions/${gone}/levels`, "Fay")).status, 404);
  // The roster's no to a coach says it isn't theirs, not that it's for staff.
  assert.equal((await req(`/staff/roster/session/${date}`, "Lou")).json.error, "error.forbidden_reason");
});

test("students: a coach sees their own; front desk picks a coach", async () => {
  const k = await req("/staff/students?coach=" + people.Lou, "Kim");   // a coach can't look at another's
  assert.deepEqual([k.json.coach.name, k.json.coaches, k.json.days], ["Kim", [], 90]);
  const f = await req("/staff/students", "Fay");
  assert.deepEqual([f.json.coach, f.json.coaches.map((c: any) => c.name)], [null, ["Kim", "Lou"]]);
  assert.equal((await req(`/staff/students?coach=${people.Kim}`, "Fay")).json.coach.name, "Kim");
  assert.equal((await req("/staff/students", "Ann")).status, 403);
});

test("the calendar link: only a coach makes one; the feed needs no sign-in; a new link ends the old", async () => {
  assert.deepEqual((await req("/staff/calendar-link", "Kim")).json, { path: null, created_at: null });
  assert.equal((await req("/staff/calendar-link", "Fay", {})).status, 403);
  const made = (await req("/staff/calendar-link", "Kim", {})).json;
  assert.match(made.path, /^\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
  assert.equal((await req("/staff/calendar-link", "Kim")).json.path, made.path);
  const feed = await app.request(made.path);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type") ?? "", /^text\/calendar/);
  assert.equal(feed.headers.get("x-robots-tag"), "noindex");
  const body = (await feed.text()).replace(/\r\n /g, "");
  assert.match(body, /SUMMARY:Volley Clinic \(1 signed up\)/);
  assert.match(body, /DESCRIPTION:Signed up: Ann/);
  const again = (await req("/staff/calendar-link", "Kim", {})).json;
  assert.notEqual(again.path, made.path);
  assert.equal((await app.request(made.path)).status, 404);
  assert.equal((await app.request(again.path)).status, 200);
  assert.equal((await app.request("/calendar/not-a-real-token.ics")).status, 404);
  // A form post from another site can't make a new one.
  assert.equal((await app.request("/staff/calendar-link", { method: "POST", headers: { cookie: cookies.Kim!, "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: "{}" })).status, 403);
});

test("a coach with no other staff role reads their own work, not the club's money, members or settings", async () => {
  for (const path of ["/staff/reports", "/staff/payments", "/staff/people", `/staff/people/${people.Lou}`, "/staff/memberships", "/staff/questions", "/staff/settings"])
    assert.equal((await req(path, "Kim")).status, 403, path);
  assert.equal((await req(`/staff/people/${people.Ann}`, "Kim")).status, 200);   // Ann is booked into Kim's clinic: one of Kim's players
  for (const path of ["/staff/my-schedule", "/staff/students", "/staff/programs", "/staff/levels"]) assert.equal((await req(path, "Kim")).status, 200, path);
  assert.equal((await req("/staff/people", "Fay")).status, 200);
  assert.equal((await req("/staff/reports", "Fay")).status, 400);   // past the door; it only wants its dates
});

test("the courts day for a coach: their own lessons in full, anyone else's booking only as booked", async () => {
  const loc = (await db.selectFrom("location").select("id").executeTakeFirstOrThrow()).id, court = (await db.selectFrom("court").select("id").executeTakeFirstOrThrow()).id;
  const d = localDate(new Date(Date.now() + 3 * 864e5), TZ);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  await run(db, "booking.create", { court_id: court, starts_at: onDate(d, "10:00", TZ).toISOString(), minutes: 60, person_id: people.Ann, price_cents: 4000 }, owner);
  const item = async (who: string) => (await req(`/staff/grid?location_id=${loc}&date=${d}`, who)).json.courts[0].items.find((x: any) => x.kind === "booking");
  const desk = await item("Fay"), coach = await item("Kim");
  assert.equal(desk.who, "Ann"); assert.ok(desk.code && desk.booking_id);
  assert.deepEqual(Object.keys(coach).sort(), ["end", "kind", "label", "start"]);
  assert.equal(coach.label, "Booked");
});

test("what waits at the desk to give back to a player: the club's money people see it on their page, their coach doesn't", async () => {
  const loc = (await db.selectFrom("location").select("id").executeTakeFirstOrThrow()).id, court = (await db.selectFrom("court").select("id").executeTakeFirstOrThrow()).id;
  const d = localDate(new Date(Date.now() + 4 * 864e5), TZ);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: onDate(d, "12:00", TZ).toISOString(), minutes: 60, person_id: people.Ann, price_cents: 4000 }, owner)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, owner);
  await run(db, "booking.cancel", { booking_id: b }, owner);
  assert.deepEqual((await req(`/staff/people/${people.Ann}`, "Fay")).json.to_give_back.map((r: any) => r.amount_cents), [4000]);
  assert.deepEqual((await req(`/staff/people/${people.Ann}`, "Kim")).json.to_give_back, []);
});

test("a coach whose other role reaches every session reads them all; a second role that doesn't is still only their own", async () => {
  for (const name of ["Cal", "Ada", "Acc"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(name);
  }
  // Cal also holds a role the club made: setting any session's levels, marking who came to any, and running any night.
  const head = ((await run(db, "role.create", { name: "Head coach", grants: ["level.set_session", "attendance.mark", "draw.generate", "game.score"].map((action) => ({ action, scope: "any" })) }, owner)).result as any).key;
  for (const [who, role] of [["Cal", "coach"], ["Cal", head], ["Ada", "coach"], ["Ada", "accountant"], ["Acc", "accountant"]] as const) await run(db, "role.assign", { person_id: people[who], role }, owner);
  const paths = [`/staff/sessions/${date}/levels`, `/staff/sessions/${date}/night`, `/staff/roster/session/${date}`];
  for (const path of paths) {
    assert.equal((await req(path, "Cal")).status, 200, path);
    for (const who of ["Ada", "Acc"]) {   // coach and accountant, and accountant alone: neither role sets levels, marks or runs a night
      const r = await req(path, who);
      assert.equal(r.status, 403, `${who} ${path}`);
      assert.equal(r.json.error, "error.forbidden_reason", `${who} ${path}`);
      assert.ok(!JSON.stringify(r.json).includes("Ann"), `${who} ${path}`);
    }
  }
  // One that isn't there is a 404 to whoever may read every one, as to front desk.
  const gone = "00000000-0000-7000-8000-00000000dead";
  for (const path of [`/staff/sessions/${gone}/levels`, `/staff/roster/session/${gone}`]) assert.equal((await req(path, "Cal")).status, 404, path);
});

test("an id that isn't one: the same no to a coach, the same 404 to front desk, never a server error", async () => {
  for (const bad of ["-".repeat(36), "g".repeat(8) + "-0000-0000-0000-" + "0".repeat(12), "nope"]) {
    for (const path of [`/staff/sessions/${bad}/levels`, `/staff/sessions/${bad}/night`, `/staff/roster/session/${bad}`, `/staff/roster/lesson/${bad}`]) {
      const lou = await req(path, "Lou");
      assert.equal(lou.status, 403, path); assert.equal(lou.json.error, "error.forbidden_reason", path);
      for (const who of ["Fay", "Robin", "Cal"]) {
        const r = await req(path, who);
        assert.equal(r.status, 404, `${who} ${path}`); assert.equal(r.json.error, "error.not_found", `${who} ${path}`);
      }
    }
  }
});

test("a program's page for a coach: its roster and levels, never what anyone paid, a refund or a free place's note", async () => {
  const program = (await db.selectFrom("session").select("program_id").where("id", "=", date).executeTakeFirstOrThrow()).program_id;
  await run(db, "enrolment.comp", { program_id: program, person_id: people.Fay, note: "Covered by the club" }, owner);
  const MONEY = ["price_cents", "price_basis", "paid_by", "paid_cents", "refund_outcome", "refund_cents", "comp_note"];
  const kim = await req(`/staff/programs/${program}`, "Kim");
  assert.equal(kim.status, 200);
  assert.equal(kim.json.money, false);
  assert.deepEqual(kim.json.roster.map((r: any) => [r.display_name, r.status]).sort(), [["Ann", "booked"], ["Fay", "booked"]]);
  for (const r of kim.json.roster) { assert.ok("level" in r); for (const k of MONEY) assert.ok(!(k in r), k); }
  assert.ok(!JSON.stringify(kim.json).includes("Covered by the club"));
  // Front desk and up, and a coach who is also the accountant, read it all as before.
  for (const who of ["Robin", "Fay", "Ada"]) {
    const r = await req(`/staff/programs/${program}`, who);
    assert.equal(r.status, 200, who); assert.equal(r.json.money, true, who);
    for (const k of MONEY) assert.ok(r.json.roster.every((x: any) => k in x), `${who} ${k}`);
    assert.ok(JSON.stringify(r.json).includes("Covered by the club"), who);
  }
  // The list and a competition's page carry no place's money to begin with.
  const list = await req("/staff/programs", "Kim");
  for (const k of ["paid_by", "paid_cents", "refund_outcome", "refund_cents", "comp_note"]) assert.ok(list.json.every((x: any) => !(k in x)), k);
});
