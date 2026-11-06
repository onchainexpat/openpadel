// Club credit and gift cards over a restore (after_restore.ts GONE gifts, credit, tries): credit paid out at the desk
// after the copy was made can't be paid out again from the copy, and a gift card redeemed since can't be redeemed
// again (its value stays in the redeemer's credit). Real databases: the copy (made first) and the one it replaces.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { connect, creditBalance, giftCodeHash, migrate, runAsSystem, uuidv7, type Db } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_rm_live_${tag}`, COPY = `kumi_test_rm_copy_${tag}`;
let admin: Kysely<any>, live: Db;
const ann = uuidv7(), bo = uuidv7(), card = uuidv7(), CODE = "GIFT-AAAA-BBBB-CCCC";

async function account(db: Db, kind: string, personId: string | null) {
  const got = await db.selectFrom("ledger_account").select("id").where("kind", "=", kind).where("person_id", personId === null ? "is" : "=", personId as any).where("revenue_type", "is", null).executeTakeFirst();
  if (got) return got.id;
  const id = uuidv7(); await db.insertInto("ledger_account").values({ id, kind: kind as any, person_id: personId }).execute(); return id;
}
async function post(db: Db, kind: string, entries: Array<[string, number]>) {
  const run = uuidv7(), txn = uuidv7();
  await sql`INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${run}, 'test.money', 1, 'test', '{}', '{}', 'applied', 'none', '{}', now(), now())`.execute(db);
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("ledger_txn").values({ id: txn, kind, action_run_id: run, memo: kind }).execute();
    await trx.insertInto("ledger_entry").values(entries.map(([account_id, cents]) => ({ txn_id: txn, account_id, amount_cents: String(cents) }))).execute();
  });
  return run;
}

before(async () => {
  const pool = new pg.Pool({ connectionString: ADMIN, max: 1 }); pool.on("error", () => {});
  admin = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`CREATE DATABASE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  await migrate(live);
  await runAsSystem(live, "club.setup", { name: "Rook Padel", time_zone: "America/Los_Angeles", owner_email: "owner@example.test", owner_name: "Olu Rook" }, "setup");
  for (const [id, name] of [[ann, "Ann"], [bo, "Bo"]] as const) await live.insertInto("person").values({ id, display_name: `${name} Rook`, email: `${name}@example.test`, created_via: "desk" }).execute();
  // Ann has $50 of club credit (a refund given as credit); Bo bought a $40 gift card at the desk, not yet redeemed.
  const annCredit = await account(live, "member_credit", ann), adj = await account(live, "adjustment", null), drawer = await account(live, "cash_drawer", null), cards = await account(live, "gift_cards", null);
  await post(live, "refund", [[annCredit, -5000], [adj, 5000]]);
  await post(live, "gift_card_sold", [[cards, -4000], [drawer, 4000]]);
  await live.insertInto("gift_card").values({ id: card, code_hash: giftCodeHash(CODE), code_sealed: "sealed", last4: "CCCC", amount_cents: 4000, buyer_id: bo, sold_via: "desk", status: "active" }).execute();
  await live.insertInto("gift_card_try").values({ person_id: bo }).execute();
  await live.destroy();
  await sql.raw(`CREATE DATABASE ${COPY} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // Then: Ann's $50 is paid out at the desk in cash, and Bo redeems the card into his own credit.
  const runId = await post(live, "credit_payout", [[annCredit, 5000], [drawer, -5000]]);
  await live.insertInto("credit_payout").values({ id: uuidv7(), person_id: ann, amount_cents: 5000, method: "cash", action_run_id: runId }).execute();
  await post(live, "gift_card_redeemed", [[cards, 4000], [await account(live, "member_credit", bo), -4000]]);
  await live.updateTable("gift_card").set({ status: "redeemed", redeemed_by: bo, redeemed_at: new Date() }).where("id", "=", card).execute();
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, COPY]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

test("a restore to before a pay-out and a redemption: neither can happen twice, and nobody's credit is made up", async () => {
  const db = connect(urlFor(COPY));
  try {
    assert.equal(await creditBalance(db, ann), 5000, "the copy still has Ann's $50 (what a restore would bring back)");
    assert.equal((await db.selectFrom("gift_card").select("status").where("id", "=", card).executeTakeFirstOrThrow()).status, "active");
    await afterRestore(urlFor(COPY), await readSentBefore(urlFor(LIVE)));
    assert.equal(await creditBalance(db, ann), 0, "the $50 handed over can't be paid out again");
    const c = await db.selectFrom("gift_card").select(["status", "redeemed_by"]).where("id", "=", card).executeTakeFirstOrThrow();
    assert.deepEqual([c.status, c.redeemed_by], ["redeemed", bo], "a redeemed code stays redeemed");
    assert.equal(await creditBalance(db, bo), 4000, "and its value is in the redeemer's credit, as it was");
    assert.equal((await db.selectFrom("gift_card_try").select("id").execute()).length, 0, "wrong tries start again");
    // The books still balance (each carried move is its own transaction of two sides).
    const sum = (await sql<{ s: string }>`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_entry`.execute(db)).rows[0]!.s;
    assert.equal(sum, "0");
    // Again: nothing more moves.
    await afterRestore(urlFor(COPY), await readSentBefore(urlFor(LIVE)));
    assert.deepEqual([await creditBalance(db, ann), await creditBalance(db, bo)], [0, 4000]);
  } finally { await db.destroy(); }
});
