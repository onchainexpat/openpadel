// The staff app's Today page, Approvals page and menu counts (today.ts): each part only where the reader's roles read
// it. The owner reads everything with names; the accountant the money, no questions or asks; a coach on their own
// nothing; a role the club made covering bookings only sees counts and times with no one's name, and an ask's title in
// place of its summary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, onDate, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { sql } from "kysely";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc = "", court = "", ask = "";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const as = (who: string) => `${who.toLowerCase()}@example.test`;
/** A court booking held straight in the database (as a booking made earlier today would be), owed in full. */
async function bookedToday(personId: string, starts: Date, cents: number) {
  const id = uuidv7(), code = `KP-${id.slice(-4).toUpperCase()}`;
  await db.insertInto("booking").values({ id, code, location_id: loc, kind: "court", organiser_id: personId, status: "confirmed", source: "desk", price_cents: cents } as any).execute();
  await db.insertInto("booking_player").values({ id: uuidv7(), booking_id: id, person_id: personId, share_cents: cents } as any).execute();
  await db.insertInto("court_time").values({ id: uuidv7(), court_id: court, during: sql`tstzrange(${starts}, ${new Date(starts.getTime() + 3600_000)})`, kind: "booking", booking_id: id } as any).execute();
  return id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  await signIn("robin@example.test");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 3200 }, owner);
  // Cleo: a role the club made covering bookings only, who may count a game for levels. Ori: one who must ask to.
  const clerk = ((await run(db, "role.create", { name: "Bookings clerk", grants: [{ action: "booking.set_rated", scope: "any" }] }, owner)).result as any).key;
  const asker = ((await run(db, "role.create", { name: "Rating asker", grants: [{ action: "booking.set_rated", scope: "any", approval: true }] }, owner)).result as any).key;
  for (const [name, role] of [["Annabel", null], ["Cora", "coach"], ["Dana", "front_desk"], ["Acc", "accountant"], ["Cleo", clerk], ["Orinoco", asker]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: as(name) }, owner)).result as any).person_id;
    if (role) { await run(db, "role.assign", { person_id: people[name], role }, owner); await signIn(as(name)); }
  }
  const now = new Date(), today = localDate(now, TZ);
  // Annabel's court today, nothing paid (owed at the desk); a card charge of hers that failed; a disputed score on it.
  const owed = await bookedToday(people.Annabel!, new Date(Math.max(onDate(today, "00:05", TZ).getTime(), now.getTime() - 3600_000)), 4000);
  await db.insertInto("payment").values({ id: uuidv7(), person_id: people.Annabel!, amount_cents: 2500, method: "card", provider: "test", status: "failed" } as any).execute();
  await db.insertInto("game").values({ id: uuidv7(), booking_id: owed, court_id: court, status: "disputed", played_at: now } as any).execute();
  // A member's question handed over to staff.
  await db.insertInto("question").values({ id: uuidv7(), person_id: people.Annabel!, asked_by: people.Annabel!, status: "open" } as any).execute();
  // Cora is off tomorrow, when she's down to run a clinic date.
  const tomorrow = localDate(new Date(now.getTime() + 86400_000), TZ);
  await db.insertInto("coach").values({ person_id: people.Cora! } as any).execute();
  const clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley drills", capacity: 8, price_cents: 2000 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: onDate(tomorrow, "18:00", TZ).toISOString(), ends_at: onDate(tomorrow, "19:00", TZ).toISOString(), court_ids: [court] }, owner);
  await db.updateTable("session").set({ coach_id: people.Cora! }).where("program_id", "=", clinic).execute();
  await db.insertInto("coach_time_off").values({ id: uuidv7(), coach_id: people.Cora!, during: `[${onDate(tomorrow, "00:00", TZ).toISOString()},${onDate(tomorrow, "24:00", TZ).toISOString()})`, note: "sick" } as any).execute();
  // Orinoco asks to count Annabel's court in two days for levels: it waits for a yes from the owner or Cleo.
  const later = localDate(new Date(now.getTime() + 2 * 86400_000), TZ);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: onDate(later, "10:00", TZ).toISOString(), minutes: 60, person_id: people.Annabel }, owner)).result as any).booking_id;
  const r = await app.request("/actions/booking.set_rated/plan", { method: "POST", headers: { cookie: cookies[as("Orinoco")]!, "content-type": "application/json" }, body: JSON.stringify({ booking_id: b, rated: false }) });
  const p = await r.json() as any;
  assert.equal(p.status, "awaiting_approval", JSON.stringify(p));
  ask = p.run_id;
});
after(async () => drop());

const kinds = (j: any) => j.needs.map((n: any) => n.kind).sort();

test("the owner's Today has every need, with names, the takings and the changes since", async () => {
  const r = await get("/staff/today", "robin@example.test");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(kinds(r.json), ["approvals", "cover", "disputes", "failed", "owed", "questions"].sort());
  const need = (k: string) => r.json.needs.find((n: any) => n.kind === k);
  assert.equal(need("owed").count, 1);
  assert.equal(need("owed").items[0].text, "Annabel");
  assert.equal(need("owed").items[0].cents, 4000);
  assert.equal(need("owed").href, "/bookings?status=unpaid");
  assert.equal(need("failed").items[0].text, "Annabel");
  assert.equal(need("cover").items[0].text, "Volley drills");
  assert.match(need("cover").items[0].sub, /Cora/);
  assert.equal(need("approvals").items[0].sub, "Orinoco");
  assert.ok(r.json.takings, "the owner reads the money");
  assert.ok(Array.isArray(r.json.since.changes), "the owner reads Changes, so sees them");
  assert.ok(r.json.since.counts.booked >= 1);
});

test("the menu's counts add up Today's needs and say how many asks and questions wait", async () => {
  const r = await get("/staff/counts", "robin@example.test");
  assert.deepEqual(r.json, { approvals: 1, questions: 1, today: 6, disputes: 1, moving: false });
  // A coach on their own has none of these in their menu.
  assert.deepEqual((await get("/staff/counts", as("Cora"))).json, { approvals: 0, questions: 0, today: 0, disputes: 0, moving: false });
  assert.deepEqual((await get("/staff/today", as("Cora"))).json.needs, []);
});

test("the menu offers Moving in while a move is under way: in practice, or once the club says where it's coming from, until it's finished", async () => {
  const moving = async () => (await get("/staff/counts", "robin@example.test")).json.moving;
  const was = process.env.KUMI_PRACTICE;
  try {
    delete process.env.KUMI_PRACTICE;
    assert.equal(await moving(), false);   // a live club that never started a move
    process.env.KUMI_PRACTICE = "1";
    assert.equal(await moving(), true);    // a new club in practice
    delete process.env.KUMI_PRACTICE;
    await db.insertInto("move_in").values({ singleton: true } as any).onConflict((oc) => oc.column("singleton").doNothing()).execute();
    await db.updateTable("move_in").set({ source: "courtreserve" } as any).execute();
    assert.equal(await moving(), true);    // live, and moving from CourtReserve
    await db.updateTable("move_in").set({ finished_at: new Date() } as any).execute();
    assert.equal(await moving(), false);   // the move is finished
    await db.updateTable("move_in").set({ source: null, finished_at: null } as any).execute();
  } finally { if (was === undefined) delete process.env.KUMI_PRACTICE; else process.env.KUMI_PRACTICE = was; }
});

test("the accountant reads the money and what's owed, not the asks, questions or scores", async () => {
  const r = await get("/staff/today", as("Acc"));
  assert.deepEqual(kinds(r.json), ["cover", "disputes", "failed", "owed"]);
  assert.ok(r.json.takings);
  assert.equal(r.json.since.changes, null, "Changes is the owner's and managers'");
});

test("a bookings-only role sees no one's name on Today or Approvals, and an ask's title in place of its summary", async () => {
  const t = await get("/staff/today", as("Cleo"));
  assert.equal(t.status, 200);
  assert.equal(t.json.people, false);
  assert.deepEqual(kinds(t.json), ["approvals"], "no money, levels, questions or coaches for this role");
  assert.equal(t.json.takings, null);
  const a = await get("/staff/approvals", as("Cleo"));
  assert.equal(a.status, 200);
  assert.equal(a.json.waiting.length, 1);
  assert.equal(a.json.waiting[0].by, null);
  assert.equal(a.json.waiting[0].summary, null);
  assert.equal(a.json.waiting[0].title, "Count a game for levels");
  for (const body of [JSON.stringify(t.json), JSON.stringify(a.json)])
    for (const name of ["Annabel", "Orinoco", "Cora", "Robin"]) assert.ok(!body.includes(name), `${name} in ${body}`);
  assert.deepEqual((await get("/staff/counts", as("Cleo"))).json, { approvals: 1, questions: 0, today: 1, disputes: 0, moving: false });
});

test("Approvals: who asked, what it changes and when it runs out; the asker sees it as theirs; answering moves it to done", async () => {
  const o = await get("/staff/approvals", "robin@example.test");
  const w = o.json.waiting.find((x: any) => x.id === ask);
  assert.equal(w.by, "Orinoco");
  assert.ok(w.summary);
  assert.ok(new Date(w.expires_at) > new Date());
  const mine = await get("/staff/approvals", as("Orinoco"));
  assert.deepEqual(mine.json.waiting, []);
  assert.equal(mine.json.mine[0].id, ask);
  const no = await app.request(`/runs/${ask}/decline`, { method: "POST", headers: { cookie: cookies["robin@example.test"]!, "content-type": "application/json" }, body: JSON.stringify({ reason: "Not now" }) });
  assert.equal(no.status, 200);
  const after = await get("/staff/approvals", as("Orinoco"));
  assert.deepEqual(after.json.mine, []);
  // Orinoco's role doesn't read people either: the answer, without who gave it or their words.
  assert.deepEqual([after.json.done[0].id, after.json.done[0].outcome, after.json.done[0].answered_by, after.json.done[0].reason], [ask, "declined", null, null]);
  const theirs = (await get("/staff/approvals", "robin@example.test")).json.done.find((x: any) => x.id === ask);
  assert.deepEqual([theirs.outcome, theirs.answered_by, theirs.reason, theirs.by], ["declined", "Robin Hale", "Not now", "Orinoco"]);
  assert.equal((await get("/staff/counts", "robin@example.test")).json.approvals, 0);
});
