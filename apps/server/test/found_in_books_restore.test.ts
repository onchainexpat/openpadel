// A found card payment kept as paid elsewhere, and a restore (Kelly, 6 Nov 2026: it counts in the books as other
// income). Like any other card payment: a copy from before the staff kept it has it open again, with nothing in its
// books, and one found only after the copy is found again at the provider; neither is counted by itself, and each
// counts once when the staff keep it again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { checkMoneyAfterRestore, connect, migrate, noteFound, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db, type FoundIntent, type FoundRefund } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_fib_live_${tag}`, COPY = `kumi_test_fib_copy_${tag}`;
class Listing extends TestProvider {
  intentsSince: FoundIntent[] = [];
  override async listSince() { return { intents: this.intentsSince, refunds: [] as FoundRefund[] }; }
}
const stripe = new Listing();
let admin: Kysely<any>, live: Db, owner: Actor;
const found = (ref: string, amountCents: number): FoundIntent =>
  ({ ref, status: "succeeded", amountCents, created: new Date(Date.now() - 3600_000), kumiPaymentId: null, kumiChargeId: null, email: null, description: "Court" });
const A = found(`pi_before_copy_${tag}`, 2500), B = found(`pi_after_copy_${tag}`, 4000);
const otherIncome = async (db: Db) => Number((await sql<{ c: string }>`SELECT coalesce(-sum(e.amount_cents), 0)::text AS c FROM ledger_entry e
  JOIN ledger_account a ON a.id = e.account_id WHERE a.kind = 'revenue' AND a.revenue_type = 'after_restore'`.execute(db)).rows[0]!.c);
const idOf = async (db: Db, ref: string) => (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", ref).executeTakeFirstOrThrow()).id;

before(async () => {
  const pool = new pg.Pool({ connectionString: ADMIN, max: 1 }); pool.on("error", () => {});
  admin = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`CREATE DATABASE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  await migrate(live);
  setPaymentProvider(stripe);
  const s = await runAsSystem(live, "club.setup", { name: "Rev Padel", time_zone: "America/Los_Angeles", owner_email: "owner@example.test", owner_name: "Olu Owner" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  // A is found before the copy is made, still to decide in it.
  await noteFound(live, A, null, new Date(), { tell: false });
  await live.destroy();
  await sql.raw(`CREATE DATABASE ${COPY} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // ---- after the copy: A kept, B found and kept ----
  await run(live, "payment_found.paid_elsewhere", { id: await idOf(live, A.ref), books: "income" }, owner);
  await noteFound(live, B, null, new Date(), { tell: false });
  await run(live, "payment_found.paid_elsewhere", { id: await idOf(live, B.ref), books: "income" }, owner);
  assert.equal(await otherIncome(live), 6500);
});
after(async () => {
  setPaymentProvider(new TestProvider());
  await live.destroy();
  for (const d of [LIVE, COPY]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

test("after a restore to before they were kept: open again or found again, nothing counted by itself, each once when kept again", async () => {
  await afterRestore(urlFor(COPY), await readSentBefore(urlFor(LIVE)));
  const db = connect(urlFor(COPY));
  try {
    assert.equal(await otherIncome(db), 0, "the copy's books are from before either was kept");
    const a = await db.selectFrom("payment_found").select(["status", "booked_cents"]).where("provider_ref", "=", A.ref).executeTakeFirstOrThrow();
    assert.deepEqual(a, { status: "open", booked_cents: 0 }, "A is to decide again");
    // As the server starts after the restore: the provider has both since the copy; B is found again.
    stripe.intentsSince = [A, B];
    const m = await checkMoneyAfterRestore(db);
    assert.equal(m.found, 1, "B, found again; A was already listed");
    assert.equal(await otherIncome(db), 0, "nothing counted by itself");
    for (const ref of [A.ref, B.ref]) await run(db, "payment_found.paid_elsewhere", { id: await idOf(db, ref), books: "income" }, owner);
    assert.equal(await otherIncome(db), 6500, "each once");
    await assert.rejects(run(db, "payment_found.paid_elsewhere", { id: await idOf(db, A.ref), books: "income" }, owner), /changed/);
    await db.insertInto("restore_check").values({ since: new Date(Date.now() - 86400_000) } as any).execute();
    await checkMoneyAfterRestore(db);
    assert.equal(await otherIncome(db), 6500, "a later check counts nothing more");
  } finally { await db.destroy(); }
});

test("kept before the copy: the copy has it in its books already, and a check after the restore counts nothing more", async () => {
  // A copy made after both were kept (the live database itself, restored onto a fresh one).
  const LATER = `kumi_test_fib_later_${tag}`;
  await live.destroy();
  await sql.raw(`CREATE DATABASE ${LATER} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  try {
    await afterRestore(urlFor(LATER), await readSentBefore(urlFor(LIVE)));
    const db = connect(urlFor(LATER));
    try {
      assert.equal(await otherIncome(db), 6500);
      stripe.intentsSince = [A, B];
      assert.equal((await checkMoneyAfterRestore(db)).found, 0);
      assert.equal(await otherIncome(db), 6500);
    } finally { await db.destroy(); }
  } finally { await sql.raw(`DROP DATABASE IF EXISTS ${LATER} WITH (FORCE)`).execute(admin); }
});
