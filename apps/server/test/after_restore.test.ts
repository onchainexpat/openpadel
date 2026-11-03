// After a restore nothing goes out twice (after_restore.ts): what the database before it had sent keeps that
// answer, an event it had handled is held, and when it can't vouch for the copy everything waiting is held.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, uuidv7, type Db } from "@kumi/core";
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

const email = async (subject: string) => { const id = uuidv7(); await db.insertInto("outbound_message").values({ id, event_id: null, person_id: person, kind: "test.note", channel: "email",
  purpose: "account", essential: true, lang: "en", subject, body: "Hello", link: null, status: "waiting", send_after: NOW, stale_at: null, failure: null, sent_at: null, read_at: null }).execute(); return id; };
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
  assert.deepEqual(r.carried, { messages: 1, events_held: 1 });
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
