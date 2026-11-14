// The member app's money round: the card on file (added and replaced by a card setup, removed after a preview that
// says what relied on it), switching membership plans (nothing charged until the current plan ends, then the new
// one on the same card), and the open match's teams card (fair teams and as joined, the organiser's choice).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { renewMemberships, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court: string;
const pv = new TestProvider();
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
const post = async (path: string, who: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const mail = (name: string) => `${name.toLowerCase()}@example.test`;
/** Preview, then confirm, through the API as the app does. */
async function act(who: string, action: string, input: unknown) {
  const p = await post(`/actions/${action}/plan`, mail(who), input);
  if (p.status !== 200) return { plan: p, applied: null };
  return { plan: p, applied: await post(`/runs/${p.json.run_id}/apply`, mail(who)) };
}
/** Add a card through the card form, as the app does: open the setup, the card form saves it, then the check. */
async function addCard(name: string) {
  const o = await post("/my/card", mail(name));
  assert.equal(o.status, 200);
  const ref = (await db.selectFrom("person_card").select("provider_ref").where("id", "=", o.json.card_id).executeTakeFirstOrThrow()).provider_ref!;
  pv.settleSetup(ref);
  assert.equal((await post(`/my/card/${o.json.card_id}/check`, mail(name))).json.status, "succeeded");
  return (await db.selectFrom("person_card").select("saved_method").where("id", "=", o.json.card_id).executeTakeFirstOrThrow()).saved_method!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(pv);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  for (const [name, level] of [["Pat", 3.2], ["Sam", 3.0], ["Ann", 3.4], ["Ben", 3.2], ["Cal", 3.6]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: mail(name) }, owner)).result as any).person_id;
    await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner);
    await signIn(mail(name));
  }
});
after(async () => drop());

test("card on file: added with a card setup (nothing charged), replaced everywhere, removed after saying what relied on it", async () => {
  assert.deepEqual((await get("/my/card", mail("Pat"))).json.card, null);
  const charged = pv.charges.length;
  const first = await addCard("Pat");
  assert.equal(pv.charges.length, charged);   // saving a card charges nothing
  let mine = (await get("/my/card", mail("Pat"))).json;
  assert.deepEqual(mine.card, { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 });
  assert.equal(mine.uses.deadlines, 0);

  // Pat pays their part of a court and the card is saved with it: what's unpaid at the deadline goes on it.
  const start = new Date(Date.now() + 4 * 86400_000); start.setUTCHours(18, 0, 0, 0);
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "split", players: 4, person_id: people.Pat }, as("Pat"))).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded", saved_customer: "cus_test_part", saved_method: "pm_test_part" }, "test");
  mine = (await get("/my/card", mail("Pat"))).json;
  assert.equal(mine.uses.deadlines, 1);

  // Replacing it moves the court's deadline charge to the new card, and takes the old cards off at the provider.
  const second = await addCard("Pat");
  const pay = await db.selectFrom("payment").select(["saved_method", "saved_customer"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.equal(pay.saved_method, second);
  assert.ok(pv.detached.has(first) && pv.detached.has("pm_test_part"));
  assert.equal((await db.selectFrom("person_card").select("id").where("person_id", "=", people.Pat!).where("status", "=", "saved").execute()).length, 1);

  // Removing it says first that a court's deadline relies on it; nothing moves before Confirm.
  const { plan, applied } = await act("Pat", "card.remove", { person_id: people.Pat });
  assert.match(plan.json.summary, /Visa card ending 4242/);
  assert.match(plan.json.summary, /unpaid on 1 court at its deadline/);
  assert.equal(applied!.status, 200);
  assert.equal((await db.selectFrom("payment").select("saved_method").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).saved_method, null);
  assert.ok(pv.detached.has(second));
  assert.equal((await get("/my/card", mail("Pat"))).json.card, null);
  // Nobody else removes Pat's card.
  assert.equal((await post("/actions/card.remove/plan", mail("Sam"), { person_id: people.Pat })).status, 403);
  // Nothing on file: nothing to remove.
  assert.equal((await post("/actions/card.remove/plan", mail("Pat"), { person_id: people.Pat })).json.error, "error.no_card_on_file");
});

test("card on file: a parent's card is the family card too, and removing it says the kids pay with it", async () => {
  await run(db, "household.add_junior", { person_id: people.Ann, display_name: "Mia", birth_year: 2014 }, as("Ann"));
  const fam = await post("/dev/family/card", mail("Ann"));
  assert.equal(fam.json.status, "succeeded");
  const old = (await db.selectFrom("family_card").select("saved_method").where("saved_by", "=", people.Ann!).where("status", "=", "saved").executeTakeFirstOrThrow()).saved_method;
  const card = await addCard("Ann");
  // The family card is replaced by the card on file.
  assert.equal((await db.selectFrom("family_card").select("saved_method").where("saved_by", "=", people.Ann!).where("status", "=", "saved").executeTakeFirstOrThrow()).saved_method, card);
  assert.ok(pv.detached.has(old!));
  const { plan } = await act("Ann", "card.remove", { person_id: people.Ann });
  assert.match(plan.json.summary, /family card/);
  assert.equal((await db.selectFrom("family_card").select("status").where("saved_by", "=", people.Ann!).orderBy("created_at", "desc").executeTakeFirstOrThrow()).status, "removed");
});

test("switching plans: nothing charged today, the new plan starts when the current one ends, on the same card", async () => {
  const plus = ((await run(db, "membership.plan_set", { name: "Plus", price_cents: 7900, period: "month" }, owner)).result as any).plan_id;
  const off = ((await run(db, "membership.plan_set", { name: "Off-peak", price_cents: 4500, period: "month" }, owner)).result as any).plan_id;
  const j = (await run(db, "membership.join", { plan_id: plus, person_id: people.Sam }, as("Sam"))).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded", saved_customer: "cus_test_sam", saved_method: "pm_test_sam" }, "test");
  let m = (await get("/my/membership", mail("Sam"))).json.membership;
  assert.deepEqual([m.name, m.can_switch, m.switch], ["Plus", true, null]);

  const charged = pv.charges.length;
  const { plan, applied } = await act("Sam", "membership.switch", { membership_id: m.id, plan_id: off });
  assert.equal(plan.json.charge.due_cents, 0);   // nothing today
  assert.deepEqual(plan.json.charge.lines.map((l: any) => l.cents), [4500, 4500]);
  assert.match(plan.json.summary, new RegExp(`Switch to Off-peak, \\$45.00 a month, from .* when Plus ends`));
  assert.match(plan.json.charge.how, /Visa card ending 4242/);
  assert.equal(applied!.status, 200);
  assert.equal(pv.charges.length, charged);
  m = (await get("/my/membership", mail("Sam"))).json.membership;
  assert.equal(m.switch.name, "Off-peak");
  assert.equal(m.switch.starts_on, m.ends_on);

  // Called off, the current plan renews as before; and switched again.
  assert.equal((await act("Sam", "membership.switch_cancel", { membership_id: m.id })).applied!.status, 200);
  assert.equal((await get("/my/membership", mail("Sam"))).json.membership.switch, null);
  assert.equal((await act("Sam", "membership.switch", { membership_id: m.id, plan_id: off })).applied!.status, 200);
  // Only the member's own: someone else can't switch it.
  assert.equal((await post("/actions/membership.switch/plan", mail("Ben"), { membership_id: m.id, plan_id: off })).status, 403);
  assert.equal((await post("/actions/membership.switch/plan", mail("Sam"), { membership_id: m.id, plan_id: plus })).json.error, "error.switch_same_plan");

  // At the renewal: Plus ends, Off-peak starts and is charged once, on the card Plus renewed from.
  const end = (await db.selectFrom("membership").select("current_period_end").where("id", "=", m.id).executeTakeFirstOrThrow()).current_period_end!;
  const n = await renewMemberships(db, new Date(end.getTime() + 60_000));
  assert.equal(n.renewed, 1);
  const rows = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").select(["membership.status", "membership.end_reason", "membership_plan.name", "membership.saved_method", "membership.current_period_end", "membership.started_at"])
    .where("membership.person_id", "=", people.Sam!).orderBy("membership.created_at").execute();
  assert.deepEqual(rows.map((x) => [x.name, x.status, x.end_reason]), [["Plus", "ended", "switched"], ["Off-peak", "active", null]]);
  assert.equal(rows[1]!.saved_method, "pm_test_sam");
  assert.equal(rows[1]!.started_at.getTime(), end.getTime());
  assert.ok(rows[1]!.current_period_end! > end);
  assert.deepEqual(pv.charges.slice(charged).map((c) => [c.amountCents, c.paymentMethod]), [[4500, "pm_test_sam"]]);
  assert.equal((await get("/my/membership", mail("Sam"))).json.membership.name, "Off-peak");
});

test("switching plans needs a membership joined in the app, and a card for a plan that costs money", async () => {
  const gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 9900, period: "month" }, owner)).result as any).plan_id;
  const club = ((await run(db, "membership.plan_set", { name: "Club", price_cents: 5000, period: "month" }, owner)).result as any).plan_id;
  const mid = ((await run(db, "membership.grant", { person_id: people.Ben, plan_id: club }, owner)).result as any).membership_id;
  assert.equal((await post("/actions/membership.switch/plan", mail("Ben"), { membership_id: mid, plan_id: gold })).json.error, "error.switch_not_now");
  assert.equal((await get("/my/membership", mail("Ben"))).json.membership.can_switch, false);
});

test("the teams card: fair teams and as joined with each side's chance, chosen by the organiser; pairs who came together stay together", async () => {
  const start = new Date(Date.now() + 3 * 86400_000); start.setUTCHours(20, 0, 0, 0);
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "split", person_id: people.Pat, open: { level_min: 2.5, level_max: 4 } }, as("Pat"))).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  for (const name of ["Ann", "Ben"]) {
    const j = (await run(db, "booking.join", { booking_id: r.booking_id, person_id: people[name] }, as(name))).result as any;
    await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "test");
  }
  // Three in: Cal sees the teams if Cal joins.
  const three = (await get(`/matches/${r.booking_id}`, mail("Cal"))).json;
  assert.equal(three.match_teams.if_join, true);
  assert.ok([...three.match_teams.fair.a, ...three.match_teams.fair.b].some((p: any) => p.name === "Cal"));
  assert.equal(three.match_teams.fair.a_chance + three.match_teams.fair.b_chance, 100);
  assert.deepEqual([three.late.sub, typeof three.late.empty], [three.late.sub, "number"]);
  const j = (await run(db, "booking.join", { booking_id: r.booking_id, person_id: people.Cal }, as("Cal"))).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "test");

  const host = (await get(`/matches/${r.booking_id}`, mail("Pat"))).json.match_teams;
  assert.deepEqual([host.pick, host.can_pick, host.if_join], [null, true, false]);
  // As joined: the first to join (Pat) with the next (Ann), against Ben and Cal.
  assert.deepEqual([host.joined.a.map((p: any) => p.name), host.joined.b.map((p: any) => p.name)], [["Pat", "Ann"], ["Ben", "Cal"]]);
  assert.equal((await get(`/matches/${r.booking_id}`, mail("Ann"))).json.match_teams.can_pick, false);
  // Only the organiser chooses.
  assert.equal((await post("/actions/booking.set_teams/plan", mail("Ann"), { booking_id: r.booking_id, teams: "joined" })).status, 403);
  const { plan, applied } = await act("Pat", "booking.set_teams", { booking_id: r.booking_id, teams: "joined" });
  assert.match(plan.json.summary, /as you joined: Pat and Ann against Ben and Cal/);
  assert.equal(applied!.status, 200);
  const now = (await get(`/matches/${r.booking_id}`, mail("Ben"))).json;
  assert.equal(now.match_teams.pick, "joined");
  assert.deepEqual([now.teams.a.map((p: any) => p.name), now.teams.b.map((p: any) => p.name)], [["Pat", "Ann"], ["Ben", "Cal"]]);
});

test("card on file: a membership joined in the app with no card to renew from renews from the new card", async () => {
  const basic = ((await run(db, "membership.plan_set", { name: "Basic", price_cents: 3000, period: "month" }, owner)).result as any).plan_id;
  const j = (await run(db, "membership.join", { plan_id: basic, person_id: people.Cal }, as("Cal"))).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: j.payment_id, outcome: "succeeded" }, "test");   // paid, no card kept
  const card = await addCard("Cal");
  const m = await db.selectFrom("membership").select("saved_method").where("person_id", "=", people.Cal!).where("status", "=", "active").executeTakeFirstOrThrow();
  assert.equal(m.saved_method, card);
  assert.equal((await get("/my/card", mail("Cal"))).json.uses.membership.name, "Basic");
});
