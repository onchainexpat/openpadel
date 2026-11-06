// Prices that include tax, outside the US (intl review L3 and L4): a lesson's quote keeps its subtotal as the price
// less the tax in it, and Reports shows revenue before tax (the tax on each day's court and lesson receipts comes off,
// a refund's tax goes back on) with the tax collected beside it. A club in Spain: euros, VAT 21% included.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { plainAmount, setClubFormat } from "@kumi/i18n";
import { checkPayment, issueReceipts, localDate, moneyHandlers, onDate, openPayment, processOutbox, run, runAsSystem, setPaymentProvider, taxSplit, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, court: string, cookie: string;
const stripe = new TestProvider(), mailer = new MemoryMailer(), TZ = "Europe/Madrid";
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
// Real time (the books and the receipts are dated as they happen): three days ahead in the club's time.
const DAY = localDate(new Date(Date.now() + 3 * 86400_000), TZ), WEEKDAY = new Date(`${DAY}T12:00:00Z`).getUTCDay();
const get = async (path: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, json: await r.json() as any }; };
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, paymentId, "test"), "succeeded");
}
/** Reports from yesterday to tomorrow, added up (a payment just before midnight has its receipt just after). */
async function totals() {
  const from = localDate(new Date(Date.now() - 86400_000), TZ), to = localDate(new Date(Date.now() + 86400_000), TZ);
  const rows = (await get(`/staff/reports?location_id=${loc}&from=${from}&to=${to}`)).json.rows as Array<Record<string, number>>;
  const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return { courts: sum("court_revenue_cents"), lessons: sum("lesson_revenue_cents"), tax: sum("tax_cents") };
}
let courtPaid: { booking_id: string; payment_id: string };

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: TZ, owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  app = makeApp({ db, mailer, secureCookies: false });
  for (const name of ["Ann", "Ben", "Kim"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as { person_id: string }).person_id;
  loc = ((await run(db, "location.create", { name: "Centro", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Pista 1" }, owner)).result as any).court_id;
  await run(db, "court.create", { location_id: loc, name: "Pista 2" }, owner);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Tarifa", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true, currency: "EUR", format_locale: "es-ES", tax_rate_bp: 2100, prices_include_tax: true, tax_label: "VAT" }, owner);
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner);
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Kim has coached for ten years.", level_min: 1.5, level_max: 5, languages: ["es", "en"], rates: [{ minutes: 60, cents: 6000 }], lessons: true, max_players: 4 }, owner);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: WEEKDAY, starts: "09:00", ends: "21:00" }] }, owner);
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "lucia@example.test" }) });
  const code = mailer.last("lucia@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "lucia@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => { setPaymentProvider(new TestProvider()); setClubFormat({ currency: "USD", locale: "en-US", country: "US" }); await drop(); });

test("a lesson priced with tax included: its quote's subtotal is the price less the VAT in it", async () => {
  const l = (await run(db, "lesson.request", { coach_id: people.Kim, starts_at: onDate(DAY, "10:00", TZ).toISOString(), minutes: 60, pay: "whole", person_id: people.Ann }, as("Ann"))).result as { booking_id: string; payment_id: string; total_cents: number };
  const split = taxSplit(6000, 2100, true);
  assert.deepEqual(split, { net: 4959, tax: 1041, total: 6000 });
  assert.equal(l.total_cents, 6000, "the coach's rate is what's paid: the VAT is inside it");
  const b = await db.selectFrom("booking").select(["price_cents", "tax_cents", "quote"]).where("id", "=", l.booking_id).executeTakeFirstOrThrow();
  const q = b.quote as { subtotal_cents: number; tax_cents: number; total_cents: number; tax_included: boolean; tax_bp: number };
  assert.deepEqual([b.price_cents, b.tax_cents], [6000, 1041]);
  assert.deepEqual([q.subtotal_cents, q.tax_cents, q.total_cents, q.tax_included, q.tax_bp], [4959, 1041, 6000, true, 2100], "subtotal + tax = total, never the rate twice");
  await pay(l.payment_id, "Ann");
  await issueReceipts(db);
  const r = await db.selectFrom("receipt").select(["subtotal_cents", "tax_cents", "total_cents", "tax_included"]).where("payment_id", "=", l.payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([r.subtotal_cents, r.tax_cents, r.total_cents, r.tax_included], [4959, 1041, 6000, true]);
});

test("Reports: revenue from courts and lessons is before tax, with the tax collected beside it", async () => {
  courtPaid = (await run(db, "booking.request", { court_id: court, starts_at: onDate(DAY, "12:00", TZ).toISOString(), minutes: 60, person_id: people.Ben, pay: "whole" }, as("Ben"))).result as { booking_id: string; payment_id: string };
  await pay(courtPaid.payment_id, "Ben");
  await issueReceipts(db);
  assert.equal((await db.selectFrom("receipt").select("tax_cents").where("payment_id", "=", courtPaid.payment_id).executeTakeFirstOrThrow()).tax_cents, 694);
  // The books hold what was paid (40,00 € and 60,00 €, VAT inside); the report takes the receipts' VAT off each.
  assert.deepEqual(await totals(), { courts: 4000 - 694, lessons: 6000 - 1041, tax: 694 + 1041 });
  // The page's line for it, in both languages, from the same number.
  setClubFormat({ currency: "EUR", locale: "es-ES" });
  const { t } = await import("@kumi/i18n");
  assert.match(t("en", "ui.revenue_before_tax", { tax: "17,35 €" }), /^Revenue is before tax\. Tax collected on courts and lessons: 17,35 €\.$/);
  assert.match(t("es", "ui.revenue_before_tax", { tax: "17,35 €" }), /^Los ingresos son sin impuestos\. Impuestos cobrados en canchas y clases: 17,35 €\.$/);
});

test("Reports: a refund gives its share of the VAT back, so revenue and tax both come down", async () => {
  await run(db, "booking.refund", { booking_id: courtPaid.booking_id, payment_id: courtPaid.payment_id, cents: 2000, reason: "Lights out" }, owner);
  await processOutbox(db, moneyHandlers);
  assert.equal((await db.selectFrom("refund").select("status").where("payment_id", "=", courtPaid.payment_id).executeTakeFirstOrThrow()).status, "sent");
  await issueReceipts(db);
  const back = await db.selectFrom("receipt").select(["tax_cents", "total_cents"]).where("payment_id", "=", courtPaid.payment_id).where("kind", "=", "refund").executeTakeFirstOrThrow();
  assert.deepEqual([back.total_cents, back.tax_cents], [2000, 347], "half the payment back: half its VAT");
  // Courts: 40,00 € paid less 20,00 € back = 20,00 €, of which 6,94 € - 3,47 € was VAT.
  assert.deepEqual(await totals(), { courts: (4000 - 2000) - (694 - 347), lessons: 6000 - 1041, tax: (694 - 347) + 1041 });
});

test("the Reports download has the tax collected as its own column, matching the page, revenue before tax beside it", async () => {
  const from = localDate(new Date(Date.now() - 86400_000), TZ), to = localDate(new Date(Date.now() + 86400_000), TZ);
  const page = (await get(`/staff/reports?location_id=${loc}&from=${from}&to=${to}`)).json.rows as Array<Record<string, any>>;
  const csv = await (await app.request(`/staff/reports.csv?location_id=${loc}&from=${from}&to=${to}`, { headers: { cookie } })).text();
  // A row of cells: quoted ones may hold the decimal comma (12,35).
  const cells = (line: string) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => m[1]!.replace(/^"|"$/g, "").replace(/""/g, "\""));
  const [head, ...rows] = csv.trim().split("\r\n").map(cells);
  assert.equal(head!.at(-1), "tax collected");
  const col = (name: string) => head!.indexOf(name);
  assert.equal(rows.length, page.length, "a line a day, as on the page");
  for (const [i, r] of rows.entries()) {
    assert.equal(r.length, head!.length, `line ${i + 1} has every column`);
    assert.equal(r[col("date")], page[i]!.date);
    assert.equal(r[col("tax collected")], plainAmount(page[i]!.tax_cents), `${page[i]!.date}: the page's tax`);
    assert.equal(r[col("court revenue")], plainAmount(page[i]!.court_revenue_cents));
    assert.equal(r[col("lesson revenue")], plainAmount(page[i]!.lesson_revenue_cents));
  }
  // Added up: the VAT left after the half refund (3,47 € on the court, 10,41 € on the lesson).
  assert.equal(page.reduce((n, r) => n + Number(r.tax_cents ?? 0), 0), (694 - 347) + 1041);
  assert.ok(rows.some((r) => r[col("tax collected")] !== plainAmount(0)), "some day has tax in it");
});
