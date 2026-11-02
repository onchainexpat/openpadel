import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { aiCents, countAi, countEmail, countUsage, DEFAULT_PRICES, messageHandlers, parsePrices, processOutbox, run, runAsSystem, sendEmails, setPrices, staffAlerts, usageAllows,
  usageMonth, usageView, uuidv7, type Actor, type Db, type Mail } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, ann: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-10T17:00:00Z");
const view = async (now = NOW) => (await usageView(db, now))!;
const levels = async () => (await db.selectFrom("event_outbox").select(sql<string>`payload->>'level'`.as("level")).where("topic", "=", "usage.cap").orderBy("id").execute()).map((r) => r.level);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner, { now: NOW })).result as { person_id: string }).person_id;
});
after(async () => { setPrices(DEFAULT_PRICES); await drop(); });

test("prices: list prices unless KUMI_PRICES says otherwise, in cents (AI per million tokens)", () => {
  assert.deepEqual(parsePrices(undefined), DEFAULT_PRICES);
  assert.deepEqual(parsePrices(" text_segment=0.83, email=0 "), { ...DEFAULT_PRICES, text_segment: 0.83, email: 0 });
  assert.throws(() => parsePrices("sms=1"), /"sms" isn't a price/);
  assert.throws(() => parsePrices("email=-1"), /email should be a number of cents/);
  assert.throws(() => parsePrices("email="), /email should be a number of cents/);
  // Haiku 5.5: $0.10 in and $0.50 out a million tokens; Jev $0.042 in, output free.
  assert.equal(aiCents("haiku", 3000, 200), 0.04);
  assert.equal(Math.round(aiCents("jev", 3000, 50) * 1e6) / 1e6, 0.0126);
});

test("AI, texts and email each count in the club's month, and a host bills from the month's lines", async () => {
  await countAi(db, "ai_decisions", "jev", { input: 3000, output: 50 }, NOW);
  await countAi(db, "ai_decisions", "haiku", { input: 3000, output: 200 }, NOW);
  await countAi(db, "ai_drafts", "haiku", { input: 1000, output: 1000 }, NOW);
  await countEmail(db, NOW); await countEmail(db, NOW);
  await countUsage(db, "texts", { segments: 3, cents: 3.78 }, NOW);
  // 11:59 pm on Oct 31 in Los Angeles is still October.
  await countEmail(db, new Date("2026-11-01T06:59:00Z"));
  const m = await usageMonth(db, "2026-11-01");
  assert.deepEqual(m.kinds.ai_decisions, { count: 2, input_tokens: 6000, output_tokens: 250, segments: 0, cents: 0.0526 });
  assert.deepEqual(m.kinds.ai_drafts, { count: 1, input_tokens: 1000, output_tokens: 1000, segments: 0, cents: 0.06 });
  assert.deepEqual([m.kinds.email.count, m.kinds.email.cents, m.kinds.texts.segments, m.kinds.texts.cents], [2, 0.18, 3, 3.78]);
  assert.deepEqual([m.total_cents, m.cap_cents, m.over_cents, m.time_zone], [4.0726, 5000, 0, TZ]);
  assert.equal((await usageMonth(db, "2026-10-01")).kinds.email.count, 1);
  const v = await view();
  assert.deepEqual([v.month, v.spent_cents, v.cap_cents, v.state, v.history.map((h) => [h.month, h.kinds.email])], ["2026-11-01", 4, 5000, "ok", [["2026-10-01", 0]]]);
  assert.equal(v.resets, "2026-12-01T08:00:00.000Z");
});

test("an amount allowed over the cap: at the cap the owner hears and everything goes on; past it, what can wait pauses; what can't goes to twice the limit", async () => {
  await db.deleteFrom("usage_month").execute();
  await run(db, "club.usage_cap_set", { cap_cents: 1000, over_cents: 500 }, owner, { now: NOW });
  await countUsage(db, "texts", { segments: 1, cents: 850 }, NOW);
  await countUsage(db, "texts", { segments: 1, cents: 200 }, NOW);
  assert.deepEqual([await levels(), (await view()).state], [["near", "over"], "over"]);
  assert.equal(await usageAllows(db, "can_wait", 400, NOW), true, "1,050 + 400 is inside the 1,500 limit");
  await countUsage(db, "email", { cents: 460 }, NOW);
  assert.deepEqual([await levels(), (await view()).state], [["near", "over", "paused"], "paused"]);
  assert.equal(await usageAllows(db, "can_wait", 1, NOW), false);
  assert.deepEqual([await usageAllows(db, "essential", 1490, NOW), await usageAllows(db, "essential", 1491, NOW)], [true, false], "the ceiling is $30");
  assert.equal((await levels()).length, 3, "said once each");
  // Only "paused" waits on Today; the owner heard about the amount over too.
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["kind", "subject", "body"]).where("person_id", "=", owner.personId!).where("channel", "=", "email").where("kind", "like", "usage_%").orderBy("kind").execute();
  assert.deepEqual(told.map((m) => m.kind), ["usage_near_staff", "usage_over_staff", "usage_paused_staff"]);
  assert.equal(told[1]!.body, "The club has used its $10.00 monthly cap for AI, texts and email ($10.50). Everything keeps going up to $15.00, with the $5.00 allowed over the cap; past that, what can wait pauses until December 1, 2026. To change either, go to Usage.");
  assert.deepEqual((await staffAlerts(db, owner.personId!, new Date())).open.map((a) => a.kind), ["usage_paused_staff"]);
  // More allowed over it: what can wait goes again, and the pause needs nobody.
  const p = await run(db, "club.usage_cap_set", { cap_cents: 1000, over_cents: 1000 }, owner, { now: NOW });
  assert.equal(p.plan.summary.en, "Set the club's monthly cap for AI, texts and email to $10.00, and allow up to $10.00 more in a busy month. $15.10 is used this month.");
  assert.deepEqual([(await view()).state, await usageAllows(db, "can_wait", 1, NOW)], ["over", true]);
  assert.deepEqual((await staffAlerts(db, owner.personId!, new Date())).handled.map((a) => [a.kind, a.handled_by]), [["usage_paused_staff", ""]]);
});

test("club news email waits for next month past the limit; other email goes, and every email the provider takes counts", async () => {
  await db.deleteFrom("usage_month").execute();
  await run(db, "club.usage_cap_set", { cap_cents: 100, over_cents: 0 }, owner, { now: NOW });
  await countUsage(db, "texts", { segments: 1, cents: 100 }, NOW);
  await db.updateTable("outbound_message").set({ status: "sent" }).where("channel", "=", "email").where("status", "=", "waiting").execute();   // the alerts above
  const ev = await db.insertInto("event_outbox").values({ action_run_id: null, topic: "test.mail", payload: JSON.stringify({}), delivered_at: NOW }).returning("id").executeTakeFirstOrThrow();
  const base = { event_id: ev.id, person_id: ann, essential: false, lang: "en", subject: "Hello", body: "Hi", link: null, stale_at: null, channel: "email", status: "waiting", send_after: NOW };
  const news = uuidv7(), receipt = uuidv7();
  await db.insertInto("outbound_message").values([{ ...base, id: news, kind: "broadcast", purpose: "club_news" }, { ...base, id: receipt, kind: "booking_cancelled", purpose: "account", essential: true }] as any).execute();
  const sent: Mail[] = [], box = { send: async (m: Mail) => { sent.push(m); await countEmail(db, NOW); } };
  assert.deepEqual(await sendEmails(db, box, NOW), { sent: 1, dropped: 0, failed: 0, waiting: 1 });
  assert.deepEqual(sent.map((m) => m.id), [receipt]);
  const n = await db.selectFrom("outbound_message").select(["status", "send_after"]).where("id", "=", news).executeTakeFirstOrThrow();
  assert.deepEqual([n.status, n.send_after.toISOString()], ["waiting", "2026-12-01T08:00:00.000Z"]);
  assert.equal((await view()).kinds.email.count, 1);
  // On the 1st it goes.
  assert.deepEqual(await sendEmails(db, box, new Date("2026-12-01T16:00:00Z")), { sent: 1, dropped: 0, failed: 0, waiting: 0 });
});
