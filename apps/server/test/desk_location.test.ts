// A front desk kept to one location (Kelly, 8 Nov 2026): it handles the alerts that aren't about one place and its own
// location's, answers members' questions and sets levels; the whole club's own things (messages to groups, the
// groups, message templates, the club's facts, someone's data) stay with managers and the owner, refused in words
// that say who does them, and the staff app is told which buttons to hide. A desk with no location keeps it all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const fact = { topic: "parking", question_en: "Where do I park?", answer_en: "Behind the club.", question_es: "¿Dónde aparco?", answer_es: "Detrás del club." };
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, east: string, west: string, westCourt: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {}, people: Record<string, string> = {};
const day = () => localDate(new Date(Date.now() + 2 * 86400_000), TZ);
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
/** A staff alert for these people, from an event with this payload. */
async function alert(kind: string, payload: object, subject: string, to: string[]) {
  const ev = await db.insertInto("event_outbox").values({ topic: "test.alert", payload: JSON.stringify(payload), delivered_at: new Date() }).returning("id").executeTakeFirstOrThrow();
  for (const p of to) await db.insertInto("outbound_message").values({ id: uuidv7(), event_id: ev.id, person_id: p, kind, channel: "inbox", purpose: "staff",
    essential: false, lang: "en", subject, body: "-", link: "/", status: "sent", send_after: new Date(), sent_at: new Date(), stale_at: null, failure: null, read_at: null }).execute();
  return ev.id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  east = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  west = ((await run(db, "location.create", { name: "Westside", time_zone: TZ }, owner)).result as any).location_id;
  westCourt = ((await run(db, "court.create", { location_id: west, name: "West 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: west, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  for (const name of ["Ann", "Lee", "Dana"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  // Lee: the front desk at Eastside only. Dana: the front desk with no location.
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk", location_id: east }, owner);
  await run(db, "role.assign", { person_id: people.Dana, role: "front_desk" }, owner);
  await run(db, "consent.club_news", { person_id: people.Ann, granted: true }, { personId: people.Ann!, via: "test", lang: "en" });
  await signIn("Robin", "robin@example.test"); await signIn("Lee", "lee@example.test"); await signIn("Dana", "dana@example.test"); await signIn("Ann", "ann@example.test");
});
after(async () => drop());

test("Eastside's desk handles an alert of no place, not Westside's, and the list says which", async () => {
  const anywhere = await alert("refund_failed", {}, "A refund didn't go through", [owner.personId!, people.Lee!]);
  const b = ((await run(db, "booking.create", { court_id: westCourt, starts_at: `${day()}T18:00:00-08:00`, minutes: 60, person_id: people.Ann }, owner)).result as any).booking_id;
  const westside = await alert("booking_balance_due_staff", { booking_id: b }, "Money owed at Westside", [owner.personId!, people.Lee!]);
  const list = (await get("Lee", "/staff/alerts")).json.open as { event_id: string; can_handle: boolean }[];
  assert.deepEqual(Object.fromEntries(list.map((a) => [a.event_id, a.can_handle])), { [anywhere]: true, [westside]: false });
  const no = await post("Lee", "/actions/alert.handle/plan", { event_id: westside, kind: "booking_balance_due_staff" });
  assert.equal(no.status, 403);
  assert.match(JSON.stringify(no.json), /your role doesn't cover this location/);
  const p = await post("Lee", "/actions/alert.handle/plan", { event_id: anywhere, kind: "refund_failed" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await post("Lee", `/runs/${p.json.run_id}/apply`)).status, 200);
  // The owner handles Westside's.
  assert.equal((await get("Robin", "/staff/alerts")).json.open.find((a: any) => a.event_id === westside).can_handle, true);
});

test("Eastside's desk answers a member's question and sets a level (asking, as every desk does)", async () => {
  const q = await run(db, "question.ask", { person_id: people.Ann!, body: "Is there parking at the club?" }, { personId: people.Ann!, via: "test", lang: "en" });
  const qid = (q.result as { question_id: string }).question_id;
  const a = await post("Lee", "/actions/question.answer/plan", { question_id: qid, body: "Yes, behind the club." });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal((await post("Lee", `/runs/${a.json.run_id}/apply`)).status, 200);
  const l = await post("Lee", "/actions/level.set/plan", { person_id: people.Ann, level: 3.5, reason: "Played with her tonight" });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal(l.json.status, "awaiting_approval");
});

test("the whole club's own things: refused in words, and named in /me so the buttons hide", async () => {
  const words = { subject_en: "Courts closed Sunday", body_en: "For the resurfacing.", subject_es: "Pistas cerradas el domingo", body_es: "Por el nuevo suelo." };
  const tries: [string, object, RegExp][] = [
    ["broadcast.send", { purpose: "club_news", filters: {}, ...words }, /messages to a group of members are sent by staff who cover the whole club/],
    ["template.save", { name: "Closed", ...words }, /message templates are kept by staff who cover the whole club/],
    ["fact.create", fact, /the club's facts are kept by staff who cover the whole club/],
    ["privacy.export", { person_id: people.Ann }, /downloading someone's data or deleting their account is done by staff who cover the whole club/],
  ];
  for (const [action, input, says] of tries) {
    const r = await post("Lee", `/actions/${action}/plan`, input);
    assert.equal(r.status, 403, `${action}: ${JSON.stringify(r.json)}`);
    assert.match(JSON.stringify(r.json), says, action);
    assert.doesNotMatch(JSON.stringify(r.json), /doesn't cover this location/, action);
  }
  const lee = (await get("Lee", "/me")).json;
  for (const a of ["broadcast.send", "broadcast.cancel", "segment.save", "segment.update", "template.save", "template.update", "fact.create", "fact.update", "privacy.export", "privacy.erase", "tag.update"])
    assert.ok(lee.cannot.includes(a), a);
  for (const a of ["question.answer", "alert.handle", "tag.create", "person.tag"]) assert.ok(!lee.cannot.includes(a), a);
  // In Spanish (Lee reads Spanish for a moment), the same refusal.
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Lee!).execute();
  const es = await post("Lee", "/actions/fact.create/plan", fact);
  await db.updateTable("person").set({ locale: "en" }).where("id", "=", people.Lee!).execute();
  assert.equal(es.json.message, "No puedes hacer eso: las respuestas del club las gestiona alguien del equipo que lleva todo el club.");
});

test("Eastside's desk adds a tag, as tagging a person already can; renaming or removing one is the whole club's", async () => {
  const c = await post("Lee", "/actions/tag.create/plan", { name: "Beginners" });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal((await post("Lee", `/runs/${c.json.run_id}/apply`)).status, 200);
  const tag = await db.selectFrom("tag").select("id").where("name", "=", "Beginners").executeTakeFirstOrThrow();
  for (const input of [{ tag_id: tag.id, name: "Starters" }, { tag_id: tag.id, active: false }]) {
    const r = await post("Lee", "/actions/tag.update/plan", input);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.message, "You can't do that: the club's tags are renamed or removed by staff who cover the whole club.");
  }
  assert.equal((await post("Dana", "/actions/tag.update/plan", { tag_id: tag.id, name: "Starters" })).status, 200);
});

test("a desk with no location keeps what it has: the club's facts and messages, and nothing hidden", async () => {
  assert.deepEqual((await get("Dana", "/me")).json.cannot, []);
  const f = await post("Dana", "/actions/fact.create/plan", fact);
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal((await get("Robin", "/me")).json.cannot.length, 0);
});

test("Eastside's desk still previews and confirms what's Eastside's for a member (cancelling a court, a sign-up), and still not Westside's", async () => {
  const eastCourt = ((await run(db, "court.create", { location_id: east, name: "East 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: east, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  const booked = async (court: string) => ((await run(db, "booking.create", { court_id: court, starts_at: `${day()}T19:00:00-08:00`, minutes: 60, person_id: people.Ann }, owner)).result as any).booking_id as string;
  const mine = await booked(eastCourt), theirs = await booked(westCourt);
  // Whose these are is asked before the preview now, at the booking's location: Eastside's desk keeps Eastside's.
  const c = await post("Lee", "/actions/booking.cancel/plan", { booking_id: mine });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal((await post("Lee", `/runs/${c.json.run_id}/apply`)).status, 200);
  const clinic = ((await run(db, "program.create", { location_id: east, kind: "clinic", name: "Eastside Clinic", capacity: 8, price_cents: 0 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: `${day()}T10:00:00-08:00`, ends_at: `${day()}T11:00:00-08:00`, court_ids: [eastCourt] }, owner);
  await run(db, "program.publish", { program_id: clinic }, owner);
  const j = await post("Lee", "/actions/enrolment.join/plan", { program_id: clinic, person_id: people.Ann });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  assert.equal((await post("Lee", `/runs/${j.json.run_id}/apply`)).status, 200);
  // Westside's is still refused for where it is, as it was; a booking that isn't there is still "not found".
  const w = await post("Lee", "/actions/booking.cancel/plan", { booking_id: theirs });
  assert.equal(w.status, 403);
  assert.match(JSON.stringify(w.json), /your role doesn't cover this location/);
  assert.equal((await post("Lee", "/actions/booking.cancel/plan", { booking_id: "00000000-0000-7000-8000-00000000abcd" })).status, 404);
  assert.equal((await post("Dana", "/actions/booking.cancel/plan", { booking_id: theirs })).status, 200);
});
