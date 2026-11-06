// The review of the groundwork for clubs outside the US (5 Nov 2026): phones read in the club's country first,
// a share's receipt taxed on its own amount at the rate it was sold at, the meter in US dollars, amounts shown the
// way they're typed, only the club's own currency read, a country kept once Stripe has an account, Stripe's
// two-decimal whole-unit currencies refused, limits sized for each currency.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "./helpers.ts";
import { setClubFormat, money, parseAmount, amountInput, capFor, currencyProblem, minorUnits } from "@kumi/i18n";
import { anyPhone, textablePhone, checkPayment, issueReceipts, openPayment, plan, receiptParams, receiptsOf, run, runAsSystem, setPaymentProvider, taxSplit, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string;
const stripe = new TestProvider(), TZ = "Europe/Madrid", NOW = new Date("2026-11-05T09:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, paymentId, "test"), "succeeded");
}
before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Club", time_zone: TZ, owner_email: "o@example.test", owner_name: "Owner" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  for (const name of ["Ann", "Ben"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  const loc = ((await run(db, "location.create", { name: "Centro", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Pista 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Tarifa", cents_per_hour: 1000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true, currency: "EUR", format_locale: "es-ES", tax_rate_bp: 2100, prices_include_tax: true, tax_label: "VAT" }, owner, opts);
});
after(async () => { setClubFormat({ currency: "USD", locale: "en-US", country: "US" }); await drop(); });

test("a phone typed the local way is read in the club's country: a Mexican number never becomes a US one", () => {
  for (const [country, typed, local] of [["MX", "55 1234 5678", "+525512345678"], ["MX", "33 1234 5678", "+523312345678"], ["AR", "351 234 5678", "+543512345678"], ["ES", "612 345 678", "+34612345678"]] as const) {
    assert.equal(textablePhone(typed, country), null, `${country} ${typed} isn't texted (it isn't a US or Canadian number)`);
    assert.equal(anyPhone(typed, country), local);
  }
  assert.equal(textablePhone("(503) 555-0123", "US"), "+15035550123", "a US club reads US numbers as before");
  assert.equal(textablePhone("416 555 0123", "CA"), "+14165550123");
  assert.equal(textablePhone("+1 503 555 0123", "MX"), "+15035550123", "typed with +1, a US number is a US number anywhere");
  assert.equal(textablePhone("+52 55 1234 5678", "US"), null);
});

test("a share's receipt states the VAT on its own amount: a quarter of a €10 court at 21% is €0.43", async () => {
  const r = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T10:00:00+01:00", minutes: 60, pay: "split", players: 4, person_id: people.Ann }, as("Ann"), opts)).result as any;
  const p = await db.selectFrom("payment").select("amount_cents").where("id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.equal(p.amount_cents, 250);
  await pay(r.payment_id, "Ann"); await issueReceipts(db, { now: NOW });
  const [rc] = await receiptsOf(db, people.Ann!);
  const row = await db.selectFrom("receipt").select(["total_cents", "tax_cents", "tax_bp", "tax_included"]).where("id", "=", rc!.id).executeTakeFirstOrThrow();
  assert.deepEqual(row, { total_cents: 250, tax_cents: taxSplit(250, 2100, true).tax, tax_bp: 2100, tax_included: true });
  assert.equal(row.tax_cents, 43);
});

test("a receipt keeps the rate and mode the booking was sold at, though the club's changed since", async () => {
  const r = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-12T12:00:00+01:00", minutes: 60, pay: "whole", person_id: people.Ben }, as("Ben"), opts)).result as any;
  await run(db, "club.update", { tax_rate_bp: 1000 }, owner, opts);
  await pay(r.payment_id, "Ben"); await issueReceipts(db, { now: NOW });
  const [rc] = await receiptsOf(db, people.Ben!);
  const row = await db.selectFrom("receipt").select(["total_cents", "tax_cents", "tax_bp", "tax_included"]).where("id", "=", rc!.id).executeTakeFirstOrThrow();
  assert.deepEqual(row, { total_cents: 1000, tax_cents: 174, tax_bp: 2100, tax_included: true });
  const printed = (await receiptParams(db, rc!.id))!.params.included as { en: string };
  assert.match(printed.en, /21\s?%/);
  await run(db, "club.update", { tax_rate_bp: 2100 }, owner, opts);
});

test("the meter is in US dollars in any club, and its alerts say so", async () => {
  setClubFormat({ currency: "JPY", locale: "ja-JP" });
  await runAsSystem(db, "club.usage_alert", { level: "near", spent_cents: 1234, cap_cents: 5000, over_cents: 0, month: "2026-11-01" }, "test");
  const row = await db.selectFrom("action_run").select("plan").where("action", "=", "club.usage_alert").orderBy("id", "desc").executeTakeFirstOrThrow();
  const summary = (row.plan as { summary: { en: string } }).summary.en;
  assert.match(summary, /\$12\.34/);
  assert.doesNotMatch(summary, /¥|￥/);
  setClubFormat({ currency: "EUR", locale: "es-ES" });
});

test("amounts are shown the way staff type them, and only the club's own currency is read", () => {
  setClubFormat({ currency: "EUR", locale: "es-ES" });
  assert.equal(parseAmount(money(4050, "en")), 4050, "what an English reader sees in Spain can be typed back");
  assert.equal(amountInput(4050), "40,50");
  assert.equal(parseAmount(amountInput(120050)), 120050);
  for (const s of ["$40", "12 mil", "5k", "40 USD"]) assert.equal(parseAmount(s), null, s);
  assert.equal(parseAmount("40 €"), 4000);
  assert.equal(parseAmount("EUR 40"), 4000);
  setClubFormat({ currency: "JPY", locale: "ja-JP" });
  assert.equal(amountInput(1500), "1500");
  assert.equal(parseAmount("¥1,500"), 1500);
  setClubFormat({ currency: "EUR", locale: "es-ES" });
});

test("limits sized in dollars are sized for the currency; Stripe's whole-units-in-two-decimals are refused", () => {
  assert.equal(capFor(500000, "USD"), 500000);
  assert.equal(capFor(500000, "JPY"), 750000, "about $5,000 in yen");
  assert.equal(capFor(100_000, "KRW"), 1_400_000, "about $1,000 in won");
  assert.equal(currencyProblem("ISK"), "whole_in_two");
  assert.equal(currencyProblem("UGX"), "whole_in_two");
  assert.equal(currencyProblem("HUF"), null);
  assert.equal(minorUnits("JPY"), 0);
});

test("the club's country can't change once its Stripe account exists", async () => {
  await db.updateTable("club").set({ stripe_account_id: "acct_test_1", country: "ES" }).execute();
  await assert.rejects(plan(db, "club.update", { country: "FR" }, owner), /Stripe account was opened in ES/);
  await db.updateTable("club").set({ stripe_account_id: null }).execute();
});

test("no staff or member form turns an amount into cents with * 100 (zero-decimal currencies would be 100 times out)", () => {
  const roots = ["../../../apps/manager/src", "../../../apps/member/src", "../../ui/src"].map((r) => new URL(r, import.meta.url).pathname);
  const bad: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) {
    readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (/Number\([^)]*\)\s*\*\s*100\b/.test(l)) bad.push(`${p}:${i + 1}`); }); } } };
  roots.forEach(walk);
  assert.deepEqual(bad, []);
});
