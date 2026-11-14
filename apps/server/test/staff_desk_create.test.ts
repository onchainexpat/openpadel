// + Create's private lesson and open match at the desk (DeskCreate.tsx), and the Schedule's Month view (Month.tsx):
// - a lesson is the coach's rate for everyone (members or not), taxed like a court, the court picked by itself, no card
//   held: places marked paid are paid now, the rest owed at the desk, and each their part settles to the desk;
// - an open match keeps the members' rules (level band, not full by the deadline: cancelled and everyone paid back),
//   with the places the desk named counted as taken, and their unpaid parts owed at the desk;
// - the month's days: occupancy as the day view counts it, bookings, and program dates by name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, messageHandlers, onDate, processOutbox, run, runAsSystem, settleShares, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc = "", court = "", court2 = "", day = "";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
const post = async (who: string, path: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
async function signIn(who: string) {
  const email = `${who.toLowerCase()}@example.test`;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[who] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const at = (h: number, d = day) => onDate(d, `${String(h).padStart(2, "0")}:00`, TZ);
const plan = (who: string, action: string, input: unknown) => post(who, `/actions/${action}/plan`, input);
const apply = (who: string, runId: string) => post(who, `/runs/${runId}/apply`);
const seatsOf = (id: string) => db.selectFrom("booking_player").select(["person_id", "guest_name", "share_cents"]).where("booking_id", "=", id).where("removed_at", "is", null).orderBy("id").execute();
const paidOn = (id: string) => db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
  .select(["payment.amount_cents", "payment.method", "payment.status", "payment.save_card"]).where("booking_player.booking_id", "=", id).execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  app = makeApp({ db, mailer, secureCookies: false });
  await signIn("Robin");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  for (const [name, role] of [["Ann", null], ["Ben", null], ["Cal", null], ["Dee", null], ["Kim", "coach"], ["Dana", "front_desk"], ["Mia", "manager"]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) await run(db, "role.assign", { person_id: people[name], role }, owner);
    await signIn(name);
  }
  // Kim gives lessons every day, 9 to 21 here, an hour for $90.00 or an hour and a half for $125.00.
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: null, level_min: null, level_max: null, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }, { minutes: 90, cents: 12500 }],
    lessons: true, max_players: 4 }, owner);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, starts: "09:00", ends: "21:00" })) }, owner);
  day = localDate(new Date(Date.now() + 3 * 86400_000), TZ);
});
after(async () => drop());

test("the desk's lesson form reads the coaches who give lessons and their free times; a member can't", async () => {
  const c = await get("/staff/lesson-coaches", "Dana");
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(c.json.coaches.map((x: any) => [x.name, x.rates, x.max_players]), [["Kim", { "60": 9000, "90": 12500 }, 4]]);
  const times = await get(`/staff/lesson-times?coach_id=${people.Kim}&date=${day}&minutes=60&location_id=${loc}`, "Dana");
  assert.equal(times.status, 200);
  assert.equal(times.json.times[0], at(9).toISOString());
  assert.ok(!times.json.times.includes(at(20, day).toISOString().replace(":00:00", ":30:00")), "a lesson can't run past the coach's hours");
  assert.equal((await get("/staff/lesson-coaches", "Ann")).status, 403);
  assert.equal((await get(`/staff/lesson-times?coach_id=nope&date=${day}&minutes=60`, "Dana")).status, 400);
});

test("a private lesson at the desk: the coach's rate for everyone, a court picked, the organiser's part paid now, the coach told", async () => {
  const p = await plan("Dana", "booking.create_lesson", { coach_id: people.Kim, starts_at: at(10).toISOString(), minutes: 60, location_id: loc, pay: "whole",
    places: [{ guest_name: "Walk-in Sam", paid: true }, { person_id: people.Ann }], paid_method: "terminal", note: "First lesson" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const words = p.json.summary as string;
  assert.match(words, /Book a 60-minute lesson with Kim for 2 players: Court 1, .*\. \$90\.00, court included, the same for members and anyone else\./);
  assert.match(words, /Walk-in Sam pays it all\./);
  assert.match(words, /Players: Ann\./);
  assert.match(words, /Paid at the desk on the club's card reader: Walk-in Sam, \$90\.00\./);
  const done = await apply("Dana", p.json.run_id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const id = done.json.result.booking_id;
  const b = await db.selectFrom("booking").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([b.kind, b.coach_id, b.status, b.source, b.price_cents, b.pay_mode, b.players, b.note], ["lesson", people.Kim, "confirmed", "desk", 9000, "whole", 2, "First lesson"]);
  assert.deepEqual((await seatsOf(id)).map((x) => [x.person_id ?? x.guest_name, x.share_cents]), [["Walk-in Sam", 9000], [people.Ann, 0]]);
  assert.deepEqual(await paidOn(id), [{ amount_cents: 9000, method: "terminal", status: "succeeded", save_card: false }]);
  // The court's time is held, and the coach is busy then: a second lesson at the same time is refused.
  const again = await plan("Mia", "booking.create_lesson", { coach_id: people.Kim, starts_at: at(10).toISOString(), minutes: 60, pay: "whole", places: [{ person_id: people.Ben }] });
  assert.match(JSON.stringify(again.json), /Kim already has a lesson or a session/);
  // The coach hears of it, as of one booked in the app.
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["kind", "person_id"]).where("person_id", "=", people.Kim!).where("kind", "=", "coach_lesson_booked").execute();
  assert.equal(told.length > 0, true);
  // The Schedule shows it as a lesson with Kim.
  const grid = await get(`/staff/grid?location_id=${loc}&date=${day}`, "Dana");
  const item = grid.json.courts.flatMap((c: any) => c.items).find((x: any) => x.booking_id === id);
  assert.deepEqual([item.booking_kind, item.coach], ["lesson", "Kim"]);
});

test("a lesson each their part: shares as the app's, the open place by link, and what's unpaid at the deadline owed at the desk", async () => {
  const p = await plan("Dana", "booking.create_lesson", { coach_id: people.Kim, starts_at: at(14).toISOString(), minutes: 90, location_id: loc, pay: "split",
    places: [{ person_id: people.Ben }, { person_id: people.Cal, paid: true }, {}], paid_method: "cash" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const words = p.json.summary as string;
  assert.match(words, /\$125\.00/);
  assert.match(words, /Each player pays their part: \$41\.68 for Ben, \$41\.66 for each of the others\./);
  assert.match(words, /Paid at the desk in cash: Cal, \$41\.66\./);
  assert.match(words, /1 place stays open/);
  const id = (await apply("Dana", p.json.run_id)).json.result.booking_id;
  assert.equal((await paidOn(id)).filter((x) => x.save_card).length, 0, "no card is held");
  await settleShares(db, new Date(at(14).getTime() - 23 * 3600_000));
  const settled = await db.selectFrom("booking").select(["status", "settled_at", "balance_cents"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([settled.status, Boolean(settled.settled_at), settled.balance_cents], ["confirmed", true, 12500 - 4166]);
});

test("what the desk's lesson refuses: a length the coach doesn't give, outside their hours, too many players, the coach as a player, a guest splitting", async () => {
  const lesson = (extra: object) => plan("Dana", "booking.create_lesson", { coach_id: people.Kim, starts_at: at(16).toISOString(), minutes: 60, pay: "whole", places: [{ person_id: people.Ann }], ...extra });
  assert.match(JSON.stringify((await lesson({ minutes: 120 })).json), /Kim gives lessons of/);
  assert.match(JSON.stringify((await lesson({ starts_at: at(7).toISOString() })).json), /Kim doesn.t give lessons at/);
  assert.match(JSON.stringify((await lesson({ places: [{ person_id: people.Kim }] })).json), /own lesson|yourself/i);
  assert.match(JSON.stringify((await lesson({ pay: "split", places: [{ guest_name: "Walk-in" }, { person_id: people.Ann }] })).json), /needs a member as the organiser/);
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: null, level_min: null, level_max: null, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }, { minutes: 90, cents: 12500 }],
    lessons: true, max_players: 2 }, owner);
  assert.match(JSON.stringify((await lesson({ places: [{ person_id: people.Ann }, { person_id: people.Ben }, { person_id: people.Cal }] })).json), /up to 2/);
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: null, level_min: null, level_max: null, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }, { minutes: 90, cents: 12500 }],
    lessons: true, max_players: 4 }, owner);
  // A coach on their own can't book lessons at the desk (booking.* is the front desk's and up).
  assert.equal((await lesson({})).status, 200);
  assert.notEqual((await plan("Kim", "booking.create_lesson", { coach_id: people.Kim, starts_at: at(16).toISOString(), minutes: 60, pay: "whole", places: [{ person_id: people.Ann }] })).status, 200);
});

const match = (who: string, h: number, places: object[], extra: object = {}) => plan(who, "booking.create", { court_id: court2, starts_at: at(h).toISOString(), minutes: 90, pay: "split", places,
  open: { level_min: 2.5, level_max: 3.5, outside_band: "ask", rated: true, listed: true, note: "Friendly crowd" }, ...extra });

test("an open match at the desk: the band said, the places named counted as taken, and full at the deadline what's unpaid is owed at the desk", async () => {
  const p = await match("Dana", 17, [{ person_id: people.Ann, paid: true }, { person_id: people.Ben }, { person_id: people.Cal }, { person_id: people.Dee }], { paid_method: "cash" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const words = p.json.summary as string;
  assert.match(words, /Open a match on Court 2, .*, for 90 minutes, hosted by Ann: \$60\.00, four places, each paying their part \(\$15\.00 for the host, \$15\.00 for each of the others\)\./);
  assert.match(words, /It's an open match for levels 2\.50-3\.50, rated .* players outside the band can ask the host\./);
  assert.match(words, /Places named here count as taken; what they haven't paid by then is owed at the desk\. No card is held\./);
  assert.match(words, /Outside the band, or with no level yet: Ann, Ben, Cal, Dee\./);
  const id = (await apply("Dana", p.json.run_id)).json.result.booking_id;
  const om = await db.selectFrom("open_match").selectAll().where("booking_id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([om.level_min, om.level_max, om.outside_band, om.rated, om.listed, om.note, om.cutoff_at], ["2.50", "3.50", "ask", true, true, "Friendly crowd", null]);
  const grid = await get(`/staff/grid?location_id=${loc}&date=${day}`, "Dana");
  assert.equal(grid.json.courts.flatMap((c: any) => c.items).find((x: any) => x.booking_id === id).open_match, true);
  await settleShares(db, new Date(at(17).getTime() - 23 * 3600_000));
  const b = await db.selectFrom("booking").select(["status", "balance_cents"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([b.status, b.balance_cents], ["confirmed", 4500], "full: it goes ahead, and the three unpaid places are owed at the desk");
});

test("an open match at the desk not full by the deadline: cancelled, and what was paid at the desk waits there to be handed back", async () => {
  const p = await match("Dana", 19, [{ person_id: people.Ann, paid: true }, { person_id: people.Ben }, {}, {}]);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.summary, /2 places stay open: members at the level find the match in the app, join it and pay their part there\./);
  const id = (await apply("Dana", p.json.run_id)).json.result.booking_id;
  await settleShares(db, new Date(at(19).getTime() - 23 * 3600_000));
  const b = await db.selectFrom("booking").select(["status", "cancel_reason"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([b.status, b.cancel_reason], ["cancelled", "not_filled"]);
  const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select(["refund.amount_cents", "refund.destination"]).where("booking_player.booking_id", "=", id).execute();
  assert.deepEqual(back.map((r) => r.amount_cents), [1500]);
});

test("what the desk's open match refuses: a guest, the whole court, a band upside down, no member as host", async () => {
  assert.match(JSON.stringify((await match("Dana", 12, [{ person_id: people.Ann }, { guest_name: "Walk-in" }])).json), /Everyone named in an open match is a member/);
  assert.match(JSON.stringify((await match("Dana", 12, [{ person_id: people.Ann }], { pay: "whole" })).json), /An open match is a court for four/);
  assert.match(JSON.stringify((await match("Dana", 12, [{ person_id: people.Ann }], { open: { level_min: 4, level_max: 3 } })).json), /lowest level can't be above/);
  assert.match(JSON.stringify((await match("Dana", 12, [{}, { person_id: people.Ann }])).json), /Say who the booking is for/);
});

test("the Month view: each day's occupancy and bookings as the day view counts them, its program dates by name, the same for a coach", async () => {
  const month = day.slice(0, 7);
  const clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley drills", capacity: 8, price_cents: 2500 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: at(9).toISOString(), ends_at: at(10).toISOString(), court_ids: [court2], coach_id: people.Kim }, owner);
  const m = await get(`/staff/month?location_id=${loc}&month=${month}`, "Dana");
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const d = m.json.days.find((x: any) => x.date === day);
  const grid = (await get(`/staff/grid?location_id=${loc}&date=${day}`, "Dana")).json;
  const bookings = new Set(grid.courts.flatMap((c: any) => c.items).filter((x: any) => x.kind === "booking" && x.booking_id).map((x: any) => x.booking_id));
  assert.equal(d.bookings, bookings.size);
  assert.ok(d.percent > 0 && d.percent <= 100);
  assert.deepEqual(d.programs.map((x: any) => [x.name, x.kind]), [["Volley drills", "clinic"]]);
  assert.equal(m.json.days.length, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
  assert.equal(m.json.days.find((x: any) => x.date !== day && x.programs.length), undefined);
  const coach = await get(`/staff/month?location_id=${loc}&month=${month}`, "Kim");
  assert.equal(coach.status, 200);
  assert.deepEqual(coach.json.days, m.json.days, "no names or money in it: a coach reads the same month");
  assert.equal((await get(`/staff/month?location_id=${loc}&month=${month}`, "Ann")).status, 403);
  assert.equal((await get(`/staff/month?location_id=nope&month=${month}`, "Dana")).status, 404);
});
