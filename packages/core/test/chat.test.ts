// Chat between players (chat.ts): who reads and posts in a game's chat (players, someone who left or was taken off,
// a waitlist, juniors and their parents, outsiders), the limits on posting (at once too), taking a message back,
// the club's moderation, pushes that keep no words, and how long a chat is kept.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { chatAccess, chatMute, chatPushWords, chatSeen, chatText, chatThread, chatUnread, checkPayment, editChat, eraseChats, exportData, messageHandlers, myChats, openPayment, plan, postChat,
  processOutbox, removeChat, run, runAsSystem, setPaymentProvider, staffChat, staffChats, tidyChats, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, booking: string, session: string, court: string, loc: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-12-01T18:00:00Z");                                           // Tue 1 Dec, 10 am
const START = new Date("2026-12-02T18:00:00-08:00"), END = new Date("2026-12-02T19:30:00-08:00");   // Wed 6 pm, 90 minutes
const DAY = 86400_000;
const min = (n: number, from = NOW) => new Date(from.getTime() + n * 60_000);
const people: Record<string, string> = {};
const as = (name: string, extra: Partial<Actor> = {}): Actor => ({ personId: people[name]!, via: "test", lang: "en", ...extra });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const seatOf = async (name: string) => (await db.selectFrom("booking_player").select("id").where("booking_id", "=", booking).where("person_id", "=", people[name]!).where("removed_at", "is", null).executeTakeFirstOrThrow()).id;
const thread = (name: string, at = NOW) => chatThread(db, people[name]!, "booking", booking, "en", at);
const threadId = async (ref: string) => (await db.selectFrom("chat_thread").select("id").where("ref_id", "=", ref).executeTakeFirstOrThrow()).id;
const device = (name: string) => db.insertInto("push_subscription").values({ id: crypto.randomUUID(), person_id: people[name]!, app: "member", endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, p256dh: "k", auth: "a" }).execute();
const course = async (name: string, dates: [string, string][], capacity = 8) => {
  const p = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name, capacity, price_cents: 0 }, owner, { now: NOW })).result as any).program_id;
  for (const [s, e] of dates) await run(db, "session.add", { program_id: p, starts_at: s, ends_at: e, court_ids: [court] }, owner, { now: NOW });
  await run(db, "program.publish", { program_id: p }, owner, { now: NOW });
  return { id: p as string, dates: (await db.selectFrom("session").select("id").where("program_id", "=", p).orderBy("starts_at").execute()).map((x) => x.id) };
};
const enrolmentOf = async (name: string, program: string) => (await db.selectFrom("enrolment").select(["id", "status"]).where("person_id", "=", people[name]!).where("program_id", "=", program).executeTakeFirstOrThrow());

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Hal", "Ann", "Andy", "Dee", "Out", "Fay", "Cole", "Wk", "Late", "Sav"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
  await run(db, "role.assign", { person_id: people.Cole, role: "coach" }, owner);
  people.Mia = ((await run(db, "household.add_junior", { person_id: people.Ann, display_name: "Mia", birth_year: 2014 }, as("Ann"), opts)).result as any).person_id;

  // Hal books Court 1 for Wednesday and pays; Ann and Andy join by the players link; Mia (Ann's junior) is on it too,
  // and a place is saved for Sav that Sav hasn't taken.
  const r = await run(db, "booking.request", { court_id: court, starts_at: START.toISOString(), minutes: 90, pay: "whole", person_id: people.Hal }, as("Hal"), opts);
  booking = (r.result as any).booking_id;
  await openPayment(db, (r.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (r.result as any).payment_id, "test", NOW);
  const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", booking).executeTakeFirstOrThrow()).invite_code!;
  for (const name of ["Ann", "Andy"]) await run(db, "booking.join_players", { invite_code: code, person_id: people[name] }, as(name), opts);
  await db.insertInto("booking_player").values({ id: crypto.randomUUID(), booking_id: booking, person_id: people.Mia!, guest_name: null }).execute();
  await db.insertInto("booking_player").values({ id: crypto.randomUUID(), booking_id: booking, person_id: people.Sav!, guest_name: null, share_cents: 1500, saved_by: people.Hal! }).execute();

  // A free clinic on Thursday: Dee has the one place, Out is waitlisted, Cole coaches it.
  const c = await course("Volley Clinic", [["2026-12-03T17:00:00-08:00", "2026-12-03T18:30:00-08:00"]], 1);
  session = c.dates[0]!;
  await db.updateTable("session").set({ coach_id: people.Cole! }).where("id", "=", session).execute();
  await run(db, "enrolment.join", { program_id: c.id, person_id: people.Dee }, as("Dee"), opts);
  await run(db, "enrolment.join", { program_id: c.id, person_id: people.Out }, as("Out"), opts);
});
after(async () => drop());

test("the players in a booking read and post; nobody else does, nor a place saved and not taken; the badge counts it", async () => {
  await postChat(db, people.Hal!, "booking", booking, "  Who's bringing balls?\r\nI have one can.  ", NOW);
  const ann = await thread("Ann");
  assert.equal(ann.title, "Court 1");
  assert.deepEqual(ann.people, ["Andy", "Ann", "Hal"], "who's in (not the junior, not a place nobody took)");
  assert.deepEqual([ann.messages[0]!.author, ann.messages[0]!.body, ann.messages[0]!.mine, ann.can_post], ["Hal", "Who's bringing balls?\nI have one can.", false, true]);
  assert.equal((await thread("Hal")).messages[0]!.author, null, "your own shows as you");
  assert.equal(await chatUnread(db, people.Ann!, NOW), 1);
  assert.equal(await chatUnread(db, people.Hal!, NOW), 0, "not your own");
  await chatSeen(db, people.Ann!, "booking", booking, min(1));
  assert.equal(await chatUnread(db, people.Ann!, min(1)), 0);
  for (const name of ["Out", "Dee", "Fay", "Sav"]) {
    await rejects(postChat(db, people[name]!, "booking", booking, "hi", NOW), "error.chat_not_in");
    await rejects(thread(name), "error.chat_not_in");
  }
  await rejects(postChat(db, people.Ann!, "booking", booking, "   ", NOW), "error.chat_empty");
  await rejects(postChat(db, people.Ann!, "booking", booking, "x".repeat(1001), NOW), "error.chat_too_long");
});

test("bidi overrides, zero-width and control characters never reach a chat", () => {
  assert.equal(chatText("pay here ‮gnp.exe‬ ​x⁦y⁩ \u0085z­"), "pay here gnp.exe xy z");
  assert.equal(chatText("family \u{1F468}‍\u{1F469}‍\u{1F467}"), "family \u{1F468}‍\u{1F469}‍\u{1F467}", "emoji keep their joiner");
});

test("juniors don't see chats; a parent in the same game reads it as themselves", async () => {
  const a = await chatAccess(db, people.Mia!, "booking", booking, NOW);
  assert.deepEqual([a.read, a.post, a.why], [false, false, "error.chat_junior"]);
  await rejects(postChat(db, people.Mia!, "booking", booking, "hi", NOW), "error.chat_junior");
  assert.deepEqual(await myChats(db, people.Mia!, NOW), { off: false, junior: true, chats: [] });
  assert.equal((await thread("Ann")).can_post, true);
  assert.equal((await db.selectFrom("chat_seen").select("person_id").where("person_id", "=", people.Mia!).execute()).length, 0);
});

test("someone the organiser takes off reads nothing, even what came before", async () => {
  await run(db, "booking.remove_player", { booking_player_id: await seatOf("Andy") }, as("Hal"), { now: NOW });
  await postChat(db, people.Ann!, "booking", booking, "Andy's out, meet at 5:30 at the back gate", min(10));
  await rejects(thread("Andy", min(11)), "error.chat_not_in");
  assert.equal(await chatUnread(db, people.Andy!, min(11)), 0);
  assert.equal((await myChats(db, people.Andy!, min(11))).chats.length, 0);
});

test("a program's date: places and the coach; not a waitlist, even one left; who's named is who's written", async () => {
  await postChat(db, people.Dee!, "session", session, "First clinic for me!", NOW);
  const cole = await chatThread(db, people.Cole!, "session", session, "en", NOW);
  assert.deepEqual([cole.can_post, cole.people, cole.players], [true, ["Dee"], 2], "the roster stays the club's: only who's written is named");
  await rejects(chatThread(db, people.Out!, "session", session, "en", NOW), "error.chat_not_in");
  const out = await db.selectFrom("enrolment").select("id").where("person_id", "=", people.Out!).executeTakeFirstOrThrow();
  await run(db, "enrolment.leave", { enrolment_id: out.id }, as("Out"), { now: min(1) });
  await rejects(chatThread(db, people.Out!, "session", session, "en", min(2)), "error.chat_not_in");
});

test("left a course: the dates already begun read up to when they left; later dates, and a course left before it began, nothing", async () => {
  const c = await course("Six-week course", [["2026-12-04T17:00:00-08:00", "2026-12-04T18:00:00-08:00"], ["2027-01-08T17:00:00-08:00", "2027-01-08T18:00:00-08:00"]]);
  const [d1, d2] = c.dates as [string, string];
  await run(db, "enrolment.join", { program_id: c.id, person_id: people.Wk }, as("Wk"), { now: NOW });
  await run(db, "enrolment.join", { program_id: c.id, person_id: people.Late }, as("Late"), { now: NOW });
  const dec4 = new Date("2026-12-05T01:30:00Z");   // during the first date
  await postChat(db, people.Late!, "session", d1, "Court's wet, bring a towel", dec4);
  await run(db, "enrolment.leave", { enrolment_id: (await enrolmentOf("Wk", c.id)).id }, as("Wk"), { now: min(5, dec4) });
  await postChat(db, people.Late!, "session", d1, "Wk left early", min(10, dec4));
  const wk = await chatThread(db, people.Wk!, "session", d1, "en", min(11, dec4));
  assert.deepEqual([wk.messages.map((m) => m.body), wk.can_post, wk.people], [["Court's wet, bring a towel"], false, []]);
  await postChat(db, people.Late!, "session", d2, "Jan 8: carpool from Eastside?", new Date("2027-01-07T18:00:00Z"));
  await rejects(chatThread(db, people.Wk!, "session", d2, "en", new Date("2027-01-07T18:01:00Z")), "error.chat_not_in");
  // Someone who left before the course began never had any of its dates.
  const early = await course("Spring course", [["2026-12-08T17:00:00-08:00", "2026-12-08T18:00:00-08:00"]]);
  await run(db, "enrolment.join", { program_id: early.id, person_id: people.Wk }, as("Wk"), { now: NOW });
  await run(db, "enrolment.leave", { enrolment_id: (await enrolmentOf("Wk", early.id)).id }, as("Wk"), { now: min(1) });
  await run(db, "enrolment.join", { program_id: early.id, person_id: people.Late }, as("Late"), { now: min(2) });
  await postChat(db, people.Late!, "session", early.dates[0]!, "anyone?", min(3));
  await rejects(chatThread(db, people.Wk!, "session", early.dates[0]!, "en", min(4)), "error.chat_not_in");
});

test("at most 20 posts in 10 minutes, at once too; one push in 5 minutes, at once too", async () => {
  await device("Hal");
  const t0 = new Date("2026-12-01T19:00:00Z");
  await db.updateTable("chat_seen").set({ pushed_at: null }).execute();
  const pushes = async () => Number((await db.selectFrom("outbound_message").select((x) => x.fn.countAll<string>().as("n")).where("person_id", "=", people.Hal!).where("kind", "=", "chat_message").executeTakeFirstOrThrow()).n);
  const before_ = await pushes();
  const rs = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => postChat(db, people.Ann!, "booking", booking, `flood ${i}`, t0)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 20);
  assert.ok(rs.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason?.code === "error.chat_too_fast"));
  assert.equal(await pushes() - before_, 1);
  await postChat(db, people.Ann!, "booking", booking, "and now", min(11, t0));
});

test("a message changes for 5 minutes and is taken back any time; a push copy keeps no words", async () => {
  const t1 = new Date("2026-12-01T20:00:00Z");
  await device("Ann");
  await db.updateTable("chat_seen").set({ pushed_at: null }).execute();
  const { id } = await postChat(db, people.Hal!, "booking", booking, "Lets meet at 5:45, my cell is 415 555 0199", t1);
  const copy = await db.selectFrom("outbound_message").select(["subject", "body", "chat_message_id", "link", "stale_at"]).where("person_id", "=", people.Ann!).where("chat_message_id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([copy.subject, copy.body, copy.link], ["Court 1, Wed, Dec 2, 6:00 PM", "", `/chats/booking/${booking}`]);
  assert.equal(new Date(copy.stale_at!).getTime(), min(15, t1).getTime());
  assert.equal(await chatPushWords(db, id, "en"), "Hal: Lets meet at 5:45, my cell is 415 555 0199", "the words are read as it's sent");
  await editChat(db, people.Hal!, id, "Let's meet at 5:45", min(4, t1));
  assert.deepEqual((await thread("Ann", min(4, t1))).messages.find((x) => x.id === id)!.edited, true);
  await rejects(editChat(db, people.Hal!, id, "too late", min(6, t1)), "error.chat_edit_window");
  await rejects(editChat(db, people.Ann!, id, "not mine", min(1, t1)), "error.not_found");
  await removeChat(db, people.Hal!, id, min(60, t1));
  const m = (await thread("Ann", min(60, t1))).messages.find((x) => x.id === id)!;
  assert.deepEqual([m.state, m.body, m.can_report], ["removed", null, false]);
  assert.equal(await chatPushWords(db, id, "en"), null, "a push still waiting sends nothing");
  assert.equal((await db.selectFrom("outbound_message").select("id").where(sql<boolean>`body LIKE '%0199%' OR subject LIKE '%0199%'`).execute()).length, 0);
  const data = await exportData(db, people.Ann!, min(61, t1), "en") as any;
  assert.ok(!data.messages.some((x: any) => x.kind === "chat_message"), "other players' messages aren't in Ann's Download data");
});

test("a report: once per chat an hour to the desk; a reported message keeps its words for the staff and can't be changed", async () => {
  const t0 = new Date("2026-12-01T22:00:00Z");
  const { id } = await postChat(db, people.Hal!, "booking", booking, "You all play like beginners", t0);
  const { id: id2 } = await postChat(db, people.Hal!, "booking", booking, "and you're slow", min(1, t0));
  await rejects(plan(db, "chat.report", { message_id: id }, as("Hal"), { now: min(2, t0) }), "error.chat_report_own");
  await rejects(plan(db, "chat.report", { message_id: id }, as("Out"), { now: min(2, t0) }), "error.not_found");
  await rejects(plan(db, "chat.report", { message_id: id }, as("Ann", { auth: "oauth" }), { now: min(2, t0) }), "error.assistant_in_app");
  const r = await run(db, "chat.report", { message_id: id, reason: "She lives next to me" }, as("Ann"), { now: min(2, t0) });
  assert.equal(r.plan.summary.en.includes("beginners"), false, "the words aren't copied into the change log");
  await run(db, "chat.report", { message_id: id2 }, as("Ann"), { now: min(3, t0) });
  await rejects(plan(db, "chat.report", { message_id: id }, as("Ann"), { now: min(4, t0) }), "error.chat_reported");
  await processOutbox(db, messageHandlers, 100, min(5, t0));
  const alerts = await db.selectFrom("outbound_message").select(["person_id", "subject"]).where("kind", "=", "chat_reported_staff").where("channel", "=", "inbox").execute();
  assert.deepEqual(alerts.map((a) => a.person_id).sort(), [people.Fay, people.Robin].sort(), "one alert each, not one per message");
  const runs = await db.selectFrom("action_run").select("id").where(sql<boolean>`input::text LIKE '%next to me%'`).execute();
  const log = await db.selectFrom("entity_change").select("id").where(sql<boolean>`after::text LIKE '%next to me%' OR after::text LIKE '%beginners%'`).execute();
  assert.deepEqual([runs.length, log.length], [0, 0], "neither the reason nor the words are kept in the change log");

  // Taken back before the staff look: the players see it gone, the staff still see it, and it can't be changed.
  await rejects(editChat(db, people.Hal!, id2, "and you're fast", min(4, t0)), "error.chat_report_waits");
  await removeChat(db, people.Hal!, id, min(6, t0));
  const tid = await threadId(booking);
  assert.equal((await thread("Ann", min(7, t0))).messages.find((m) => m.id === id)!.state, "removed");
  let sm = (await staffChat(db, tid, min(7, t0))).messages.find((m) => m.id === id)!;
  assert.deepEqual([sm.state, sm.body, sm.reports[0]!.reason], ["removed", "You all play like beginners", "She lives next to me"]);
  assert.equal((await staffChats(db, min(7, t0))).find((c) => c.id === tid)!.reports, 2);
  await rejects(plan(db, "chat.hide", { message_id: id, hidden: true }, as("Ann"), { now: min(8, t0) }), "error.forbidden_reason");
  await rejects(plan(db, "chat.hide", { message_id: id, hidden: true }, as("Cole"), { now: min(8, t0) }), "error.forbidden_reason");
  await run(db, "chat.hide", { message_id: id, hidden: true }, as("Fay"), { now: min(8, t0) });
  sm = (await staffChat(db, tid, min(9, t0))).messages.find((m) => m.id === id)!;
  assert.equal(sm.body, null, "dealt with: the words its author took back go now");
  await run(db, "chat.hide", { message_id: id2, hidden: true }, as("Fay"), { now: min(9, t0) });
  assert.deepEqual([(await thread("Ann", min(10, t0))).messages.find((m) => m.id === id2)!.state, (await staffChats(db, min(10, t0))).find((c) => c.id === tid)!.reports], ["hidden", 0]);

  await run(db, "chat.stop", { person_id: people.Hal, days: 3, reason: "Rude in chat" }, as("Fay"), { now: min(11, t0) });
  await rejects(postChat(db, people.Hal!, "booking", booking, "sorry", min(12, t0)), "error.chat_stopped");
  assert.match((await thread("Hal", min(12, t0))).cannot_post!, /^The club has stopped you posting in chats until Fri, Dec 4/);
  assert.equal((await db.selectFrom("action_run").select("id").where(sql<boolean>`input::text LIKE '%Rude in chat%'`).execute()).length, 0);
  await run(db, "chat.allow", { person_id: people.Hal }, as("Fay"), { now: min(13, t0) });
  await postChat(db, people.Hal!, "booking", booking, "sorry everyone", min(14, t0));
});

test("the staff list puts chats with reports first, however many chats there are", async () => {
  const t0 = new Date("2026-12-02T01:00:00Z");
  for (let i = 0; i < 205; i++) {
    const tid = crypto.randomUUID(), mid = crypto.randomUUID();
    await db.insertInto("chat_thread").values({ id: tid, kind: "booking", ref_id: crypto.randomUUID(), ends_at: t0 }).execute();
    await db.insertInto("chat_message").values({ id: mid, thread_id: tid, person_id: people.Dee!, body: `x${i}`, created_at: t0 }).execute();
    if (i === 204) await db.insertInto("chat_report").values({ id: crypto.randomUUID(), message_id: mid, person_id: people.Late!, reason: null }).execute();
  }
  const list = await staffChats(db, min(1, t0));
  assert.equal(list.length, 200);
  assert.equal(list[0]!.reports, 1);
  await db.deleteFrom("chat_thread").where("kind", "=", "booking").where("ref_id", "!=", booking).execute();
});

test("pushes: never for a muted chat, the author or a junior, and not at night", async () => {
  const t0 = new Date("2026-12-01T23:00:00Z");   // 3 pm at the club
  await device("Mia");
  const pushes = async (name: string) => (await db.selectFrom("outbound_message").select("id").where("person_id", "=", people[name]!).where("kind", "=", "chat_message").execute()).length;
  await db.updateTable("chat_seen").set({ pushed_at: null }).execute();
  const a0 = await pushes("Ann"), h0 = await pushes("Hal");
  await postChat(db, people.Hal!, "booking", booking, "Court's free at 5", t0);
  assert.deepEqual([await pushes("Ann") - a0, await pushes("Hal") - h0, await pushes("Mia")], [1, 0, 0]);
  await chatMute(db, people.Ann!, "booking", booking, true, min(1, t0));
  await postChat(db, people.Hal!, "booking", booking, "Last call", min(7, t0));
  assert.equal(await pushes("Ann") - a0, 1, "muted");
  await chatMute(db, people.Ann!, "booking", booking, false, min(8, t0));
  await postChat(db, people.Hal!, "booking", booking, "Goodnight", new Date("2026-12-02T06:30:00Z"));   // 10:30 pm at the club
  assert.equal(await pushes("Ann") - a0, 1, "quiet hours");
});

test("read-only, moved or leaving: read, not added to; the club's switch turns chats off", async () => {
  await sql`UPDATE club SET read_only_since = now()`.execute(db);
  await rejects(postChat(db, people.Ann!, "booking", booking, "hello?", min(200)), "error.chat_read_only");
  assert.ok((await thread("Ann", min(200))).messages.length > 0);
  await sql`UPDATE club SET read_only_since = NULL, leaving_on = '2027-01-31'`.execute(db);
  await rejects(postChat(db, people.Ann!, "booking", booking, "hello?", min(200)), "error.chat_leaving");
  await sql`UPDATE club SET leaving_on = NULL`.execute(db);
  await run(db, "club.update", { players_chat: false }, owner, { now: min(201) });
  await rejects(thread("Ann", min(202)), "error.chat_off");
  assert.deepEqual(await myChats(db, people.Ann!, min(202)), { off: true, junior: false, chats: [] });
  await run(db, "club.update", { players_chat: true }, owner, { now: min(203) });
});

test("posting closes two days after the game; reading until 90 days; then nothing makes the chat again", async () => {
  await postChat(db, people.Ann!, "booking", booking, "Good game!", new Date(END.getTime() + DAY));
  await rejects(postChat(db, people.Ann!, "booking", booking, "still here?", new Date(END.getTime() + 3 * DAY)), "error.chat_closed");
  assert.ok((await thread("Ann", new Date(END.getTime() + 89 * DAY))).messages.length > 0);
  const old = new Date(END.getTime() + 200 * DAY);
  await tidyChats(db, old);
  assert.equal((await db.selectFrom("chat_thread").select("id").where("ref_id", "=", booking).execute()).length, 0);
  await rejects(postChat(db, people.Hal!, "booking", booking, "remember me?", old), "error.chat_expired");
  await rejects(chatMute(db, people.Ann!, "booking", booking, true, old), "error.chat_expired");
  assert.equal((await db.selectFrom("chat_thread").select("id").where("ref_id", "=", booking).execute()).length, 0, "nothing made it again");
});

test("deleting an account takes its words, from pushes too, and the reasons it gave or was given", async () => {
  const c = await course("Late course", [["2027-08-01T17:00:00-07:00", "2027-08-01T18:00:00-07:00"]]);
  const at = new Date("2027-07-30T18:00:00Z");
  for (const name of ["Dee", "Late"]) await run(db, "enrolment.join", { program_id: c.id, person_id: people[name] }, as(name), { now: at });
  const { id } = await postChat(db, people.Dee!, "session", c.dates[0]!, "I work nights at the Oak St pharmacy", at);
  await run(db, "chat.report", { message_id: id, reason: "watching my house" }, as("Late"), { now: min(1, at) });
  assert.ok((await exportData(db, people.Dee!, min(2, at), "en") as any).chats.some((m: any) => m.text === "I work nights at the Oak St pharmacy"));
  await db.transaction().execute((trx) => eraseChats(trx, people.Dee!, min(3, at)));
  await db.transaction().execute((trx) => eraseChats(trx, people.Late!, min(3, at)));
  const dee = await db.selectFrom("chat_message").select(["body", "removed_at"]).where("person_id", "=", people.Dee!).execute();
  assert.ok(dee.length && dee.every((m) => m.body === "" && m.removed_at));
  assert.equal(await chatPushWords(db, id, "en"), null);
  assert.equal((await db.selectFrom("chat_report").select("reason").where("message_id", "=", id).executeTakeFirstOrThrow()).reason, null);
  assert.equal((await db.selectFrom("action_run").select("id").where(sql<boolean>`input::text LIKE '%watching my house%'`).execute()).length, 0);
});
