// After a restore nothing goes out twice (after_restore.ts): what the database before it had sent keeps that
// answer, an event it had handled is held, what it had sent that the copy has no row for is kept as a fingerprint
// for the week (repeats.ts), and when it can't vouch for the copy everything waiting is held.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, skipRepeatsAfterRestore, uuidv7, MESSAGE_FP, type Db } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlOf = async (db: Db) => ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
let db: Db, drop: () => Promise<void>, url: string, person: string;
const NOW = new Date("2026-11-30T19:00:00Z");

before(async () => {
  ({ db, drop } = await freshDb());
  url = await urlOf(db);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  person = (s.result as { owner_person_id: string }).owner_person_id;
  await db.updateTable("event_outbox").set({ delivered_at: NOW }).where("delivered_at", "is", null).execute();
  await db.updateTable("outbound_message").set({ status: "sent" }).where("status", "=", "waiting").execute();
});
after(async () => { await drop(); });

const email = async (subject: string, channel: "email" | "inbox" | "sms" | "push" = "email", body = "Hello") => { const id = uuidv7(); await db.insertInto("outbound_message").values({ id, event_id: null, person_id: person, kind: "test.note", channel,
  purpose: "account", essential: true, lang: "en", subject, body, link: null, status: "waiting", send_after: NOW, stale_at: null, failure: null, sent_at: null, read_at: null }).execute(); return id; };
const event = async (topic: string) => String((await db.insertInto("event_outbox").values({ action_run_id: null, topic, payload: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow()).id);
const statusOf = async (id: string) => (await db.selectFrom("outbound_message").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const heldAt = async (id: string) => (await db.selectFrom("event_outbox").select("held_at").where("id", "=", id as any).executeTakeFirstOrThrow()).held_at;

test("restored over the same club: what had gone keeps its answer, a handled notice is held, the rest goes as usual", async () => {
  const gone = await email("Your receipt"), notYet = await email("See you Saturday");
  const handled = await event("receipt.issued"), waiting = await event("receipt.issued"), refund = await event("refund.requested");
  // The database before the restore had sent the receipt, and handled the first notice and the refund.
  const sent = await readSentBefore(url);
  assert.ok(sent, "a set-up club vouches for its own copies");
  const before = { ...sent!, messages: [...sent!.messages, { id: gone, status: "sent", sent_at: NOW, failure: null }], events: [...sent!.events, { id: handled, delivered_at: NOW }, { id: refund, delivered_at: NOW }] };
  const r = await afterRestore(url, before, NOW);
  assert.equal(r.vouched, true);
  assert.deepEqual(r.carried, { messages: 1, events_held: 1, repeats: 0 }, "what the copy has a row for is carried by its id, not kept as a fingerprint");
  assert.equal(await statusOf(gone), "sent");
  assert.equal(await statusOf(notYet), "waiting", "nobody sent it yet: it goes");
  assert.ok(await heldAt(handled), "its messages may have gone: held for whoever runs the server");
  assert.equal(await heldAt(waiting), null);
  assert.equal(await heldAt(refund), null, "a refund asks Stripe first, so it's never held");
});

test("restored where the database before can't vouch for it (another club, or none): everything waiting is held", async () => {
  const m = await email("Your code"), e = await event("receipt.issued");
  const r = await afterRestore(url, { timeline: "someone else's club", messages: [], events: [] }, NOW);
  assert.equal(r.vouched, false);
  assert.ok(r.held.messages >= 1 && r.held.events >= 1);
  assert.equal(await statusOf(m), "held");
  assert.ok(await heldAt(e));
  const none = await afterRestore(url, null, NOW);
  assert.equal(none.vouched, false);
});

test("a database with no club yet has nothing to vouch with", async () => {
  const empty = await freshDb();
  try { assert.equal(await readSentBefore(await urlOf(empty.db)), null); } finally { await empty.drop(); }
});

test("sent after the copy was made, then made again by a job: it takes the earlier answer, once, for a week; the inbox and other words still go", async () => {
  // The database before the restore had sent this reminder; the copy has no row for it (it was made after the copy).
  const gone = await email("Coming up: Court 1, Sat 6:00 PM", "email", "A reminder: Court 1 at Eastside, Sat 6:00 PM.");
  const fp = (await sql<{ fp: string }>`SELECT ${sql.raw(MESSAGE_FP)} AS fp FROM outbound_message WHERE id = ${gone}`.execute(db)).rows[0]!.fp;
  await db.deleteFrom("outbound_message").where("id", "=", gone).execute();
  const sentAt = new Date("2026-11-30T18:00:00Z"), RESTORED = new Date("2026-11-30T20:00:00Z");
  const sent = await readSentBefore(url);
  const r = await afterRestore(url, { ...sent!, fingerprints: [...sent!.fingerprints!, { id: gone, fp, sent_at: sentAt }] }, RESTORED);
  assert.equal(r.carried.repeats, 1);
  // The job makes it again after the restore: the same person, kind, channel, words and link.
  const again = await email("Coming up: Court 1, Sat 6:00 PM", "email", "A reminder: Court 1 at Eastside, Sat 6:00 PM.");
  const twice = await email("Coming up: Court 1, Sat 6:00 PM", "email", "A reminder: Court 1 at Eastside, Sat 6:00 PM.");
  const inbox = await email("Coming up: Court 1, Sat 6:00 PM", "inbox", "A reminder: Court 1 at Eastside, Sat 6:00 PM.");
  const other = await email("Coming up: Court 2, Sun 9:00 AM", "email", "A reminder: Court 2 at Eastside, Sun 9:00 AM.");
  assert.equal(await skipRepeatsAfterRestore(db, new Date(RESTORED.getTime() + 60_000)), 1);
  const row = await db.selectFrom("outbound_message").select(["status", "sent_at"]).where("id", "=", again).executeTakeFirstOrThrow();
  assert.deepEqual(row, { status: "sent", sent_at: sentAt }, "it went before the restore, at its time");
  assert.equal(await statusOf(twice), "waiting", "one earlier answer answers one message");
  assert.equal(await statusOf(inbox), "waiting", "the inbox copy is the app's record, never skipped");
  assert.equal(await statusOf(other), "waiting", "other words go as usual");
  const used = await db.selectFrom("sent_before_restore").select(["used_by", "message_id"]).where("fp", "=", fp).executeTakeFirstOrThrow();
  assert.deepEqual(used, { used_by: again, message_id: gone });
  // A week after the restore, the same words go as new.
  await afterRestore(url, { ...sent!, fingerprints: [{ id: uuidv7(), fp, sent_at: sentAt }] }, RESTORED);
  assert.equal(await skipRepeatsAfterRestore(db, new Date(RESTORED.getTime() + 8 * 86_400_000)), 0);
  assert.equal(await statusOf(twice), "waiting");
  await db.updateTable("outbound_message").set({ status: "dropped" }).where("id", "in", [twice, inbox, other]).execute();
});

test("where the database before can't vouch for the copy, no fingerprints are kept (everything waiting is held instead)", async () => {
  const before = await db.selectFrom("sent_before_restore").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
  const r = await afterRestore(url, { timeline: "someone else's club", messages: [], events: [], fingerprints: [{ id: uuidv7(), fp: "x".repeat(64), sent_at: NOW }] }, NOW);
  assert.equal(r.carried.repeats, 0);
  const now = await db.selectFrom("sent_before_restore").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
  assert.equal(now.n, before.n);
});

test("a chat push sent before a restore answers only for the same message's push, never a new message's", async () => {
  // Chat pushes keep no words (the words are filled in as they go), so two messages' pushes to one person about one
  // game read the same: only which message they're for tells them apart.
  const thread = uuidv7(), first = uuidv7(), next = uuidv7();
  await db.insertInto("chat_thread").values({ id: thread, kind: "booking", ref_id: uuidv7(), ends_at: new Date("2026-12-01T20:00:00Z") }).execute();
  for (const id of [first, next]) await db.insertInto("chat_message").values({ id, thread_id: thread, person_id: person, body: "see you there" }).execute();
  const push = async (message: string) => { const id = uuidv7(); await db.insertInto("outbound_message").values({ id, event_id: null, person_id: person, kind: "chat_message", channel: "push",
    purpose: "account", essential: false, lang: "en", subject: "Court 1, Sat 6:00 PM", body: "", link: "/chats/booking/x", status: "waiting", send_after: NOW, stale_at: null, failure: null, sent_at: null, read_at: null, chat_message_id: message }).execute(); return id; };
  // The database before the restore had pushed the first message; the copy has no row for that push.
  const gone = await push(first);
  const fp = (await sql<{ fp: string }>`SELECT ${sql.raw(MESSAGE_FP)} AS fp FROM outbound_message WHERE id = ${gone}`.execute(db)).rows[0]!.fp;
  await db.deleteFrom("outbound_message").where("id", "=", gone).execute();
  const RESTORED = new Date("2026-12-01T10:00:00Z"), sentAt = new Date("2026-12-01T09:00:00Z");
  const sent = await readSentBefore(url);
  await afterRestore(url, { ...sent!, fingerprints: [{ id: gone, fp, sent_at: sentAt }] }, RESTORED);
  // After it: a new message's push, and the first message's push made again.
  const other = await push(next), again = await push(first);
  assert.equal(await skipRepeatsAfterRestore(db, new Date(RESTORED.getTime() + 60_000)), 1);
  assert.equal(await statusOf(other), "waiting", "a different message: it goes");
  assert.equal(await statusOf(again), "sent", "the same message's push: it went before the restore");
  // An email's fingerprint is what it always was (nothing added for messages that aren't chat pushes).
  const mail = await email("Same as ever");
  const [a, b] = (await sql<{ a: string; b: string }>`SELECT ${sql.raw(MESSAGE_FP)} AS a,
    encode(sha256(convert_to(concat_ws(chr(31), person_id::text, kind, channel, subject, body, coalesce(link, '')), 'UTF8')), 'hex') AS b FROM outbound_message WHERE id = ${mail}`.execute(db)).rows.map((r) => [r.a, r.b])[0]!;
  assert.equal(a, b);
  await db.updateTable("outbound_message").set({ status: "dropped" }).where("id", "in", [other, mail]).execute();
});
