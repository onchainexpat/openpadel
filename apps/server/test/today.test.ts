import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, c1: string, c2: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {}, people: Record<string, string> = {};
// Tomorrow in the club's time, so the test works on any day.
const day = () => localDate(new Date(Date.now() + 86400_000), TZ);
const at = (hhmm: string) => new Date(`${day()}T${hhmm}:00${new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).format(new Date(`${day()}T12:00:00Z`)).slice(-6)}`).toISOString();
const get = async (who: string, path: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
const post = async (who: string, path: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
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
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  for (const name of ["Ann", "Lee", "Fran"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner);
  // A role the club made: tagging members, nothing else.
  const role = ((await run(db, "role.create", { name: "Tagger", grants: [{ action: "person.tag", scope: "any" }] }, owner)).result as any).key;
  await run(db, "role.assign", { person_id: people.Fran, role }, owner);
  await signIn("Robin", "robin@example.test"); await signIn("Lee", "lee@example.test"); await signIn("Fran", "fran@example.test");
});
after(async () => drop());

test("the Today view's day: who's playing, what's paid net of refunds, running-late word, and the server's clock", async () => {
  const b = ((await run(db, "booking.create", { court_id: c1, starts_at: at("10:00"), minutes: 90, person_id: people.Ann }, owner)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 2000, method: "cash" }, owner);
  // What a player said through the app (booking.running_late) is an event: it shows on the booking that day.
  await db.insertInto("event_outbox").values({ topic: "booking.running_late", payload: JSON.stringify({ booking_id: b, person_id: people.Ann, minutes: 10 }), created_at: new Date(new Date(at("09:30")).getTime()), delivered_at: new Date() }).execute();
  const g = (await get("Lee", `/staff/grid?location_id=${loc}&date=${day()}`)).json;
  assert.equal(g.date, day()); assert.ok(g.now && g.today);
  const it = g.courts.find((c: any) => c.id === c1).items[0];
  assert.deepEqual([it.booking_kind, it.open_match, it.status, it.players, it.price_cents, it.paid_cents], ["court", false, "confirmed", ["Ann"], 6000, 2000]);
  assert.deepEqual(it.late.map((l: any) => [l.name, l.minutes]), [["Ann", 10]]);

  // Moved to Court 2 through the same preview and confirm as every change.
  const p = await post("Lee", "/actions/booking.move/plan", { booking_id: b, court_id: c2, starts_at: at("11:00") });
  assert.equal(p.status, 200);
  assert.match(p.json.summary, /from Court 1, .* 10:00 AM to Court 2, .* 11:00 AM\. The price stays as it was\. The players are told\.$/);
  assert.equal((await post("Lee", `/runs/${p.json.run_id}/apply`)).status, 200);
  const moved = (await get("Lee", `/staff/grid?location_id=${loc}&date=${day()}`)).json;
  assert.equal(moved.courts.find((c: any) => c.id === c1).items.length, 0);
  assert.equal(moved.courts.find((c: any) => c.id === c2).items[0].booking_id, b);
});

test("a program date on the day says its program's kind, so the Schedule colours a clinic apart from a league", async () => {
  const league = ((await run(db, "program.create", { location_id: loc, kind: "league", name: "Monday League", capacity: 8, price_cents: 0 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: league, starts_at: at("18:00"), ends_at: at("19:30"), court_ids: [c2] }, owner);
  const g = (await get("Lee", `/staff/grid?location_id=${loc}&date=${day()}`)).json;
  const it = g.courts.find((c: any) => c.id === c2).items.find((x: any) => x.session_id);
  assert.deepEqual([it.label, it.program_kind, it.program_id], ["Monday League", "league", league]);
});

test("alerts: the staff messages that need someone, until one of them marks it handled", async () => {
  const ev = await db.insertInto("event_outbox").values({ topic: "refund.failed", payload: JSON.stringify({}), delivered_at: new Date() }).returning("id").executeTakeFirstOrThrow();
  for (const to of [owner.personId!, people.Lee!]) await db.insertInto("outbound_message").values({ id: uuidv7(), event_id: ev.id, person_id: to, kind: "refund_failed", channel: "inbox", purpose: "staff",
    essential: false, lang: "en", subject: "A refund didn't go through", body: "$20.00 for Ann.", link: "/", status: "sent", send_after: new Date(), sent_at: new Date(), stale_at: null, failure: null, read_at: null }).execute();
  assert.deepEqual((await get("Robin", "/staff/alerts")).json.open.map((a: any) => a.subject), ["A refund didn't go through"]);
  const p = await post("Lee", "/actions/alert.handle/plan", { event_id: ev.id, kind: "refund_failed" });
  assert.equal(p.json.summary, "Mark this as handled for everyone: A refund didn't go through");
  await post("Lee", `/runs/${p.json.run_id}/apply`);
  const robin = (await get("Robin", "/staff/alerts")).json;
  assert.deepEqual([robin.open.length, robin.handled[0].handled_by], [0, "Lee"]);
});

test("someone with only the club's own role: told which changes their role allows, and kept out of the day", async () => {
  const fran = (await get("Fran", "/me")).json;
  assert.deepEqual(fran.areas, ["members"]);
  assert.deepEqual(fran.can, ["person.tag"]);   // tagging someone on their page, and none of the buttons that add, import, book or move
  assert.equal((await get("Fran", `/staff/grid?location_id=${loc}&date=${day()}`)).status, 403);
  assert.equal((await get("Fran", "/staff/alerts")).status, 403);
  assert.equal((await get("Lee", "/me")).json.can, null);   // a built-in role: what it always had
  // + Create on the Schedule offers what any role allows, built-in ones included: the desk books courts and lessons and
  // blocks courts but doesn't make programs; the owner makes everything; the club's own tagging role makes nothing.
  assert.deepEqual((await get("Lee", "/me")).json.creates, ["booking.create", "booking.create_lesson", "booking.repeat", "court.block"]);
  assert.deepEqual((await get("Robin", "/me")).json.creates, ["program.create", "booking.create", "booking.create_lesson", "booking.repeat", "court.block"]);
  assert.deepEqual(fran.creates, []);
});
