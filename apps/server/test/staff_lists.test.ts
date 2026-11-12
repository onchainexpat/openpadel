// The staff app's Bookings and Customers lists, and the Playtomic copies' names on the Schedule (reads.ts): each read
// gated as the pages it lists already are. A coach sees their own lessons and no money or names beyond them; a role the
// club made covering bookings sees the bookings without names or money; a memberships role reads none of it; front desk,
// the accountant and the owner read all of it. A member whose account was deleted here never shows by name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { archiveBookings, localDate, onDate, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { sql } from "kysely";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc = "", court = "", court2 = "", day = "";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {}, ids: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const at = (h: number) => onDate(day, `${String(h).padStart(2, "0")}:00`, TZ);
/** A Playtomic booking the mirror holds on a court (a 'mirror' court time), kept in the archive with its players. */
async function playtomicCopy(id: string, courtId: string, h: number, participants: { participant_id: string; name: string; email: string }[]) {
  const s = at(h), e = new Date(s.getTime() + 90 * 60_000), ct = uuidv7();
  await db.insertInto("court_time").values({ id: ct, court_id: courtId, during: sql`tstzrange(${s}, ${e})`, kind: "mirror" } as any).execute();
  await db.insertInto("mirror_booking").values({ ref: `${id}:pt-1`, court_id: courtId, during: `[${s.toISOString()},${e.toISOString()})`, booking_type: "REGULAR_BOOKING", status: "held", court_time_id: ct }).execute();
  await archiveBookings(db, [{ booking_id: id, resource_id: "pt-1", resource_name: "Padel 1", booking_start_date: s.toISOString().slice(0, 19), booking_end_date: e.toISOString().slice(0, 19),
    duration: 0, price: "40 USD", booking_type: "REGULAR_BOOKING", payment_status: "PAID", is_canceled: false, participant_info: { owner_id: participants[0]!.participant_id, participants } }]);
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  await signIn("robin@example.test");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 3200 }, owner);
  // Clerk: a role the club made covering bookings only. Keeper: one covering memberships only.
  const clerk = ((await run(db, "role.create", { name: "Bookings clerk", grants: [{ action: "booking.move", scope: "any" }] }, owner)).result as any).key;
  const keeper = ((await run(db, "role.create", { name: "Membership keeper", grants: ["membership.pause", "membership.unpause"].map((action) => ({ action, scope: "any" })) }, owner)).result as any).key;
  for (const [name, role] of [["Ann", null], ["Ben", null], ["Pia", null], ["Cora", "coach"], ["Dana", "front_desk"], ["Acc", "accountant"], ["Cleo", clerk], ["Kip", keeper]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) { await run(db, "role.assign", { person_id: people[name], role }, owner); await signIn(`${name.toLowerCase()}@example.test`); }
  }
  await db.updateTable("person").set({ phone: "+14155550142" }).where("id", "=", people.Ann!).execute();
  await db.insertInto("channel_consent").values({ id: uuidv7(), person_id: people.Ann!, channel: "email", purpose: "club_news", granted: true, source: "test" }).execute();
  await db.insertInto("rating").values({ person_id: people.Ann!, level: "3.40" } as any).execute();
  day = localDate(new Date(Date.now() + 2 * 86400_000), TZ);
  // Ann's court at the desk (owed there), Ben's cancelled one, Cora's lesson with Ann, a clinic date.
  ids.court = ((await run(db, "booking.create", { court_id: court, starts_at: at(9).toISOString(), minutes: 90, person_id: people.Ann }, owner)).result as any).booking_id;
  ids.gone = ((await run(db, "booking.create", { court_id: court2, starts_at: at(9).toISOString(), minutes: 60, person_id: people.Ben }, owner)).result as any).booking_id;
  await run(db, "booking.cancel", { booking_id: ids.gone, refund: "none" }, owner);
  ids.lesson = uuidv7();
  await db.insertInto("booking").values({ id: ids.lesson, code: "KP-LESS", location_id: loc, kind: "lesson", coach_id: people.Cora!, organiser_id: people.Ann!, status: "confirmed", source: "app", price_cents: 5000 } as any).execute();
  await db.insertInto("booking_player").values({ id: uuidv7(), booking_id: ids.lesson, person_id: people.Ann!, share_cents: 5000 } as any).execute();
  await db.insertInto("court_time").values({ id: uuidv7(), court_id: court2, during: sql`tstzrange(${at(12)}, ${at(13)})`, kind: "booking", booking_id: ids.lesson } as any).execute();
  const clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley drills", capacity: 8, price_cents: 2000 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: at(15).toISOString(), ends_at: at(16).toISOString(), court_ids: [court, court2] }, owner);
  // Two Playtomic copies: Xavi's, with Pia playing; and Pia's own. Pia's account is then deleted here, and a later read
  // of her booking (still in Playtomic) brings her name back nowhere.
  await playtomicCopy("h1", court, 18, [{ participant_id: "u-x", name: "Xavi Outside", email: "xavi@example.test" }, { participant_id: "u-pia", name: "Pia", email: "pia@example.test" }]);
  await run(db, "privacy.erase", { person_id: people.Pia }, { personId: people.Pia!, via: "test", lang: "en" });
  await playtomicCopy("h2", court2, 18, [{ participant_id: "u-pia", name: "Pia", email: "pia@example.test" }, { participant_id: "u-y", name: "Yara Outside", email: "yara@example.test" }]);
  // Ann's weekly court.
  await run(db, "booking.repeat", { court_id: court, starts_at: onDate(localDate(new Date(Date.now() + 3 * 86400_000), TZ), "19:00", TZ).toISOString(), minutes: 60, person_id: people.Ann, weeks: 3 }, owner);
});
after(async () => drop());

const list = (who: string, extra = "") => get(`/staff/bookings?location_id=${loc}&from=${day}${extra}`, `${who}@example.test`);

test("front desk, the accountant and the owner read every booking that day, with names and what's owed", async () => {
  for (const who of ["robin", "dana", "acc"]) {
    const r = await list(who);
    assert.equal(r.status, 200, who);
    assert.equal(r.json.money, true); assert.equal(r.json.people, true);
    const by = (k: string | undefined) => r.json.rows.find((x: any) => x.key === k);
    assert.deepEqual([by(ids.court).type, by(ids.court).made_in, by(ids.court).status, by(ids.court).who, by(ids.court).owed_cents], ["court", "desk", "upcoming", "Ann", 4800], who);
    assert.equal(by(ids.gone).status, "cancelled"); assert.equal(by(ids.gone).owed_cents, undefined, "nothing is owed on a cancelled booking");
    assert.equal(by(ids.lesson).type, "lesson");
    const clinic = r.json.rows.find((x: any) => x.type === "program");
    assert.equal(clinic.label, "Volley drills"); assert.equal(clinic.court, "Court 1, Court 2");
    const copies = r.json.rows.filter((x: any) => x.type === "playtomic");
    assert.deepEqual(copies.map((x: any) => [x.who, x.more]).sort(), [[null, 1], ["Xavi Outside", 0]], "Pia is in neither, by name or as a player counted");
    assert.equal(r.json.total, 6);
    assert.ok(!JSON.stringify(r.json).includes("Pia"), "a deleted member never shows by name");
  }
  const unpaid = await list("dana", "&status=unpaid");
  assert.deepEqual(unpaid.json.rows.map((x: any) => x.key).sort(), [ids.court, ids.lesson].sort());
  assert.deepEqual((await list("dana", "&made_in=playtomic")).json.rows.map((x: any) => x.type), ["playtomic", "playtomic"]);
  assert.deepEqual((await list("dana", "&type=lesson")).json.rows.map((x: any) => x.key), [ids.lesson]);
});

test("a coach reads their own lessons with their player's name, and the day's program dates and Playtomic copies unnamed; no money", async () => {
  const r = await list("cora");
  assert.equal(r.status, 200);
  assert.equal(r.json.money, false); assert.equal(r.json.people, false);
  const keys = r.json.rows.map((x: any) => x.key);
  assert.ok(keys.includes(ids.lesson) && !keys.includes(ids.court) && !keys.includes(ids.gone), "someone else's booking isn't listed");
  assert.equal(r.json.rows.find((x: any) => x.key === ids.lesson).who, "Ann");
  assert.ok(r.json.rows.every((x: any) => x.owed_cents === undefined));
  assert.ok(r.json.rows.filter((x: any) => x.type === "playtomic").every((x: any) => x.who === null && x.more === 0));
  assert.ok(!JSON.stringify(r.json).includes("Xavi"));
  assert.notDeepEqual((await list("cora", "&status=unpaid")).json.rows, [], "Unpaid narrows nothing for someone without money");
  assert.equal((await get(`/staff/weekly-courts?location_id=${loc}`, "cora@example.test")).status, 403);
  assert.equal((await get("/staff/customers", "cora@example.test")).status, 403);
  // The Schedule: no Playtomic names for a coach either.
  const grid = await get(`/staff/grid?location_id=${loc}&date=${day}`, "cora@example.test");
  assert.ok(!JSON.stringify(grid.json).includes("Xavi"));
});

test("a role the club made covering bookings reads them without names or money; a memberships role reads none of it", async () => {
  const r = await list("cleo");
  assert.equal(r.status, 200);
  assert.equal(r.json.people, false); assert.equal(r.json.money, false);
  assert.ok(r.json.rows.every((x: any) => x.who === null && x.person_id == null && x.owed_cents === undefined));
  const weekly = await get(`/staff/weekly-courts?location_id=${loc}`, "cleo@example.test");
  assert.equal(weekly.status, 200);
  assert.deepEqual(weekly.json.rows.map((x: any) => [x.who, x.price_cents]), [[null, undefined]]);
  assert.ok(!JSON.stringify((await get(`/staff/grid?location_id=${loc}&date=${day}`, "cleo@example.test")).json).includes("Xavi"));
  for (const path of [`/staff/bookings?location_id=${loc}`, `/staff/weekly-courts?location_id=${loc}`, "/staff/customers"])
    assert.equal((await get(path, "kip@example.test")).status, 403, path);
});

test("the Schedule names who booked and plays in a Playtomic copy for those who read people, never a deleted member", async () => {
  const grid = await get(`/staff/grid?location_id=${loc}&date=${day}`, "dana@example.test");
  const copies = grid.json.courts.flatMap((c: any) => c.items).filter((x: any) => x.kind === "mirror");
  assert.deepEqual(copies.map((x: any) => [x.who, x.players]).sort(), [["", ["Yara Outside"]], ["Xavi Outside", ["Xavi Outside"]]]);
  assert.ok(!JSON.stringify(grid.json).includes("Pia"));
});

test("weekly courts: who and the price for the desk", async () => {
  const r = await get(`/staff/weekly-courts?location_id=${loc}`, "dana@example.test");
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.deepEqual([r.json.rows[0].who, r.json.rows[0].court, r.json.rows[0].starts, r.json.rows[0].status, r.json.rows[0].price_cents], ["Ann", "Court 1", "19:00", "active", 3200]);
});

test("customers: a page of people with their email, a shortened phone, membership, club news and level for the desk", async () => {
  const r = await get("/staff/customers?q=ann", "dana@example.test");
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  const ann = r.json.rows[0];
  assert.deepEqual([ann.display_name, ann.email, ann.phone, ann.club_news, ann.level, ann.membership], ["Ann", "ann@example.test", "...42", true, "3.40", null]);
  const all = await get("/staff/customers", "dana@example.test");
  assert.ok(all.json.total >= 8 && all.json.rows.length === all.json.total);
  assert.ok(!all.json.rows.some((x: any) => x.display_name === "Pia"), "a deleted account isn't listed by name");
  // Someone reading people without levels (a role the club made covering members only) gets no level.
  const reader = ((await run(db, "role.create", { name: "Front of house", grants: [{ action: "person.tag", scope: "any" }] }, owner)).result as any).key;
  const fay = ((await run(db, "person.create", { display_name: "Fay", email: "fay@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: fay, role: reader }, owner);
  await signIn("fay@example.test");
  const f = await get("/staff/customers?q=ann", "fay@example.test");
  assert.equal(f.status, 200);
  assert.equal(f.json.levels, false); assert.equal(f.json.rows[0].level, undefined);
});

test("a booking moved to another day and then cancelled is listed on the day it was moved to, not the one it left", async () => {
  const later = localDate(new Date(Date.now() + 5 * 86400_000), TZ);
  const id = ((await run(db, "booking.create", { court_id: court2, starts_at: at(20).toISOString(), minutes: 60, person_id: people.Ben }, owner)).result as any).booking_id;
  await run(db, "booking.move", { booking_id: id, court_id: court2, starts_at: onDate(later, "20:00", TZ).toISOString() }, owner);
  await run(db, "booking.cancel", { booking_id: id, refund: "none" }, owner);
  assert.ok(!(await list("dana")).json.rows.some((x: any) => x.key === id), "not on the day it left");
  const there = await get(`/staff/bookings?location_id=${loc}&from=${later}`, "dana@example.test");
  assert.equal(there.json.rows.find((x: any) => x.key === id)?.status, "cancelled");
});
