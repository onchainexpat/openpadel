// The staff app's Schedule and Bookings pages (Courts.tsx, NewBooking.tsx, SessionPanel.tsx, Bookings.tsx): a court
// booked at the desk with its places (the whole court, or each their part, never a card held), places marked paid at
// the desk, the staff's note and the players'; a program date's side panel (who's on it and how each place stands), its
// "Check in all" and "Message players"; and the Bookings list as a spreadsheet. Each read is gated as the Schedule is:
// a role the club made covering bookings sees no names, money only for money readers, a coach their own dates.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, messageHandlers, onDate, processOutbox, run, runAsSystem, settleShares, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc = "", court = "", court2 = "", day = "", clinic = "", date = "";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, text: await r.clone().text(), json: await r.json().catch(() => null) as any }; };
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

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  app = makeApp({ db, mailer, secureCookies: false });
  await signIn("Robin");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2", kind: "outdoor" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  // Clerk: a role the club made covering bookings only (makes them, never takes money). Two coaches.
  const clerk = ((await run(db, "role.create", { name: "Bookings clerk", grants: ["booking.create", "booking.move"].map((action) => ({ action, scope: "any" })) }, owner)).result as any).key;
  for (const [name, role] of [["Ann", null], ["Ben", null], ["Cal", null], ["Dee", null], ["Eve", null], ["Cora", "coach"], ["Kim", "coach"], ["Dana", "front_desk"], ["Mia", "manager"],
    ["Acc", "accountant"], ["Cleo", clerk]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) await run(db, "role.assign", { person_id: people[name], role }, owner);
    await signIn(name);
  }
  day = localDate(new Date(Date.now() + 3 * 86400_000), TZ);
  // A clinic date Cora runs, with two places: Ann paid at the desk, Ben owes, Cal waits.
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley drills", capacity: 2, price_cents: 2500 }, owner)).result as any).program_id;
  date = ((await run(db, "session.add", { program_id: clinic, starts_at: at(15).toISOString(), ends_at: at(16).toISOString(), court_ids: [court2], coach_id: people.Cora }, owner)).result as any).session_id;
  await run(db, "program.publish", { program_id: clinic }, owner);
  for (const name of ["Ann", "Ben", "Cal"]) await run(db, "enrolment.join", { program_id: clinic, person_id: people[name] }, owner);
  const ann = await db.selectFrom("enrolment").select("id").where("person_id", "=", people.Ann!).where("program_id", "=", clinic).executeTakeFirstOrThrow();
  await run(db, "enrolment.record_payment", { enrolment_id: ann.id, cents: 2500, method: "cash" }, owner);
});
after(async () => drop());

const plan = (who: string, input: unknown) => post(who, "/actions/booking.create/plan", input);
const book = (h: number, extra: object) => ({ court_id: court, starts_at: at(h).toISOString(), minutes: 90, ...extra });

test("whole court at the desk: four places in two teams, the organiser's paid now, the rest named, and both notes", async () => {
  const p = await plan("Dana", book(8, { pay: "whole", places: [{ person_id: people.Ann, paid: true }, { person_id: people.Ben }, { guest_name: "Walk-in Sam" }, {}], paid_method: "terminal",
    note: "Regular, wants the window court", player_note: "Balls at the desk" }));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const words = p.json.summary as string;
  assert.match(words, /for Ann: \$60\.00\./);
  assert.match(words, /Players: Ben, Walk-in Sam\./);
  assert.match(words, /Paid at the desk on the club's card reader: Ann, \$60\.00\./);
  assert.match(words, /1 place stays open: the organiser can share the players link\./);
  assert.match(words, /Players see this note: Balls at the desk/);
  assert.ok(!words.includes("wants the window"), "the staff's note isn't read out as the players'");
  const done = await post("Dana", `/runs/${p.json.run_id}/apply`);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const id = done.json.result.booking_id;
  const b = await db.selectFrom("booking").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([b.pay_mode, b.note, b.player_note, b.price_cents, Boolean(b.invite_code)], ["whole", "Regular, wants the window court", "Balls at the desk", 6000, true]);
  const seats = await db.selectFrom("booking_player").select(["person_id", "guest_name", "share_cents", "added_by"]).where("booking_id", "=", id).orderBy("id").execute();
  assert.deepEqual(seats.map((x) => [x.person_id ?? x.guest_name, x.share_cents]), [[people.Ann, 6000], [people.Ben, 0], ["Walk-in Sam", 0]]);
  const paid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(["payment.amount_cents", "payment.method", "payment.person_id"])
    .where("booking_player.booking_id", "=", id).execute();
  assert.deepEqual(paid, [{ amount_cents: 6000, method: "terminal", person_id: people.Ann }]);
  // Ben sees the players' note in the app; the staff's never leaves the staff app.
  const m = (await get(`/matches/${id}`, "Ben")).json;
  assert.equal(m.note, "Balls at the desk");
  assert.ok(!JSON.stringify(m).includes("window court"));
  // The Schedule shows both notes to those who read people, neither to the bookings clerk.
  const grid = (who: string) => get(`/staff/grid?location_id=${loc}&date=${day}`, who).then((r) => r.json.courts.flatMap((c: any) => c.items).find((x: any) => x.booking_id === id));
  assert.deepEqual([(await grid("Dana")).note, (await grid("Dana")).player_note], ["Regular, wants the window court", "Balls at the desk"]);
  const clerkSees = await grid("Cleo");
  assert.equal(clerkSees.note, undefined); assert.equal(clerkSees.player_note, undefined); assert.equal(clerkSees.who, "");
});

test("each their part: four equal parts, the deadline said, no card held, and what's unpaid at the deadline owed by the organiser", async () => {
  const p = await plan("Mia", book(18, { pay: "split", places: [{ person_id: people.Dee }, { person_id: people.Eve, paid: true }, {}, {}], paid_method: "cash" }));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const words = p.json.summary as string;
  assert.match(words, /organised by Dee: \$60\.00, each player paying their part \(\$15\.00 for the organiser, \$15\.00 for each of the others\)\./);
  assert.match(words, /Anything still unpaid at .* goes to Dee: on a card saved for this booking if there is one, otherwise owed at the desk\. No card is held\./);
  assert.match(words, /Paid at the desk in cash: Eve, \$15\.00\./);
  assert.match(words, /2 places stay open: whoever takes one with the booking's link pays their part in the app\./);
  const id = (await post("Mia", `/runs/${p.json.run_id}/apply`)).json.result.booking_id;
  const b = await db.selectFrom("booking").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([b.pay_mode, b.players], ["split", 4]);
  assert.equal((await db.selectFrom("payment").select("id").where("save_card", "=", true).where("person_id", "in", [people.Dee!, people.Eve!]).execute()).length, 0, "no card is saved or held");
  // The deadline comes: nothing is charged to a card (none was saved for it); Dee owes the rest at the desk, once.
  const after = new Date(at(18).getTime() - 23 * 3600_000);
  await settleShares(db, after);
  await settleShares(db, after);
  const settled = await db.selectFrom("booking").select(["settled_at", "balance_cents"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.ok(settled.settled_at);
  assert.equal(settled.balance_cents, 4500);
  // Nobody is told a card was declined: none was ever tried. Dee hears the places are owed at the desk; managers too.
  const told = await db.selectFrom("event_outbox").select(["topic", "payload"]).where("topic", "=", "booking.balance_due").execute();
  assert.equal(told.filter((e) => (e.payload as any).booking_id === id).length, 1, "said once");
  await processOutbox(db, messageHandlers);
  const kinds = (await db.selectFrom("outbound_message").select(["kind", "person_id", "body"]).where("channel", "=", "inbox").where("kind", "like", "booking_%").execute());
  const dee = kinds.find((k) => k.person_id === people.Dee);
  assert.equal(dee?.kind, "booking_parts_owed");
  assert.match(dee!.body, /\$45\.00 .* yours to pay at the desk .* nothing was charged/);
  assert.ok(kinds.some((k) => k.person_id === people.Mia && k.kind === "booking_parts_owed_staff"), "managers hear it, as an alert");
  assert.ok(!kinds.some((k) => /balance_due/.test(k.kind)), "nobody is told a card was declined");
  assert.equal((await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id").where("booking_player.booking_id", "=", id).execute()).length, 1);
});

test("what the desk can't do: each their part too late or for a guest, a place paid that's empty, one person twice", async () => {
  // Inside the club's 24 hours: a start about 20 hours from now, on the half hour, when the club is open then.
  const soon = new Date(Math.ceil((Date.now() + 20 * 3600_000) / 1800_000) * 1800_000);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(soon));
  const tooLate = await plan("Dana", { court_id: court2, starts_at: soon.toISOString(), minutes: 60, pay: "split", places: [{ person_id: people.Ann }] });
  if (hour >= 7 && hour < 21) assert.match(JSON.stringify(tooLate.json), /more than 24 hours before/);
  assert.match(JSON.stringify((await plan("Dana", book(11, { pay: "split", places: [{ guest_name: "Walk-in" }] }))).json), /needs a member as the organiser/);
  assert.match(JSON.stringify((await plan("Dana", book(11, { places: [{ person_id: people.Ann }, { paid: true }] }))).json), /empty place can't be marked paid/);
  assert.match(JSON.stringify((await plan("Dana", book(11, { places: [{ person_id: people.Ann }, { person_id: people.Ann }] }))).json), /listed twice/);
  assert.match(JSON.stringify((await plan("Dana", book(11, { places: [{ person_id: people.Ann }, { person_id: people.Ben, paid: true }] }))).json), /nothing to pay/, "the whole court: only the organiser's place pays");
  assert.match(JSON.stringify((await plan("Dana", book(11, { person_id: people.Ann, guest_name: "Both" }))).json), /Say who the booking is for/);
  assert.match(JSON.stringify((await plan("Dana", book(11, { person_id: people.Ann, places: [{ person_id: people.Ann }] }))).json), /Say who the booking is for/);
});

test("another price and places paid are for whoever takes money at the desk: not the bookings clerk", async () => {
  const ok = await plan("Cleo", book(12, { places: [{ guest_name: "Walk-in Lou" }] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(JSON.stringify((await plan("Cleo", book(12, { places: [{ guest_name: "Walk-in Lou" }], price_cents: 1000 }))).json), /Another price is for staff who take payments/);
  assert.match(JSON.stringify((await plan("Cleo", book(12, { places: [{ guest_name: "Walk-in Lou", paid: true }] }))).json), /Marking places paid is for staff/);
  // The front desk may do both.
  assert.equal((await plan("Dana", book(12, { places: [{ guest_name: "Walk-in Lou", paid: true }], price_cents: 1000 }))).status, 200);
  // A coach doesn't make court bookings at the desk at all.
  assert.equal((await plan("Cora", book(12, { places: [{ guest_name: "Walk-in Lou" }] }))).status, 403);
});

test("a program date's side panel: names and how each place stands for money readers, names alone for its coach", async () => {
  for (const who of ["Robin", "Mia", "Dana", "Acc"]) {
    const r = await get(`/staff/sessions/${date}/panel`, who);
    assert.equal(r.status, 200, who);
    assert.equal(r.json.money, true, who);
    assert.deepEqual(r.json.players.map((p: any) => [p.name, p.pay ?? `waitlist ${p.waitlist}`]), [["Ann", "paid"], ["Ben", "unpaid"], ["Cal", "waitlist 1"]], who);
    assert.deepEqual([r.json.booked, r.json.places, r.json.waiting, r.json.price_cents], [2, 2, 1, 2500], who);
  }
  const coach = await get(`/staff/sessions/${date}/panel`, "Cora");
  assert.equal(coach.status, 200);
  assert.equal(coach.json.money, false);
  assert.deepEqual(coach.json.players.map((p: any) => p.name), ["Ann", "Ben", "Cal"]);
  assert.ok(coach.json.players.every((p: any) => p.pay === undefined) && coach.json.price_cents === undefined, "a coach sees who, not what they paid");
  assert.equal((await get(`/staff/sessions/${date}/panel`, "Kim")).status, 403, "another coach's date");
  assert.equal((await get(`/staff/sessions/${date}/panel`, "Cleo")).status, 403, "a role covering bookings only reads no program's players");
  assert.equal((await get(`/staff/sessions/${date}/panel`, "Ann")).status, 403, "a member");
});

test("Message players: a service message to the date's players only, through the preview", async () => {
  const p = await post("Mia", "/actions/broadcast.send/plan", { purpose: "service", filters: { session_id: date }, subject_en: "Court change", body_en: "We're on Court 1 tonight.",
    subject_es: "Cambio de cancha", body_es: "Hoy jugamos en la cancha 1." });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.summary, /2 people/);
  assert.match(p.json.summary, /with a place in Volley drills on/);
  const sent = await post("Mia", `/runs/${p.json.run_id}/apply`);
  assert.equal(sent.status, 200);
  const to = (await db.selectFrom("outbound_message").select("person_id").where("kind", "=", "broadcast").where("channel", "=", "inbox").execute()).map((x) => x.person_id).sort();
  assert.deepEqual(to, [people.Ann!, people.Ben!].sort(), "not Cal, who's waiting, nor anyone else");
  // A coach doesn't message groups.
  assert.equal((await post("Cora", "/actions/broadcast.send/plan", { purpose: "service", filters: { session_id: date }, subject_en: "x", body_en: "y", subject_es: "x", body_es: "y" })).status, 403);
});

test("Check in all is the roster's own change: before the date starts it's refused", async () => {
  const r = await post("Cora", "/actions/attendance.mark/plan", { session_id: date, marks: [{ person_id: people.Ann, came: true }, { person_id: people.Ben, came: true }] });
  assert.match(JSON.stringify(r.json), /from the start until 48 hours after|once it starts/i);
});

test("the Schedule names each court's kind, and the Bookings list downloads as the reader sees it", async () => {
  const g = (await get(`/staff/grid?location_id=${loc}&date=${day}`, "Dana")).json;
  assert.deepEqual(g.courts.map((c: any) => [c.name, c.kind]), [["Court 1", "indoor"], ["Court 2", "outdoor"]]);
  const owner = await get(`/staff/bookings.csv?location_id=${loc}&from=${day}`, "Robin");
  assert.equal(owner.status, 200);
  const [head, ...rows] = owner.text.trim().split("\r\n");
  assert.equal(head, "date,starts,ends,minutes,court,kind,what,made in,status,organiser,players,code,owed");
  assert.ok(rows.some((r) => /,08:00,09:30,90,Court 1,Court booking,,Desk,Upcoming,Ann,3,/.test(r)), rows.join("\n"));
  assert.ok(rows.some((r) => r.includes("Volley drills")));
  const clerk = await get(`/staff/bookings.csv?location_id=${loc}&from=${day}`, "Cleo");
  assert.equal(clerk.text.split("\r\n")[0], "date,starts,ends,minutes,court,kind,what,made in,status,players,code");
  assert.ok(!/Ann|Dee|Eve/.test(clerk.text), "no names for a role that doesn't read people");
  assert.equal((await get(`/staff/bookings.csv?location_id=${loc}&from=${day}`, "Ann")).status, 403);
  const coach = await get(`/staff/bookings.csv?location_id=${loc}&from=${day}&type=court`, "Cora");
  assert.equal(coach.text.trim().split("\r\n").length, 1, "a coach's list has no one else's court");
});
