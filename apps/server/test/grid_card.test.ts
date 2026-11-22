// What the Schedule's hover card reads from /staff/grid (reads.ts): each player's level and membership plan here, what
// each place has paid, and a Playtomic copy's players, type, price and payment. Under the grid's own rules: names
// (and so levels and plans) for those who read people and a coach on their own lesson; money for money readers; a
// coach's view of someone else's booking stays "Booked" with nothing else. Nothing is made up for a Playtomic copy.
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
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const grid = async (who: string) => (await (await app.request(`/staff/grid?location_id=${loc}&date=${day}`, { headers: { cookie: cookies[`${who}@example.test`]! } })).json()) as any;
const items = (g: any) => g.courts.flatMap((c: any) => c.items);
const at = (h: number) => onDate(day, `${String(h).padStart(2, "0")}:00`, TZ);
/** A Playtomic booking the mirror holds, of a type, kept in the archive with its players, price and payment. */
async function playtomicCopy(id: string, courtId: string, h: number, type: string, participants: { participant_id: string; name: string; email: string }[], payment: string | null) {
  const s = at(h), e = new Date(s.getTime() + 60 * 60_000), ct = uuidv7();
  await db.insertInto("court_time").values({ id: ct, court_id: courtId, during: sql`tstzrange(${s}, ${e})`, kind: "mirror" } as any).execute();
  await db.insertInto("mirror_booking").values({ ref: `${id}:pt-1`, court_id: courtId, during: `[${s.toISOString()},${e.toISOString()})`, booking_type: type, status: "held", court_time_id: ct }).execute();
  await archiveBookings(db, [{ booking_id: id, resource_id: "pt-1", resource_name: "Padel 1", booking_start_date: s.toISOString().slice(0, 19), booking_end_date: e.toISOString().slice(0, 19),
    duration: 0, price: "40 USD", booking_type: type, payment_status: payment, is_canceled: false, participant_info: { owner_id: participants[0]?.participant_id ?? null, participants } }]);
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 3200 }, owner);
  const clerk = ((await run(db, "role.create", { name: "Bookings clerk", grants: [{ action: "booking.move", scope: "any" }] }, owner)).result as any).key;
  for (const [name, role] of [["Ann", null], ["Ben", null], ["Cora", "coach"], ["Dana", "front_desk"], ["Cleo", clerk]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) { await run(db, "role.assign", { person_id: people[name], role }, owner); await signIn(`${name.toLowerCase()}@example.test`); }
  }
  // Ann: a level here and a membership; Ben: neither.
  await db.insertInto("rating").values({ person_id: people.Ann!, level: "3.40" } as any).execute();
  const plan = uuidv7();
  await db.insertInto("membership_plan").values({ id: plan, name: "Padelhead", price_cents: 9900, period: "month" } as any).execute();
  await db.insertInto("membership").values({ id: uuidv7(), person_id: people.Ann!, plan_id: plan, status: "active", source: "desk" } as any).execute();
  day = localDate(new Date(Date.now() + 2 * 86400_000), TZ);
  // Ann's court at the desk, $20 of $48 paid, with Ben and a guest playing; four places.
  ids.court = ((await run(db, "booking.create", { court_id: court, starts_at: at(9).toISOString(), minutes: 90, person_id: people.Ann }, owner)).result as any).booking_id;
  const annPlace = (await db.selectFrom("booking_player").select("id").where("booking_id", "=", ids.court!).where("person_id", "=", people.Ann!).executeTakeFirstOrThrow()).id;
  await db.insertInto("payment").values({ id: uuidv7(), person_id: people.Ann!, amount_cents: 2000, method: "cash", provider: "none", status: "succeeded", booking_player_id: annPlace } as any).execute();
  const later = Date.now() + 1000;   // after Ann's place, in this order
  await db.insertInto("booking_player").values([{ id: uuidv7(later), booking_id: ids.court, person_id: people.Ben! }, { id: uuidv7(later + 1), booking_id: ids.court, guest_name: "Gus" }] as any).execute();
  // An open match of Ben's with one player in it.
  ids.match = ((await run(db, "booking.create", { court_id: court2, starts_at: at(9).toISOString(), minutes: 60, person_id: people.Ben }, owner)).result as any).booking_id;
  await db.insertInto("open_match").values({ booking_id: ids.match, level_min: "2.00", level_max: "4.00" } as any).execute();
  // Cora's lesson with Ann.
  ids.lesson = uuidv7();
  await db.insertInto("booking").values({ id: ids.lesson, code: "KP-LESS", location_id: loc, kind: "lesson", coach_id: people.Cora!, organiser_id: people.Ann!, status: "confirmed", source: "app", price_cents: 5000, players: 1 } as any).execute();
  await db.insertInto("booking_player").values({ id: uuidv7(), booking_id: ids.lesson, person_id: people.Ann!, share_cents: 5000 } as any).execute();
  await db.insertInto("court_time").values({ id: uuidv7(), court_id: court2, during: sql`tstzrange(${at(12)}, ${at(13)})`, kind: "booking", booking_id: ids.lesson } as any).execute();
  // Playtomic copies of several types: an open match with Ann (matched to her account here) and someone from outside,
  // a class nobody paid for yet, a league match, and a type Playtomic might add later.
  await playtomicCopy("pt-om", court, 14, "OPEN_MATCH", [{ participant_id: "u-x", name: "Xavi Outside", email: "xavi@example.test" }, { participant_id: "u-ann", name: "Ann P", email: "ann@example.test" }], "PAID");
  await db.updateTable("playtomic_booking_player").set({ person_id: people.Ann! }).where("participant_id", "=", "u-ann").execute();
  await playtomicCopy("pt-cl", court2, 14, "PRIVATE_CLASS", [{ participant_id: "u-y", name: "Yara Outside", email: "yara@example.test" }], "PENDING");
  await playtomicCopy("pt-lg", court, 16, "LEAGUE_MATCH", [], null);
  await playtomicCopy("pt-new", court2, 16, "SOMETHING_NEW", [], null);
});
after(async () => drop());

test("the front desk reads each player's level, plan and what their place has paid; open places are counted", async () => {
  const g = await grid("dana");
  const court1 = items(g).find((x: any) => x.booking_id === ids.court);
  const rows = court1.arrivals.map(({ id, in: _in, ...r }: any) => r);
  assert.deepEqual(rows, [
    { name: "Ann", guest: false, level: 3.4, plan: "Padelhead", paid_cents: 2000, owed_cents: 2800 },
    { name: "Ben", guest: false, paid_cents: 0, owed_cents: 0 },
    { name: "Gus", guest: true, paid_cents: 0, owed_cents: 0 }]);
  assert.equal(court1.places, 4, "four places, three players in it");
  const match = items(g).find((x: any) => x.booking_id === ids.match);
  assert.equal(match.open_match, true); assert.equal(match.places, 4); assert.equal(match.arrivals.length, 1);
  assert.equal(items(g).find((x: any) => x.booking_id === ids.lesson).places, undefined, "a lesson with its one player has no places to add");
});

test("Playtomic copies: their type, players from the archive (level and plan only when matched here), price and payment", async () => {
  const g = await grid("dana");
  const copies = items(g).filter((x: any) => x.kind === "mirror");
  const by = (type: string) => copies.find((x: any) => x.pt_type === type);
  assert.deepEqual(copies.map((x: any) => x.pt_type).sort(), ["LEAGUE_MATCH", "OPEN_MATCH", "PRIVATE_CLASS", "SOMETHING_NEW"]);
  assert.equal(by("OPEN_MATCH").label, "Open match", "the type in words, without \"Playtomic:\" (the mark says so)");
  assert.deepEqual(by("OPEN_MATCH").roster, [{ name: "Xavi Outside" }, { name: "Ann P", level: 3.4, plan: "Padelhead" }]);
  assert.deepEqual([by("OPEN_MATCH").pt_price_cents, by("OPEN_MATCH").pt_payment], [4000, "PAID"]);
  assert.deepEqual([by("PRIVATE_CLASS").pt_price_cents, by("PRIVATE_CLASS").pt_payment], [4000, "PENDING"]);
  assert.equal(by("LEAGUE_MATCH").roster, undefined, "no players given: none listed");
  assert.equal(by("LEAGUE_MATCH").pt_payment, null, "no payment given: none made up");
});

test("without people or money (a role the club made covering bookings): no names, levels, plans or money", async () => {
  const g = await grid("cleo");
  assert.equal(g.people, false); assert.equal(g.money, false);
  const court1 = items(g).find((x: any) => x.booking_id === ids.court);
  assert.deepEqual(court1.arrivals.map(({ id, in: _in, ...r }: any) => r), [{ name: "", guest: false }, { name: "", guest: false }, { name: "", guest: true }]);
  for (const x of items(g).filter((y: any) => y.kind === "mirror")) {
    assert.equal(x.roster, undefined); assert.equal(x.pt_price_cents, undefined); assert.equal(x.pt_payment, undefined);
    assert.ok(x.pt_type, "the type still colours it");
  }
  const text = JSON.stringify(g);
  assert.ok(!text.includes("Padelhead") && !text.includes("3.4") && !text.includes("Xavi"));
});

test("a coach: their own lesson with their student's level and plan, no money; anyone else's booking only \"Booked\"", async () => {
  const g = await grid("cora");
  assert.equal(g.money, false);
  const lesson = items(g).find((x: any) => x.booking_id === ids.lesson);
  assert.deepEqual(lesson.arrivals.map(({ id, in: _in, ...r }: any) => r), [{ name: "Ann", guest: false, level: 3.4, plan: "Padelhead" }]);
  const others = items(g).filter((x: any) => x.kind === "booking" && !x.booking_id);
  assert.equal(others.length, 2);
  for (const x of others) assert.deepEqual(Object.keys(x).sort(), ["end", "kind", "label", "start"]);
  assert.ok(items(g).filter((x: any) => x.kind === "mirror").every((x: any) => x.roster === undefined && x.pt_payment === undefined));
});
