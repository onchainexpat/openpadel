// The person page's top and the Levels page's tabs: the phone (in full for the desk, shortened for anyone else), what's
// coming up, their latest question for the desk; every player's level, staff's level changes with their undo, and the
// numbers the level rules run on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, REVIEW_EVERY_DAYS, SELF_ADJUST_GAMES, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, session: string, program: string;
const TZ = "America/Los_Angeles";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const req = async (path: string, who: string) => {
  const r = await app.request(path, { headers: { cookie: cookies[who]! } });
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
  people.Robin = owner.personId!;
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  for (const name of ["Ann", "Kim", "Fay", "Acc"]) people[name] = ((await run(db, "person.create", { display_name: name === "Ann" ? "Ann Ruiz" : name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  for (const [who, role] of [["Kim", "coach"], ["Fay", "front_desk"], ["Acc", "accountant"]] as const) await run(db, "role.assign", { person_id: people[who], role }, owner);
  for (const name of ["Robin", "Kim", "Fay", "Acc"]) await signIn(name);
  await db.updateTable("person").set({ phone: "+14155550142" }).where("id", "=", people.Ann!).execute();
  program = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley Clinic", capacity: 8, price_cents: 0 }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 2 * 864e5);
  session = ((await run(db, "session.add", { program_id: program, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court], coach_id: people.Kim }, owner)).result as any).session_id;
  await run(db, "program.publish", { program_id: program }, owner);
  await run(db, "enrolment.join", { program_id: program, person_id: people.Ann }, { personId: people.Ann!, via: "test", lang: "en" });
});
after(async () => drop());

test("a person's page: the phone in full for the desk and up, its last two digits for the accountant, and what's coming up", async () => {
  for (const who of ["Robin", "Fay"]) {
    const p = (await req(`/staff/people/${people.Ann}`, who)).json;
    assert.equal(p.phone, "+14155550142", who);
    assert.equal(p.contact_short, false, who);
  }
  const acc = (await req(`/staff/people/${people.Ann}`, "Acc")).json;
  assert.equal(acc.phone, "...42");
  assert.equal(acc.contact_short, true);
  // The clinic's date coming up, with its program.
  const p = (await req(`/staff/people/${people.Ann}`, "Fay")).json;
  assert.deepEqual(p.coming.map((x: any) => [x.id, x.program_id, x.name]), [[session, program, "Volley Clinic"]]);
  // Nobody's phone: nothing to shorten, and nothing said about it.
  const kim = (await req(`/staff/people/${people.Kim}`, "Acc")).json;
  assert.equal(kim.phone, null);
  assert.equal(kim.contact_short, false);
});

test("a person's latest question is on their page for the desk (who answer questions), not for the accountant", async () => {
  const id = uuidv7();
  await db.insertInto("question").values({ id, person_id: people.Ann!, asked_by: people.Ann! }).execute();
  assert.deepEqual((await req(`/staff/people/${people.Ann}`, "Fay")).json.question, { id, status: "open" });
  assert.equal((await req(`/staff/people/${people.Ann}`, "Acc")).json.question, null);
});

test("Levels: every player's level by name, staff's changes newest first with their undo, and the rules' numbers", async () => {
  await run(db, "level.set", { person_id: people.Ann, level: 3.2, reason: "Starting level" }, owner);
  await run(db, "level.set", { person_id: people.Kim, level: 4.1, reason: "Coach's own" }, owner);
  await run(db, "level.set_floor", { person_id: people.Ann, floor: 3.0, reason: "After the assessment" }, owner);
  const all = (await req("/staff/levels/players", "Robin")).json;
  assert.equal(all.total, 2);
  assert.deepEqual(all.rows.map((r: any) => [r.name, r.level, r.floor]), [["Ann Ruiz", "3.20", "3.00"], ["Kim", "4.10", null]]);
  assert.deepEqual((await req("/staff/levels/players?q=ruiz", "Robin")).json.rows.map((r: any) => r.name), ["Ann Ruiz"]);
  assert.equal((await req("/staff/levels/players?q=%25", "Robin")).json.total, 0);   // a % is a letter here, not "anything"
  const ch = (await req("/staff/levels/changes", "Robin")).json;
  assert.deepEqual(ch.map((c: any) => [c.name, c.kind, c.before, c.after, c.by]),
    [["Ann Ruiz", "floor", "3.20", "3.20", "Robin Hale"], ["Kim", "staff_set", null, "4.10", "Robin Hale"], ["Ann Ruiz", "staff_set", null, "3.20", "Robin Hale"]]);
  assert.ok(ch.every((c: any) => c.can_undo && !c.undone && c.run_id));
  assert.match(ch[0].explanation, /After the assessment/);
  // Undone: still listed, said to be undone, and not offered again (the undo itself isn't a change by staff here).
  await run(db, "level.set", { person_id: people.Kim, level: 4.3, reason: "After a lesson" }, owner);
  const second = (await req("/staff/levels/changes", "Robin")).json[0];
  assert.deepEqual([second.name, second.before, second.after], ["Kim", "4.10", "4.30"]);
  await run(db, "action.undo", { run_id: second.run_id }, owner);
  const after = (await req("/staff/levels/changes", "Robin")).json;
  assert.equal(after.length, 4);
  assert.deepEqual([after[0].run_id, after[0].undone, after[0].can_undo], [second.run_id, true, false]);
  const q = (await req("/staff/levels", "Robin")).json;
  assert.deepEqual([q.rules.review_days, q.rules.self_adjust_games, q.rules.import_line], [REVIEW_EVERY_DAYS, SELF_ADJUST_GAMES, 4.5]);
  // Read with the queue: a coach reads levels; someone without a staff role doesn't.
  assert.equal((await req("/staff/levels/players", "Kim")).status, 200);
  assert.equal((await req("/staff/levels/changes", "Kim")).status, 200);
  await signIn("Ann");
  assert.equal((await req("/staff/levels/players", "Ann")).status, 403);
  assert.equal((await req("/staff/levels/changes", "Ann")).status, 403);
});
