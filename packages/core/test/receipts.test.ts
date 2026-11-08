import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, combine, issueReceipts, messageHandlers, moneyHandlers, openPayment, plan, processOutbox, receiptsOf, receiptView, renewMemberships, run, runAsSystem, setPaymentProvider,
  KumiError, TestProvider, uuidv7, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, monthly: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const deliver = () => processOutbox(db, combine(moneyHandlers, messageHandlers));
const card = async (ref: string) => stripe.cardOf(ref);
const issue = () => issueReceipts(db, { card, now: NOW });
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, paymentId, "test"), "succeeded");
}
const emails = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body", "link", "channel"]).where("person_id", "=", people[who]!).where("kind", "=", kind).orderBy("id").execute();
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const opts = { now: NOW };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ, address: "100 Example St, Springfield, OR 97477" }, owner, opts)).result as any).location_id;
  [c1, c2] = await Promise.all(["Court 1", "Court 2"].map(async (name) => ((await run(db, "court.create", { location_id: loc, name }, owner, opts)).result as any).court_id));
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true, tax_rate_bp: 1000 }, owner, opts);
  monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, opts)).result as any).plan_id;
  for (const name of ["Ann", "Ben", "Cal", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Cal, role: "front_desk" }, owner, opts);
  await run(db, "role.assign", { person_id: people.Dee, role: "coach" }, owner, opts);
});
after(async () => drop());

let annReceipt = "";
test("a court paid by card: a numbered receipt with the club's address, the court and time, the tax and the card, by email and in the app (no notification)", async () => {
  const r = await run(db, "booking.request", { court_id: c1, starts_at: at("2026-12-02", "18:00"), minutes: 90, pay: "whole", person_id: people.Ann }, as("Ann"), { now: NOW });
  await pay((r.result as any).payment_id, "Ann");
  await db.insertInto("push_subscription").values({ id: uuidv7(), person_id: people.Ann!, app: "member", endpoint: "https://push.example/ann", p256dh: "x".repeat(87), auth: "y".repeat(22), user_agent: null } as any).execute();
  assert.deepEqual(await issue(), { issued: 1 });
  assert.deepEqual(await issue(), { issued: 0 });   // once
  await deliver();
  const [email, ...rest] = (await emails("Ann", "receipt")).filter((m) => m.channel === "email");
  assert.equal(rest.length, 0);
  annReceipt = (await db.selectFrom("receipt").select("id").where("person_id", "=", people.Ann!).executeTakeFirstOrThrow()).id;
  assert.equal(email!.subject, "Your receipt from Kestrel Padel: $66.00");
  assert.equal(email!.body, [
    "Kestrel Padel", "100 Example St, Springfield, OR 97477", "",
    "Receipt R-001001, Nov 30, 2026, 8:00 AM",
    "", "Court booking, Court 1, Wed, Dec 2, 6:00 PM: $66.00", "",
    "Subtotal: $60.00", "Sales tax: $6.00", "Total: $66.00", "Paid with: Visa ending in 4242"].join("\n"));
  assert.equal(email!.link, `/receipts/${annReceipt}`);
  const channels = (await emails("Ann", "receipt")).map((m) => m.channel).sort();
  assert.deepEqual(channels, ["email", "inbox"]);   // a phone with notifications on gets none for a receipt
  const v = (await receiptView(db, annReceipt))!;
  assert.deepEqual([v.number, v.total.en, v.tax!.en, v.method.es], ["R-001001", "$66.00", "$6.00", "Visa terminada en 4242"]);
});

test("splitting the court: each player gets a receipt for their own share", async () => {
  const r = await run(db, "booking.request", { court_id: c2, starts_at: at("2026-12-03", "18:00"), minutes: 60, pay: "split", players: 2, person_id: people.Ben }, as("Ben"), { now: NOW });
  await pay((r.result as any).payment_id, "Ben");
  await issue(); await deliver();
  const [ben] = (await emails("Ben", "receipt")).filter((m) => m.channel === "email");
  assert.match(ben!.body, /^Share of a court, Court 2, Thu, Dec 3, 6:00 PM: \$\d+\.\d\d$/m);
});

test("paid at the desk in cash: the receipt says so; a refund gets its own receipt pointing back at the first", async () => {
  const b = await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-04", "10:00"), minutes: 60, person_id: people.Ben }, owner, { now: NOW });
  const bookingId = (b.result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: bookingId, cents: 4400, method: "cash" }, as("Cal"), { now: NOW });
  await issue(); await deliver();
  const cash = (await emails("Ben", "receipt")).filter((m) => m.channel === "email").at(-1)!;
  assert.match(cash.body, /\nPaid with: cash$/);
  // Ann cancels her card booking in good time: her money goes back to the card, with a refund receipt.
  const booking = (await db.selectFrom("receipt_payment").innerJoin("payment", "payment.id", "receipt_payment.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select("booking_player.booking_id").where("receipt_payment.receipt_id", "=", annReceipt).executeTakeFirstOrThrow()).booking_id;
  await run(db, "booking.cancel", { booking_id: booking }, as("Ann"), { now: NOW });
  await deliver();   // the refund goes to the card
  assert.deepEqual(await issue(), { issued: 1 });
  await deliver();
  const [refund] = (await emails("Ann", "refund_receipt")).filter((m) => m.channel === "email");
  assert.equal(refund!.subject, "Your refund receipt from Kestrel Padel: $66.00");
  assert.match(refund!.body, /^Refund receipt R-\d{6}, Nov 30, 2026, 8:00 AM\nThis refunds receipt R-001001\.\n\nCourt booking, Court 1, Wed, Dec 2, 6:00 PM: \$66\.00\n\nSubtotal: \$60\.00\nSales tax: \$6\.00\nTotal refunded: \$66\.00\nRefunded to: Visa ending in 4242$/m);
});

test("a membership's first payment and each renewal get receipts", async () => {
  const j = await run(db, "membership.join", { plan_id: monthly, person_id: people.Ann }, as("Ann"), { now: NOW });
  await pay((j.result as any).payment_id, "Ann");
  await issue();
  const mine = await receiptsOf(db, people.Ann!);
  assert.equal(mine[0]!.what.en, "Monthly membership");
  assert.equal(mine[0]!.total.en, "$80.00");   // no sales tax on a membership
  assert.equal((await renewMemberships(db, new Date("2026-12-30T18:00:00Z"))).renewed, 1);
  await issue();
  const after = await receiptsOf(db, people.Ann!);
  assert.equal(after.length, mine.length + 1);
  assert.equal(after[0]!.what.en, "Monthly membership");
});

test("a kid's charge on the family card is the receipt of the parent who saved the card, naming the kid", async () => {
  const hh = uuidv7(), fc = uuidv7(), p = uuidv7();
  await db.insertInto("household").values({ id: hh, created_by: people.Ben! }).execute();
  await db.insertInto("family_card").values({ id: fc, household_id: hh, saved_by: people.Ben!, status: "saved", provider: "test" } as any).execute();
  await db.insertInto("payment").values({ id: p, person_id: people.Dee!, amount_cents: 2500, method: "card", provider: "test", provider_ref: null, status: "succeeded", family_card_id: fc } as any).execute();
  await issue(); await deliver();
  const r = (await db.selectFrom("receipt").select(["id", "person_id", "for_person_id"]).where("payment_id", "=", p).executeTakeFirstOrThrow());
  assert.deepEqual([r.person_id, r.for_person_id], [people.Ben, people.Dee]);
  const email = (await emails("Ben", "receipt")).filter((m) => m.channel === "email").at(-1)!;
  assert.match(email.body, /\nFor Dee\n\nPayment: \$25\.00\n/);
  assert.match(email.body, /\nPaid with: card$/);   // the stand-in had no card for it
  assert.equal((await receiptsOf(db, people.Dee!)).length, 0);   // not the kid's own
  assert.equal((await receiptsOf(db, people.Dee!, { asStaff: true })).length, 1);   // but on their page for staff
});

test("a parent who pays their junior's place by card gets the receipt, naming the junior; the junior's page says who paid", async () => {
  // Phone run 15: it went to the junior (no login), so the parents read "Mia: Your receipt..." and the link opened nothing.
  const mia = ((await run(db, "household.add_junior", { person_id: people.Ben, display_name: "Mia", birth_year: 2016 }, as("Ben"), { now: NOW })).result as any).person_id as string;
  people.Mia = mia;
  const p = uuidv7();
  await db.insertInto("payment").values({ id: p, person_id: mia, amount_cents: 2500, method: "card", provider: "test", provider_ref: null, status: "pending" } as any).execute();
  await pay(p, "Ben");
  assert.equal((await db.selectFrom("payment").select("paid_by").where("id", "=", p).executeTakeFirstOrThrow()).paid_by, people.Ben, "whoever opened the card form paid");
  await issue(); await deliver();
  const r = await db.selectFrom("receipt").select(["id", "person_id", "for_person_id"]).where("payment_id", "=", p).executeTakeFirstOrThrow();
  assert.deepEqual([r.person_id, r.for_person_id], [people.Ben, mia]);
  const email = (await emails("Ben", "receipt")).filter((m) => m.channel === "email").at(-1)!;
  assert.match(email.subject, /^Your receipt from Kestrel Padel: \$25\.00$/, "Ben's own, not forwarded as Mia's");
  assert.match(email.body, /\nFor Mia\n/);
  assert.equal((await receiptsOf(db, people.Ben!)).find((x) => x.id === r.id)?.for_name, "Mia");
  assert.equal((await receiptsOf(db, mia)).length, 0, "not the junior's own");
  const onHerPage = await receiptsOf(db, mia, { asStaff: true });
  assert.deepEqual(onHerPage.map((x) => [x.paid_by, x.for_name]), [["Ben", null]]);
});

test("payments from before receipts began get none; staff with the club's money send one again, by email only", async () => {
  const old = uuidv7();
  await db.insertInto("payment").values({ id: old, person_id: people.Cal!, amount_cents: 1000, method: "cash", provider: "none", provider_ref: null, status: "succeeded", created_at: new Date("2020-01-01T00:00:00Z") } as any).execute();
  await issue();
  assert.equal(await db.selectFrom("receipt").select("id").where("payment_id", "=", old).executeTakeFirst(), undefined);
  // The front desk can; a coach and a member can't.
  const p = await plan(db, "receipt.resend", { receipt_id: annReceipt }, as("Cal"), { now: NOW });
  assert.equal(p.plan.summary.en, "Email receipt R-001001 to Ann at ann@example.test again.");
  await rejects(plan(db, "receipt.resend", { receipt_id: annReceipt }, as("Dee"), { now: NOW }), "error.forbidden_reason");
  await rejects(plan(db, "receipt.resend", { receipt_id: annReceipt }, as("Ann"), { now: NOW }), "error.forbidden_reason");
  const before = (await emails("Ann", "receipt")).length;
  await run(db, "receipt.resend", { receipt_id: annReceipt }, as("Cal"), { now: NOW });
  await deliver();
  const added = (await emails("Ann", "receipt")).slice(before);
  assert.deepEqual(added.map((m) => m.channel), ["email"]);   // no second inbox copy
  // Someone with no email: said plainly; they still have it in the app.
  await db.updateTable("person").set({ email: null }).where("id", "=", people.Ann!).execute();
  await rejects(plan(db, "receipt.resend", { receipt_id: annReceipt }, as("Cal"), { now: NOW }), "error.receipt_no_email");
  await db.updateTable("person").set({ email: "ann@example.test" }).where("id", "=", people.Ann!).execute();
});
