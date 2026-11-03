// What a security review asked of moving and restoring a club (export.ts, backups.ts, after_restore.ts):
//   - a file whose database brings a function, trigger or anything else Kumi's migrations don't make is refused,
//     and the database stays as it was (shape.ts);
//   - support access ends on a move, and on a restore that can't say which access was ended since; one ended
//     since a copy was made stays ended;
//   - "moved" (club_exit.ts): the old server sends members nothing, so an export made after it holds nothing and
//     the new server sends what waited, once.
// Needs pg_dump and pg_restore 17, like the backup tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { isReadOnly, messageHandlers, plan, processOutbox, registerMessageTopics, run, runAsSystem, sendEmails, setSecretKeys, uuidv7, type Actor, type Db } from "@kumi/core";
import { pgTool, RestoreRefused } from "../src/backups.ts";
import { importExport, makeExport } from "../src/export.ts";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";

const NOW = new Date("2026-11-30T19:00:00Z"), ENV = { KUMI_PG_BIN: process.env.KUMI_PG_BIN };
const urlOf = async (db: Db) => ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
type Club = { db: Db; drop: () => Promise<void>; url: string; owner: Actor };
const made: Club[] = [];
let dir: string;

async function club(): Promise<Club> {
  const { db, drop } = await freshDb();
  await registerMessageTopics(db, new Date(Date.now() - 60_000));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  const c = { db, drop, url: await urlOf(db), owner: { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en" as const, auth: "passkey" as const } };
  made.push(c);
  return c;
}
const fresh = async () => { const { db, drop } = await freshDb(); const c = { db, drop, url: await urlOf(db), owner: { personId: null, via: "test", lang: "en" as const } }; made.push(c); return c; };
const people = async (db: Db) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM person`.execute(db)).rows[0]!.n);
const grant = async (c: Club, email: string) => ((await run(c.db, "support.grant", { email, name: "Zed", reason: "help with the move", level: "manager", hours: 24 }, c.owner)).result as { grant_id: string }).grant_id;
const waitingEmail = async (c: Club, subject: string) => c.db.insertInto("outbound_message").values({ id: uuidv7(), event_id: null, person_id: c.owner.personId!, kind: "test.note", channel: "email",
  purpose: "account", essential: true, lang: "en", subject, body: "Hello", link: null, status: "waiting", send_after: NOW, stale_at: null, failure: null, sent_at: null, read_at: null }).execute();

before(async () => { if (skip) return; dir = mkdtempSync(join(tmpdir(), "kumi-review-test-")); setSecretKeys({ current: Buffer.alloc(32, 7).toString("base64") }); });
after(async () => { if (skip) return; setSecretKeys({}); rmSync(dir, { recursive: true, force: true }); for (const c of made) await c.drop(); });

test("an export whose database brings a trigger of someone else's is refused, and the database is as it was", { skip }, async () => {
  const src = await club(), dst = await club();
  await run(dst.db, "person.create", { display_name: "Dee", email: "dee@example.test" }, dst.owner);
  await sql`CREATE FUNCTION copy_out() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`.execute(src.db);
  await sql`CREATE TRIGGER copy_out AFTER INSERT ON outbound_message FOR EACH ROW EXECUTE FUNCTION copy_out()`.execute(src.db);
  const file = await makeExport(src.db, { url: src.url, env: ENV, now: NOW, passphrase: "correct horse battery" });
  const before = await people(dst.db);
  await assert.rejects(importExport({ url: dst.url, file: file.file, passphrase: "correct horse battery", dir, env: ENV, now: NOW }),
    (e: unknown) => e instanceof RestoreRefused && /not Kumi's: function copy_out\(\)/.test(e.message) && /trigger outbound_message\.copy_out/.test(e.message));
  assert.equal(await people(dst.db), before, "this club's own data, as it was");
  assert.equal((await sql<{ n: string }>`SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'copy_out'`.execute(dst.db)).rows[0]!.n, "0");
  assert.equal((await dst.db.selectFrom("person").select("id").where("email", "=", "dee@example.test").executeTakeFirst()) !== undefined, true);
});

test("a Kumi function changed in the file is refused too", { skip }, async () => {
  const src = await club(), dst = await fresh();
  await sql`CREATE OR REPLACE FUNCTION rating_event_words_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`.execute(src.db);
  const file = await makeExport(src.db, { url: src.url, env: ENV, now: NOW, passphrase: "correct horse battery" });
  await assert.rejects(importExport({ url: dst.url, file: file.file, passphrase: "correct horse battery", dir, env: ENV, now: NOW }),
    (e: unknown) => e instanceof RestoreRefused && /rating_event_words_only/.test(e.message));
});

test("support access given on the old server ends on the way in, and the owners hear", { skip }, async () => {
  const src = await club(), dst = await fresh();
  const g = await grant(src, "zed@help.test");
  const file = await makeExport(src.db, { url: src.url, env: ENV, now: NOW, passphrase: "correct horse battery" });
  const r = await importExport({ url: dst.url, file: file.file, passphrase: "correct horse battery", dir, env: ENV });
  assert.equal(r.support_ended, 1);
  const row = await dst.db.selectFrom("support_grant").select(["ended_at", "end_told_at"]).where("id", "=", g).executeTakeFirstOrThrow();
  assert.ok(row.ended_at && row.end_told_at);
  await processOutbox(dst.db, messageHandlers);
  const told = await dst.db.selectFrom("outbound_message").select("body").where("kind", "=", "support_ended_owner").where("channel", "=", "email").execute();
  assert.ok(told.some((m) => /moved to another server/.test(m.body)), "the owner is told why");
});

test("a restore: access ended since the copy stays ended; one that can't vouch ends it all", { skip }, async () => {
  const c = await club();
  const ended = await grant(c, "zed@help.test"), open = await grant(c, "amy@help.test");
  // The database before the restore had ended the first; the copy has it open.
  const sent = await readSentBefore(c.url);
  const r = await afterRestore(c.url, { ...sent!, support_ended: [{ id: ended, ended_at: NOW, ended_by: c.owner.personId, end_told_at: NOW }] }, NOW);
  assert.equal(r.support_ended, 1);
  const state = async (id: string) => (await c.db.selectFrom("support_grant").select("ended_at").where("id", "=", id).executeTakeFirstOrThrow()).ended_at;
  assert.ok(await state(ended));
  assert.equal(await state(open), null, "still open: the database before it hadn't ended it");
  const none = await afterRestore(c.url, { timeline: "someone else's club", messages: [], events: [] }, new Date());
  assert.equal(none.support_ended, 1);
  assert.ok(await state(open));
});

test("moved: the old server sends members nothing and takes nothing new; an export made after it holds nothing, and the new server sends what waited, once", { skip }, async () => {
  const src = await club(), dst = await fresh();
  // Only the owner says the club moved; a manager can't.
  const m = (await run(src.db, "person.create", { display_name: "Mia", email: "mia@example.test" }, src.owner)).result as { person_id: string };
  await run(src.db, "role.assign", { person_id: m.person_id, role: "manager" }, src.owner);
  await assert.rejects(plan(src.db, "club.moved", { on: true }, { personId: m.person_id, via: "test", lang: "en", auth: "two_factor" }), (e: any) => e.code === "error.export_owner_only");
  await run(src.db, "club.moved", { on: true, to: "https://kestrelpadel.com" }, src.owner);
  assert.equal(await isReadOnly(src.db), true);
  await assert.rejects(plan(src.db, "person.create", { display_name: "Late", email: "late@example.test" }, src.owner), (e: any) => e.code === "error.moved_to" && e.text.en.includes("https://kestrelpadel.com"));
  await waitingEmail(src, "See you Saturday");
  const sentOld: string[] = [];
  await sendEmails(src.db, { async send(x: { subject: string }) { sentOld.push(x.subject); } }, NOW);
  assert.deepEqual(sentOld, [], "the old server sends nothing once it's moved");
  const file = await makeExport(src.db, { url: src.url, env: ENV, now: NOW, passphrase: "correct horse battery" });
  const r = await importExport({ url: dst.url, file: file.file, passphrase: "correct horse battery", dir, env: ENV, now: NOW });
  assert.equal(r.was_moved, true);
  assert.deepEqual(r.held, { messages: 0, events: 0 });
  assert.equal(await isReadOnly(dst.db), false, "moved is the old server's: the new one works as usual");
  const sentNew: string[] = [];
  await sendEmails(dst.db, { async send(x: { subject: string }) { sentNew.push(x.subject); } }, NOW);
  assert.ok(sentNew.includes("See you Saturday"));
});
