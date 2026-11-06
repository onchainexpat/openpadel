// After a restore, the last round (payments_after_restore.ts): Kumi's own charges are never refunded as unknown, a
// refund made after the backup gives nothing more by the rule, and the staff hear once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { checkMoneyAfterRestore, reviewFound, refundedStillBooked, checkPayment, connect, eraseAfterRestore, expireHolds, lapseUnpaidPlaces, migrate, moneyHandlers, openPayment, plan, processOutbox, reconcilePayments, run, runAsSystem, setPaymentProvider, TestProvider, uuidv7, type Actor, type Db } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";
import { startEmailSignIn, verifyEmailCode } from "../src/auth.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_r4_live_${tag}`, COPY = `kumi_test_r4_copy_${tag}`;
let admin: Kysely<any>, live: Db;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date();
const day = new Date(NOW.getTime() + 2 * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const P: Record<string, string> = {};
let owner: Actor, c1: string;
const as = (n: string): Actor => ({ personId: P[n]!, via: "test", lang: "en" });
const X: Record<string, any> = {};
async function pay(db: Db, paymentId: string, who: string) {
  await openPayment(db, paymentId, P[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  assert.equal(await checkPayment(db, paymentId, "test"), "succeeded");
  return ref;
}
const refunded = (ref: string) => [...stripe.refunds.values()].filter((r) => r.paymentRef === ref).reduce((n, r) => n + r.amountCents, 0);
async function signIn(db: Db, email: string) {
  const mailer = new MemoryMailer();
  await startEmailSignIn(db, mailer, email, "en", new Date());
  const code = /\b(\d{6})\b/.exec(`${mailer.sent[0]?.subject ?? ""} ${mailer.sent[0]?.text ?? ""}`)?.[1];
  if (!code) return "no code sent";
  const r = await verifyEmailCode(db, email, code, null, new Date()).catch((e) => ({ error: String(e) }));
  return "personId" in r ? Object.entries(P).find(([, id]) => id === r.personId)?.[0] ?? r.personId : JSON.stringify(r);
}

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
  P.Olu = owner.personId!;
  const loc = ((await run(live, "location.create", { name: "East", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(live, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(live, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(live, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(live, "club.update", { court_bookings: true }, owner);
  await run(live, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor);
  await sql`UPDATE booking_policy SET free_cancel_hours = 200, late_refund_percent = 50`.execute(live);
  for (const n of ["Ann", "Ben", "Cal", "Dan", "Vic", "Pam"]) P[n] = ((await run(live, "person.create", { display_name: `${n} Test`, email: `${n.toLowerCase()}@example.test` }, owner)).result as { person_id: string }).person_id;
  const book = async (who: string, hhmm: string) => (await run(live, "booking.request", { court_id: c1, starts_at: at(hhmm), minutes: 90, pay: "whole", person_id: P[who] }, as(who))).result as any;
  X.ann = await book("Ann", "08:00"); X.ann.ref = await pay(live, X.ann.payment_id, "Ann");
  X.dan = await book("Dan", "10:00"); X.dan.ref = await pay(live, X.dan.payment_id, "Dan");
  X.ben = await book("Ben", "16:00"); await openPayment(live, X.ben.payment_id, P.Ben!);
  // Vic: the attacker's address on the account when the copy was made.
  await live.updateTable("person").set({ email: "attacker@example.test" }).where("id", "=", P.Vic!).execute();
  await live.deleteFrom("auth_identity").where("person_id", "=", P.Vic!).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P.Vic!, kind: "email", value: "attacker@example.test", verified_at: new Date() }).execute();
  // Pam signs in by phone only: no email identity, an email field.
  await live.deleteFrom("auth_identity").where("person_id", "=", P.Pam!).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P.Pam!, kind: "phone", value: "+14155550177", verified_at: new Date() }).execute();
  await live.destroy();
  await sql.raw(`CREATE DATABASE ${COPY} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // ---- after the copy ----
  await run(live, "booking.cancel", { booking_id: X.ann.booking_id }, as("Ann"));
  await run(live, "booking.cancel", { booking_id: X.dan.booking_id }, as("Dan"));
  await processOutbox(live, moneyHandlers);
  assert.deepEqual([refunded(X.ann.ref), refunded(X.dan.ref)], [3000, 3000]);
  await live.insertInto("erase_after_restore").values({ person_id: P.Ann!, redacted_at: new Date(), deleted_by: "self" } as any).execute();
  assert.equal((await eraseAfterRestore(live)).erased, 1);
  X.ben.ref = await pay(live, X.ben.payment_id, "Ben");
  X.cal = await book("Cal", "12:00"); X.cal.ref = await pay(live, X.cal.payment_id, "Cal");
  X.gift = (await run(live, "gift_card.buy", { person_id: P.Cal, cents: 5000, for_name: "Sam" }, as("Cal"))).result as any; X.gift.ref = await pay(live, X.gift.payment_id, "Cal");
  await live.updateTable("person").set({ email: "vic@example.test" }).where("id", "=", P.Vic!).execute();
  await live.deleteFrom("auth_identity").where("person_id", "=", P.Vic!).execute();
  await live.insertInto("auth_identity").values({ id: uuidv7(), person_id: P.Vic!, kind: "email", value: "vic@example.test", verified_at: new Date() }).execute();
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, COPY]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

const alerts = async (db: Db) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM event_outbox WHERE topic = 'ops.failed' AND payload->>'job' = 'restore_money'`.execute(db)).rows[0]!.n);

test("after a restore: Kumi's own charges wait and close as recorded, a refund since gives nothing more by the rule, one alert", async () => {
  await afterRestore(urlFor(COPY), await readSentBefore(urlFor(LIVE)));
  const db = connect(urlFor(COPY));
  const ownerApp = { ...owner, auth: "passkey" } as Actor;
  try {
    await reconcilePayments(db, new Date(), 500, { all: true });
    // A renewal Kumi charged after the backup, by its key: listed with kumi_charge_id only.
    const ref = `pi_test_${randomBytes(6).toString("hex")}`;
    stripe.intents.set(ref, { amountCents: 9000, description: "Membership renewal", status: "succeeded", clientSecret: "x", created: new Date(), metadata: { kumi_charge_id: `renew:${uuidv7()}:x:0` } });
    const m = await checkMoneyAfterRestore(db);
    assert.equal(m.found, 2, "Cal's booking and gift card, not the renewal");
    const renewal = await db.selectFrom("payment_found").selectAll().where("provider_ref", "=", ref).executeTakeFirstOrThrow();
    assert.deepEqual([renewal.kind, renewal.status], ["kumi_charge", "waiting"], "Kumi's own charge waits for the jobs");
    assert.equal(await alerts(db), 1, "one alert for the restore");
    // The renewal job records it: closed as recorded, never refundable here.
    await db.insertInto("payment").values({ id: uuidv7(), person_id: P.Ben!, amount_cents: 9000, method: "card", provider: "test", provider_ref: ref, status: "succeeded" } as any).execute();
    assert.deepEqual(await reviewFound(db), { recorded: 1, opened: 0 });
    await assert.rejects(run(db, "payment_found.refund", { id: renewal.id }, ownerApp), /changed/);
    assert.equal(refunded(ref), 0);
    // An open one whose row appears later (a webhook that came in): refused before, and caught again at send time.
    const cal = await db.selectFrom("payment_found").select("id").where("provider_ref", "=", X.cal.ref).executeTakeFirstOrThrow();
    await run(db, "payment_found.refund", { id: cal.id }, ownerApp);
    await db.insertInto("payment").values({ id: uuidv7(), person_id: P.Cal!, amount_cents: 6000, method: "card", provider: "test", provider_ref: X.cal.ref, status: "succeeded" } as any).execute();
    await processOutbox(db, moneyHandlers);
    assert.equal(refunded(X.cal.ref), 0, "a payment Kumi records by now is never refunded as unknown");
    assert.equal((await db.selectFrom("payment_found").select("status").where("id", "=", cal.id).executeTakeFirstOrThrow()).status, "recorded");
    const gift = await db.selectFrom("payment_found").select("id").where("provider_ref", "=", X.gift.ref).executeTakeFirstOrThrow();
    await db.insertInto("payment").values({ id: uuidv7(), person_id: P.Cal!, amount_cents: 5000, method: "card", provider: "test", provider_ref: X.gift.ref, status: "succeeded" } as any).execute();
    await assert.rejects(plan(db, "payment_found.refund", { id: gift.id }, ownerApp), /nothing to refund here/);
    // A charge of Kumi's that no row ever appears for: listed for the staff after the jobs have had their time.
    const lone = `pi_test_${randomBytes(6).toString("hex")}`;
    stripe.intents.set(lone, { amountCents: 4000, description: "Weekly court", status: "succeeded", clientSecret: "x", created: new Date(), metadata: { kumi_charge_id: `week:${uuidv7()}` } });
    await db.insertInto("restore_check").values({ since: new Date(Date.now() - 60_000) } as any).execute();
    await checkMoneyAfterRestore(db);
    assert.deepEqual(await reviewFound(db, new Date(Date.now() + 16 * 60_000)), { recorded: 1, opened: 1 }, "the gift card, recorded by now, closes; the lone charge opens");
    assert.equal(await alerts(db), 1, "still the one alert: later ones join the list");
    // Dan cancelled after the backup and was refunded $30 of $60 (50% late): here the booking is back, still booked.
    const still = await refundedStillBooked(db);
    assert.deepEqual(still.bookings.map((b) => b.amount_cents), [3000], "listed for the staff");
    const again = await plan(db, "booking.cancel", { booking_id: X.dan.booking_id }, as("Dan"));
    assert.match(again.plan.summary.en, /Nothing more comes back by the club's rule/);
    await run(db, "booking.cancel", { booking_id: X.dan.booking_id }, as("Dan"));
    await processOutbox(db, moneyHandlers);
    assert.equal(refunded(X.dan.ref), 3000, "no $15 more on a $60 booking under a 50% rule");
  } finally { await db.destroy(); }
});
