// A club's own currency (format.ts, club.ts): amounts read and written the club's way, Stripe asked in it, and no
// change once the club has taken a payment. Three-decimal currencies refused; zero-decimal ones in whole units.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { amountExample, currencyProblem, currencySign, money, parseAmount, plainAmount, setClubFormat, t } from "@kumi/i18n";
import { openPayment, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, loadClubFormat, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, ann: string, loc: string;
const stripe = new TestProvider(), TZ = "Europe/Madrid", opts = { now: new Date("2026-11-05T10:00:00Z") };
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: TZ, owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner, opts)).result as { person_id: string }).person_id;
  loc = ((await run(db, "location.create", { name: "Centro", time_zone: TZ }, owner, opts)).result as any).location_id;
});
after(async () => { setClubFormat({ currency: "USD", locale: "en-US" }); await drop(); });

test("amounts read the club's way: US by default, Spain's commas, France's spaces, whole yen", () => {
  const us = { currency: "USD", locale: "en-US" }, es = { currency: "EUR", locale: "es-ES" }, fr = { currency: "EUR", locale: "fr-FR" }, jp = { currency: "JPY", locale: "ja-JP" };
  assert.deepEqual(["1,200.50", "$40", "12.5", "12,5", "1.200"].map((s) => parseAmount(s, us)), [120050, 4000, 1250, null, null]);
  assert.deepEqual(["1.200,50", "1200,50", "12,5", "12.5", "40 €", "€40"].map((s) => parseAmount(s, es)), [120050, 120050, 1250, null, 4000, 4000]);
  assert.equal(parseAmount("1 200,50", fr), 120050);
  assert.deepEqual(["1,500", "1500", "1,500.5"].map((s) => parseAmount(s, jp)), [1500, 1500, null]);
  assert.equal(money(4050, "en", "EUR"), "€40.50");
  assert.equal(money(1500, "en", "JPY"), "¥1,500");
  assert.equal(plainAmount(1500, "JPY"), "1500");
  assert.equal(plainAmount(-4050, "EUR"), "-40.50");
  assert.deepEqual(["EUR", "GBP", "KWD", "XYZ", "EU"].map(currencyProblem), [null, null, "three_decimals", "unknown", "unknown"]);
});

test("a currency the club can change to before its first payment, and the wording follows it", async () => {
  await rejects(run(db, "club.update", { currency: "KWD" }, owner, opts), "error.currency_three_decimals");
  await rejects(run(db, "club.update", { currency: "XYZ" }, owner, opts), "error.currency_unknown");
  await run(db, "club.update", { currency: "eur" }, owner, opts);
  assert.equal((await db.selectFrom("club").select("currency").executeTakeFirstOrThrow()).currency, "EUR");
  setClubFormat({ currency: "USD" }); await loadClubFormat(db);
  assert.equal(currencySign(), "€");
  assert.equal(t("en", "ui.price"), "Price (€)");
  setClubFormat({ locale: "es-ES" });
  assert.equal(amountExample(), "1200,50");
  assert.match(t("es", "ui.amount_format"), /1200,50/);
});

test("Stripe is asked in the club's currency, and the currency can't change once a payment exists", async () => {
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  const program = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Iniciación", capacity: 8, price_cents: 2500 }, owner, opts)).result as any).program_id;
  await run(db, "program.publish", { program_id: program }, owner, opts);
  const joined = (await run(db, "enrolment.join", { program_id: program, person_id: ann }, { personId: ann, via: "test", lang: "en" }, opts)).result as { payment_id: string };
  await openPayment(db, joined.payment_id, ann);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", joined.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  assert.equal(stripe.intents.get(ref)?.currency, "EUR");
  await rejects(run(db, "club.update", { currency: "GBP" }, owner, opts), "error.currency_has_payments");
  // Changing nothing else is still fine.
  await run(db, "club.update", { currency: "EUR", name: "Club Pádel Sol Centro" }, owner, opts);
});
