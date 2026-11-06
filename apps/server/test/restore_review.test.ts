// The review of the restore carry-over (after_restore.ts GONE, release.sh carry_gone, 885fda7): a staff
// authenticator survives a restore that didn't touch it, a replaced one comes back as the new one, an account still
// waiting to be deleted again is deleted, a yes given for a new number doesn't reach the old one, a sign-in address or
// device taken away stays away, the club's last owner keeps the role, staff deletions can be kept, and a restore
// with nothing to vouch for it uses the newest backup's list. Real databases: the copy (made first) and the one it
// replaces; release.sh's COPY is stood in for by text, as COPY carries it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { connect, migrate, runAsSystem, textsAnswer, uuidv7, type Db } from "@kumi/core";
import { afterRestore, GONE, GONE_PARTS, readSentBefore } from "../src/after_restore.ts";
import { sessionPerson } from "../src/auth.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_rr_live_${tag}`, C = (n: number) => `kumi_test_rr_c${n}_${tag}`;
let admin: Kysely<any>, live: Db;
const P: Record<string, string> = {};
const NOW = new Date("2026-11-30T19:00:00Z");

async function person(name: string, extra: Record<string, unknown> = {}) {
  P[name] = uuidv7();
  await live.insertInto("person").values({ id: P[name]!, display_name: `${name} Rook`, email: `${name.toLowerCase()}@example.test`, created_via: "desk", ...extra }).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P[name]!, kind: "email", value: `${name.toLowerCase()}@example.test`, verified_at: new Date() }).execute();
}
const erasedBy = async (who: string, by: string | null) => {
  await live.updateTable("person").set({ redacted_at: NOW, display_name: "Former member", email: null }).where("id", "=", P[who]!).execute();
  await sql`INSERT INTO action_run (id, action, action_version, actor_person_id, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${uuidv7()}, 'privacy.erase', 1, ${by}, 'app', ${JSON.stringify({ person_id: P[who] })}::jsonb, '{}'::jsonb, 'applied', 'none', '{}'::jsonb, now(), now())`.execute(live);
};

before(async () => {
  const pool = new pg.Pool({ connectionString: ADMIN, max: 1 }); pool.on("error", () => {});
  admin = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`CREATE DATABASE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  await migrate(live);
  await runAsSystem(live, "club.setup", { name: "Rook Padel", time_zone: "America/Los_Angeles", owner_email: "owner@example.test", owner_name: "Olu Rook" }, "setup");
  P.Olu = (await live.selectFrom("person").select("id").where("email", "=", "owner@example.test").executeTakeFirstOrThrow()).id;
  for (const n of ["Ada", "Ben", "Cy", "Dee", "Eve", "Fin", "Gus", "Hal", "Kit", "Sam"]) await person(n, n === "Eve" ? { phone: "+14155550101" } : {});
  // Authenticators made by now(): microseconds, as in production.
  for (const n of ["Ada", "Ben", "Cy"]) await sql`INSERT INTO staff_factor (person_id, secret, confirmed_at, last_step) VALUES (${P[n]}, ${`old-${n}`}, now(), 100)`.execute(live);
  // Fin's phone was added by someone else (an attacker's); Gus's phone gets Gus's pushes.
  await live.updateTable("person").set({ phone: "+14155550666" }).where("id", "=", P.Fin!).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P.Fin!, kind: "phone", value: "+14155550666", verified_at: new Date() }).execute();
  P.push = uuidv7();
  await live.insertInto("push_subscription").values({ id: P.push!, person_id: P.Gus!, app: "member", endpoint: `https://push.example.test/${tag}`, p256dh: "k", auth: "a" }).execute();
  await live.destroy();
  for (const n of [1, 2, 3, 4, 5]) await sql.raw(`CREATE DATABASE ${C(n)} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // Then, on the club's database:
  // Ben lost his phone: authenticator removed and set up again (the same row, a new secret and a later confirmed_at).
  await sql`UPDATE staff_factor SET removed_at = now() WHERE person_id = ${P.Ben}`.execute(live);
  await sql`UPDATE staff_factor SET secret = 'new-Ben', confirmed_at = now(), last_step = 7, removed_at = NULL WHERE person_id = ${P.Ben}`.execute(live);
  // Cy removed his; Ada used a later code.
  await sql`UPDATE staff_factor SET removed_at = now() WHERE person_id = ${P.Cy}`.execute(live);
  await sql`UPDATE staff_factor SET last_step = 150 WHERE person_id = ${P.Ada}`.execute(live);
  // Dee was waiting to be deleted again (an earlier restore queued her, and the server hadn't started yet).
  await live.insertInto("erase_after_restore").values({ person_id: P.Dee!, redacted_at: NOW, deleted_by: "self" }).execute();
  // Eve changed number: a no for the old one (number_changed), a yes for the new one.
  await live.updateTable("person").set({ phone: "+14155550202" }).where("id", "=", P.Eve!).execute();
  await live.insertInto("channel_consent").values({ id: uuidv7(), person_id: P.Eve!, channel: "sms", purpose: "account", granted: false, source: "number_changed" }).execute();
  await live.insertInto("channel_consent").values({ id: uuidv7(), person_id: P.Eve!, channel: "sms", purpose: "account", granted: true, source: "app" }).execute();
  // Fin undid the sign-in that wasn't his: the phone goes (two_factor.ts sign_in_undo).
  await live.deleteFrom("auth_identity").where("person_id", "=", P.Fin!).where("kind", "=", "phone").execute();
  await live.updateTable("person").set({ phone: null }).where("id", "=", P.Fin!).execute();
  // Hal subscribed on Gus's old phone: the same row is Hal's now (push.ts).
  await live.updateTable("push_subscription").set({ person_id: P.Hal! }).where("id", "=", P.push!).execute();
  // Kit was deleted by the club, Sam deleted his own account.
  await erasedBy("Kit", P.Olu!);
  await erasedBy("Sam", P.Sam!);
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, C(1), C(2), C(3), C(4), C(5)]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

const factors = async (db: Db) => Object.fromEntries((await db.selectFrom("staff_factor").select(["person_id", "secret", "removed_at", "last_step"]).execute()).map((r) => [r.person_id, r]));
const redacted = async (db: Db, who: string) => (await db.selectFrom("person").select("redacted_at").where("id", "=", P[who]!).executeTakeFirstOrThrow()).redacted_at;

test("kumi restore: the authenticators as the database before it had them, each one's newest; the copy's own untouched", async () => {
  const sent = await readSentBefore(urlFor(LIVE));
  const r = await afterRestore(urlFor(C(1)), sent, NOW);
  const db = connect(urlFor(C(1)));
  try {
    const f = await factors(db);
    assert.equal(f[P.Ada!]!.removed_at, null, "Ada did nothing: her authenticator stays (it was removed by every restore)");
    assert.equal(f[P.Ada!]!.last_step, "150", "and the later code used can't be used again");
    assert.equal(f[P.Ben!]!.secret, "new-Ben", "Ben's new authenticator works");
    assert.equal(f[P.Ben!]!.removed_at, null);
    assert.ok(f[P.Cy!]!.removed_at, "Cy's removed one stays removed");
    // Dee, still waiting on the database before it, is deleted here.
    assert.ok(await redacted(db, "Dee"), "an account still queued on the database it replaced is deleted again");
    assert.ok(r.gone.people.some((p) => p.id === P.Dee));
    // Eve's number changed since: the copy has her new one (contact), and her yes was for it.
    assert.equal(await textsAnswer(db, P.Eve!), true, "her yes for her new number stands, on her new number");
    // Fin's undone phone: the address and the number are gone.
    assert.equal((await db.selectFrom("auth_identity").select("id").where("person_id", "=", P.Fin!).where("kind", "=", "phone").execute()).length, 0);
    assert.equal((await db.selectFrom("person").select("phone").where("id", "=", P.Fin!).executeTakeFirstOrThrow()).phone, null);
    assert.ok((await db.selectFrom("auth_identity").select("id").where("person_id", "=", P.Fin!).where("kind", "=", "email").executeTakeFirst()), "his email still signs him in");
    // Gus's old phone is Hal's now: the copy stops pushing Gus's messages to it.
    assert.ok((await db.selectFrom("push_subscription").select("revoked_at").where("id", "=", P.push!).executeTakeFirstOrThrow()).revoked_at);
    // Kit (the club's deletion) and Sam (his own) deleted again, each said with who asked.
    assert.ok(await redacted(db, "Kit")); assert.ok(await redacted(db, "Sam"));
    assert.deepEqual(r.gone.people.filter((p) => [P.Kit, P.Sam].includes(p.id)).map((p) => [p.id, p.by, p.kept]).sort(), [[P.Kit, "staff", false], [P.Sam, "self", false]].sort());
  } finally { await db.destroy(); }
  // Again: nothing more to do.
  const again = await afterRestore(urlFor(C(1)), sent, NOW);
  assert.equal(again.gone.erased, 0);
});

test("release.sh and kumi-hosted (COPY): the same, read as text", async () => {
  // COPY carries every value as text: stand in for it by reading the live database as text and loading it the same way.
  const textPool = new pg.Pool({ connectionString: urlFor(LIVE), max: 1, types: { getTypeParser: () => (v: string) => v } } as pg.PoolConfig);
  const copy = new pg.Pool({ connectionString: urlFor(C(2)), max: 1 });
  try {
    for (const k of GONE_PARTS) {
      const part = GONE[k], rows = (await textPool.query(part.read).catch(() => ({ rows: [] }))).rows;
      if (!rows.length) continue;
      const name = /^CREATE TEMP TABLE (\w+)/.exec(part.table)![1]!, client = await copy.connect();
      try {
        await client.query(part.table);
        await client.query(`INSERT INTO ${name} SELECT * FROM json_populate_recordset(NULL::${name}, $1)`, [JSON.stringify(rows)]);
        await client.query(part.apply);
        await client.query(`DROP TABLE ${name}`);
      } finally { client.release(); }
    }
  } finally { await textPool.end(); await copy.end(); }
  const db = connect(urlFor(C(2)));
  try {
    const f = await factors(db);
    assert.equal(f[P.Ada!]!.removed_at, null, "unchanged: stays");
    assert.equal(f[P.Ben!]!.secret, "new-Ben", "replaced: the new one, not the old");
    assert.ok(f[P.Cy!]!.removed_at, "removed: stays removed");
    assert.equal((await db.selectFrom("erase_after_restore").select("person_id").where("person_id", "=", P.Dee!).execute()).length, 1, "Dee queued, for the server to delete as it starts");
    // Until then nobody signs in as an account waiting to be deleted again.
    const token = `dee-${tag}`;
    await db.insertInto("web_session").values({ token_hash: createHash("sha256").update(token).digest("hex"), person_id: P.Dee!, expires_at: new Date("2027-12-01T00:00:00Z") }).execute();
    assert.equal(await sessionPerson(db, token, NOW), null);
  } finally { await db.destroy(); }
});

test("an export newer than this server's database keeps its own authenticator", async () => {
  // The copy (an export, say, from after the club came back) set one up again later than the database it replaces.
  const db = connect(urlFor(C(3)));
  try {
    await sql`UPDATE staff_factor SET secret = 'newest-Ben', confirmed_at = now() + interval '1 hour', removed_at = NULL WHERE person_id = ${P.Ben}`.execute(db);
    await afterRestore(urlFor(C(3)), await readSentBefore(urlFor(LIVE)), NOW);
    assert.equal((await factors(db))[P.Ben!]!.secret, "newest-Ben", "an older row never replaces a newer one");
  } finally { await db.destroy(); }
});

test("--keep-staff-deleted: an account the club deleted keeps its place; one deleted by its owner is deleted again", async () => {
  const r = await afterRestore(urlFor(C(4)), await readSentBefore(urlFor(LIVE)), NOW, { keep: { staff: true } });
  const db = connect(urlFor(C(4)));
  try {
    assert.equal(await redacted(db, "Kit"), null, "kept, as asked");
    assert.ok(await redacted(db, "Sam"), "his own deletion is always repeated");
    assert.deepEqual(r.gone.people.find((p) => p.id === P.Kit)?.kept, true);
  } finally { await db.destroy(); }
});

test("nothing to vouch for it: the newest backup's list of deleted accounts; the club's last owner keeps the role", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-rr-"));
  try {
    writeFileSync(join(dir, "kumi-2026-11-30T1100.dump"), "");
    writeFileSync(join(dir, "kumi-2026-11-30T1100.json"), JSON.stringify({ kind: "kumi-backup", redacted: [{ id: P.Sam, at: NOW.toISOString() }, { id: P.Olu, at: NOW.toISOString() }] }));
    const r = await afterRestore(urlFor(C(5)), null, NOW, { backupDir: dir });
    assert.equal(r.gone.unvouched, true);
    assert.equal(r.gone.from_backup, "kumi-2026-11-30T1100.json");
    const db = connect(urlFor(C(5)));
    try {
      assert.ok(await redacted(db, "Sam"), "deleted again from the backup's list");
      assert.ok(await redacted(db, "Olu"));
      assert.deepEqual(r.gone.last_owner_kept, [P.Olu], "the last owner: said");
      const role = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.active")
        .where("person_role.person_id", "=", P.Olu!).where("role.key", "=", "owner").executeTakeFirstOrThrow();
      assert.equal(role.active, true, "and the role stays, so the club isn't left without one");
    } finally { await db.destroy(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
