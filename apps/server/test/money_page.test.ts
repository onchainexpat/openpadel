// The staff app's Money page (today.ts, /staff/money): today's takings, what's owed over the last weeks (each once, with
// what the desk's record-payment actions need), recent refunds and the credit members hold. Only the club's money people
// read it (the owner, the accountant, the front desk); a coach on their own and a role the club made covering bookings
// only are refused. A payment recorded through the usual action takes the row off the list.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, onDate, paymentProvider, run, runAsSystem, setPaymentProvider, StripeError, TestProvider, uuidv7, type Actor, type Db } from "@kumi/core";
import { sql } from "kysely";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const TZ = "America/Los_Angeles", DAY = 86400_000;
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc = "", court = "", beaBooking = "", annBooking = "", place = "";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
const post = async (path: string, who: string, body: unknown, headers: Record<string, string> = {}) =>
  (await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json() as Promise<any>;
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const as = (who: string) => `${who.toLowerCase()}@example.test`;
const ROBIN = "robin@example.test";
/** A court booking held straight in the database, owed in full; its player's id too. */
async function booked(personId: string, starts: Date, cents: number) {
  const id = uuidv7(), code = `KP-${id.slice(-4).toUpperCase()}`, player = uuidv7();
  await db.insertInto("booking").values({ id, code, location_id: loc, kind: "court", organiser_id: personId, status: "confirmed", source: "desk", price_cents: cents } as any).execute();
  await db.insertInto("booking_player").values({ id: player, booking_id: id, person_id: personId, share_cents: cents } as any).execute();
  await db.insertInto("court_time").values({ id: uuidv7(), court_id: court, during: sql`tstzrange(${starts}, ${new Date(starts.getTime() + 3600_000)})`, kind: "booking", booking_id: id } as any).execute();
  return { id, code, player };
}
/** Club credit for someone, posted to the ledger as a balanced transaction. */
async function credit(personId: string, cents: number) {
  const acct = async (kind: string, pid: string | null) => {
    const got = await db.selectFrom("ledger_account").select("id").where("kind", "=", kind as any).where("person_id", pid === null ? "is" : "=", pid as any).where("revenue_type", "is", null).executeTakeFirst();
    if (got) return got.id;
    const id = uuidv7(); await db.insertInto("ledger_account").values({ id, kind: kind as any, person_id: pid }).execute(); return id;
  };
  const mine = await acct("member_credit", personId), adj = await acct("adjustment", null), r = uuidv7(), txn = uuidv7();
  await sql`INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${r}, 'test.money', 1, 'test', '{}', '{}', 'applied', 'none', '{}', now(), now())`.execute(db);
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("ledger_txn").values({ id: txn, kind: "test", action_run_id: r, memo: "test" }).execute();
    await trx.insertInto("ledger_entry").values([{ txn_id: txn, account_id: mine, amount_cents: String(-cents) }, { txn_id: txn, account_id: adj, amount_cents: String(cents) }] as any).execute();
  });
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: ROBIN, owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  await signIn(ROBIN);
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  const clerk = ((await run(db, "role.create", { name: "Bookings clerk", grants: [{ action: "booking.set_rated", scope: "any" }] }, owner)).result as any).key;
  for (const [name, role] of [["Annabel", null], ["Bea", null], ["Cora", "coach"], ["Dana", "front_desk"], ["Acc", "accountant"], ["Cleo", clerk]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: as(name) }, owner)).result as any).person_id;
    if (role) { await run(db, "role.assign", { person_id: people[name], role }, owner); await signIn(as(name)); }
  }
  const now = new Date(), today = localDate(now, TZ), dayAt = (n: number, hm: string) => onDate(localDate(new Date(now.getTime() - n * DAY), TZ), hm, TZ);
  // Owed: Annabel's court three days ago, Bea's court today, and a place on a clinic with two dates in the last week.
  const ann = await booked(people.Annabel!, dayAt(3, "10:00"), 4000);
  annBooking = ann.id;
  beaBooking = (await booked(people.Bea!, onDate(today, "00:05", TZ), 3000)).id;
  await booked(people.Bea!, dayAt(45, "10:00"), 5000);   // long ago: not on the page
  const clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley drills", capacity: 8, price_cents: 2000 }, owner)).result as any).program_id;
  for (const n of [5, 2]) await db.insertInto("session").values({ id: uuidv7(), program_id: clinic, starts_at: dayAt(n, "18:00"), ends_at: dayAt(n, "19:00") } as any).execute();
  place = uuidv7();
  await db.insertInto("enrolment").values({ id: place, program_id: clinic, person_id: people.Bea!, status: "booked", price_cents: 2000 } as any).execute();
  // Refunds: one on Annabel's court two days ago, one older (on the list, not in the week's tile), one that failed.
  for (const [cents, ago, status] of [[1000, 2, "sent"], [700, 12, "sent"], [300, 1, "failed"]] as const) {
    const pay = uuidv7();
    await db.insertInto("payment").values({ id: pay, person_id: people.Annabel!, amount_cents: cents, method: "card", provider: "test", status: "succeeded", booking_player_id: ann.player } as any).execute();
    await db.insertInto("refund").values({ id: uuidv7(), payment_id: pay, amount_cents: cents, destination: "card", status, created_at: new Date(now.getTime() - ago * DAY) } as any).execute();
  }
  await credit(people.Annabel!, 2500);
  await credit(people.Bea!, 1000);
});
after(async () => drop());

test("the owner's Money page: takings, what's owed (each once, with what to record a payment), refunds and credit held", async () => {
  const r = await get("/staff/money", ROBIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = r.json;
  assert.equal(m.people, true);
  assert.equal(typeof m.takings.total_cents, "number");
  assert.equal(m.owed.count, 3, "the court from 45 days ago is past the page's reach; the place is listed once");
  // Annabel's court: 4000, less the 2000 paid on it, plus the 1700 given back (the failed refund gave nothing back).
  assert.equal(m.owed.total_cents, 3700 + 3000 + 2000);
  assert.deepEqual(m.owed.rows.map((x: any) => [x.kind, x.who, x.cents]), [["place", "Bea", 2000], ["booking", "Annabel", 3700], ["booking", "Bea", 3000]],
    "earliest first: the place at its first date in the window, five days ago");
  const a = m.owed.rows[1];
  assert.deepEqual([a.id, a.location_id, a.person_id, a.court], [annBooking, loc, people.Annabel, "Court 1"]);
  assert.equal(m.owed.rows[0].id, place);
  assert.equal(m.owed.rows[0].program, "Volley drills");
  assert.equal(m.refunds.rows.length, 3);
  assert.deepEqual([m.refunds.week_count, m.refunds.week_cents], [1, 1000], "the failed one and the older one aren't this week's");
  assert.deepEqual([m.refunds.rows[1].cents, m.refunds.rows[1].to, m.refunds.rows[1].status, m.refunds.rows[1].who, m.refunds.rows[1].what.kind], [1000, "card", "sent", "Annabel", "booking"]);
  assert.deepEqual([m.credit.cents, m.credit.people], [3500, 2]);
  assert.deepEqual(m.credit.top.map((h: any) => [h.name, h.cents]), [["Annabel", 2500], ["Bea", 1000]]);
});

test("the accountant and the front desk read it; a coach on their own and a bookings-only role don't", async () => {
  for (const who of ["Acc", "Dana"]) {
    const r = await get("/staff/money", as(who));
    assert.equal(r.status, 200, who);
    assert.equal(r.json.owed.count, 3, who);
  }
  for (const who of ["Cora", "Cleo", "Annabel"]) {
    if (!cookies[as(who)]) await signIn(as(who));
    assert.equal((await get("/staff/money", as(who))).status, 403, who);
  }
});

test("a payment recorded at the desk, through the action's preview and confirm, takes the court off the list", async () => {
  const p = await post("/actions/booking.record_payment/plan", ROBIN, { booking_id: beaBooking, cents: 3000, method: "cash" });
  assert.equal(p.status, "planned", JSON.stringify(p));
  await post(`/runs/${p.run_id}/apply`, ROBIN, {}, { "idempotency-key": p.run_id });
  const m = (await get("/staff/money", ROBIN)).json;
  assert.equal(m.owed.count, 2);
  assert.ok(!m.owed.rows.some((x: any) => x.id === beaBooking));
  assert.ok(m.takings.total_cents >= 3000, "today's takings count the cash");
});

test("payouts: from the payment provider, newest first, the next one on its way, for the same readers only", async () => {
  const was = paymentProvider(), stand = new TestProvider();
  setPaymentProvider(stand);
  try {
    // A club in practice has had none: an empty list, said to be the stand-in's.
    const none = await get("/staff/money/payouts", ROBIN);
    assert.equal(none.status, 200);
    assert.deepEqual(none.json, { provider: "test", connected: true, unavailable: false, bank: null, payouts: [] });
    const bank = { name: "STRIPE TEST BANK", last4: "6789" };
    stand.payouts.push({ ref: "po_1", amountCents: 790244, currency: "USD", status: "paid", arrivesOn: "2026-10-27", created: new Date("2026-10-25T12:00:00Z"), bank },
      { ref: "po_2", amountCents: 521436, currency: "USD", status: "in_transit", arrivesOn: "2026-10-28", created: new Date("2026-10-27T12:00:00Z"), bank });
    const r = await get("/staff/money/payouts", as("Acc"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.payouts.map((p: any) => [p.id, p.amount_cents, p.status, p.arrives_on]), [["po_2", 521436, "in_transit", "2026-10-28"], ["po_1", 790244, "paid", "2026-10-27"]]);
    assert.deepEqual(r.json.bank, bank);
    for (const who of ["Cora", "Cleo"]) assert.equal((await get("/staff/money/payouts", as(who))).status, 403, who);
    // Stripe out of reach: the list says so, and the rest of the page is untouched.
    stand.listPayouts = async () => { throw new StripeError("down", null, 500, null); };
    const down = await get("/staff/money/payouts", ROBIN);
    assert.deepEqual([down.status, down.json.unavailable, down.json.payouts], [200, true, []]);
    assert.equal((await get("/staff/money", ROBIN)).status, 200);
  } finally { setPaymentProvider(was); }
});
