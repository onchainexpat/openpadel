// The restore review's second recheck (f6fca31), kept as regression tests: authenticators, the queue, no money moved twice by
// erasing again, an undone email that signs nobody in, who asked kept through restores, nothing carried into a newer copy.
// Reviewer's throwaway recheck of f6fca31 (not part of the repo).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { connect, creditBalance, eraseAfterRestore, migrate, moneyHandlers, openPayment, checkPayment, processOutbox, run, runAsSystem, setPaymentProvider, TestProvider, uuidv7, type Actor, type Db } from "@kumi/core";
import { afterRestore, carryGoneAfterImport, GONE, readGoneBefore, readSentBefore } from "../src/after_restore.ts";
import { startEmailSignIn, verifyEmailCode } from "../src/auth.ts";
import { MemoryMailer } from "../src/mailer.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_rev2_live_${tag}`, C = (n: number) => `kumi_test_rev2_c${n}_${tag}`;
let admin: Kysely<any>, live: Db;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const P: Record<string, string> = {};
let owner: Actor, annBooking: { booking_id: string; payment_id: string }, annRef: string;
const as = (n: string): Actor => ({ personId: P[n]!, via: "test", lang: "en" });
const psql = (db: string, args: string[], input?: string) =>
  execFileSync("docker", ["exec", "-i", "kumi-dev-pg", "psql", "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, ...args], { input: input ?? "", encoding: "utf8" });
async function account(db: Db, kind: string, personId: string | null) {
  const got = await db.selectFrom("ledger_account").select("id").where("kind", "=", kind as any).where("person_id", personId === null ? "is" : "=", personId as any).where("revenue_type", "is", null).executeTakeFirst();
  if (got) return got.id;
  const id = uuidv7(); await db.insertInto("ledger_account").values({ id, kind: kind as any, person_id: personId }).execute(); return id;
}
async function post(db: Db, kind: string, entries: Array<[string, number]>) {
  const r = uuidv7(), txn = uuidv7();
  await sql`INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${r}, 'test.money', 1, 'test', '{}', '{}', 'applied', 'none', '{}', now(), now())`.execute(db);
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("ledger_txn").values({ id: txn, kind, action_run_id: r, memo: kind }).execute();
    await trx.insertInto("ledger_entry").values(entries.map(([account_id, cents]) => ({ txn_id: txn, account_id, amount_cents: String(cents) }))).execute();
  });
}
const refundedOnStripe = (ref: string) => [...stripe.refunds.values()].filter((r) => r.paymentRef === ref).reduce((n, r) => n + r.amountCents, 0);

before(async () => {
  const pool = new pg.Pool({ connectionString: ADMIN, max: 1 }); pool.on("error", () => {});
  admin = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`CREATE DATABASE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  await migrate(live);
  await sql`ALTER TABLE club ALTER COLUMN two_factor SET DEFAULT 'off'`.execute(live);
  setPaymentProvider(stripe);
  const s = await runAsSystem(live, "club.setup", { name: "Rev Padel", time_zone: TZ, owner_email: "owner@example.test", owner_name: "Olu Owner" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(live, "location.create", { name: "East", time_zone: TZ }, owner)).result as any).location_id;
  const c1 = ((await run(live, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(live, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(live, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(live, "club.update", { court_bookings: true }, owner, { now: NOW });
  // The club's rule: under 200 hours before, half back.
  await sql`UPDATE booking_policy SET free_cancel_hours = 200, late_refund_percent = 50`.execute(live);
  for (const n of ["Ann", "Sam", "Ada", "Ben", "Vic", "Kim", "Dee"])
    P[n] = ((await run(live, "person.create", { display_name: `${n} Test`, email: `${n.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;
  // Ann books and pays $60 (3 days ahead: a late cancel by the club's rule gives $30 back).
  annBooking = (await run(live, "booking.request", { court_id: c1, starts_at: at("2026-12-03", "10:00"), minutes: 90, pay: "whole", person_id: P.Ann }, as("Ann"), { now: NOW })).result as any;
  await openPayment(live, annBooking.payment_id, P.Ann!);
  annRef = (await live.selectFrom("payment").select("provider_ref").where("id", "=", annBooking.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(annRef, "succeeded");
  assert.equal(await checkPayment(live, annBooking.payment_id, "test"), "succeeded");
  for (const n of ["Ada", "Ben"]) await sql`INSERT INTO staff_factor (person_id, secret, confirmed_at, last_step) VALUES (${P[n]}, ${`old-${n}`}, now(), 100)`.execute(live);
  // Vic: an attacker had changed Vic's email to theirs when the copy was made (email-undo fixes it below).
  await live.updateTable("person").set({ email: "attacker@example.test" }).where("id", "=", P.Vic!).execute();
  await live.deleteFrom("auth_identity").where("person_id", "=", P.Vic!).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P.Vic!, kind: "email", value: "attacker@example.test", verified_at: new Date() }).execute();
  await live.destroy();
  for (const n of [1, 2, 3, 4]) await sql.raw(`CREATE DATABASE ${C(n)} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // ---- after the copies, on the club's database ----
  await sql`UPDATE staff_factor SET removed_at = now() WHERE person_id = ${P.Ben}`.execute(live);
  await sql`UPDATE staff_factor SET secret = 'new-Ben', confirmed_at = now(), last_step = 7, removed_at = NULL WHERE person_id = ${P.Ben}`.execute(live);
  // Ann cancels (late: $30 of $60 back to her card, sent), then deletes her account.
  await run(live, "booking.cancel", { booking_id: annBooking.booking_id }, as("Ann"), { now: NOW });
  await processOutbox(live, moneyHandlers);
  assert.equal(refundedOnStripe(annRef), 3000, "the club's rule: half back");
  await live.insertInto("erase_after_restore").values({ person_id: P.Ann!, redacted_at: NOW, deleted_by: "self" }).execute();
  assert.equal((await eraseAfterRestore(live, NOW)).erased, 1);
  // Sam deletes his own account (as privacy.erase records it).
  await live.updateTable("person").set({ redacted_at: NOW, display_name: "Former member", email: null }).where("id", "=", P.Sam!).execute();
  await sql`INSERT INTO action_run (id, action, action_version, actor_person_id, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${uuidv7()}, 'privacy.erase', 1, ${P.Sam}, 'app', ${JSON.stringify({ person_id: P.Sam })}::jsonb, '{}'::jsonb, 'applied', 'none', '{}'::jsonb, now(), now())`.execute(live);
  // Vic clicks "that wasn't me": the email goes back to Vic's own (email.change + sign_in_undo).
  await live.updateTable("person").set({ email: "vic@example.test" }).where("id", "=", P.Vic!).execute();
  await live.deleteFrom("auth_identity").where("person_id", "=", P.Vic!).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P.Vic!, kind: "email", value: "vic@example.test", verified_at: new Date() }).execute();
  // Somebody on the club's database has credit and a phone's push (so those parts have rows to carry).
  await post(live, "refund", [[await account(live, "member_credit", P.Ben!), -1000], [await account(live, "adjustment", null), 1000]]);
  await live.insertInto("push_subscription").values({ id: uuidv7(), person_id: P.Ada!, app: "member", endpoint: `https://push.example.test/ada-${tag}`, p256dh: "k", auth: "a" }).execute();
  // Dee still waiting to be deleted again (from an earlier restore).
  await live.insertInto("erase_after_restore").values({ person_id: P.Dee!, redacted_at: NOW, deleted_by: "self" }).execute();
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, C(1), C(2), C(3), C(4)]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

test("A. kumi restore: factors, queue (rechecks of HIGH-1/2, MEDIUM-3)", async () => {
  const r = await afterRestore(urlFor(C(1)), await readSentBefore(urlFor(LIVE)), NOW);
  const db = connect(urlFor(C(1)));
  try {
    const f = Object.fromEntries((await db.selectFrom("staff_factor").select(["person_id", "secret", "removed_at"]).execute()).map((x) => [x.person_id, x]));
    assert.equal(f[P.Ada!]!.removed_at, null, "HIGH-1: unchanged authenticator kept");
    assert.equal(f[P.Ben!]!.secret, "new-Ben", "HIGH-2: replaced one is the new one");
    assert.ok((await db.selectFrom("person").select("redacted_at").where("id", "=", P.Dee!).executeTakeFirstOrThrow()).redacted_at, "MEDIUM-3: queued one deleted");
    console.log("A gone:", JSON.stringify({ erased: r.gone.erased, other: r.gone.other, people: r.gone.people }));
  } finally { await db.destroy(); }
});

test("B. kumi restore: Ann's booking, cancelled and refunded by the rule before she deleted her account, isn't refunded again", async () => {
  const db = connect(urlFor(C(1)));
  try {
    const refunds = await db.selectFrom("refund").select(["amount_cents", "status", "destination"]).where("payment_id", "=", annBooking.payment_id).execute();
    console.log("B copy refunds for Ann's payment:", refunds);
    await processOutbox(db, moneyHandlers);
    console.log("B total refunded at the provider for Ann's $60:", refundedOnStripe(annRef));
    assert.equal(refundedOnStripe(annRef), 3000, "the late cancel's $30 went back twice ($60 of $60 refunded)");
  } finally { await db.destroy(); }
});

test("C. kumi restore: the attacker's email that Vic undid signs nobody in", async () => {
  const db = connect(urlFor(C(1)));
  try {
    const v = await db.selectFrom("person").select("email").where("id", "=", P.Vic!).executeTakeFirstOrThrow();
    const ids = await db.selectFrom("auth_identity").select(["kind", "value"]).where("person_id", "=", P.Vic!).execute();
    console.log("C Vic person.email:", v.email, "identities:", ids);
    const mailer = new MemoryMailer();
    await startEmailSignIn(db, mailer, "attacker@example.test", "en", new Date());
    const code = /\b(\d{6})\b/.exec(`${mailer.sent[0]?.subject ?? ""} ${mailer.sent[0]?.text ?? ""}`)?.[1];
    const signed = code ? await verifyEmailCode(db, "attacker@example.test", code, null, new Date()).catch((e) => ({ error: String(e) })) : null;
    console.log("C attacker sign-in:", signed && "personId" in signed ? (signed.personId === P.Vic ? "signed in AS VIC" : signed.personId) : signed);
    assert.ok(!(signed && "personId" in signed && signed.personId === P.Vic), "the attacker's undone email signs in as Vic after the restore");
  } finally { await db.destroy(); }
});

test("D. a second restore: a self-deleted account is deleted again whatever --keep says (who asked is kept)", async () => {
  // C(1) is now the club's database (after restore A, which deleted Sam again); C(3) is the same old copy.
  const r = await afterRestore(urlFor(C(3)), await readSentBefore(urlFor(C(1))), NOW, { keep: { ids: [P.Sam!] } });
  const db = connect(urlFor(C(3)));
  try {
    const sam = r.gone.people.find((p) => p.id === P.Sam);
    console.log("D Sam in the second restore:", sam);
    assert.ok((await db.selectFrom("person").select("redacted_at").where("id", "=", P.Sam!).executeTakeFirstOrThrow()).redacted_at, "Sam's own deletion was not repeated");
  } finally { await db.destroy(); }
});

test("E. an export newer than the server's database (the club came back): what it gained since stays", async () => {
  const db = connect(urlFor(C(4)));
  try {
    // While away: Kim got $50 back as club credit, a new phone and a new device, and changed email.
    await post(db, "refund", [[await account(db, "member_credit", P.Kim!), -5000], [await account(db, "adjustment", null), 5000]]);
    await db.updateTable("person").set({ phone: "+14155550123", email: "kim-new@example.test" }).where("id", "=", P.Kim!).execute();
    await db.deleteFrom("auth_identity").where("person_id", "=", P.Kim!).execute();
    await db.insertInto("auth_identity").values([{ id: uuidv7(), person_id: P.Kim!, kind: "email", value: "kim-new@example.test", verified_at: new Date() },
      { id: uuidv7(), person_id: P.Kim!, kind: "phone", value: "+14155550123", verified_at: new Date() }]).execute();
    await db.insertInto("push_subscription").values({ id: uuidv7(), person_id: P.Kim!, app: "member", endpoint: `https://push.example.test/kim-${tag}`, p256dh: "k", auth: "a" }).execute();
    const r = await carryGoneAfterImport(db, await readGoneBefore(urlFor(LIVE)), NOW);
    const kim = await db.selectFrom("person").select(["phone", "email"]).where("id", "=", P.Kim!).executeTakeFirstOrThrow();
    const ids = await db.selectFrom("auth_identity").select(["kind", "value"]).where("person_id", "=", P.Kim!).execute();
    const push = await db.selectFrom("push_subscription").select("revoked_at").where("person_id", "=", P.Kim!).execute();
    const credit = await creditBalance(db, P.Kim!);
    console.log("E other:", r.other, "Kim:", kim, "identities:", ids, "push:", push, "credit:", credit);
    const problems = [credit !== 5000 && `credit ${credit} (was 5000)`, kim.phone === null && "phone removed", !ids.some((i) => i.value === "kim-new@example.test") && "new email identity removed",
      ids.some((i) => i.value === "kim@example.test") && "old email identity put back", push.some((x) => x.revoked_at) && "new device's push revoked"].filter(Boolean);
    assert.deepEqual(problems, [], "an export newer than the server's database loses what it gained since");
  } finally { await db.destroy(); }
});

test("F. release.sh / hosted: the factor strings through real psql COPY", async () => {
  for (const k of ["people", "factors"] as const) {
    const rows = psql(LIVE, ["-c", `COPY (${GONE[k].read}) TO STDOUT`]);
    const name = /^CREATE TEMP TABLE (\w+)/.exec(GONE[k].table)![1]!;
    psql(C(2), ["-c", GONE[k].table, "-c", `COPY ${name} FROM STDIN`, "-c", GONE[k].apply], rows);
  }
  const db = connect(urlFor(C(2)));
  try {
    const f = Object.fromEntries((await db.selectFrom("staff_factor").select(["person_id", "secret", "removed_at"]).execute()).map((x) => [x.person_id, x]));
    assert.equal(f[P.Ada!]!.removed_at, null); assert.equal(f[P.Ben!]!.secret, "new-Ben");
    assert.equal((await db.selectFrom("erase_after_restore").select("person_id").where("person_id", "=", P.Dee!).execute()).length, 1);
  } finally { await db.destroy(); }
});
