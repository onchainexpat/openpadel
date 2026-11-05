// Chat between players (chat.ts): who reads and posts in a game's chat (players, someone who left, juniors and their
// parents, outsiders), the limits on posting, taking a message back, the club's moderation, pushes, and how long
// a chat is kept.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { chatAccess, chatMute, chatSeen, chatThread, chatUnread, checkPayment, editChat, eraseChats, exportData, messageHandlers, myChats, openPayment, plan, postChat, processOutbox,
  removeChat, run, runAsSystem, setPaymentProvider, staffChat, staffChats, tidyChats, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, booking: string, session: string, court: string, loc: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-12-01T18:00:00Z");                                           // Tue 1 Dec, 10 am
const START = new Date("2026-12-02T18:00:00-08:00"), END = new Date("2026-12-02T19:30:00-08:00");   // Wed 6 pm, 90 minutes
const min = (n: number, from = NOW) => new Date(from.getTime() + n * 60_000);
const people: Record<string, string> = {};
const as = (name: string, extra: Partial<Actor> = {}): Actor => ({ personId: people[name]!, via: "test", lang: "en", ...extra });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const seatOf = async (name: string) => (await db.selectFrom("booking_player").select("id").where("booking_id", "=", booking).where("person_id", "=", people[name]!).where("removed_at", "is", null).executeTakeFirstOrThrow()).id;
const thread = (name: string, at = NOW) => chatThread(db, people[name]!, "booking", booking, "en", at);

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
  for (const name of ["Hal", "Ann", "Andy", "Dee", "Out", "Fay", "Cole"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
  await run(db, "role.assign", { person_id: people.Cole, role: "coach" }, owner);
  people.Mia = ((await run(db, "household.add_junior", { person_id: people.Ann, display_name: "Mia", birth_year: 2014 }, as("Ann"), opts)).result as any).person_id;

  // Hal books Court 1 for Wednesday and pays; Ann and Andy join by the players link; Mia (Ann's junior) is on it too.
  const r = await run(db, "booking.request", { court_id: court, starts_at: START.toISOString(), minutes: 90, pay: "whole", person_id: people.Hal }, as("Hal"), opts);
  booking = (r.result as any).booking_id;
  await openPayment(db, (r.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (r.result as any).payment_id, "test", NOW);
  const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", booking).executeTakeFirstOrThrow()).invite_code!;
  for (const name of ["Ann", "Andy"]) await run(db, "booking.join_players", { invite_code: code, person_id: people[name] }, as(name), opts);
  await db.insertInto("booking_player").values({ id: crypto.randomUUID(), booking_id: booking, person_id: people.Mia!, guest_name: null }).execute();

  // A free clinic on Thursday: Dee has a place, Cole coaches it.
  const p = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley Clinic", capacity: 1, price_cents: 0 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: p, starts_at: "2026-12-03T17:00:00-08:00", ends_at: "2026-12-03T18:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: p }, owner, opts);
  session = (await db.selectFrom("session").select("id").where("program_id", "=", p).executeTakeFirstOrThrow()).id;
  await db.updateTable("session").set({ coach_id: people.Cole! }).where("id", "=", session).execute();
  await run(db, "enrolment.join", { program_id: p, person_id: people.Dee }, as("Dee"), opts);
  await run(db, "enrolment.join", { program_id: p, person_id: people.Out }, as("Out"), opts);   // full: waitlisted
});
after(async () => drop());

test("the players in a booking read and post; nobody else does; the others' badge counts it until they read", async () => {
  await postChat(db, people.Hal!, "booking", booking, "  Who's bringing balls?\r\nI have one can.  ", NOW);
  const ann = await thread("Ann");
  assert.equal(ann.title, "Court 1");
  assert.deepEqual(ann.people, ["Andy", "Ann", "Hal"], "who's in (not the junior)");
  assert.equal(ann.messages.length, 1);
  assert.deepEqual([ann.messages[0]!.author, ann.messages[0]!.body, ann.messages[0]!.mine, ann.can_post], ["Hal", "Who's bringing balls?\nI have one can.", false, true]);
  assert.equal((await thread("Hal")).messages[0]!.author, null, "your own shows as you");
  assert.equal(await chatUnread(db, people.Ann!, NOW), 1);
  assert.equal(await chatUnread(db, people.Hal!, NOW), 0, "not your own");
  await chatSeen(db, people.Ann!, "booking", booking, min(1));
  assert.equal(await chatUnread(db, people.Ann!, min(1)), 0);
  assert.equal((await myChats(db, people.Andy!, NOW)).chats.find((c) => c.id === booking)?.unread, 1);

  for (const name of ["Out", "Dee", "Fay"]) {
    await rejects(postChat(db, people[name]!, "booking", booking, "hi", NOW), "error.chat_not_in");
    await rejects(thread(name), "error.chat_not_in");
  }
  await rejects(postChat(db, people.Ann!, "booking", booking, "   ", NOW), "error.chat_empty");
  await rejects(postChat(db, people.Ann!, "booking", booking, "x".repeat(1001), NOW), "error.chat_too_long");
});

test("juniors don't see chats; a parent in the same game reads it as themselves", async () => {
  const a = await chatAccess(db, people.Mia!, "booking", booking, NOW);
  assert.deepEqual([a.read, a.post, a.why], [false, false, "error.chat_junior"]);
  await rejects(postChat(db, people.Mia!, "booking", booking, "hi", NOW), "error.chat_junior");
  assert.deepEqual(await myChats(db, people.Mia!, NOW), { off: false, junior: true, chats: [] });
  assert.equal((await thread("Ann")).can_post, true);
  // Nobody pushes or counts for the junior.
  const seen = await db.selectFrom("chat_seen").select("person_id").where("person_id", "=", people.Mia!).execute();
  assert.equal(seen.length, 0);
});

test("someone who leaves reads until the game ends but doesn't post; after it, only those still in it read", async () => {
  await run(db, "booking.remove_player", { booking_player_id: await seatOf("Andy") }, as("Hal"), { now: NOW });
  const left = await thread("Andy");
  assert.equal(left.can_post, false);
  assert.equal(left.cannot_post, "You've left this game: you can read its chat until it ends, but not post.");
  await rejects(postChat(db, people.Andy!, "booking", booking, "still here?", NOW), "error.chat_left");
  await rejects(thread("Andy", min(1, END)), "error.chat_not_in");
  assert.equal((await thread("Ann", min(60, END))).can_post, true, "the players still in it carry on after the game");
});

test("at most 20 posts in 10 minutes; a message changes for 5 minutes and is taken back any time", async () => {
  const t0 = new Date("2026-12-01T19:00:00Z");
  for (let i = 0; i < 20; i++) await postChat(db, people.Ann!, "booking", booking, `post ${i}`, min(i * 0.1, t0));
  await rejects(postChat(db, people.Ann!, "booking", booking, "one more", min(3, t0)), "error.chat_too_fast");
  await postChat(db, people.Ann!, "booking", booking, "and now", min(11, t0));

  const t1 = new Date("2026-12-01T20:00:00Z");
  const { id } = await postChat(db, people.Hal!, "booking", booking, "Lets meet at 5:45", t1);
  await editChat(db, people.Hal!, id, "Let's meet at 5:45", min(4, t1));
  let m = (await thread("Ann", min(4, t1))).messages.find((x) => x.id === id)!;
  assert.deepEqual([m.body, m.edited], ["Let's meet at 5:45", true]);
  await rejects(editChat(db, people.Hal!, id, "too late", min(6, t1)), "error.chat_edit_window");
  await rejects(editChat(db, people.Ann!, id, "not mine", min(1, t1)), "error.not_found");
  await removeChat(db, people.Hal!, id, min(60, t1));
  m = (await thread("Ann", min(60, t1))).messages.find((x) => x.id === id)!;
  assert.deepEqual([m.state, m.body, m.can_report], ["removed", null, false]);
  assert.equal((await db.selectFrom("chat_message").select("body").where("id", "=", id).executeTakeFirstOrThrow()).body, "", "its words are gone");
});

test("a program's date: the players with a place and the coach; a waitlist isn't a place", async () => {
  await postChat(db, people.Dee!, "session", session, "First clinic for me!", NOW);
  assert.equal((await chatThread(db, people.Cole!, "session", session, "en", NOW)).can_post, true);
  await postChat(db, people.Cole!, "session", session, "Welcome, bring water.", min(1));
  await rejects(chatThread(db, people.Out!, "session", session, "en", NOW), "error.chat_not_in");
  assert.equal((await chatThread(db, people.Dee!, "session", session, "en", min(2))).title, "Volley Clinic");
});

test("a player reports a message once; the desk hears once; the desk hides it and stops its author; members can't", async () => {
  const { id } = await postChat(db, people.Hal!, "booking", booking, "You all play like beginners", min(120));
  await rejects(plan(db, "chat.report", { message_id: id }, as("Hal"), { now: min(121) }), "error.chat_report_own");
  await rejects(plan(db, "chat.report", { message_id: id }, as("Out"), { now: min(121) }), "error.not_found");
  // An assistant never reports (what it reads in a chat could tell it to).
  await rejects(plan(db, "chat.report", { message_id: id }, as("Ann", { auth: "oauth" }), { now: min(121) }), "error.assistant_in_app");
  const r = await run(db, "chat.report", { message_id: id, reason: "Rude" }, as("Ann"), { now: min(121) });
  assert.equal(r.plan.summary.en.includes("beginners"), false, "the words aren't copied into the change log");
  await rejects(plan(db, "chat.report", { message_id: id }, as("Ann"), { now: min(122) }), "error.chat_reported");
  await processOutbox(db, messageHandlers, 100, min(122));
  const alerts = await db.selectFrom("outbound_message").select(["person_id", "subject"]).where("kind", "=", "chat_reported_staff").where("channel", "=", "inbox").execute();
  assert.deepEqual(new Set(alerts.map((a) => a.person_id)), new Set([people.Fay, people.Robin]));
  assert.equal(alerts[0]!.subject, "A message was reported: Hal");
  assert.equal((await thread("Ann", min(122))).messages.find((m) => m.id === id)!.reported, true);

  await rejects(plan(db, "chat.hide", { message_id: id, hidden: true }, as("Ann"), { now: min(123) }), "error.forbidden_reason");
  await rejects(plan(db, "chat.hide", { message_id: id, hidden: true }, as("Cole"), { now: min(123) }), "error.forbidden_reason");
  await run(db, "chat.hide", { message_id: id, hidden: true }, as("Fay"), { now: min(123) });
  const seen = (await thread("Ann", min(124))).messages.find((m) => m.id === id)!;
  assert.deepEqual([seen.state, seen.body], ["hidden", null]);
  const staff = await staffChat(db, (await db.selectFrom("chat_thread").select("id").where("ref_id", "=", booking).executeTakeFirstOrThrow()).id, min(124));
  const sm = staff.messages.find((m) => m.id === id)!;
  assert.deepEqual([sm.state, sm.body, sm.reports.length, sm.reports[0]!.reason], ["hidden", "You all play like beginners", 1, "Rude"]);
  assert.equal((await staffChats(db, min(124)))[0]!.reports, 0, "a hidden message's reports are dealt with");
  const log = await db.selectFrom("entity_change").select(["before", "after"]).where("entity", "=", "chat_message").where("entity_id", "=", id).executeTakeFirstOrThrow();
  assert.equal(JSON.stringify(log).includes("beginners"), false, "the change log keeps no words");

  await run(db, "chat.stop", { person_id: people.Hal, days: 3, reason: "Rude in chat" }, as("Fay"), { now: min(125) });
  await rejects(postChat(db, people.Hal!, "booking", booking, "sorry", min(126)), "error.chat_stopped");
  assert.match((await thread("Hal", min(126))).cannot_post!, /^The club has stopped you posting in chats until Fri, Dec 4/);
  await run(db, "chat.allow", { person_id: people.Hal }, as("Fay"), { now: min(127) });
  await postChat(db, people.Hal!, "booking", booking, "sorry everyone", min(128));
  await rejects(plan(db, "chat.allow", { person_id: people.Hal }, as("Fay"), { now: min(129) }), "error.chat_not_stopped");
});

test("phones hear at most once in 5 minutes per chat, never for a muted chat, the author or a junior, and not at night", async () => {
  const t0 = new Date("2026-12-01T21:00:00Z");   // 1 pm at the club
  for (const name of ["Ann", "Hal", "Mia"]) await db.insertInto("push_subscription").values({ id: crypto.randomUUID(), person_id: people[name]!, app: "member", endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, p256dh: "k", auth: "a" }).execute();
  const pushes = async (name: string) => (await db.selectFrom("outbound_message").select(["subject", "body", "link", "stale_at", "send_after"]).where("person_id", "=", people[name]!).where("kind", "=", "chat_message").orderBy("created_at").execute());
  await db.deleteFrom("outbound_message").where("kind", "=", "chat_message").execute();
  await db.updateTable("chat_seen").set({ pushed_at: null }).execute();
  await postChat(db, people.Hal!, "booking", booking, "Court's free at 5 if anyone wants a warm-up", t0);
  await postChat(db, people.Hal!, "booking", booking, "Bring water", min(2, t0));
  const ann = await pushes("Ann");
  assert.equal(ann.length, 1);
  assert.deepEqual([ann[0]!.subject, ann[0]!.body, ann[0]!.link], ["Court 1, Wed, Dec 2, 6:00 PM", "Hal: Court's free at 5 if anyone wants a warm-up", `/chats/booking/${booking}`]);
  assert.equal(new Date(ann[0]!.stale_at!).getTime(), min(15, t0).getTime());
  assert.equal((await pushes("Hal")).length, 0); assert.equal((await pushes("Mia")).length, 0);
  await postChat(db, people.Hal!, "booking", booking, "Anyone?", min(6, t0));
  assert.equal((await pushes("Ann")).length, 2);
  await chatMute(db, people.Ann!, "booking", booking, true, min(7, t0));
  await postChat(db, people.Hal!, "booking", booking, "Last call", min(13, t0));
  assert.equal((await pushes("Ann")).length, 2, "muted");
  assert.equal((await thread("Ann", min(14, t0))).muted, true);
  await chatMute(db, people.Ann!, "booking", booking, false, min(14, t0));
  await postChat(db, people.Hal!, "booking", booking, "Goodnight", new Date("2026-12-02T06:30:00Z"));   // 10:30 pm at the club
  assert.equal((await pushes("Ann")).length, 2, "quiet hours");
});

test("read-only, moved or leaving: chats are read but not added to; the club's switch turns them off", async () => {
  await sql`UPDATE club SET read_only_since = now()`.execute(db);
  await rejects(postChat(db, people.Ann!, "booking", booking, "hello?", min(200)), "error.chat_read_only");
  assert.equal((await thread("Ann", min(200))).messages.length > 0, true);
  await sql`UPDATE club SET read_only_since = NULL, leaving_on = '2027-01-31'`.execute(db);
  await rejects(postChat(db, people.Ann!, "booking", booking, "hello?", min(200)), "error.chat_leaving");
  await sql`UPDATE club SET leaving_on = NULL`.execute(db);
  await run(db, "club.update", { players_chat: false }, owner, { now: min(201) });
  await rejects(thread("Ann", min(202)), "error.chat_off");
  assert.deepEqual(await myChats(db, people.Ann!, min(202)), { off: true, junior: false, chats: [] });
  assert.equal(await chatUnread(db, people.Ann!, min(202)), 0);
  await run(db, "club.update", { players_chat: true }, owner, { now: min(203) });
});

test("a member's own messages are in their Download data; deleting the account takes their words", async () => {
  const data = await exportData(db, people.Hal!, min(300), "en") as any;
  assert.ok(data.chats.some((m: any) => m.text === "sorry everyone" && m.game === "booking"));
  assert.ok(!data.chats.some((m: any) => m.text === "First clinic for me!"), "only their own");
  await db.transaction().execute((trx) => eraseChats(trx, people.Dee!, min(300)));
  const dee = await db.selectFrom("chat_message").select(["body", "removed_at"]).where("person_id", "=", people.Dee!).execute();
  assert.ok(dee.length && dee.every((m) => m.body === "" && m.removed_at));
  assert.equal((await db.selectFrom("chat_seen").select("person_id").where("person_id", "=", people.Dee!).execute()).length, 0);
});

test("a chat goes 90 days after its game, with everything in it", async () => {
  const day = 86400_000;
  assert.deepEqual(await tidyChats(db, new Date(END.getTime() + 89 * day)), { deleted: 0 });
  assert.equal((await tidyChats(db, new Date(new Date("2026-12-03T18:30:00-08:00").getTime() + 91 * day))).deleted, 2);
  assert.equal((await db.selectFrom("chat_message").select("id").execute()).length, 0);
  assert.equal((await db.selectFrom("chat_report").select("id").execute()).length, 0);
});
