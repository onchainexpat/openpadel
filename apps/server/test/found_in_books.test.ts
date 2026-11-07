// "Record as paid elsewhere" counts in the books (Kelly, 6 Nov 2026). A card payment the provider took that nothing
// here records (found after a restore), kept by the staff, is other income on the day it was paid, so Kumi's revenue
// matches the provider's: once, even asked twice at the same moment; "Refund it" is refused after it; a refund the
// provider made of it takes its part back out (once each), and one seen before it was kept means only what's left
// counts; a payment Kumi records for it later takes the rest out, so it never counts twice; one in another currency
// stays out of the books. Reports shows it on a line of its own, and its download has a column for it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { plainAmount } from "@kumi/i18n";
import { checkMoneyAfterRestore, localDate, noteFound, plan, reviewFound, run, runAsSystem, setPaymentProvider, TestProvider, uuidv7, type Actor, type Db, type FoundIntent, type FoundRefund } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

/** What the provider has since a backup: set by each test. */
class Listing extends TestProvider {
  intentsSince: FoundIntent[] = [];
  refundsSince: FoundRefund[] = [];
  override async listSince() { return { intents: this.intentsSince, refunds: this.refundsSince }; }
}
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, cookie: string;
const stripe = new Listing(), mailer = new MemoryMailer(), TZ = "America/Los_Angeles";
const PAID = new Date(Date.now() - 2 * 86400_000), PAID_DAY = localDate(PAID, TZ), TODAY = localDate(new Date(), TZ);
let n = 0;
const found = (amountCents: number, o: Partial<FoundIntent> = {}): FoundIntent =>
  ({ ref: `pi_found_${++n}_${uuidv7().slice(-8)}`, status: "succeeded", amountCents, created: PAID, kumiPaymentId: null, kumiChargeId: null, email: "someone@example.test", description: "Court", ...o });
async function keep(it: FoundIntent) {
  await noteFound(db, it, null, new Date(), { tell: false });
  return (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", it.ref).executeTakeFirstOrThrow()).id;
}
const row = (id: string) => db.selectFrom("payment_found").select(["status", "booked_cents"]).where("id", "=", id).executeTakeFirstOrThrow();
/** Other income in the books: what found payments kept as paid elsewhere count. */
const otherIncome = async () => Number((await sql<{ c: string }>`SELECT coalesce(-sum(e.amount_cents), 0)::text AS c FROM ledger_entry e
  JOIN ledger_account a ON a.id = e.account_id WHERE a.kind = 'revenue' AND a.revenue_type = 'after_restore'`.execute(db)).rows[0]!.c);
const get = async (path: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, text: await r.text() }; };
async function restoreCheck() {
  await db.insertInto("restore_check").values({ since: new Date(Date.now() - 30 * 86400_000) } as any).execute();
  return checkMoneyAfterRestore(db);
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  loc = ((await run(db, "location.create", { name: "East", time_zone: TZ }, owner)).result as any).location_id;
  await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => { setPaymentProvider(new TestProvider()); await drop(); });

test("kept as paid elsewhere: other income once, on the day it was paid, even asked twice at once; Reports and its download show it", async () => {
  const id = await keep(found(2500));
  const p = await plan(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.match(p.plan.summary.en, /^Record \$25\.00 as paid for something put right by hand, and keep it, counted as income: it's added to the books as other income on the day it was paid/);
  assert.match(p.plan.summary.es, /contado como ingreso: se anota en la contabilidad como otros ingresos/);
  const before = await otherIncome();
  const both = await Promise.allSettled([run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner), run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner)]);
  assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"], "one keeps it; the other finds it changed");
  assert.match(String((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /changed/);
  assert.equal(await otherIncome() - before, 2500, "counted once");
  assert.deepEqual(await row(id), { status: "handled", booked_cents: 2500 });
  await assert.rejects(run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner), /changed/, "and not again later");
  assert.equal(await otherIncome() - before, 2500);
  // On the day it was paid, apart from the other lines; the download has its own column.
  const r = JSON.parse((await get(`/staff/reports?location_id=${loc}&from=${PAID_DAY}&to=${TODAY}`)).text) as { rows: Array<Record<string, any>> };
  const day = r.rows.find((x) => x.date === PAID_DAY)!;
  assert.equal(day.found_revenue_cents, 2500);
  assert.equal(day.court_revenue_cents, 0, "not counted as courts");
  assert.equal(r.rows.filter((x) => x.date !== PAID_DAY).reduce((s, x) => s + x.found_revenue_cents, 0), 0);
  const csv = (await get(`/staff/reports.csv?location_id=${loc}&from=${PAID_DAY}&to=${PAID_DAY}`)).text.trim().split("\r\n");
  assert.equal(csv[0]!.split(",").at(-1), "card payments recorded after a restore");
  assert.equal(csv[1]!.split(",").at(-1), plainAmount(2500));
});

test("\"Refund it\" after it was kept is refused, and nothing leaves the books or the provider", async () => {
  const id = await keep(found(1800));
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  const before = await otherIncome();
  await assert.rejects(plan(db, "payment_found.refund", { id }, owner), /changed/);
  await assert.rejects(run(db, "payment_found.refund", { id }, owner), /changed/);
  assert.equal(await otherIncome(), before);
  assert.equal([...stripe.refunds.values()].length, 0, "no refund asked of the provider");
});

test("a refund the provider made of it since takes its part back out of the books, once", async () => {
  const it = found(4000), id = await keep(it);
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  const before = await otherIncome();
  stripe.intentsSince = [it];
  stripe.refundsSince = [{ ref: `re_${uuidv7().slice(-10)}`, paymentRef: it.ref, amountCents: 1500, ok: true, created: new Date(), kumiRefundId: null }];
  assert.equal((await restoreCheck()).refunds, 1);
  assert.equal(before - await otherIncome(), 1500, "$15.00 of $40.00 out");
  assert.deepEqual(await row(id), { status: "handled", booked_cents: 2500 });
  assert.equal((await restoreCheck()).refunds, 0, "the same refund seen again takes nothing more");
  assert.equal(before - await otherIncome(), 1500);
  // A second refund for more than is left takes only what's left.
  stripe.refundsSince.push({ ref: `re_${uuidv7().slice(-10)}`, paymentRef: it.ref, amountCents: 9000, ok: true, created: new Date(), kumiRefundId: null });
  assert.equal((await restoreCheck()).refunds, 1);
  assert.equal(before - await otherIncome(), 4000, "never below nothing");
  assert.deepEqual(await row(id), { status: "handled", booked_cents: 0 });
  stripe.intentsSince = []; stripe.refundsSince = [];
});

test("a refund seen before it's kept: keeping it counts only what's left", async () => {
  const it = found(3000), id = await keep(it);
  stripe.intentsSince = [it];
  stripe.refundsSince = [{ ref: `re_${uuidv7().slice(-10)}`, paymentRef: it.ref, amountCents: 1000, ok: true, created: new Date(), kumiRefundId: null }];
  const before = await otherIncome();
  assert.equal((await restoreCheck()).refunds, 0, "nothing in the books yet to take out");
  assert.equal(await otherIncome(), before);
  const p = await plan(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.match(p.plan.summary.en, /^Record \$20\.00 as paid/);
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.equal(await otherIncome() - before, 2000);
  stripe.intentsSince = []; stripe.refundsSince = [];
});

test("Kumi records a payment for it later (its own charge made again by its key): it comes out of other income, never counted twice", async () => {
  const it = found(9000, { kumiChargeId: `renew:${uuidv7()}:x:0`, description: "Membership renewal" }), id = await keep(it);
  assert.equal((await row(id)).status, "waiting");
  await reviewFound(db, new Date(Date.now() + 16 * 60_000));
  assert.equal((await row(id)).status, "open", "listed for the staff after the jobs had their time");
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  const kept = await otherIncome();
  await db.insertInto("payment").values({ id: uuidv7(), person_id: owner.personId!, amount_cents: 9000, method: "card", provider: "test", provider_ref: it.ref, status: "succeeded" } as any).execute();
  const r = await reviewFound(db, new Date(Date.now() + 17 * 60_000));
  assert.equal(r.recorded, 1);
  assert.equal(kept - await otherIncome(), 9000, "all of it out: the payment Kumi records counts it");
  assert.deepEqual(await row(id), { status: "recorded", booked_cents: 0 });
  assert.equal((await reviewFound(db, new Date(Date.now() + 18 * 60_000))).recorded, 0, "once");
  assert.equal(kept - await otherIncome(), 9000);
});

test("one paid in another currency than the club's stays out of the books, and the staff are told so", async () => {
  const id = await keep(found(5000, { currency: "EUR" }));
  const p = await plan(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.match(p.plan.summary.en, /another currency than the club's \(USD\), so it isn't added to the books/);
  assert.match(p.plan.summary.en, /€50\.00/);
  const before = await otherIncome();
  await run(db, "payment_found.paid_elsewhere", { id, books: "income" }, owner);
  assert.equal(await otherIncome(), before);
  assert.deepEqual(await row(id), { status: "handled", booked_cents: 0 });
  // The provider's currency is kept as it said it: one in the club's own counts.
  const usd = await keep(found(700, { currency: "usd" }));
  assert.equal((await db.selectFrom("payment_found").select("currency").where("id", "=", usd).executeTakeFirstOrThrow()).currency, "USD");
  await run(db, "payment_found.paid_elsewhere", { id: usd, books: "income" }, owner);
  assert.equal(await otherIncome() - before, 700);
});
