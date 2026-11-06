// What was taken away on request stays away after a restore (after_restore.ts GONE, release.sh carry_gone): an older
// copy put back over the club's database doesn't bring back a deleted account, words taken back or hidden, a sign-in
// ended or a no to messages. Two real databases: the copy (made first) and the one it replaces.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { FORMER_MEMBER } from "@kumi/i18n";
import { connect, eraseAfterRestore, migrate, removeChat, runAsSystem, uuidv7, type Db } from "@kumi/core";
import { afterRestore, carryGoneAfterImport, GONE, readGoneBefore, readSentBefore, REVOKED } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_gone_live_${tag}`, COPY = `kumi_test_gone_copy_${tag}`, COPY2 = `kumi_test_gone_copy2_${tag}`;
let admin: Kysely<any>, live: Db;
const people: Record<string, string> = {};
let thread: string, msg: Record<string, string> = {};
const NOW = new Date("2026-11-30T19:00:00Z");

async function copyOf(from: string, to: string) {
  await live.destroy();   // a template can't have anyone connected
  await sql.raw(`CREATE DATABASE ${to} TEMPLATE ${from}`).execute(admin);
  live = connect(urlFor(LIVE));
}

before(async () => {
  const pool = new pg.Pool({ connectionString: ADMIN, max: 1 }); pool.on("error", () => {});
  admin = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`CREATE DATABASE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  await migrate(live);
  await runAsSystem(live, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  for (const name of ["Zed", "Ann", "Bo"]) {
    people[name] = uuidv7();
    await live.insertInto("person").values({ id: people[name]!, display_name: `${name} Quill`, email: `${name.toLowerCase()}@example.test`, phone: name === "Zed" ? "+14155550199" : null, created_via: "desk" }).execute();
  }
  thread = uuidv7();
  await live.insertInto("chat_thread").values({ id: thread, kind: "booking", ref_id: uuidv7(), ends_at: new Date("2026-12-01T20:00:00Z") }).execute();
  for (const [name, body] of [["Zed", "I work nights at the Oak St pharmacy"], ["Ann", "my cell is 415 555 0123"], ["Bo", "rude words"]] as const) {
    msg[name] = uuidv7();
    await live.insertInto("chat_message").values({ id: msg[name]!, thread_id: thread, person_id: people[name]!, body }).execute();
  }
  await live.insertInto("web_session").values({ token_hash: `ann-${tag}`, person_id: people.Ann!, expires_at: new Date("2027-01-01T00:00:00Z") }).execute();
  await live.insertInto("channel_consent").values({ id: uuidv7(), person_id: people.Ann!, channel: "email", purpose: "club_news", granted: true, source: "app" }).execute();
  // The copy: made now, before any of the below.
  await copyOf(LIVE, COPY);
  await copyOf(LIVE, COPY2);
  // Then, on the club's database: Zed deletes their account, Ann takes her message back, signs out and says no to
  // club news, and the club hides Bo's message.
  await live.insertInto("erase_after_restore").values({ person_id: people.Zed!, redacted_at: NOW }).execute();
  assert.deepEqual(await eraseAfterRestore(live, NOW), { erased: 1, failed: 0, lastOwnerKept: [] }, "the same deletion as the first time");
  await removeChat(live, people.Ann!, msg.Ann!, NOW);
  await live.updateTable("chat_message").set({ hidden_at: NOW, hidden_by: people.Ann! }).where("id", "=", msg.Bo!).execute();
  await live.updateTable("web_session").set({ revoked_at: NOW }).where("token_hash", "=", `ann-${tag}`).execute();
  await live.insertInto("channel_consent").values({ id: uuidv7(), person_id: people.Ann!, channel: "email", purpose: "club_news", granted: false, source: "unsubscribe" }).execute();
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, COPY, COPY2]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

async function state(url: string) {
  const db = connect(url);
  try {
    const zed = await db.selectFrom("person").select(["display_name", "email", "phone", "redacted_at"]).where("id", "=", people.Zed!).executeTakeFirstOrThrow();
    const m = Object.fromEntries(await Promise.all(Object.entries(msg).map(async ([k, id]) => [k, await db.selectFrom("chat_message").select(["body", "removed_at", "hidden_at"]).where("id", "=", id).executeTakeFirstOrThrow()] as const)));
    const session = await db.selectFrom("web_session").select("revoked_at").where("token_hash", "=", `ann-${tag}`).executeTakeFirstOrThrow();
    const news = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", people.Ann!).where("purpose", "=", "club_news").orderBy("at", "desc").orderBy("id", "desc").executeTakeFirstOrThrow();
    const queued = await db.selectFrom("erase_after_restore").select("person_id").execute();
    return { zed, m, session, news, queued };
  } finally { await db.destroy(); }
}

test("before: the copy still has all of it (that's what a restore would bring back)", async () => {
  const s = await state(urlFor(COPY));
  assert.equal(s.zed.redacted_at, null);
  assert.equal(s.zed.email, "zed@example.test");
  assert.equal(s.m.Ann!.body, "my cell is 415 555 0123");
  assert.equal(s.session.revoked_at, null);
  assert.equal(s.news.granted, true);
});

test("kumi restore of the copy: the account is deleted again at once, the words stay taken back, the sign-in ended, the no kept", async () => {
  const sent = await readSentBefore(urlFor(LIVE));
  assert.ok(sent?.gone, "read from the database being replaced");
  const r = await afterRestore(urlFor(COPY), sent, NOW);
  assert.equal(r.vouched, true);
  assert.equal(r.gone.erased, 1);
  assert.ok(r.gone.other >= 4, `taken back, hidden, signed out, the no: ${r.gone.other}`);
  const s = await state(urlFor(COPY));
  assert.ok(s.zed.redacted_at, "deleted again");
  assert.deepEqual([s.zed.display_name, s.zed.email, s.zed.phone], [FORMER_MEMBER, null, null]);
  assert.equal(s.m.Zed!.body, "", "a deleted account's words go with it");
  assert.equal(s.m.Ann!.body, "", "taken back: its words are gone");
  assert.ok(s.m.Ann!.removed_at);
  assert.ok(s.m.Bo!.hidden_at, "hidden by the club");
  assert.equal(s.m.Bo!.body, "rude words", "a hidden message keeps its words for the staff");
  assert.ok(s.session.revoked_at, "signed out stays signed out");
  assert.equal(s.news.granted, false, "the no to club news is kept");
  assert.deepEqual(s.queued, [], "nothing left waiting");
  // Again (a second restore of the same copy, or a start): nothing more to do, nothing changes.
  const again = await afterRestore(urlFor(COPY), sent, NOW);
  assert.deepEqual([again.gone.erased, again.gone.other], [0, 0]);
});

test("an update's snapshot put back by release.sh: the same SQL queues the account, and the server deletes it again as it starts", async () => {
  // release.sh's carry_gone: COPY (read) TO STDOUT from the club's database, then table, COPY FROM STDIN and apply
  // in the snapshot. Here the COPY is the rows read through the same query.
  const rows = (await sql.raw<{ id: string; redacted_at: Date; deleted_by: string | null }>(GONE.people.read).execute(live)).rows;
  const snap = connect(urlFor(COPY2));
  try {
    await sql.raw(GONE.people.table).execute(snap);
    for (const r of rows) await sql`INSERT INTO kumi_gone VALUES (${r.id}, ${r.redacted_at}, ${r.deleted_by})`.execute(snap);
    await sql.raw(GONE.people.apply).execute(snap);
    await sql.raw(GONE.people.apply).execute(snap);   // twice: still one row
    assert.equal((await snap.selectFrom("erase_after_restore").select("person_id").execute()).length, 1);
    // The server starting (main.ts).
    assert.deepEqual(await eraseAfterRestore(snap, NOW), { erased: 1, failed: 0, lastOwnerKept: [] });
    assert.deepEqual(await eraseAfterRestore(snap, NOW), { erased: 0, failed: 0, lastOwnerKept: [] }, "once");
    const zed = await snap.selectFrom("person").select(["redacted_at", "email"]).where("id", "=", people.Zed!).executeTakeFirstOrThrow();
    assert.ok(zed.redacted_at); assert.equal(zed.email, null);
  } finally { await snap.destroy(); }
});

test("an export put back on the same club's server carries it too; another club's database carries nothing", async () => {
  const before = await readGoneBefore(urlFor(LIVE));
  assert.ok(before);
  const db = connect(urlFor(COPY2));
  try {
    assert.deepEqual(await carryGoneAfterImport(db, { ...before!, timeline: "someone else's club" }, NOW), { erased: 0, other: 0, people: [], last_owner_kept: [], failed: 0 });
    const r = await carryGoneAfterImport(db, before, NOW);
    assert.equal(r.erased, 0, "Zed was deleted again above");
    assert.ok(r.other >= 4);
    assert.equal((await db.selectFrom("chat_message").select("body").where("id", "=", msg.Ann!).executeTakeFirstOrThrow()).body, "");
  } finally { await db.destroy(); }
});

test("release.sh runs the same SQL as after_restore.ts, for the same things", () => {
  const sh = readFileSync(new URL("../../../deploy/release.sh", import.meta.url), "utf8");
  for (const [name, part] of Object.entries(GONE)) {
    assert.ok(sh.includes(`COPY (${part.read}) TO STDOUT`), `${name}: release.sh reads it the same way`);
    assert.ok(sh.includes(part.table), `${name}: the same temporary table`);
    assert.ok(sh.includes(part.apply), `${name}: the same apply`);
  }
  const listed = /\nREVOKED="([^"]*)"/.exec(sh)?.[1]?.trim().split("\n").map((l) => l.trim().split(/\s+/));
  assert.deepEqual(listed, REVOKED.map((r) => [...r]), "the same tables and columns");
});
