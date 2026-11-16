import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, c1: string, c2: string, booking: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {}, people: Record<string, string> = {};
// The next half hour at least half an hour from now: the server reads use the real clock.
const START = new Date(Math.ceil((Date.now() + 30 * 60_000) / 1800_000) * 1800_000);
const get = async (who: string, path: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
const post = async (who: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
const change = async (who: string, action: string, input: unknown) => {
  const p = await post(who, `/actions/${action}/plan`, input);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  return { plan: p.json, applied: await post(who, `/runs/${p.json.run_id}/apply`, {}, { "idempotency-key": p.json.run_id }) };
};
async function signIn(who: string, email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[who] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  for (const name of ["Ann", "Lee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner);
  await signIn("Lee", "lee@example.test");
  booking = ((await run(db, "booking.create", { court_id: c1, starts_at: START.toISOString(), minutes: 30, places: [{ person_id: people.Ann }, { guest_name: "Jo" }] }, owner)).result as any).booking_id;
});
after(async () => drop());

test("Today's now and next: who's checked in on each booking, and checking them in from it", async () => {
  const row = () => get("Lee", "/staff/today").then((r) => r.json.next.items.find((x: any) => x.id === booking));
  const before = await row();
  assert.deepEqual([before.kind, before.court, before.title, before.places, before.checked_in, before.check_in_open], ["booking", "Court 1", "Ann", 2, 0, true]);
  const { plan, applied } = await change("Lee", "booking.check_in", { booking_id: booking });
  assert.match(plan.summary, /^Check in all 2 players for Court 1 at .+: .+\. Nobody is told, and no money moves\.$/);
  assert.equal(applied.status, 200);
  assert.equal((await row()).checked_in, 2);
  // The Schedule says the same, place by place, guests too.
  const g = (await get("Lee", `/staff/grid?location_id=${loc}&date=${localDate(START, TZ)}`)).json;
  const it = g.courts.find((c: any) => c.id === c1).items.find((x: any) => x.booking_id === booking);
  assert.deepEqual(it.arrivals.map((a: any) => [a.name, a.guest, a.in]).sort(), [["Ann", false, true], ["Jo", true, true]]);
});

test("blocking the court: the preview comes row by row, and the booking moves", async () => {
  const end = new Date(START.getTime() + 60 * 60_000);
  const { plan, applied } = await change("Lee", "court.block", { court_ids: [c1], starts_at: START.toISOString(), ends_at: end.toISOString(), reason: "fault", move_bookings: true });
  assert.deepEqual(plan.rows.map((r: any) => r.label), ["Block", "Moves", "Messages", "Money"]);
  assert.match(plan.rows[1].text, /\(Ann\) at .+ moves from Court 1 to Court 2, same time\.$/);
  assert.equal(applied.status, 200);
  assert.equal((await db.selectFrom("court_time").select("court_id").where("booking_id", "=", booking).where("active", "=", true).executeTakeFirstOrThrow()).court_id, c2);
});
