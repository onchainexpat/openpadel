import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, app: ReturnType<typeof makeApp>, drop: () => Promise<void>, owner: Actor, loc: string, court: string, social: string, full: string;
const TZ = "America/Los_Angeles";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const day = (n: number, h: number) => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(h, 0, 0, 0); return d; };
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
/** Preview an action as `who` and confirm it, as the apps do. */
async function act(who: string, name: string, input: unknown) {
  const p = await req(`/actions/${name}/plan`, who, input);
  if (p.status !== 200) return p;
  return req(`/runs/${p.json.run_id}/apply`, who, {});
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  for (const name of ["Ann", "Ben", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(name);
  }
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
  people.Robin = owner.personId!;
  await signIn("Robin");
  // A free social that needs 4 to run (a draft, then published), and a free clinic with one place.
  social = ((await run(db, "program.create", { location_id: loc, kind: "social", name: "Friday social", capacity: 8, price_cents: 0, min_players: 4 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: social, starts_at: day(5, 2).toISOString(), ends_at: day(5, 4).toISOString(), court_ids: [court], weeks: 2 }, owner);
  full = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Tiny clinic", capacity: 1, price_cents: 0 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: full, starts_at: day(3, 18).toISOString(), ends_at: day(3, 19).toISOString(), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: full }, owner);
  await run(db, "enrolment.join", { program_id: full, person_id: people.Ann }, { personId: people.Ann!, via: "test", lang: "en" });
});
after(async () => drop());

test("a draft's preview: the card members will see, its dates, nothing in the way; staff only", async () => {
  const r = await req(`/staff/programs/${social}/preview`, "Robin");
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.card.name, r.json.card.min_players, r.json.card.booked, r.json.card.my_basis, r.json.dates.length, r.json.dates[0].courts, r.json.blocks, r.json.warnings],
    ["Friday social", 4, 0, "full", 2, ["Court 1"], [], []]);
  assert.equal((await req(`/staff/programs/${social}/preview`, "Ann")).status, 403);
  assert.equal((await req(`/staff/programs/${social}`, "Robin")).json.decide_hours, 24);
});

test("publishing, then What's On shows how many more it needs to run", async () => {
  assert.equal((await act("Robin", "program.publish", { program_id: social })).status, 200);
  await act("Ann", "enrolment.join", { program_id: social, person_id: people.Ann });
  const mine = (await req("/open-programs", "Ben")).json.find((p: any) => p.id === social);
  assert.deepEqual([mine.min_players, mine.booked, mine.my_watch], [4, 1, null]);
});

test("watching a full program from What's On, and stopping", async () => {
  const w = await act("Ben", "program.watch", { program_id: full, person_id: people.Ben });
  assert.equal(w.status, 200);
  const row = (await req("/open-programs", "Ben")).json.find((p: any) => p.id === full);
  assert.equal(row.my_watch, w.json.result.watch_id);
  assert.equal((await act("Ann", "program.unwatch", { watch_id: row.my_watch })).status, 403);   // someone else's
  assert.equal((await act("Ben", "program.unwatch", { watch_id: row.my_watch })).status, 200);
  assert.equal((await req("/open-programs", "Ben")).json.find((p: any) => p.id === full).my_watch, null);
});

test("editing and cancelling dates are for owners and managers; front desk can't", async () => {
  const date = (await req(`/staff/programs/${social}`, "Robin")).json.sessions[1].id;
  assert.equal((await req("/actions/series.edit/plan", "Fay", { session_id: date, scope: "this", minutes: 90 })).status, 403);
  const p = await req("/actions/series.edit/plan", "Robin", { session_id: date, scope: "this", minutes: 90 });
  assert.equal(p.status, 200);
  assert.match(p.json.summary, /^Change one date of Friday social: .* 90 minutes, on Court 1\. Signed up \(1\): Ann\. They're told\.$/);
  assert.equal((await req("/actions/series.cancel/plan", "Fay", { session_id: date, scope: "this" })).status, 403);
  const c = await act("Robin", "series.cancel", { session_id: date, scope: "this" });
  assert.deepEqual(c.json.result, { cancelled: 1, program_cancelled: false });
  assert.equal((await req(`/staff/programs/${social}`, "Robin")).json.sessions[1].status, "cancelled");
});

test("the club's defaults for minimums are in Settings", async () => {
  const s = await req("/staff/settings", "Robin");
  assert.deepEqual([s.json.club.program_decide_hours, s.json.club.program_heads_up_hours], [24, 24]);
  assert.equal((await act("Robin", "club.update", { program_decide_hours: 48, program_heads_up_hours: 0 })).status, 200);
  assert.deepEqual(Object.values((await req("/staff/settings", "Robin")).json.club).slice(-2), [48, 0]);
});
