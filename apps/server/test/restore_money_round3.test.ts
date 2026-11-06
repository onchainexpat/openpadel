// Card money after a restore (the review's NEW-6 and NEW-7, kept as regression tests): what the provider took with no row here
// is found and kept for the staff, a webhook for it is noticed, and a payment paid after the copy is confirmed, not let go.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { checkMoneyAfterRestore, checkPayment, connect, expireHolds, lapseUnpaidPlaces, migrate, moneyHandlers, openPayment, processOutbox, reconcilePayments, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_rev3_live_${tag}`, COPY = `kumi_test_rev3_copy_${tag}`;
let admin: Kysely<any>, live: Db;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date();
const day = new Date(NOW.getTime() + 2 * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const P: Record<string, string> = {};
let owner: Actor, c1: string;
const as = (n: string): Actor => ({ personId: P[n]!, via: "test", lang: "en" });
const ids: Record<string, { payment_id: string; ref?: string; booking_id?: string; gift_card_id?: string }> = {};
async function pay(db: Db, paymentId: string, who: string) {
  await openPayment(db, paymentId, P[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  assert.equal(await checkPayment(db, paymentId, "test"), "succeeded");
  return ref;
}
const refunded = (ref: string) => [...stripe.refunds.values()].filter((r) => r.paymentRef === ref).reduce((n, r) => n + r.amountCents, 0);

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
  c1 = ((await run(live, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(live, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(live, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(live, "club.update", { court_bookings: true }, owner);
  await run(live, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor);
  for (const n of ["Ann", "Ben", "Cal"]) P[n] = ((await run(live, "person.create", { display_name: `${n} Test`, email: `${n.toLowerCase()}@example.test` }, owner)).result as { person_id: string }).person_id;
  // Before the copy: Ben holds a court and opens its card form (the payment row exists, pending).
  ids.ben = (await run(live, "booking.request", { court_id: c1, starts_at: at("10:00"), minutes: 90, pay: "whole", person_id: P.Ben }, as("Ben"))).result as any;
  await openPayment(live, ids.ben!.payment_id, P.Ben!);
  await live.destroy();
  await sql.raw(`CREATE DATABASE ${COPY} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // After the copy, on the club's database: Ben pays (confirmed); Ann books another court and pays; Ann buys a gift card.
  ids.ben!.ref = await pay(live, ids.ben!.payment_id, "Ben");
  ids.ann = (await run(live, "booking.request", { court_id: c1, starts_at: at("14:00"), minutes: 90, pay: "whole", person_id: P.Ann }, as("Ann"))).result as any;
  ids.ann!.ref = await pay(live, ids.ann!.payment_id, "Ann");
  ids.gift = (await run(live, "gift_card.buy", { person_id: P.Ann, cents: 5000, for_name: "Sam" }, as("Ann"))).result as any;
  ids.gift!.ref = await pay(live, ids.gift!.payment_id, "Ann");
  const st = async (id: string) => (await live.selectFrom("booking").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
  assert.deepEqual([await st(ids.ben!.booking_id!), await st(ids.ann!.booking_id!)], ["confirmed", "confirmed"]);
  assert.equal((await live.selectFrom("gift_card").select("status").where("id", "=", ids.gift!.gift_card_id!).executeTakeFirstOrThrow()).status, "active");
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, COPY]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

test("after the restore: what the provider took with no row here is kept for the staff, and a payment paid since is confirmed, not let go", async () => {
  const LATER = new Date(NOW.getTime() + 3 * 3600_000);   // the restore three hours on: Ben's hold has run out in the copy
  await afterRestore(urlFor(COPY), await readSentBefore(urlFor(LIVE)), LATER);
  const db = connect(urlFor(COPY));
  try {
    assert.equal((await db.selectFrom("restore_check").select("id").where("done_at", "is", null).execute()).length, 1, "the restore asks the server to check the provider when it starts");
    // main.ts at start, before any job: every pending payment asked about, then the provider's payments since the copy.
    await reconcilePayments(db, LATER, 500, { all: true });
    const m = await checkMoneyAfterRestore(db, LATER);
    // Then the jobs in their order: nothing of Ben's is let go.
    await lapseUnpaidPlaces(db, LATER); await expireHolds(db, LATER);
    await processOutbox(db, moneyHandlers); await processOutbox(db, moneyHandlers);
    const ben = await db.selectFrom("booking").select(["status"]).where("id", "=", ids.ben!.booking_id!).executeTakeFirstOrThrow();
    assert.equal(ben.status, "confirmed", "Ben paid after the copy: his court is his");
    assert.equal(refunded(ids.ben!.ref!), 0, "and nothing went back to his card");
    // Ann's booking and gift card: no rows in the copy; the money is kept for the staff, nothing refunded by itself.
    const found = await db.selectFrom("payment_found").select(["provider_ref", "amount_cents", "status"]).orderBy("amount_cents").execute();
    assert.deepEqual(found.map((f) => [f.provider_ref, f.status]).sort(), [[ids.ann!.ref, "open"], [ids.gift!.ref, "open"]].sort());
    assert.equal(m.found, 2);
    assert.equal(refunded(ids.ann!.ref!) + refunded(ids.gift!.ref!), 0, "nothing refunded by itself");
    const alerts = await db.selectFrom("event_outbox").select("id").where("topic", "=", "ops.failed").where(sql<string>`payload->>'job'`, "=", "restore_money").execute();
    assert.ok(alerts.length >= 1, "the owner and managers hear");
    // A webhook for Ann's intent at the restored server: noticed (already kept), not a silent 200.
    const WHSEC = "whsec_rev3";
    const app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false, stripe: { publishableKey: "pk_test_x", webhookSecret: WHSEC } });
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: ids.ann!.ref, object: "payment_intent", amount: 6000, amount_received: 6000, created: Math.floor(Date.now() / 1000), metadata: { kumi_payment_id: ids.ann!.payment_id } } } });
    const t = Math.floor(Date.now() / 1000), sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}`;
    const said: string[] = [], keep = { warn: console.warn };
    console.warn = (...x: unknown[]) => { said.push(x.map(String).join(" ")); };
    try { const res = await app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body }); assert.equal(res.status, 200); }
    finally { console.warn = keep.warn; }
    assert.ok(said.some((l) => l.includes("no payment here records it")), "the webhook says so");
    // The staff refund one in full: once, through the outbox, under its own id.
    const one = (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", ids.gift!.ref!).executeTakeFirstOrThrow()).id;
    await run(db, "payment_found.refund", { id: one }, { ...owner, auth: "passkey" } as Actor);
    await processOutbox(db, moneyHandlers);
    assert.equal(refunded(ids.gift!.ref!), 5000);
    assert.equal((await db.selectFrom("payment_found").select("status").where("id", "=", one).executeTakeFirstOrThrow()).status, "refunded");
    await assert.rejects(run(db, "payment_found.refund", { id: one }, { ...owner, auth: "passkey" } as Actor), /changed/);
    assert.equal((await db.selectFrom("restore_check").select("id").where("done_at", "is", null).execute()).length, 0, "checked once");
  } finally { await db.destroy(); }
});
