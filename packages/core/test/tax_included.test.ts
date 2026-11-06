// Prices that include tax (prices.ts, lessons.ts, receipts.ts): the price is the total and the tax the part the
// rate makes up; the US way (tax on top) is unchanged. Receipts keep how they were taxed and say "Of which VAT (21%)".
// Places, memberships, passes and gift cards stay untaxed as before; promo codes and refunds take the tax in share.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { setClubFormat } from "@kumi/i18n";
import { checkPayment, issueReceipts, openPayment, quote, receiptParams, receiptsOf, receiptView, run, runAsSystem, setPaymentProvider, taxSplit, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, loc: string;
const stripe = new TestProvider(), TZ = "Europe/Madrid", NOW = new Date("2026-11-05T09:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, paymentId, "test"), "succeeded");
}
const book = async (who: string, hhmm: string, day = "2026-11-12") =>
  (await run(db, "booking.request", { court_id: court, starts_at: `${day}T${hhmm}:00+01:00`, minutes: 60, person_id: people[who], pay: "whole" }, as(who), opts)).result as { booking_id: string; payment_id: string };

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: TZ, owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  for (const name of ["Ann", "Ben", "Cal"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  loc = ((await run(db, "location.create", { name: "Centro", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Pista 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Tarifa", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true, currency: "EUR", format_locale: "es-ES", tax_rate_bp: 2100, prices_include_tax: true, tax_label: "VAT" }, owner, opts);
});
after(async () => { setClubFormat({ currency: "USD", locale: "en-US" }); await drop(); });

test("the split: on top the US way, inside the price where it's included, nothing at 0%", () => {
  assert.deepEqual(taxSplit(4000, 2100, false), { net: 4000, tax: 840, total: 4840 });
  assert.deepEqual(taxSplit(4000, 2100, true), { net: 3306, tax: 694, total: 4000 });
  assert.deepEqual(taxSplit(4000, 0, true), { net: 4000, tax: 0, total: 4000 });
  assert.deepEqual(taxSplit(1, 2100, true), { net: 1, tax: 0, total: 1 });
});

test("a court priced with tax included costs its price, and its receipt says the VAT it holds", async () => {
  const q = await quote(db, { courtId: court, start: new Date("2026-11-12T10:00:00+01:00"), minutes: 60 });
  assert.deepEqual([q.total_cents, q.tax_cents, q.subtotal_cents], [4000, 694, 3306]);
  const b = await book("Ann", "10:00");
  assert.equal((await db.selectFrom("payment").select("amount_cents").where("id", "=", b.payment_id).executeTakeFirstOrThrow()).amount_cents, 4000);
  await pay(b.payment_id, "Ann");
  await issueReceipts(db, { now: NOW });
  const [r] = await receiptsOf(db, people.Ann!);
  const v = (await receiptView(db, r!.id))!;
  assert.equal(v.tax_included, true);
  assert.equal(v.tax_rate?.en, "21\u00a0%");   // written as the club writes numbers (Spain: "21 %")
  assert.equal((await db.selectFrom("receipt").select(["tax_cents", "total_cents"]).where("id", "=", r!.id).executeTakeFirstOrThrow()).tax_cents, 694);
  const p = (await receiptParams(db, r!.id))!;
  assert.equal((p.params.subtotal as { en: string }).en, "");
  assert.match((p.params.included as { en: string }).en, /^Of which VAT \(21\s%\): 6,94\s€/);   // amounts the club's way, words in English
  // The line is written when read: switch the club's formats and the same receipt follows (a stored line keeps its key
  // and the booking's start, not text from the day it was issued).
  const before = v.lines[0]!.what.en;
  setClubFormat({ currency: "EUR", locale: "en-US" });
  try {
    const after = (await receiptView(db, r!.id))!.lines[0]!.what.en;
    assert.notEqual(after, before, "the date follows the club's formats when read");
    assert.match(after, /(AM|PM)/);
  } finally { setClubFormat({ currency: "EUR", locale: "es-ES" }); }
});

test("a promo code takes its share of the tax, and the US way is unchanged when switched back", async () => {
  await run(db, "promo_code.set", { code: "HALF", kind: "percent", percent: 50, applies_to: ["courts"] }, owner, opts);
  const b = await book("Ben", "12:00");
  const used = (await run(db, "payment.use_promo", { payment_id: b.payment_id, code: "HALF" }, as("Ben"), opts)).result as { payment_id: string };
  await pay(used.payment_id, "Ben");
  await issueReceipts(db, { now: NOW });
  const [r] = await receiptsOf(db, people.Ben!);
  const row = await db.selectFrom("receipt").select(["tax_cents", "total_cents", "tax_included"]).where("id", "=", r!.id).executeTakeFirstOrThrow();
  assert.deepEqual([row.total_cents, row.tax_cents, row.tax_included], [2000, 347, true]);
  await run(db, "club.update", { prices_include_tax: false, tax_label: null }, owner, opts);
  const q = await quote(db, { courtId: court, start: new Date("2026-11-13T10:00:00+01:00"), minutes: 60 });
  assert.deepEqual([q.total_cents, q.tax_cents], [4840, 840]);
  // A receipt already given keeps how it was taxed.
  assert.equal((await receiptView(db, r!.id))!.tax_included, true);
});

test("a program place stays untaxed, either way", async () => {
  await run(db, "club.update", { prices_include_tax: true }, owner, opts);
  const program = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Iniciación", capacity: 8, price_cents: 2500 }, owner, opts)).result as any).program_id;
  await run(db, "program.publish", { program_id: program }, owner, opts);
  const j = (await run(db, "enrolment.join", { program_id: program, person_id: people.Cal }, as("Cal"), opts)).result as { payment_id: string };
  await pay(j.payment_id, "Cal");
  await issueReceipts(db, { now: NOW });
  const [r] = await receiptsOf(db, people.Cal!);
  assert.equal((await db.selectFrom("receipt").select("tax_cents").where("id", "=", r!.id).executeTakeFirstOrThrow()).tax_cents, 0);
  assert.equal((await receiptParams(db, r!.id))!.params.included.en, "");
});
