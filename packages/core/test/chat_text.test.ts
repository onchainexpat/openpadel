// What a chat shows and keeps (the chat review's last round): names and messages that draw nothing are refused, and a
// blank one already stored shows as "A player"; a reason typed into a report or a stop that was never confirmed isn't
// kept with the preview; words held for a report are in the author's own download; a booking moved earlier ends its
// chat at its new time.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { chatPushWords, chatsOf, checkPayment, gameOf, openPayment, plan, postChat, removeChat, run, runAsSystem, setPaymentProvider, staffChat, tidyChats,
  plainName, plainText, visible, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, booking: string, court: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-12-01T18:00:00Z");
const START = new Date("2026-12-02T18:00:00-08:00");
const min = (n: number, from = NOW) => new Date(from.getTime() + n * 60_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, test: (e: KumiError | Error) => boolean) {
  await assert.rejects(p, (e: unknown) => { assert.ok(test(e as KumiError), String(e)); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Hal", "Ann"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  const r = await run(db, "booking.request", { court_id: court, starts_at: START.toISOString(), minutes: 90, pay: "whole", person_id: people.Hal }, as("Hal"), opts);
  booking = (r.result as any).booking_id;
  await openPayment(db, (r.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (r.result as any).payment_id, "test", NOW);
  const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", booking).executeTakeFirstOrThrow()).invite_code!;
  await run(db, "booking.join_players", { invite_code: code, person_id: people.Ann }, as("Ann"), opts);
});
after(async () => { await drop(); });

test("text that draws nothing: joiners only between emoji, the non-joiner between letters, fillers and stray selectors out, marks capped", () => {
  for (const blank of ["​", "‍‍", "ㅤ", "ᅟᅠ", "ﾠ", "⠀", "‌", "️", " ́́ "]) {
    assert.equal(visible(plainName(blank)), false, JSON.stringify(blank));
  }
  assert.equal(plainName("👨‍👩‍👧"), "👨‍👩‍👧", "a family keeps its joiners");
  assert.equal(plainName("a‍b"), "ab", "a joiner between letters goes");
  assert.equal(plainName("می‌خواهم"), "می‌خواهم", "Persian keeps its non-joiner");
  assert.equal(plainName("❤️ 1️⃣"), "❤️ 1️⃣", "an emoji's and a keycap's selector stay");
  assert.equal(plainName("hi︀\u{e0100}"), "hi", "selectors that hide bytes go");
  const england = "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
  assert.equal(plainName(england), england, "a subdivision flag keeps its tag letters");
  assert.equal(plainName("x\u{e0067}y"), "xy", "tag letters anywhere else go");
  assert.equal([...plainName("a" + "́".repeat(400))].length, 4, "at most three marks on a letter");
  assert.equal(plainName("Nguyễn"), "Nguyễn");
  assert.equal(plainText("line\r\n\r\n\r\nnextㅤ"), "line\n\nnext");
});

test("a name or a message with nothing to see is refused; a blank name already stored shows as A player", async () => {
  for (const name of ["​", "ㅤ", "⠀⠀", "‍"]) {
    await rejects(run(db, "person.update_profile", { person_id: people.Ann, display_name: name }, as("Ann"), { now: NOW }), (e) => !(e instanceof KumiError) || e.code === "error.invalid_input");
    await rejects(run(db, "person.create", { display_name: name, email: "blank@example.test" }, owner, { now: NOW }), (e) => !(e instanceof KumiError) || e.code === "error.invalid_input");
    await rejects(run(db, "household.add_junior", { person_id: people.Ann, display_name: name, birth_year: 2014 }, as("Ann"), { now: NOW }), (e) => !(e instanceof KumiError) || e.code === "error.invalid_input");
  }
  const named = await run(db, "person.update_profile", { person_id: people.Ann, display_name: "  Ann​  Lee " }, as("Ann"), { now: NOW });
  assert.ok(named);
  assert.equal((await db.selectFrom("person").select("display_name").where("id", "=", people.Ann!).executeTakeFirstOrThrow()).display_name, "Ann Lee", "kept plain");
  for (const text of ["‍", "ㅤㅤ", "️", "‌"]) {
    await rejects(postChat(db, people.Hal!, "booking", booking, text, min(1)), (e) => e instanceof KumiError && e.code === "error.chat_empty");
  }
  // A name stored before the rule (or by hand): the push and the staff's view say A player, never an empty author.
  await db.updateTable("person").set({ display_name: "​" }).where("id", "=", people.Hal!).execute();
  const { id } = await postChat(db, people.Hal!, "booking", booking, "See you at six", min(2));
  assert.equal(await chatPushWords(db, id, "en"), "A player: See you at six");
  assert.equal(await chatPushWords(db, id, "es"), "Alguien: See you at six");
  const p = await plan(db, "chat.hide", { message_id: id, hidden: true }, owner, { now: min(3) });
  assert.match(p.plan.summary.en, /A player/);
  await db.updateTable("person").set({ display_name: "Hal" }).where("id", "=", people.Hal!).execute();
});

test("a report's reason: not kept when the report is refused, nor once its preview expires unconfirmed", async () => {
  const { id } = await postChat(db, people.Hal!, "booking", booking, "Bring balls", min(10));
  // Previewed with a reason and never confirmed.
  const p = await plan(db, "chat.report", { message_id: id, reason: "my address is 12 Oak St" }, as("Ann"), { now: min(11) });
  const before = await db.selectFrom("action_run").select("input").where("id", "=", p.runId).executeTakeFirstOrThrow();
  assert.equal((before.input as any).reason, "my address is 12 Oak St", "the preview needs it until it's confirmed or expires");
  await tidyChats(db, min(11 + 60));
  const later = await db.selectFrom("action_run").select("input").where("id", "=", p.runId).executeTakeFirstOrThrow();
  assert.equal((later.input as any).reason, undefined, "gone once the preview expired");
  // Refused (Hal can't report his own message): the stored "no" has no reason either.
  await rejects(plan(db, "chat.report", { message_id: id, reason: "test reason kept?" }, as("Hal"), { now: min(12) }), () => true);
  const refused = await db.selectFrom("action_run").select("input").where("action", "=", "chat.report").where("status", "=", "failed").execute();
  for (const r of refused) assert.equal((r.input as any).reason, undefined);
  // Confirmed: used for the report, not kept with the change.
  const r = await run(db, "chat.report", { message_id: id, reason: "rude" }, as("Ann"), { now: min(13) });
  const done = await db.selectFrom("action_run").select("input").where("id", "=", (r as any).runId).executeTakeFirst();
  if (done) assert.equal((done.input as any).reason, undefined);
  assert.equal((await db.selectFrom("chat_report").select("reason").where("message_id", "=", id).executeTakeFirstOrThrow()).reason, "rude");
});

test("words held for a report are in the author's own download, marked as kept for a report", async () => {
  const { id } = await postChat(db, people.Hal!, "booking", booking, "Text me on 415 555 0199", min(20));
  await run(db, "chat.report", { message_id: id }, as("Ann"), { now: min(21) });
  await removeChat(db, people.Hal!, id, min(22));
  const mine = (await chatsOf(db, people.Hal!)).find((m) => m.text === "Text me on 415 555 0199");
  assert.ok(mine, "the held words are in his download");
  assert.equal((mine as any).kept_for_a_report, true);
  assert.ok(mine.taken_back_at);
  const staff = await staffChat(db, (await db.selectFrom("chat_message").select("thread_id").where("id", "=", id).executeTakeFirstOrThrow()).thread_id, min(23));
  assert.ok(JSON.stringify(staff).includes("415 555 0199"), "the staff still read them");
  // Dealt with (hidden): the words go, from the download too.
  await run(db, "chat.hide", { message_id: id, hidden: true }, owner, { now: min(24) });
  const after = (await chatsOf(db, people.Hal!)).find((m) => (m as any).kept_for_a_report);
  assert.equal(after, undefined);
});

test("a booking moved earlier: its chat ends at its new end, not its old one", async () => {
  const before = await gameOf(db, "booking", booking);
  assert.equal(before!.ends_at.getTime(), START.getTime() + 90 * 60_000);
  const earlier = new Date(START.getTime() - 3 * 3600_000);   // 3 pm instead of 6 pm
  await run(db, "booking.move", { booking_id: booking, court_id: court, starts_at: earlier.toISOString() }, owner, { now: min(30) });
  const moved = await gameOf(db, "booking", booking);
  assert.equal(moved!.starts_at.getTime(), earlier.getTime());
  assert.equal(moved!.ends_at.getTime(), earlier.getTime() + 90 * 60_000, "ends when it ends now");
});
