// The review of club credit and gift cards (6a004f4, be2a73c): each case it proved, held to the fixed behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, creditBalance, deleteCheck, deskLines, exportData, giftCardsOf, lapseUnpaidPlaces, openPayment, plan, resealAll, run, runAsSystem,
  setPaymentProvider, setSecretKeys, GIFT_TRIES_PER_HOUR, KumiError, SUPPORT_NEVER, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, court: string, clinic: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-04T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const codeOf = (e: unknown) => (e instanceof KumiError ? e.code : String(e));
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function cardPaid(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
let slot = 0;
/** $40 of club credit for `who`: a court paid by card, cancelled by the desk as club credit. */
async function creditOf40(who: string) {
  const day = String(5 + slot++).padStart(2, "0");
  const b = (await run(db, "booking.request", { court_id: court, starts_at: `2026-11-${day}T10:00:00-08:00`, minutes: 60, person_id: people[who], pay: "whole" }, as(who), opts)).result as { booking_id: string; payment_id: string };
  assert.equal(await cardPaid(b.payment_id, who), "succeeded");
  await run(db, "booking.cancel", { booking_id: b.booking_id, refund: "credit" }, desk, opts);
}
async function bought(who: string, cents: number) {
  const r = (await run(db, "gift_card.buy", { person_id: people[who], cents, for_name: "Sam", message: "Happy birthday Sam Smith" }, as(who), opts)).result as { gift_card_id: string; payment_id: string };
  assert.equal(await cardPaid(r.payment_id, who), "succeeded");
  return { ...r, code: (await giftCardsOf(db, people[who]!)).find((c) => c.id === r.gift_card_id)!.code! };
}

before(async () => {
  // A server key, as in production: the codes' fingerprints are keyed by it.
  setSecretKeys({ current: randomBytes(32).toString("base64") });
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  desk = as("Lee");
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 6, price_cents: 6000 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
});
after(async () => { await drop(); setSecretKeys({}); });

test("M1: only the person redeeming is counted or answered: nobody can spend someone else's tries or learn whether a code is live", async () => {
  const { code: good } = await bought("Ann", 2000);
  for (let i = 0; i < GIFT_TRIES_PER_HOUR; i++) await rejects(plan(db, "gift_card.redeem", { person_id: people.Cal, code: `WRONG-${i}` }, as("Ben"), opts), "error.forbidden_reason");
  assert.equal((await db.selectFrom("gift_card_try").select("person_id").execute()).length, 0, "no tries charged to anyone");
  // The same answer for a live code and a dead one, when it isn't yours.
  await rejects(plan(db, "gift_card.redeem", { person_id: people.Dee, code: good }, as("Ben"), opts), "error.forbidden_reason");
  await rejects(plan(db, "gift_card.redeem", { person_id: people.Dee, code: "NOPE-NOPE-NOPE-NOPE" }, as("Ben"), opts), "error.forbidden_reason");
  // Cal still redeems a real card.
  await run(db, "gift_card.redeem", { person_id: people.Cal, code: good }, as("Cal"), opts);
  assert.equal(await creditBalance(db, people.Cal!), 2000);
  // Wrong codes at once count one at a time: never more than the limit.
  const out = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => plan(db, "gift_card.redeem", { person_id: people.Dee, code: `MISS-${i}-MISS-MISS` }, as("Dee"), opts)));
  assert.equal((await db.selectFrom("gift_card_try").select("person_id").where("person_id", "=", people.Dee!).execute()).length, GIFT_TRIES_PER_HOUR);
  assert.equal(out.filter((x) => x.status === "rejected" && codeOf(x.reason) === "error.gift_card_tries").length, 16 - GIFT_TRIES_PER_HOUR);
});

test("M2: no copy of a code anywhere but its sealed column: not with a preview, a refusal or the change log; the fingerprint is keyed", async () => {
  const { code: good, gift_card_id } = await bought("Eve", 3000);
  const norm = good.replace(/-/g, ""), plain = createHash("sha256").update(norm).digest("hex");
  const row = await db.selectFrom("gift_card").select(["code_hash", "code_sealed"]).where("id", "=", gift_card_id).executeTakeFirstOrThrow();
  assert.notEqual(row.code_hash, plain, "keyed by the server's key, not a plain SHA-256");
  await plan(db, "gift_card.redeem", { person_id: people.Fay, code: good }, as("Fay"), opts);   // previewed, never confirmed
  await rejects(plan(db, "gift_card.redeem", { person_id: people.Gus, code: good }, as("Fay"), opts), "error.forbidden_reason");   // refused
  const p = await plan(db, "gift_card.redeem", { person_id: people.Fay, code: good.toLowerCase() }, as("Fay"), opts);
  await apply(db, p.runId, as("Fay"), opts);   // applied
  const runs = JSON.stringify(await db.selectFrom("action_run").select(["input", "plan", "result", "error"]).execute());
  const changes = JSON.stringify(await db.selectFrom("entity_change").select(["before", "after"]).execute());
  for (const secret of [good, good.toLowerCase(), norm, row.code_hash, row.code_sealed, plain]) {
    assert.ok(!runs.includes(secret), `a run holds ${secret.slice(0, 8)}`);
    assert.ok(!changes.includes(secret), `the change log holds ${secret.slice(0, 8)}`);
  }
  // A card from before keyed fingerprints is still found, and gets the keyed one.
  const old = await bought("Eve", 1000);
  await db.updateTable("gift_card").set({ code_hash: createHash("sha256").update(old.code.replace(/-/g, "")).digest("hex") }).where("id", "=", old.gift_card_id).execute();
  await run(db, "gift_card.redeem", { person_id: people.Hal, code: old.code }, as("Hal"), opts);
  assert.equal(await creditBalance(db, people.Hal!), 1000);
  const again = await bought("Eve", 1000), was = (await db.selectFrom("gift_card").select("code_hash").where("id", "=", again.gift_card_id).executeTakeFirstOrThrow()).code_hash;
  await db.updateTable("gift_card").set({ code_hash: "stale" }).where("id", "=", again.gift_card_id).execute();
  await resealAll(db);   // every start: fingerprints made again under the key in use
  assert.equal((await db.selectFrom("gift_card").select("code_hash").where("id", "=", again.gift_card_id).executeTakeFirstOrThrow()).code_hash, was);
});

test("M3: a place paid in part only from club credit is reminded and let go like an unpaid one, and the credit goes back", async () => {
  await creditOf40("Ann");
  await run(db, "credit.pay_out", { person_id: people.Ann, cents: 3999, method: "cash" }, owner, opts);
  const a = (await run(db, "enrolment.join", { program_id: clinic, person_id: people.Ann }, as("Ann"), opts)).result as { enrolment_id: string; payment_id: string };
  const r = (await run(db, "payment.use_credit", { payment_id: a.payment_id }, as("Ann"), opts)).result as { paid: boolean; rest_cents: number };
  assert.deepEqual([r.paid, r.rest_cents, await creditBalance(db, people.Ann!)], [false, 5999, 0]);
  assert.equal((await lapseUnpaidPlaces(db, new Date(NOW.getTime() + 13 * 3600_000))).reminded, 1, "reminded halfway");
  assert.equal((await lapseUnpaidPlaces(db, new Date(NOW.getTime() + 25 * 3600_000))).lapsed, 1, "let go at the end of the hold");
  const e = await db.selectFrom("enrolment").select(["status", "refund_outcome", "refund_cents"]).where("id", "=", a.enrolment_id).executeTakeFirstOrThrow();
  assert.deepEqual([e.status, e.refund_outcome, e.refund_cents], ["cancelled", "credit", 1]);
  assert.equal(await creditBalance(db, people.Ann!), 1, "the cent is back in Ann's credit");
});

test("M4: the desk's day counts only what changed hands there, not the rest of a place paid from credit", async () => {
  await creditOf40("Ben");
  const e = (await run(db, "enrolment.join", { program_id: clinic, person_id: people.Ben }, as("Ben"), opts)).result as { enrolment_id: string };
  await run(db, "enrolment.record_payment", { enrolment_id: e.enrolment_id, cents: 2000, method: "cash" }, desk, opts);
  const rest = await db.selectFrom("payment").select("id").where("enrolment_id", "=", e.enrolment_id).where("status", "=", "pending").executeTakeFirstOrThrow();
  await run(db, "payment.use_credit", { payment_id: rest.id }, as("Ben"), opts);
  const lines = (await deskLines(db, "2026-11-04", "2026-11-04")).filter((l) => l.person_id === people.Ben && l.kind === "in");
  assert.deepEqual(lines.map((l) => `${l.method}:${l.cents}`), ["cash:2000"]);
});

test("L1: moved to another server, no money goes out here (the new server pays it); read-only still pays back", async () => {
  await creditOf40("Dee");
  const { gift_card_id } = await bought("Dee", 2500);
  try {
    await db.updateTable("club").set({ moved_at: NOW, moved_to: "https://new.example" }).execute();
    await rejects(run(db, "credit.pay_out", { person_id: people.Dee, cents: 4000, method: "cash" }, owner, opts), "error.moved_to");
    await rejects(run(db, "gift_card.void", { gift_card_id }, owner, opts), "error.moved_to");
    await db.updateTable("club").set({ moved_at: null, moved_to: null, read_only_since: NOW }).execute();
    await run(db, "credit.pay_out", { person_id: people.Dee, cents: 1000, method: "cash" }, owner, opts);
  } finally { await db.updateTable("club").set({ moved_at: null, moved_to: null, read_only_since: null }).execute(); }
  assert.equal(await creditBalance(db, people.Dee!), 3000);
});

test("L2 (as decided after the recheck, N2): an active card the person bought doesn't stop deleting their account; the preview says to save the code, and the card stays usable without their words", async () => {
  const { code: good, gift_card_id } = await bought("Ivy", 2000);
  const check = await deleteCheck(db, people.Ivy!, NOW);
  assert.ok(!check.blockers.length, "a buyer can always delete their account");
  assert.ok(check.ends.some((t) => t.en.includes("save its code first")));
  // The data download has the cards (never the code) and all of the credit history.
  const data = await exportData(db, people.Ivy!, NOW, "en") as any;
  assert.ok(data.gift_cards.some((c: any) => c.bought && c.last4 === good.slice(-4)));
  assert.ok(!JSON.stringify(data).includes(good));
  await run(db, "privacy.erase", { person_id: people.Ivy }, as("Ivy"), opts);
  const c = await db.selectFrom("gift_card").select(["for_name", "message", "status"]).where("id", "=", gift_card_id).executeTakeFirstOrThrow();
  assert.deepEqual(c, { for_name: null, message: null, status: "active" });
  await run(db, "gift_card.redeem", { person_id: people.Gus, code: good }, as("Gus"), opts);
  assert.equal((await db.selectFrom("gift_card").select("status").where("id", "=", gift_card_id).executeTakeFirstOrThrow()).status, "redeemed");
});

test("L3: a booking paid from credit, made shorter: the preview and the money both say club credit", async () => {
  await creditOf40("Eve"); await creditOf40("Eve");
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-16T15:00:00-08:00", minutes: 90, person_id: people.Eve, pay: "whole" }, as("Eve"), opts)).result as { booking_id: string; payment_id: string };
  await run(db, "payment.use_credit", { payment_id: b.payment_id }, as("Eve"), opts);
  const before = await creditBalance(db, people.Eve!);
  const p = await plan(db, "booking.extend", { booking_id: b.booking_id, minutes: 60 }, desk, opts);
  assert.match(p.plan.summary.en, /\$20\.00 paid from club credit goes back to club credit/);
  assert.ok(!p.plan.summary.en.includes("at the desk"));
  await apply(db, p.runId, desk, opts);
  assert.equal(await creditBalance(db, people.Eve!), before + 2000);
  const ev = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "booking.resized").orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.deepEqual([(ev.payload as any).desk, (ev.payload as any).credit], [{}, { [people.Eve!]: 2000 }]);
});

test("L4a-b: credit and gift cards are their own person's, never support access's; nothing about a balance is said to anyone else", async () => {
  assert.ok(SUPPORT_NEVER.includes("payment.use_credit") && SUPPORT_NEVER.includes("gift_card.redeem"));
  await creditOf40("Gus");
  const g = (await run(db, "enrolment.join", { program_id: clinic, person_id: people.Gus }, as("Gus"), opts)).result as { payment_id: string };
  for (const who of [as("Ben"), owner]) await assert.rejects(plan(db, "payment.use_credit", { payment_id: g.payment_id }, who, opts), (e: unknown) => {
    assert.ok(e instanceof KumiError); assert.equal(e.code, "error.forbidden_reason"); assert.ok(!JSON.stringify(e.params ?? {}).includes("40"), "no balance said"); return true;
  });
});

test("L4c: a junior's refund given as club credit goes to the parent who looks after them, never the junior", async () => {
  const tim = ((await run(db, "household.add_junior", { person_id: people.Cal, display_name: "Tim", birth_year: 2015 }, as("Cal"), opts)).result as { person_id: string }).person_id;
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-27T10:00:00-08:00", minutes: 60, person_id: tim }, desk, opts)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, opts);
  const cal = await creditBalance(db, people.Cal!);
  await run(db, "booking.cancel", { booking_id: b, refund: "credit" }, desk, opts);
  assert.deepEqual([await creditBalance(db, tim), await creditBalance(db, people.Cal!)], [0, cal + 4000]);
});

test("paying out credit that came from neither a gift card nor a card (cash at the desk, given back as credit) isn't warned of", async () => {
  const zed = ((await run(db, "person.create", { display_name: "Zed", email: "zed@example.test" }, owner, opts)).result as { person_id: string }).person_id;
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-28T10:00:00-08:00", minutes: 60, person_id: zed }, desk, opts)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, opts);
  await run(db, "booking.cancel", { booking_id: b, refund: "credit" }, desk, opts);
  const out = await plan(db, "credit.pay_out", { person_id: zed, cents: 4000, method: "cash" }, owner, opts);
  assert.equal(out.plan.summary.en, "Pay Zed $40.00 of their club credit, in cash. $0.00 of credit is left.");
  assert.equal((out.plan.details as any).card_refunds, 0);
});

test("L4d: paying out credit that came from a gift card bought by card says so in the preview", async () => {
  const { code: good } = await bought("Ann", 5000);
  await run(db, "gift_card.redeem", { person_id: people.Hal, code: good }, as("Hal"), opts);
  const p = await plan(db, "credit.pay_out", { person_id: people.Hal, cents: 5000, method: "cash" }, owner, opts);
  assert.match(p.plan.summary.en, /came from gift cards they redeemed/);
  assert.match(p.plan.summary.en, /cash out a stolen card/);
});
