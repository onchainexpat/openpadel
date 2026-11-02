import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { countText, messageHandlers, monthOf, plan, processOutbox, run, runAsSystem, segments, sendTexts, setTexting, staffAlerts, textAllowed, textStatus, textUsage, TEXTS_FORM,
  TestTexter, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, ann: string;
const texter = new TestTexter();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const PHONE = "+15035550101", MEMBERS = "https://kestrel.example";
const usage = async (now = NOW) => (await textUsage(db, now))!;
const alerts = (level: string) => db.selectFrom("event_outbox").select("payload").where("topic", "=", "texts.usage").where(sql<string>`payload->>'level'`, "=", level).execute();
/** A message for Ann that goes by text: the event, its inbox copy and its text, as the messages write them. */
async function textForAnn(body = "Booking K7Q-2M for Court 1 is cancelled.") {
  const ev = await db.insertInto("event_outbox").values({ action_run_id: null, topic: "test.text", payload: JSON.stringify({}), delivered_at: new Date() }).returning("id").executeTakeFirstOrThrow();
  const base = { event_id: ev.id, person_id: ann, kind: "booking_cancelled", purpose: "account" as const, essential: true, lang: "en", subject: "Booking cancelled", link: "/places", stale_at: null };
  await db.insertInto("outbound_message").values([{ ...base, id: uuidv7(), channel: "inbox", body: `${body} The full message.`, status: "sent", send_after: NOW, sent_at: NOW },
    { ...base, id: uuidv7(), channel: "sms", body, status: "waiting", send_after: NOW }]).execute();
  return ev.id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setTexting(true);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner, { now: NOW })).result as { person_id: string }).person_id;
  await runAsSystem(db, "phone.confirm", { person_id: ann, phone: PHONE }, "web", { now: NOW });
  await run(db, "consent.texts", { person_id: ann, granted: true, form_version: TEXTS_FORM, app: "member", device: "Mozilla/5.0 (iPhone)" }, { personId: ann, via: "test", lang: "en" }, { now: NOW });
});
after(async () => drop());

test("segments are counted the way Twilio bills them", () => {
  assert.deepEqual([segments("x".repeat(160)), segments("x".repeat(161)), segments("x".repeat(306)), segments("x".repeat(307))], [1, 2, 2, 3]);
  // ^{}\[~]|€ take two, and a pair is never split between parts: 152 plain and a € don't fit the first part.
  assert.deepEqual([segments("€".repeat(80)), segments("€".repeat(81)), segments(`${"x".repeat(152)}€${"x".repeat(10)}`)], [1, 2, 2]);
  // Anything outside the plain alphabet: 70 in one, 67 a part, in UTF-16 units (an emoji takes two).
  assert.deepEqual([segments("ó".repeat(70)), segments("ó".repeat(71)), segments("🎾".repeat(35)), segments("🎾".repeat(36)), segments("🎾".repeat(67))], [1, 2, 1, 2, 3]);
});

test("each text Twilio takes counts in the club's month; 80% and then the cap are each said once", async () => {
  await run(db, "texts.cap_set", { cap_segments: 10 }, owner, { now: NOW });
  for (let i = 0; i < 7; i++) await textForAnn();
  assert.deepEqual(await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW }), { sent: 7, dropped: 0, failed: 0 });
  let u = await usage();
  assert.deepEqual([u.current.month, u.current.texts, u.current.segments, u.cap, u.paused], ["2026-11-01", 7, 7, 10, false]);
  assert.equal(u.current.estimate_cents, Math.round(7 * 1.26));
  assert.equal((await db.selectFrom("outbound_message").select("segments").where("channel", "=", "sms").where("status", "=", "sent").executeTakeFirstOrThrow()).segments, 1);
  assert.equal((await alerts("near")).length, 0);
  await textForAnn(); await textForAnn();
  await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW });
  assert.equal((await alerts("near")).length, 1, "at 8 of 10, once; not again at 9");
  await textForAnn();
  await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW });
  assert.deepEqual([(await alerts("reached")).length, (await usage()).paused], [1, true]);
  // The owner and managers hear, by email too; the cap stays on Today until someone sees to it.
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["kind", "subject", "body"]).where("person_id", "=", owner.personId!).where("channel", "=", "email").where("kind", "like", "texts_cap_%").orderBy("kind").execute();
  assert.deepEqual(told.map((m) => [m.kind, m.subject]), [["texts_cap_near_staff", "Texts: 80% of this month's cap is used"], ["texts_cap_reached_staff", "Texts paused: this month's cap is reached"]]);
  assert.match(told[1]!.body, /^The club has used its 10 text segments for this month \(about \$0\.13\)\. Until December 1, 2026, members get those messages in the app/);
  assert.ok(!told.some((m) => m.body.includes("—")));
  assert.deepEqual((await staffAlerts(db, owner.personId!, new Date())).open.map((a) => a.kind), ["texts_cap_reached_staff"]);
});

test("past the cap a text isn't sent: it's in the inbox already and goes by email, and the cap is said only once", async () => {
  const ev = await textForAnn();
  assert.deepEqual(await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW }), { sent: 0, dropped: 1, failed: 0 });
  const rows = await db.selectFrom("outbound_message").select(["channel", "status", "failure", "body"]).where("event_id", "=", ev).orderBy("channel").execute();
  assert.deepEqual(rows.map((r) => [r.channel, r.status]), [["email", "waiting"], ["inbox", "sent"], ["sms", "dropped"]]);
  assert.equal(rows.find((r) => r.channel === "sms")!.failure, "monthly text cap reached");
  assert.equal(rows.find((r) => r.channel === "email")!.body, "Booking K7Q-2M for Court 1 is cancelled. The full message.");
  const u = await usage();
  assert.deepEqual([u.current.texts, u.current.held], [10, 1]);
  assert.equal((await alerts("reached")).length, 1);
});

test("codes keep going past the cap, up to twice it (and at least 100 segments), so nobody is locked out", async () => {
  assert.deepEqual(await textAllowed(db, "code", 1, NOW), { ok: true });
  await countText(db, "code", 89, NOW);   // 99 used of a ceiling of 100
  assert.deepEqual(await textAllowed(db, "code", 1, NOW), { ok: true });
  assert.equal((await textAllowed(db, "code", 2, NOW)).ok, false);
  const u = await usage();
  assert.deepEqual([u.code_ceiling, u.current.code_texts, u.current.code_segments, u.current.segments], [100, 1, 89, 99]);
});

test("raising the cap lets texts go at once and closes the alert with no one's name; only owners and managers set it", async () => {
  await assert.rejects(plan(db, "texts.cap_set", { cap_segments: 5000 }, { personId: ann, via: "test", lang: "en" }, { now: NOW }), (e: unknown) => e instanceof KumiError);
  const p = await plan(db, "texts.cap_set", { cap_segments: 50 }, owner, { now: NOW });
  assert.equal(p.plan.summary.en, "Set the club's monthly text cap to 50 segments, about $0.63 a month. 99 are used this month already, so texts stay paused until next month.");
  await run(db, "texts.cap_set", { cap_segments: 400, cents_per_segment: 0.83 }, owner, { now: NOW });
  const u = await usage();
  assert.deepEqual([u.cap, u.cents_per_segment, u.paused, u.code_ceiling], [400, 0.83, false, 800]);
  const today = await staffAlerts(db, owner.personId!, new Date());
  assert.deepEqual([today.open.length, today.handled.map((a) => [a.kind, a.handled_by])], [0, [["texts_cap_reached_staff", ""]]]);
  await textForAnn();
  assert.deepEqual(await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW }), { sent: 1, dropped: 0, failed: 0 });
  // A new cap is said again when it's reached in turn.
  await countText(db, "message", 220, NOW);
  assert.equal((await alerts("near")).length, 2);
});

test("Twilio's price, when it says it, is kept once as the actual cost", async () => {
  const sent = await db.selectFrom("outbound_message").select("provider_ref").where("channel", "=", "sms").where("status", "=", "sent").orderBy("created_at").executeTakeFirstOrThrow();
  await textStatus(db, { ref: sent.provider_ref!, status: "delivered", price: "-0.00790", now: NOW });
  await textStatus(db, { ref: sent.provider_ref!, status: "delivered", price: "-0.00790", now: NOW });   // told twice
  const u = await usage();
  assert.deepEqual([u.current.priced, u.current.actual_cents], [1, 1]);
  assert.equal((await db.selectFrom("outbound_message").select("cost_cents").where("provider_ref", "=", sent.provider_ref).executeTakeFirstOrThrow()).cost_cents, "0.790");
});

test("a new month starts fresh in the club's time zone, and twelve months are kept", async () => {
  // 11:59 pm on Nov 30 in Los Angeles is still November; a minute later it's December.
  assert.equal(monthOf(new Date("2026-12-01T07:59:00Z"), TZ), "2026-11-01");
  const dec = new Date("2026-12-01T08:00:00Z");
  assert.equal(monthOf(dec, TZ), "2026-12-01");
  for (let i = 0; i < 14; i++) {   // September 2025 to October 2026
    const d = new Date(Date.UTC(2025, 8 + i, 1)).toISOString().slice(0, 10);
    await db.insertInto("text_usage").values({ month: d, texts: 1, segments: 1, near_cap: null, reached_cap: null }).onConflict((oc) => oc.column("month").doNothing()).execute();
  }
  await textForAnn();
  assert.deepEqual(await sendTexts(db, texter, { memberUrl: MEMBERS, now: dec }), { sent: 1, dropped: 0, failed: 0 });
  const u = await usage(dec);
  assert.deepEqual([u.current.month, u.current.texts, u.paused, u.history[0]!.month], ["2026-12-01", 1, false, "2026-11-01"]);
  const months = (await db.selectFrom("text_usage").select("month").orderBy("month").execute()).map((r) => String(r.month).slice(0, 10));
  assert.equal(months.length, 12);
  assert.equal(months[0], "2026-01-01");
});
