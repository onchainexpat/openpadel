// Money that has to go back does: a refund requested while the card provider is down waits and tries again
// (longer each time) instead of stopping after eight quick tries; after about an hour it's marked failed, the
// staff hear, and they can send it again. And a player who pays between a host's cancel preview and its
// confirm gets everything back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, backoffMs, checkPayment, messageHandlers, moneyHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "../src/index.ts";

class Flaky extends TestProvider { down = false; override async refund(i: any) { if (this.down) throw new Error("ECONNRESET"); return super.refund(i); } }
let db: Db, drop: () => Promise<void>, owner: Actor, c1: string, c2: string;
const stripe = new Flaky();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test");
}
before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  for (const n of ["Ann", "Bob"]) people[n] = ((await run(db, "person.create", { display_name: n, email: `${n.toLowerCase()}@example.test` }, owner, { now: NOW })).result as any).person_id;
});
after(async () => drop());

test("waits between tries: 30 seconds, doubling, never more than an hour", () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8, 20].map(backoffMs), [30_000, 60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000]);
});

test("a refund during an outage keeps trying, is marked failed after an hour, and the staff send it again", async () => {
  const r = (await run(db, "booking.request", { court_id: c1, starts_at: "2026-12-07T18:00:00-08:00", minutes: 90, pay: "whole", person_id: people.Ann }, as("Ann"), { now: NOW })).result as any;
  await pay(r.payment_id, "Ann");
  await run(db, "booking.cancel", { booking_id: r.booking_id }, as("Ann"), { now: NOW });
  stripe.down = true;
  // Eight quick ticks used to give it up for good: now it waits longer between tries, and is still to be sent.
  let t = NOW.getTime();
  for (let k = 0; k < 8; k++) await processOutbox(db, moneyHandlers, 100, new Date(t += 30_000));
  assert.equal((await db.selectFrom("refund").select("status").executeTakeFirstOrThrow()).status, "pending");
  // An hour of tries, each after its wait: the eighth fails it.
  for (let k = 0; k < 8; k++) { t += backoffMs(k + 1) + 1000; await processOutbox(db, moneyHandlers, 100, new Date(t)); }
  const failed = await db.selectFrom("refund").select(["id", "status", "failure"]).executeTakeFirstOrThrow();
  assert.equal(failed.status, "failed");
  assert.match(failed.failure!, /not sent/);
  await processOutbox(db, messageHandlers);
  assert.ok(await db.selectFrom("outbound_message").select("id").where("kind", "=", "refund_failed").executeTakeFirst(), "the staff hear");
  // It no longer counts as paid back, and the staff send it again: the same refund, so never twice at the provider.
  stripe.down = false;
  const again = await run(db, "refund.resend", { refund_id: failed.id }, owner, { now: new Date(t) });
  assert.match(again.plan.summary.en, /^Send Ann the \$60\.00 refund for .* again\./);
  await processOutbox(db, moneyHandlers, 100, new Date(t + 1000));
  assert.equal((await db.selectFrom("refund").select("status").executeTakeFirstOrThrow()).status, "sent");
  assert.equal(stripe.refunds.size, 1);
});

test("a player who pays between the host's cancel preview and its confirm gets everything back", async () => {
  const r = (await run(db, "booking.request", { court_id: c2, starts_at: "2026-12-07T18:00:00-08:00", minutes: 90, pay: "split", person_id: people.Ann }, as("Ann"), { now: NOW })).result as any;
  await pay(r.payment_id, "Ann");
  const p = await plan(db, "booking.cancel", { booking_id: r.booking_id }, as("Ann"), { now: NOW });
  const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", r.booking_id).executeTakeFirstOrThrow()).invite_code!;
  const j = (await run(db, "booking.join", { invite_code: code, person_id: people.Bob }, as("Bob"), { now: new Date(NOW.getTime() + 60_000) })).result as any;
  await pay(j.payment_id, "Bob");
  await apply(db, p.runId, as("Ann"), { now: new Date(NOW.getTime() + 120_000) });
  const back = await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", j.payment_id).executeTakeFirst();
  assert.equal(back?.amount_cents, 1500);
});
