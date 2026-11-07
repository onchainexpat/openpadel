// A person's Playtomic history on their staff page (playtomic_archive.ts): front desk and up see who they played with in
// Playtomic; a coach sees no more than in the person's own bookings list, so not the others' names.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { archiveBookings, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { sql } from "kysely";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  for (const [name, role] of [["Ann", null], ["Cora", "coach"], ["Dana", "front_desk"]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) await run(db, "role.assign", { person_id: people[name], role }, owner);
    await signIn(`${name.toLowerCase()}@example.test`);
  }
  // Ann is Cora's student: a lesson with her last week.
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  const lesson = uuidv7(), ls = new Date(Date.now() - 5 * 86400_000);
  await db.insertInto("booking").values({ id: lesson, code: "KP-LESS", location_id: loc, kind: "lesson", coach_id: people.Cora!, organiser_id: people.Ann!, status: "confirmed", source: "desk", price_cents: 5000 } as any).execute();
  await db.insertInto("booking_player").values({ id: uuidv7(), booking_id: lesson, person_id: people.Ann!, share_cents: 5000 } as any).execute();
  await db.insertInto("court_time").values({ id: uuidv7(), court_id: court, during: sql`tstzrange(${ls}, ${new Date(ls.getTime() + 3600_000)})`, kind: "booking", booking_id: lesson } as any).execute();
  const start = new Date(Date.now() - 20 * 86400_000), end = new Date(start.getTime() + 90 * 60_000);
  await archiveBookings(db, [{ booking_id: "h1", resource_id: "pt-1", resource_name: "Padel 1", booking_start_date: start.toISOString().slice(0, 19), booking_end_date: end.toISOString().slice(0, 19),
    duration: 0, price: "40 USD", booking_type: "REGULAR_BOOKING", payment_status: "PAID", is_canceled: false,
    participant_info: { owner_id: "u-ann", participants: [{ participant_id: "u-ann", name: "Ann", email: "ann@example.test" }, { participant_id: "u-x", name: "Xavi Outside", email: "xavi@example.test" }] } }]);
});
after(async () => drop());

test("front desk sees who a person played with in Playtomic; a coach sees the booking without the others' names", async () => {
  const desk = await get(`/staff/people/${people.Ann}`, "dana@example.test");
  assert.equal(desk.status, 200);
  assert.deepEqual(desk.json.playtomic.map((b: any) => b.others), [["Xavi Outside"]]);
  const coach = await get(`/staff/people/${people.Ann}`, "cora@example.test");
  assert.equal(coach.status, 200, "her own student's page");
  assert.deepEqual(coach.json.playtomic.map((b: any) => [b.court, b.others]), [["Padel 1", []]]);
});
