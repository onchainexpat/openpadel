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

// ---- What every role together gives (coach plus a role the club made), previews, the mirror, a person's page ----

const ids = async () => ({ loc: (await db.selectFrom("location").select("id").where("name", "=", "Eastside").executeTakeFirstOrThrow()).id,
  court: (await db.selectFrom("court").select("id").orderBy("name").executeTakeFirstOrThrow()).id });
async function newStaff(name: string, roles: string[]) {
  people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await signIn(name);
  for (const role of roles) await run(db, "role.assign", { person_id: people[name], role }, owner);
}

test("a coach who also holds a role the club made reads what both give, no more: no club money, memberships, settings or questions", async () => {
  // Sam coaches and is a "Session lead" (marking who came to any session): the lead role covers programs only.
  const lead = ((await run(db, "role.create", { name: "Session lead", grants: [{ action: "attendance.mark", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Sam", ["coach", lead]);
  const { loc } = await ids(), d = localDate(new Date(), TZ);
  for (const path of [`/staff/reports?location_id=${loc}&from=${d}&to=${d}`, `/staff/reports.csv?location_id=${loc}&from=${d}&to=${d}`, "/staff/reports", "/staff/memberships",
    "/staff/settings", "/staff/questions", "/staff/people", `/staff/people/${people.Lou}`, "/staff/payments", "/staff/facts", "/staff/mirror"]) {
    const r = await req(path, "Sam");
    assert.equal(r.status, 403, path); assert.equal(r.json.error, "error.staff_only", path);
  }
  // Still a coach: their own work, their earnings, and every session's list through the lead role.
  for (const path of ["/staff/my-schedule", "/staff/students", "/staff/programs", "/staff/levels", `/staff/coach-earnings?from=${d}&to=${d}`, `/staff/roster/session/${date}`])
    assert.equal((await req(path, "Sam")).status, 200, path);
  // The staff app is told the areas both roles give together.
  assert.deepEqual((await req("/me", "Sam")).json.areas, ["bookings", "programs", "levels", "coaches"]);
  // A coach whose club-made role does cover money reads the reports too (what each role gives, together).
  const books = ((await run(db, "role.create", { name: "Bookkeeper", grants: [{ action: "receipt.resend", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Bo", ["coach", books]);
  assert.equal((await req(`/staff/reports?location_id=${loc}&from=${d}&to=${d}`, "Bo")).status, 200);
  assert.equal((await req("/staff/settings", "Bo")).status, 403);
});

test("the courts day and a student's page for a coach with another role: only booked for others, and no money", async () => {
  const { loc, court } = await ids(), d = localDate(new Date(Date.now() + 5 * 864e5), TZ);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: onDate(d, "09:00", TZ).toISOString(), minutes: 60, person_id: people.Ann, price_cents: 4000 }, owner)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, owner);
  const item = (await req(`/staff/grid?location_id=${loc}&date=${d}`, "Sam")).json.courts[0].items.find((x: any) => x.kind === "booking");
  assert.deepEqual(Object.keys(item).sort(), ["end", "kind", "label", "start"]);
  // Ann is in a clinic Sam doesn't run, so not Sam's student: her page is closed to Sam as to any coach. Kim's student she is.
  for (const who of ["Kim", "Sam"]) {
    if (who === "Sam") await run(db, "session.set_coach", { session_id: date, coach_id: people.Sam }, owner);
    const r = await req(`/staff/people/${people.Ann}`, who);
    assert.equal(r.status, 200, who);
    assert.equal(r.json.money, false, who);
    const mine = r.json.bookings.find((x: any) => x.id === b);
    assert.ok(mine, who);
    for (const k of ["price_cents", "paid_cents", "off_cents", "pt_cents", "refundable"]) assert.ok(!(k in mine), `${who} ${k}`);
    assert.ok(!JSON.stringify(r.json.bookings).includes("4000"), who);
    if (who === "Sam") await run(db, "session.set_coach", { session_id: date, coach_id: people.Kim }, owner);
  }
  const desk = await req(`/staff/people/${people.Ann}`, "Fay");
  assert.equal(desk.json.money, true);
  const row = desk.json.bookings.find((x: any) => x.id === b);
  assert.equal(row.price_cents, 4000); assert.equal(row.paid_cents, 4000); assert.equal(row.refundable.length, 0);
});

test("a person's page without money: no membership price, balance or what's due, no kid's spending, no weekly prices", async () => {
  const plan = ((await run(db, "membership.plan_set", { name: "Club", price_cents: 5000, period: "month" }, owner)).result as any).plan_id;
  await run(db, "membership.sell", { person_id: people.Ann, plan_id: plan, cents: 2000, method: "cash" }, owner).catch(async () =>
    run(db, "membership.grant", { person_id: people.Ann, plan_id: plan }, owner));
  const kim = await req(`/staff/people/${people.Ann}`, "Kim"), fay = await req(`/staff/people/${people.Ann}`, "Fay");
  assert.ok(fay.json.membership && kim.json.membership);
  for (const k of ["price_cents", "balance_cents", "due"]) { assert.ok(!(k in kim.json.membership), k); assert.ok(k in fay.json.membership, k); }
  for (const s of kim.json.series) for (const w of s.weeks) { assert.ok(!("price_cents" in w)); assert.ok(!("charged" in w)); assert.notEqual(w.state, "owed"); }
  for (const b of kim.json.playtomic) { assert.ok(!("price" in b)); assert.ok(!("payment_status" in b)); }
});

test("previewing a money change: anyone it can never be theirs hears the plain no first, never what's owed or paid", async () => {
  const { loc, court } = await ids();
  const paid = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Paid Clinic", capacity: 8, price_cents: 3000 }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 6 * 864e5);
  await run(db, "session.add", { program_id: paid, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court], coach_id: people.Kim }, owner);
  await run(db, "program.publish", { program_id: paid }, owner);
  await run(db, "enrolment.comp", { program_id: paid, person_id: people.Fay, note: "On the house" }, owner);
  await run(db, "enrolment.join", { program_id: paid, person_id: people.Ann }, owner);
  const place = async (who: string) => (await db.selectFrom("enrolment").select("id").where("program_id", "=", paid).where("person_id", "=", people[who]!).executeTakeFirstOrThrow()).id;
  const owes = await place("Ann"), comped = await place("Fay"), nothing = "00000000-0000-7000-8000-00000000beef";
  const b = (await db.selectFrom("booking").select("id").where("organiser_id", "=", people.Ann!).executeTakeFirstOrThrow()).id;
  const preview = (who: string, action: string, input: unknown) => req(`/actions/${action}/plan`, who, input);
  const tries: [string, (id: string) => unknown, string[]][] = [
    ["enrolment.record_payment", (id) => ({ enrolment_id: id, cents: 999_999, method: "cash" }), [owes, comped, nothing]],
    ["enrolment.remove", (id) => ({ enrolment_id: id, reason: "club" }), [owes, comped, nothing]],
    ["booking.refund", (id) => ({ booking_id: id, payment_id: nothing, cents: 1 }), [b, nothing]],
    ["booking.record_payment", (id) => ({ booking_id: id, cents: 999_999, method: "cash" }), [b, nothing]],
    ["refund.give_back", (id) => ({ refund_id: id }), [nothing]],
    ["credit.pay_out", (id) => ({ person_id: id, cents: 999_999, method: "cash" }), [people.Ann!, nothing]],
    ["membership.record_payment", (id) => ({ membership_id: id, cents: 999_999, method: "cash" }), [nothing]],
    ["gift_card.void", (id) => ({ gift_card_id: id }), [nothing]],
    ["pass.refund", (id) => ({ pass_id: id }), [nothing]],
  ];
  for (const who of ["Kim", "Sam"]) for (const [action, input, rows] of tries) {
    const answers = [];
    for (const id of rows) {
      const r = await preview(who, action, input(id));
      assert.equal(r.status, 403, `${who} ${action} ${id}`); assert.equal(r.json.error, "error.forbidden_reason", `${who} ${action} ${id}`);
      assert.ok(!/\$|30\.00|owed|paid/i.test(r.json.message), `${who} ${action}: ${r.json.message}`);
      answers.push(r.json);
    }
    for (const a of answers) assert.deepEqual(a, answers[0], `${who} ${action}: one and the same no`);
  }
  // Front desk still hears what's owed: the preview works as before for whoever may take the money.
  const desk = await preview("Fay", "enrolment.record_payment", { enrolment_id: owes, cents: 999_999, method: "cash" });
  assert.equal(desk.json.error, "error.more_than_owed_place");
  assert.equal((await preview("Fay", "enrolment.record_payment", { enrolment_id: comped, cents: 100, method: "cash" })).json.error, "error.place_paid_up");
});

test("the Playtomic mirror: no to a coach; a role the club made covering bookings but not money reads it without prices or owners", async () => {
  const { court } = await ids();
  await db.insertInto("connector_status").values({ system: "playtomic", last_sync_at: new Date(), last_ok_at: new Date(), last_error: null, fetched: 1, unmapped: JSON.stringify([]) })
    .onConflict((oc) => oc.column("system").doNothing()).execute();
  await run(db, "connector.map_court", { resource_id: "pt-c", resource_name: "Padel C", court_id: court }, owner);
  const s = new Date(Date.now() + 8 * 864e5);
  await db.insertInto("playtomic_booking").values({ booking_id: "ptb-1", resource_id: "pt-c", resource_name: "Padel C", court_id: court, booking_type: "REGULAR_BOOKING", starts_at: s, ends_at: new Date(s.getTime() + 5400_000),
    price: "40 USD", price_cents: 4000, currency: "USD", payment_status: "PAID", raw: JSON.stringify({}), row_hash: "x" } as any).execute();
  await db.insertInto("playtomic_booking_player").values({ id: "00000000-0000-7000-8000-0000000000f1", booking_id: "ptb-1", participant_id: "u-zed", name: "Zed Owner", is_owner: true } as any).execute();
  for (const who of ["Kim", "Sam"]) { const r = await req("/staff/mirror", who); assert.equal(r.status, 403, who); assert.equal(r.json.error, "error.staff_only", who); }
  const fay = await req("/staff/mirror", "Fay");
  assert.equal(fay.status, 200);
  assert.equal(fay.json.take_over[0].owner, "Zed Owner"); assert.equal(fay.json.take_over[0].price, "40 USD");
  const courts = ((await run(db, "role.create", { name: "Court desk", grants: [{ action: "booking.create", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Cy", [courts]);
  const cy = await req("/staff/mirror", "Cy");
  assert.equal(cy.status, 200);
  assert.equal(cy.json.take_over.length, 1);
  for (const k of ["price", "payment_status", "owner"]) assert.ok(!(k in cy.json.take_over[0]), k);
  assert.ok(!JSON.stringify(cy.json).includes("Zed Owner") && !JSON.stringify(cy.json).includes("40 USD"));
});

test("a coach kept to one location: another location's date, someone else's and one that isn't there all get the one same no", async () => {
  const west = ((await run(db, "location.create", { name: "Westside", time_zone: TZ }, owner)).result as any).location_id;
  await newStaff("Wes", []);
  await run(db, "role.assign", { person_id: people.Wes, role: "coach", location_id: west }, owner);
  const gone = "00000000-0000-7000-8000-00000000dead";
  for (const [a, b] of [[`/staff/sessions/${date}/levels`, `/staff/sessions/${gone}/levels`], [`/staff/sessions/${date}/night`, `/staff/sessions/${gone}/night`],
    [`/staff/roster/session/${date}`, `/staff/roster/session/${gone}`], [`/staff/roster/lesson/${gone}`, "/staff/roster/lesson/nope"]] as const) {
    const x = await req(a, "Wes"), y = await req(b, "Wes");
    assert.equal(x.status, 403, a); assert.equal(y.status, 403, b);
    assert.deepEqual(x.json, y.json, `${a} / ${b}`);
    assert.equal(x.json.error, "error.forbidden_reason", a);
  }
  // Lou, a coach everywhere, hears the same words about Kim's date.
  assert.deepEqual((await req(`/staff/sessions/${date}/night`, "Lou")).json, (await req(`/staff/sessions/${date}/night`, "Wes")).json);
});

// ---- Members' money on the courts day and a person's page: who takes it sees it, everyone else runs the court ----

const GRID_MONEY = ["price_cents", "paid_cents", "balance_cents", "off_cents", "pt_cents"];
test("the courts day: what members paid is for whoever sees or takes the money, not a plain coach or a role covering bookings only", async () => {
  const { loc, court } = await ids(), d = localDate(new Date(Date.now() + 9 * 864e5), TZ);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: onDate(d, "11:00", TZ).toISOString(), minutes: 60, person_id: people.Ann, price_cents: 4000 }, owner)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 1500, method: "cash" }, owner);
  // Kim's own lesson: Kim runs it (who's on it, when, where), and reads nothing of what Ann paid.
  await db.updateTable("booking").set({ coach_id: people.Kim!, kind: "lesson" }).where("id", "=", b).execute();
  const item = async (who: string) => { const r = await req(`/staff/grid?location_id=${loc}&date=${d}`, who); assert.equal(r.status, 200, who); return { money: r.json.money, it: r.json.courts[0].items.find((x: any) => x.booking_id === b) }; };
  const desk = ((await run(db, "role.create", { name: "Court runner", grants: [{ action: "booking.create", scope: "any" }] }, owner)).result as any).key;
  const till = ((await run(db, "role.create", { name: "Court till", grants: [{ action: "booking.record_payment", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Rue", [desk]); await newStaff("Tia", [till]);
  for (const who of ["Kim", "Rue"]) {
    const { money, it } = await item(who);
    assert.equal(money, false, who);
    assert.ok(it, who); assert.equal(it.who, "Ann", who); assert.ok(it.start && it.end, who);
    for (const k of GRID_MONEY) assert.ok(!(k in it), `${who} ${k}`);
  }
  for (const who of ["Fay", "Tia"]) {
    const { money, it } = await item(who);
    assert.equal(money, true, who);
    assert.equal(it.price_cents, 4000, who); assert.equal(it.paid_cents, 1500, who);
  }
});

test("a person's page for a role the club made that takes members' money: what's due, pay and refund controls; a coach still none", async () => {
  const deskRole = ((await run(db, "role.create", { name: "Membership desk", grants: [{ action: "membership.record_payment", scope: "any" }, { action: "membership.sell", scope: "any" }, { action: "person.tag", scope: "any" }] }, owner)).result as any).key;
  const refunds = ((await run(db, "role.create", { name: "Refunds", grants: [{ action: "booking.refund", scope: "any" }, { action: "person.tag", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Mo", [deskRole]); await newStaff("Rex", [refunds]);
  const plan = ((await run(db, "membership.plan_set", { name: "Owing", price_cents: 6000, period: "month" }, owner)).result as any).plan_id;
  people.Pia = ((await run(db, "person.create", { display_name: "Pia", email: "pia@example.test" }, owner)).result as any).person_id;
  await run(db, "membership.sell", { person_id: people.Pia, plan_id: plan, cents: 2000, method: "cash" }, owner);
  const { court } = await ids(), d = localDate(new Date(Date.now() + 10 * 864e5), TZ);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: onDate(d, "12:00", TZ).toISOString(), minutes: 60, person_id: people.Pia, price_cents: 3000 }, owner)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 3000, method: "cash" }, owner);
  const mo = await req(`/staff/people/${people.Pia}`, "Mo");
  assert.equal(mo.status, 200);
  assert.equal(mo.json.money, true);
  assert.ok(mo.json.membership.due, "the membership desk sees what's due");
  assert.ok("balance_cents" in mo.json.membership);
  assert.ok((await req("/me", "Mo")).json.can.includes("membership.record_payment"), "and is offered the membership desk");
  const rex = await req(`/staff/people/${people.Pia}`, "Rex");
  assert.equal(rex.json.money, true);
  const row = rex.json.bookings.find((x: any) => x.id === b);
  assert.ok(Array.isArray(row.refundable), "a refund role keeps the refund buttons");
  assert.equal(row.paid_cents, 3000);
  // A plain coach still reads none of it (Ann is Kim's student).
  const kim = await req(`/staff/people/${people.Ann}`, "Kim");
  assert.equal(kim.json.money, false);
  assert.ok(!("due" in (kim.json.membership ?? {})));
  for (const r of kim.json.bookings) assert.ok(!("refundable" in r) && !("paid_cents" in r));
});

test("a membership behind on payment reads as running to someone without money", async () => {
  await db.updateTable("membership").set({ status: "past_due" }).where("person_id", "=", people.Ann!).execute();
  const kim = await req(`/staff/people/${people.Ann}`, "Kim"), fay = await req(`/staff/people/${people.Ann}`, "Fay");
  assert.equal(fay.json.membership.status, "past_due");
  assert.equal(kim.json.membership.status, "active");
  assert.ok(!("card_saved" in kim.json.membership));
  await db.updateTable("membership").set({ status: "active" }).where("person_id", "=", people.Ann!).execute();
});

test("a coach who also holds a club-made Comms role is offered New message; the Playtomic link follows the server's rule", async () => {
  const comms = ((await run(db, "role.create", { name: "Comms", grants: [{ action: "broadcast.send", scope: "any" }, { action: "broadcast.cancel", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Camila", ["coach", comms]);
  const cam = (await req("/me", "Camila")).json;
  assert.ok(cam.can.includes("broadcast.send"), JSON.stringify(cam.can));
  assert.equal(cam.playtomic, false);
  // A coach with a club-made role covering bookings may read the mirror, and is shown the link; a plain coach isn't.
  const books = ((await run(db, "role.create", { name: "Court booker", grants: [{ action: "booking.create", scope: "any" }] }, owner)).result as any).key;
  await newStaff("Cato", ["coach", books]);
  assert.equal((await req("/me", "Cato")).json.playtomic, true);
  assert.equal((await req("/staff/mirror", "Cato")).status, 200);
  assert.equal((await req("/me", "Kim")).json.playtomic, false);
  assert.equal((await req("/me", "Fay")).json.playtomic, true);
  assert.equal((await req("/me", "Robin")).json.playtomic, true);
});
