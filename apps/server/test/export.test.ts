// A club can always leave (export.ts): the owner's "Download everything" and `kumi export` make one sealed
// file, and `kumi restore <file>` puts it into a fresh install: the same data, the secrets sealed again with the
// new server's key, passkeys retired when the address changes, and read-only and the day its Kumi was to end there
// both off. Needs pg_dump and pg_restore
// 17, like the backup tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { heldSummary, leavingOn, messageHandlers, openText, processOutbox, pushKeys, readOnlySince, run, runAsSystem, sealText, sendEmails, setSecretKeys, uuidv7, type Actor, type Db } from "@kumi/core";
import { pgTool } from "../src/backups.ts";
import { ExportRefused, importExport, makeExport, openExport, packExport, sealExport } from "../src/export.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";

const KEY_OLD = Buffer.alloc(32, 7).toString("base64"), KEY_NEW = Buffer.alloc(32, 9).toString("base64");
const SOURCE_URL = "https://staff.kestrel.kumi.club", NOW = new Date("2026-11-30T19:00:00Z");
let src: { db: Db; drop: () => Promise<void> }, dst: { db: Db; drop: () => Promise<void> }, srcUrl: string, dstUrl: string, owner: Actor, dir: string;
const urlOf = async (db: Db) => ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
const counts = async (db: Db, tables: string[]) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)}`.execute(db)).rows[0]!.n)])));
const TABLES = ["person", "person_role", "membership_plan", "action_run", "entity_change", "passkey", "staff_factor", "push_key"];

before(async () => {
  if (skip) return;
  src = await freshDb(); dst = await freshDb();
  [srcUrl, dstUrl] = [await urlOf(src.db), await urlOf(dst.db)];
  dir = mkdtempSync(join(tmpdir(), "kumi-export-test-"));
  setSecretKeys({ current: KEY_OLD });
  const s = await runAsSystem(src.db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Ann", "Ben"]) await run(src.db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner);
  await run(src.db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner);
  // Secrets sealed with the old server's key: the owner's authenticator and the push key; and a passkey for its address.
  await src.db.insertInto("staff_factor").values({ person_id: owner.personId!, secret: sealText("JBSWY3DPEHPK3PXP"), confirmed_at: NOW }).execute();
  await pushKeys(src.db);
  await src.db.insertInto("passkey").values({ credential_id: "cred-1", person_id: owner.personId!, public_key: Buffer.from("pk"), counter: "0", transports: null, name: "Robin's phone" }).execute();
  await runAsSystem(src.db, "club.read_only", { on: true }, "test");   // an unpaid hosted account, leaving
  await runAsSystem(src.db, "club.leaving", { on: "2026-12-15", kept_days: 30 }, "test", { now: NOW });   // on this day
});
after(async () => { if (skip) return; setSecretKeys({}); rmSync(dir, { recursive: true, force: true }); await src.drop(); await dst.drop(); });

test("the export opens only with its passphrase, and holds the database, the secrets and the settings", { skip }, async () => {
  const env = { KUMI_PUBLIC_URL: SOURCE_URL, KUMI_MAIL_FROM: "Kestrel <hello@kestrel.example>", KUMI_RESEND_API_KEY: "re_secret_value", KUMI_PG_BIN: process.env.KUMI_PG_BIN };
  const made = await makeExport(src.db, { url: srcUrl, env, now: NOW, passphrase: "correct horse battery" });
  assert.equal(made.passphrase, null);   // typed, so not shown back
  assert.equal(made.name, "kumi-export-20261130T1900Z.kumi");
  assert.throws(() => openExport(made.file, "wrong horse battery"), ExportRefused);
  assert.ok(!made.file.includes(Buffer.from("Robin Hale")), "nothing readable without the passphrase");
  const { manifest, entries } = openExport(made.file, "correct horse battery");
  assert.deepEqual([manifest.club.name, manifest.secrets.carried, manifest.addresses.public_url], ["Kestrel Padel", 2, SOURCE_URL]);
  assert.deepEqual(manifest.settings, { KUMI_PUBLIC_URL: SOURCE_URL, KUMI_MAIL_FROM: "Kestrel <hello@kestrel.example>" });
  assert.deepEqual(manifest.set_elsewhere, ["KUMI_RESEND_API_KEY"]);   // named, never carried
  assert.ok(!entries.get("manifest.json")!.toString().includes("re_secret_value"));
  assert.ok(manifest.migrations.includes("065_read_only.sql"));
  // Too short a passphrase isn't accepted; one Kumi makes opens however it's typed back.
  await assert.rejects(makeExport(src.db, { url: srcUrl, env, passphrase: "short" }), ExportRefused);
  const auto = await makeExport(src.db, { url: srcUrl, env, now: NOW });
  assert.match(auto.passphrase!, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){5}$/);
  assert.equal(openExport(auto.file, auto.passphrase!.toLowerCase().replace(/-/g, " ")).manifest.club.name, "Kestrel Padel");
});

test("restored into a fresh install: the same data, secrets sealed with the new key, passkeys retired, read-only and leaving off", { skip }, async () => {
  const before = await counts(src.db, TABLES);
  // A receipt's email still waiting to go when the export is made: the old server will send it.
  await src.db.insertInto("outbound_message").values({ id: uuidv7(), event_id: null, person_id: owner.personId!, kind: "receipt.issued", channel: "email", purpose: "account",
    essential: true, lang: "en", subject: "Your receipt", body: "Thanks", link: null, status: "waiting", send_after: NOW, stale_at: null, failure: null, sent_at: null, read_at: null }).execute();
  const made = await makeExport(src.db, { url: srcUrl, env: { KUMI_PUBLIC_URL: SOURCE_URL, KUMI_PG_BIN: process.env.KUMI_PG_BIN }, now: NOW });
  // The new server, its own key, at the club's own domain now.
  setSecretKeys({ current: KEY_NEW });
  const r = await importExport({ url: dstUrl, file: made.file, passphrase: made.passphrase!, dir, env: { KUMI_PUBLIC_URL: "https://staff.kestrelpadel.com", KUMI_PG_BIN: process.env.KUMI_PG_BIN }, now: NOW });
  assert.deepEqual([r.club, r.secrets, r.secrets_lost, r.passkeys_retired, r.was_read_only, r.was_leaving], ["Kestrel Padel", 2, 0, 1, true, "2026-12-15"]);
  assert.ok(existsSync(r.safety_copy), "the fresh install's database was kept first");
  const after = await counts(dst.db, TABLES);
  // The same rows, plus the import's own records of read-only and the leaving day going off.
  assert.deepEqual({ ...after, action_run: after.action_run! - 2, entity_change: after.entity_change! - 2 }, before);
  const factor = await dst.db.selectFrom("staff_factor").select("secret").executeTakeFirstOrThrow();
  assert.equal(openText(factor.secret), "JBSWY3DPEHPK3PXP");   // opens with the new key alone
  setSecretKeys({ current: KEY_OLD });
  assert.throws(() => openText(factor.secret));                // and not with the old one
  setSecretKeys({ current: KEY_NEW });
  assert.ok((await dst.db.selectFrom("passkey").select("revoked_at").executeTakeFirstOrThrow()).revoked_at);
  assert.equal(await readOnlySince(dst.db), null);
  assert.equal(await leavingOn(dst.db), null);
  // Nobody here is told the old server's date went: it was never this server's.
  await processOutbox(dst.db, messageHandlers);
  assert.equal((await dst.db.selectFrom("outbound_message").select("id").where("kind", "like", "club_leaving%").execute()).length, 0);
  // What was still waiting on the old server is held here, not sent a second time, until this server's owner says.
  assert.ok(r.held.messages >= 1 && r.held.events >= 1, "the receipt's email and the old server's unhandled events are held");
  const mails: string[] = [];
  const mailer = { async send(m: { subject: string }) { mails.push(m.subject); } };
  await sendEmails(dst.db, mailer, NOW);
  assert.equal(mails.length, 0, "nothing sent here yet");
  assert.equal((await heldSummary(dst.db)).messages, r.held.messages);
  // Sent on (the old server never got to it): the receipt goes, and still nobody hears about the old leaving day.
  await runAsSystem(dst.db, "club.held_release", { send: true }, "test", { now: NOW });
  await processOutbox(dst.db, messageHandlers);
  await sendEmails(dst.db, mailer, NOW);
  assert.ok(mails.includes("Your receipt"));
  assert.equal((await dst.db.selectFrom("outbound_message").select("id").where("kind", "like", "club_leaving%").where("channel", "=", "email").where("status", "=", "sent").execute()).length, 0);
  setSecretKeys({ current: KEY_OLD });
});

test("an export from a newer Kumi is refused, and nothing is changed", { skip }, async () => {
  const made = await makeExport(src.db, { url: srcUrl, env: { KUMI_PG_BIN: process.env.KUMI_PG_BIN }, now: NOW, passphrase: "correct horse battery" });
  const { manifest, entries } = openExport(made.file, "correct horse battery");
  const newer = { ...manifest, kumi: { version: "9.0.0", revision: "x" }, migrations: [...manifest.migrations, "999_from_the_future.sql"] };
  const file = sealExport(packExport([...entries].map(([name, data]) => ({ name, data: name === "manifest.json" ? Buffer.from(JSON.stringify(newer)) : data }))), "correct horse battery", false, NOW);
  const people = (await counts(dst.db, ["person"])).person;
  await assert.rejects(importExport({ url: dstUrl, file, passphrase: "correct horse battery", dir, env: { KUMI_PG_BIN: process.env.KUMI_PG_BIN } }), /newer Kumi \(9\.0\.0/);
  assert.equal((await counts(dst.db, ["person"])).person, people);
});

test("the staff app: the owner confirms, gets the passphrase once and the file; nobody else can", { skip }, async () => {
  await runAsSystem(src.db, "club.read_only", { on: false }, "test");
  await src.db.deleteFrom("staff_factor").execute();   // an authenticator would ask for its code at sign-in (two_factor.test.ts)
  const mailer = new MemoryMailer(), cookies: Record<string, string> = {};
  const app = makeApp({ db: src.db, mailer, secureCookies: false, databaseUrl: srcUrl });
  const post = async (path: string, who: string, body: unknown = {}) => {
    const res = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() as any };
  };
  for (const email of ["robin@example.test", "ann@example.test"]) {
    await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
    const res = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
    cookies[email] = res.headers.get("set-cookie")!.split(";")[0]!;
  }
  const no = await post("/actions/club.export/plan", "ann@example.test");
  assert.equal(no.status, 403);
  // Robin has a passkey, so only a passkey sign-in can (strongAuth); without one, the emailed code is enough.
  assert.equal((await post("/actions/club.export/plan", "robin@example.test")).json.error, "error.need_passkey");
  await src.db.deleteFrom("passkey").execute();
  const p = await post("/actions/club.export/plan", "robin@example.test");
  assert.equal(p.json.summary, "A file with all of the club's data (members, bookings, payments, programs, settings and documents) to keep, or to run the club's Kumi somewhere else. It's sealed with a passphrase that's shown once, next.");
  await post(`/runs/${p.json.run_id}/apply`, "robin@example.test");
  assert.equal((await post(`/staff/export/${p.json.run_id}`, "ann@example.test")).status, 403);   // not Ann's: staff pages aren't hers
  const made = await post(`/staff/export/${p.json.run_id}`, "robin@example.test");
  assert.equal(made.status, 200);
  assert.equal((await post(`/staff/export/${p.json.run_id}`, "robin@example.test")).status, 409);   // made once
  const file = await app.request(made.json.download, { headers: { cookie: cookies["robin@example.test"]! } });
  assert.equal(file.headers.get("content-disposition"), `attachment; filename="${made.json.name}"`);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.length, made.json.bytes);
  assert.equal(openExport(bytes, made.json.passphrase).manifest.club.name, "Kestrel Padel");
  assert.equal((await app.request(made.json.download, { headers: { cookie: cookies["ann@example.test"]! } })).status, 403);
  // The staff app's notice of the day the club's Kumi ends: the owner's (and managers') to see, not members'.
  const leaving = async (who: string) => (await (await app.request("/me", { headers: { cookie: cookies[who]! } })).json() as any).leaving;
  assert.deepEqual([await leaving("robin@example.test"), await leaving("ann@example.test")], ["2026-12-15", null]);
  assert.equal((await (await app.request("/club")).json() as any).leaving, undefined, "not on the club's public page");
  // The club's page says when it's read-only, for both apps' banner.
  assert.equal((await (await app.request("/club")).json() as any).read_only, false);
  await runAsSystem(src.db, "club.read_only", { on: true }, "test");
  assert.equal((await (await app.request("/club")).json() as any).read_only, true);
  assert.equal((await post("/actions/club.export/plan", "robin@example.test")).status, 200);   // the owner can still download everything
});
