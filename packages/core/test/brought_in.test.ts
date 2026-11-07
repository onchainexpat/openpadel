// Moving in from Playtomic, the money side (brought_in.ts): wallet balances become club credit (a liability, once
// per person and wallet), and memberships carry over paid through Playtomic's date, renewing here on a card the
// member adds, or ending that day with nothing charged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, creditBalance, exportData, messageHandlers, normalizePlayer, onDate, parseBalance, plan, processOutbox, readPlaytomicPlayers, remindMembershipEnds, renewMemberships, run, runAsSystem,
  setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor, gold: string, silver: string, desk: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-07T18:00:00Z");
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function held(kind: string, personId?: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind as any).$if(Boolean(personId), (q) => q.where("ledger_account.person_id", "=", personId!)).executeTakeFirst();
  return Number(r?.c ?? 0);
}
const file = (players: unknown[]) => ({ source: "file" as const, players });

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Mia", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Mia, role: "manager" }, owner, opts);
  manager = as("Mia");
  // Ben came in with the member import, which kept his Playtomic id.
  await db.insertInto("external_ref").values({ entity: "person", entity_id: people.Ben!, system: "playtomic", external_id: "pt-ben" }).execute();
  gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  silver = ((await run(db, "membership.plan_set", { name: "Silver", price_cents: 4000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  desk = ((await run(db, "membership.plan_set", { name: "Desk only", price_cents: 3000, period: "month", join_in_app: false }, owner, opts)).result as any).plan_id;
});
after(async () => drop());

test("Playtomic's balances read in the club's currency: an id and amount, a comma decimal, a sign, or a plain number", () => {
  assert.deepEqual(parseBalance("10 EUR", "EUR"), { cents: 1000, currency: "EUR" });
  assert.deepEqual(parseBalance("25.50 USD", "USD"), { cents: 2550, currency: "USD" });
  assert.deepEqual(parseBalance("1.234,56 €", "EUR"), { cents: 123456, currency: "EUR" });
  assert.deepEqual(parseBalance("$7", "USD"), { cents: 700, currency: "USD" });
  assert.deepEqual(parseBalance("12,5", "USD"), { cents: 1250, currency: "USD" });
  assert.deepEqual(parseBalance("5 EUR", "USD"), { cents: 500, currency: "EUR" });
  assert.equal(parseBalance("lots", "USD"), null);
  // The API's player, with its wallets and benefits.
  const p = normalizePlayer({ player_id: "pt-1", name: "Ann", email: "ann@example.test", wallets: [{ wallet_id: "w1", name: "Club", balance: "10 USD" }], benefits: [{ benefit_id: "b1", name: "Gold", type: "SOLD", expires_at: "2026-12-01T00:00:00" }] });
  assert.equal(p?.wallets[0]?.balance, "10 USD");
  assert.equal(p?.benefits[0]?.expires_at, "2026-12-01T00:00:00");
});

test("wallets become club credit once: a liability, never revenue; a re-run adds what changed, and the owner hears on Today", async () => {
  const players = [
    { email: "ann@example.test", name: "Ann", wallets: [{ ref: "club", name: "Club wallet", balance: "25.50 USD" }, { ref: "promo", name: "Bonus", balance: "4.50" }] },
    { playtomic_id: "pt-ben", name: "Ben P.", wallets: [{ ref: "club", name: "Club wallet", balance: "10" }] },
    { email: "cal@example.test", name: "Cal", wallets: [{ ref: "club", name: "Club wallet", balance: "5 EUR" }] },
    { email: "zed@example.test", name: "Zed", wallets: [{ ref: "club", name: "Club wallet", balance: "8 USD" }] },
  ];
  const p = await plan(db, "credit.bring_in", file(players), owner, opts);
  assert.match(p.plan.summary.en, /^Bring club credit in from Playtomic's wallets for 2 people, \$40\.00 in all\./, p.plan.summary.en);
  assert.match(p.plan.summary.en, /Ann: \$30\.00 \(Club wallet, Bonus\)/);
  assert.match(p.plan.summary.en, /Left out, in another currency than the club's: Cal \(5 EUR\)/);
  assert.match(p.plan.summary.en, /1 player with a wallet or membership isn't a member here yet .*Zed/);
  assert.match(p.plan.summary.en, /set these wallets to zero in the same hour/);
  assert.equal(p.plan.summary.es.includes("monederos"), true);
  await apply(db, p.runId, owner, opts);
  assert.equal(await creditBalance(db, people.Ann!), 3000);
  assert.equal(await creditBalance(db, people.Ben!), 1000);
  assert.equal(await creditBalance(db, people.Cal!), 0);
  assert.equal(await held("member_credit"), -4000);
  assert.equal(await held("brought_in"), 4000);
  assert.equal(await held("revenue"), 0);
  // Playtomic's own read names the wallets differently (an id, not a column): kept to the export, so nothing doubles.
  await rejects(plan(db, "credit.bring_in", { source: "playtomic" }, owner, opts), "error.brought_from_file");
  // The same file again: nothing new, and nothing is added twice.
  const again = await plan(db, "credit.bring_in", file(players), owner, opts);
  assert.match(again.plan.summary.en, /^Nothing new to bring in/);
  await rejects(apply(db, again.runId, owner, opts), "error.nothing_to_do");
  assert.equal(await creditBalance(db, people.Ann!), 3000);
  // Changed since: Ann topped up in Playtomic, Ben spent some there. Only the difference moves.
  const changed = [{ ...players[0], wallets: [{ ref: "club", name: "Club wallet", balance: "30 USD" }, { ref: "promo", name: "Bonus", balance: "4.50" }] },
    { playtomic_id: "pt-ben", name: "Ben P.", wallets: [{ ref: "club", name: "Club wallet", balance: "4" }] }];
  const c = await plan(db, "credit.bring_in", file(changed), owner, opts);
  assert.match(c.plan.summary.en, /Ann: \$4\.50 \(Club wallet\)/, c.plan.summary.en);
  assert.match(c.plan.summary.en, /Ben: \$6\.00 less \(Club wallet\)/, c.plan.summary.en);
  await apply(db, c.runId, owner, opts);
  assert.equal(await creditBalance(db, people.Ann!), 3450);
  assert.equal(await creditBalance(db, people.Ben!), 400);
  assert.equal(await held("brought_in"), 3850);
  // The owner and managers hear once, on Today: zero the wallets in Playtomic.
  await processOutbox(db, messageHandlers, 100, NOW);
  const told = await db.selectFrom("outbound_message").select(["person_id", "subject"]).where("kind", "=", "playtomic_wallets_staff").where("channel", "=", "inbox").execute();
  assert.deepEqual(new Set(told.map((m) => m.person_id)), new Set([owner.personId, people.Mia]));
  assert.equal(told[0]!.subject, "Set the Playtomic wallets to zero");
});

test("credit already spent here isn't taken back, and paying out Playtomic credit in cash is warned of", async () => {
  // Ann spends most of hers here (paid out at the desk), then Playtomic shows her wallet empty.
  const out = await plan(db, "credit.pay_out", { person_id: people.Ann!, cents: 3000, method: "cash" }, owner, opts);
  assert.match(out.plan.summary.en, /came from Playtomic wallets, which members may have topped up by card/, out.plan.summary.en);
  assert.equal((out.plan.details as { from_playtomic: number }).from_playtomic, 3450);
  await apply(db, out.runId, owner, opts);
  const p = await plan(db, "credit.bring_in", file([{ email: "ann@example.test", name: "Ann", wallets: [{ ref: "club", name: "Club wallet", balance: "0" }] }]), owner, opts);
  assert.match(p.plan.summary.en, /Left as they are, because they've spent their credit here since: Ann/, p.plan.summary.en);
  assert.equal(await creditBalance(db, people.Ann!), 450);
});

test("an assistant can't bring credit or memberships in, or say the wallets are at zero: the app, or the server's command", async () => {
  const bot: Actor = { ...owner, via: "mcp:Test Agent", auth: "oauth", grantId: "g-1" };
  await rejects(plan(db, "credit.bring_in", file([]), bot, opts), "error.assistant_in_app");
  await rejects(plan(db, "membership.bring_in", { ...file([]), map: {} }, bot, opts), "error.assistant_in_app");
  await rejects(plan(db, "credit.brought_zeroed", {}, bot, opts), "error.assistant_in_app");
  // Front desk doesn't bring money in at all.
  await run(db, "role.assign", { person_id: people.Gus!, role: "front_desk" }, owner, opts);
  await assert.rejects(plan(db, "credit.bring_in", file([]), as("Gus"), opts));
});

test("once the owner says the Playtomic wallets are at zero, Today's reminder is done and no more credit comes over", async () => {
  // A manager asks the owner; Today's reminder can't be ticked off by itself.
  const asked = await plan(db, "credit.brought_zeroed", {}, manager, opts);
  assert.equal(asked.status, "awaiting_approval");
  const ev = await db.selectFrom("event_outbox").select("id").where("topic", "=", "credit.brought_in").executeTakeFirstOrThrow();
  await rejects(plan(db, "alert.handle", { event_id: String(ev.id), kind: "playtomic_wallets_staff" }, owner, opts), "error.alert_wallets_on_page");
  await run(db, "credit.brought_zeroed", {}, owner, opts);
  const handled = await db.selectFrom("staff_alert").select("handled_by").where("kind", "=", "playtomic_wallets_staff").execute();
  assert.deepEqual(handled.map((h) => h.handled_by), [owner.personId]);
  await rejects(plan(db, "credit.bring_in", file([{ email: "dee@example.test", name: "Dee", wallets: [{ ref: "club", name: "Club wallet", balance: "9" }] }]), owner, opts), "error.brought_wallets_closed");
  await rejects(plan(db, "credit.brought_zeroed", {}, owner, opts), "error.already_done");
});

test("a membership carries over paid through Playtomic's date, nothing charged; unmapped ones wait for a plan", async () => {
  const players = [
    { email: "dee@example.test", name: "Dee", benefits: [{ ref: "b-gold", name: "Gold Playtomic", until: "2026-11-30", commitment: "2027-03-31" }] },
    { email: "eve@example.test", name: "Eve", benefits: [{ name: "Bronze", until: "2026-12-15" }] },
    { email: "fay@example.test", name: "Fay", benefits: [{ name: "Old one", until: "2026-10-01" }] },
    { email: "cal@example.test", name: "Cal", benefits: [{ name: "Desk", until: "2026-12-31" }] },
  ];
  const p = await plan(db, "membership.bring_in", { ...file(players), map: { "gold playtomic": gold, Desk: desk } }, owner, opts);
  const s = p.plan.summary.en;
  assert.match(s, /^Carry 2 memberships over from Playtomic, paid through Playtomic's dates\. Nothing is charged now\./, s);
  assert.match(s, /Dee: Gold until November 30, 2026, then \$60\.00 a month on a card they add in the app\./, s);
  assert.match(s, /Cal: Desk only until December 31, 2026, then paid at the desk \(\$30\.00 a month\)\./, s);
  assert.match(s, /Choose a plan here for these \(or leave them out\), then preview again: Bronze \(1\)/, s);
  assert.match(s, /commitment period in Playtomic/);
  assert.match(s, /stop these memberships renewing/);
  await apply(db, p.runId, owner, opts);
  const dee = await db.selectFrom("membership").selectAll().where("person_id", "=", people.Dee!).executeTakeFirstOrThrow();
  assert.deepEqual([dee.status, dee.source, dee.brought_from, dee.brought_ref, dee.price_cents, dee.saved_method], ["active", "app", "playtomic", "b-gold", 6000, null]);
  assert.equal(dee.current_period_end!.toISOString(), onDate("2026-11-30", "24:00", TZ).toISOString());
  assert.match(dee.note ?? "", /Playtomic commitment: 2027-03-31/);
  const cal = await db.selectFrom("membership").select(["source", "current_period_end"]).where("person_id", "=", people.Cal!).executeTakeFirstOrThrow();
  assert.equal(cal.source, "desk");
  assert.equal(await db.selectFrom("payment").select("id").where("membership_id", "=", dee.id).executeTakeFirst(), undefined);
  assert.equal(await db.selectFrom("membership").select("id").where("person_id", "=", people.Eve!).executeTakeFirst(), undefined);
  // Again: nobody twice.
  const again = await plan(db, "membership.bring_in", { ...file(players), map: { "gold playtomic": gold, Desk: desk } }, owner, opts);
  assert.match(again.plan.summary.en, /^No memberships to carry over\./, again.plan.summary.en);
  // Eve, mapped now (and Silver isn't hers to choose: she gets what's mapped).
  const eve = await plan(db, "membership.bring_in", { ...file(players), map: { Bronze: silver } }, owner, opts);
  assert.match(eve.plan.summary.en, /Eve: Silver until December 15, 2026/);
});

test("reminded a week before to add a card; with none it ends that day, nothing charged and nobody's renewal failing", async () => {
  const dee = await db.selectFrom("membership").select("id").where("person_id", "=", people.Dee!).executeTakeFirstOrThrow();
  const week = new Date("2026-11-25T18:00:00Z");
  assert.equal(await remindMembershipEnds(db, week), 1);
  assert.equal(await remindMembershipEnds(db, week), 0);
  await processOutbox(db, messageHandlers, 100, week);
  const told = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Dee!).where("kind", "=", "membership_brought_ending").where("channel", "=", "inbox").executeTakeFirstOrThrow();
  assert.equal(told.subject, "Keep your membership: Gold");
  assert.match(told.body, /runs until November 30, 2026\. To keep it after that, add a card in the app before then: it renews at \$60\.00 a month\. Without a card it ends that day, and nothing is charged\./, told.body);
  const after = new Date("2026-12-01T09:00:00Z");
  await renewMemberships(db, after);
  const m = await db.selectFrom("membership").select(["status", "end_reason"]).where("id", "=", dee.id).executeTakeFirstOrThrow();
  assert.deepEqual([m.status, m.end_reason], ["ended", "not_continued"]);
  assert.equal(await db.selectFrom("payment").select("id").where("membership_id", "=", dee.id).executeTakeFirst(), undefined);
  await processOutbox(db, messageHandlers, 100, after);
  assert.equal(await db.selectFrom("outbound_message").select("id").where("kind", "=", "membership_payment_failed_staff").executeTakeFirst(), undefined);
  assert.ok(await db.selectFrom("outbound_message").select("id").where("person_id", "=", people.Dee!).where("kind", "=", "membership_brought_ended").executeTakeFirst());
});

test("with a card added before the day, it renews here from that card, like one joined in the app", async () => {
  const p = await plan(db, "membership.bring_in", { ...file([{ email: "fay@example.test", name: "Fay", benefits: [{ name: "Gold Playtomic", until: "2026-11-20" }] }]), map: { "Gold Playtomic": gold } }, owner, opts);
  await apply(db, p.runId, owner, opts);
  const m = await db.selectFrom("membership").select("id").where("person_id", "=", people.Fay!).where("status", "=", "active").executeTakeFirstOrThrow();
  await runAsSystem(db, "membership.card_saved", { membership_id: m.id, saved_method: "pm_test_fay", saved_customer: "cus_test_fay" }, "test", opts);
  const r = await renewMemberships(db, new Date("2026-11-21T09:00:00Z"));
  const after = await db.selectFrom("membership").select(["status", "current_period_end", "end_reason", "saved_method"]).where("id", "=", m.id).executeTakeFirstOrThrow();
  assert.equal(r.renewed, 1);
  assert.equal(after.status, "active");
  // A month on from Playtomic's day, not from the day it was carried over.
  assert.equal(after.current_period_end!.toISOString(), onDate("2026-12-20", "24:00", TZ).toISOString());
  const paid = await db.selectFrom("payment").select(["amount_cents", "status"]).where("membership_id", "=", m.id).execute();
  assert.deepEqual(paid.map((x) => [x.amount_cents, x.status]), [[6000, "succeeded"]]);
});

test("Playtomic's players read through the API are kept, then read for the preview; a player gone from Playtomic goes", async () => {
  const pages = [{ players: [{ player_id: "pt-ben", name: "Ben P.", email: "ben@example.test", wallets: [{ wallet_id: "w", name: "Club", balance: "1 USD" }], benefits: [] },
    { player_id: "pt-x", name: "Xan", email: "xan@example.test", wallets: [], benefits: [] }], has_more: false }];
  const client = { players: async () => pages[0]!.players };
  const r = await readPlaytomicPlayers(db, client, NOW);
  assert.deepEqual(r, { ok: true, read: 2, changed: 2 });
  assert.equal((await readPlaytomicPlayers(db, client, NOW) as { changed: number }).changed, 0);
  const club = await db.selectFrom("club").select("playtomic_players_read_at").executeTakeFirstOrThrow();
  assert.ok(club.playtomic_players_read_at);
  const one = { players: async () => [pages[0]!.players[0]] };
  assert.equal((await readPlaytomicPlayers(db, one, NOW) as { changed: number }).changed, 1);
  assert.deepEqual((await db.selectFrom("playtomic_player").select("player_id").execute()).map((x) => x.player_id), ["pt-ben"]);
});

test("a member's data download has their Playtomic record and the credit it brought; deleting the account deletes the record", async () => {
  const d = await exportData(db, people.Ben!, NOW, "en") as any;
  assert.deepEqual(d.playtomic.as_read.map((r: any) => r.player_id), ["pt-ben"]);
  assert.deepEqual(d.playtomic.wallets_brought_in.map((w: any) => [w.wallet, w.cents]), [["Club wallet", 400]]);
  // Credit still owed holds the account back (privacy.ts): paid out first.
  await run(db, "credit.pay_out", { person_id: people.Ben!, cents: 400, method: "cash" }, owner, opts);
  await run(db, "privacy.erase", { person_id: people.Ben! }, owner, opts);
  assert.equal(await db.selectFrom("playtomic_player").select("player_id").where("player_id", "=", "pt-ben").executeTakeFirst(), undefined);
});
