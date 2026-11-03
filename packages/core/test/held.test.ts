// What a restored export brought that was still waiting to go out (held.ts): held, so the old server and this one
// never both send it; sent on or dropped when whoever runs the server says. Refunds are never held: the refund
// asks Stripe first, so one already sent is found by Kumi's id for it, not sent again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { fakeStripe } from "./fake-stripe.ts";
import { heldSummary, holdPending, processOutbox, runAsSystem, sendEmails, StripeProvider, uuidv7, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, person: string;
const NOW = new Date("2026-11-30T19:00:00Z");   // 11 am in Los Angeles: no quiet hours
const sentMail: string[] = [];
const mailer = { async send(m: { to: string; subject: string }) { sentMail.push(m.subject); } };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  person = (s.result as { owner_person_id: string }).owner_person_id;
  // Setting the club up leaves its own welcome waiting: gone, so each test counts only its own.
  await db.updateTable("event_outbox").set({ delivered_at: NOW }).where("delivered_at", "is", null).execute();
  await db.updateTable("outbound_message").set({ status: "sent" }).where("status", "=", "waiting").execute();
});
after(async () => { await drop(); });

const waitingEmail = async (subject: string) => db.insertInto("outbound_message").values({ id: uuidv7(), event_id: null, person_id: person, kind: "test.note", channel: "email",
  purpose: "account", essential: true, lang: "en", subject, body: "Hello", link: null, status: "waiting", send_after: new Date(NOW.getTime() - 60_000), stale_at: null,
  failure: null, sent_at: null, read_at: null }).execute();
const event = async (topic: string) => (await db.insertInto("event_outbox").values({ action_run_id: null, topic, payload: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow()).id;

test("held after a move: nothing goes until it's sent on, then it goes as it would have", async () => {
  sentMail.length = 0;
  await waitingEmail("Your receipt");
  const ev = await event("receipt.issued"), refundEv = await event("refund.requested");
  assert.deepEqual(await holdPending(db, NOW), { messages: 1, events: 1 }, "the refund isn't held");
  const h = await heldSummary(db);
  assert.deepEqual([h.messages, h.events, h.by_message[0]!.kind, h.by_event[0]!.topic], [1, 1, "test.note", "receipt.issued"]);
  // Neither the sender nor the outbox touches what's held.
  assert.equal((await sendEmails(db, mailer, NOW)).sent, 0);
  const handled: string[] = [];
  await processOutbox(db, { "receipt.issued": async () => { handled.push("ping"); }, "refund.requested": async () => { handled.push("refund"); } }, 100, NOW);
  assert.deepEqual(handled, ["refund"], "only the refund went");
  // Sent on: the email goes and the event is handled.
  const r = await runAsSystem(db, "club.held_release", { send: true }, "test", { now: NOW });
  assert.deepEqual(r.result, { sent: { messages: 1, events: 1 } });
  assert.equal((await sendEmails(db, mailer, NOW)).sent, 1);
  assert.deepEqual(sentMail, ["Your receipt"]);
  await processOutbox(db, { "receipt.issued": async () => { handled.push("ping"); } }, 100, NOW);
  assert.deepEqual(handled, ["refund", "ping"]);
  assert.ok((await db.selectFrom("event_outbox").select("delivered_at").where("id", "=", ev).executeTakeFirstOrThrow()).delivered_at);
  assert.ok((await db.selectFrom("event_outbox").select("delivered_at").where("id", "=", refundEv).executeTakeFirstOrThrow()).delivered_at);
  assert.deepEqual([(await heldSummary(db)).messages, (await heldSummary(db)).events], [0, 0]);
});

test("dropped once the old server sent them: the messages are marked dropped and the events handled, never sent", async () => {
  sentMail.length = 0;
  await waitingEmail("Club news");
  const ev = await event("receipt.issued");
  await holdPending(db, NOW);
  const r = await runAsSystem(db, "club.held_release", { send: false }, "test", { now: NOW });
  assert.deepEqual(r.result, { dropped: { messages: 1, events: 1 } });
  assert.equal((await sendEmails(db, mailer, NOW)).sent, 0);
  const m = await db.selectFrom("outbound_message").select(["status", "failure"]).where("subject", "=", "Club news").executeTakeFirstOrThrow();
  assert.equal(m.status, "dropped");
  const e = await db.selectFrom("event_outbox").select(["delivered_at", "held_at"]).where("id", "=", ev).executeTakeFirstOrThrow();
  assert.ok(e.delivered_at && e.held_at, "handled, and the record says it was held");
  let ran = false;
  await processOutbox(db, { "receipt.issued": async () => { ran = true; } }, 100, NOW);
  assert.equal(ran, false);
});

test("a refund asked for again finds the one Stripe has by Kumi's id for it, after Stripe has forgotten the key", async () => {
  const fake = fakeStripe();   // the stand-in keeps no idempotency keys: like Stripe a day later
  const stripe = new StripeProvider({ secretKey: "sk_test_x", fetch: fake.fetch });
  fake.intents.set("pi_1", { account: null, status: "succeeded", amount: 3000, key: "k" });
  const first = await stripe.refund({ paymentRef: "pi_1", amountCents: 3000, idempotencyKey: "refund-1" });
  const again = await stripe.refund({ paymentRef: "pi_1", amountCents: 3000, idempotencyKey: "refund-1" });
  assert.equal(fake.refunds.length, 1, "one refund, not two");
  assert.deepEqual(again, first);
  // A different refund of the same payment is its own; one that failed can go again.
  await stripe.refund({ paymentRef: "pi_1", amountCents: 500, idempotencyKey: "refund-2" });
  assert.equal(fake.refunds.length, 2);
  fake.refunds[1]!.status = "failed";
  await stripe.refund({ paymentRef: "pi_1", amountCents: 500, idempotencyKey: "refund-2" });
  assert.equal(fake.refunds.length, 3);
});
