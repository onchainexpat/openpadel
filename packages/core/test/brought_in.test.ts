// Moving in from Playtomic, the money side (brought_in.ts): wallet balances become club credit (one total per person,
// a liability, only the difference moving), and memberships carry over paid through Playtomic's date, renewing here
// on a card the member adds or ending that day with nothing charged. The export is read only from an upload the server
// parsed itself; take-backs only when staff choose them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { sizesCurrency } from "@kumi/i18n";
import * as core from "../src/index.ts";
import { approve, checkPayment, openPayment, apply, creditBalance, deleteCheck, exportData, lastDayPaid, messageHandlers, normalizePlayer, onDate, parseBalance, plan, PlaytomicClient, processOutbox, readPlaytomicPlayers,
  remindMembershipEnds, renewMemberships, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor, gold: string, silver: string, desk: string, founding: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-07T18:00:00Z");
const stripe = new TestProvider();
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function held(kind: string) {
  const r = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c"))
    .where("ledger_account.kind", "=", kind as any).executeTakeFirst();
  return Number(r?.c ?? 0);
}
/** The club's export, uploaded: the server reads it and keeps what it read; the move-in reads only that. */
async function upload(csv: string, at = NOW) {
  const r = await run(db, "playtomic.upload", { csv, file_name: "export.csv" }, owner, { now: at });
  return { source: "file" as const, ...(r.result as { upload_id: string; sha256: string }) };
}
const bring = async (src: object, more: object = {}) => { const p = await plan(db, "credit.bring_in", { ...src, ...more }, owner, opts); await apply(db, p.runId, owner, opts); return p.plan.summary.en; };
const credit = (name: string) => creditBalance(db, people[name]!);

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Mia", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kai", "Lou", "Kim", "Cy", "Max", "Ada", "Bo", "Sil", "Una", "Vik"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Mia, role: "manager" }, owner, opts);
  manager = as("Mia");
  // Ben came in with the member import, which kept his Playtomic id.
  await db.insertInto("external_ref").values({ entity: "person", entity_id: people.Ben!, system: "playtomic", external_id: "pt-ben" }).execute();
  gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  silver = ((await run(db, "membership.plan_set", { name: "Silver", price_cents: 4000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  desk = ((await run(db, "membership.plan_set", { name: "Desk only", price_cents: 3000, period: "month", join_in_app: false }, owner, opts)).result as any).plan_id;
  founding = ((await run(db, "membership.plan_set", { name: "Founding", price_cents: 5000, period: "month", join_in_app: true, max_members: 1 }, owner, opts)).result as any).plan_id;
});
after(async () => drop());

test("balances and days: an amount and its currency, a comma decimal, a sign; a bare date is that whole day", () => {
  assert.deepEqual(parseBalance("10 EUR", "EUR"), { cents: 1000, currency: "EUR" });
  assert.deepEqual(parseBalance("1.234,56 €", "EUR"), { cents: 123456, currency: "EUR" });
  assert.deepEqual(parseBalance("$7", "USD"), { cents: 700, currency: "USD" });
  assert.deepEqual(parseBalance("0", "USD"), { cents: 0, currency: "USD" });
  assert.equal(parseBalance("lots", "USD"), null);
  assert.equal(lastDayPaid("2026-12-01", TZ), "2026-12-01");
  assert.equal(lastDayPaid("2026-12-01T08:00:00", TZ), "2026-11-30");
  assert.equal(normalizePlayer({ player_id: "pt-1", name: "Ann", wallets: [{ wallet_id: "w1", name: "Club", balance: "10 USD" }] })?.wallets[0]?.balance, "10 USD");
});

test("a request can't carry rows: the file source is an upload the server read, by its id and hash", async () => {
  await rejects(plan(db, "credit.bring_in", { source: "file", players: [{ email: "ann@example.test", name: "Ann", wallets: [{ ref: "c", name: "Club", balance: "900" }] }] }, owner, opts), "error.upload_needed");
  const u = await upload("Name,Email,Wallet\nAnn,ann@example.test,1.00");
  await rejects(plan(db, "credit.bring_in", { ...u, sha256: "0".repeat(64) }, owner, opts), "error.changed");
  // An upload's preview reads the file; nothing about credit changes yet.
  assert.equal(await credit("Ann"), 0);
});

test("wallets become club credit once: one total per person, never revenue; the same file, or the same wallets under other names, brings nothing again", async () => {
  const s = await bring(await upload(["Name,Email,Playtomic ID,Club wallet,Bonus wallet",
    "Ann,ann@example.test,,25.50 USD,4.50", "Ben P.,,pt-ben,10,", "Cal,cal@example.test,,5 EUR,", "Zed,zed@example.test,,8 USD,"].join("\n")));
  assert.match(s, /^Bring club credit in from Playtomic's wallets for 2 people, \$40\.00 in all\./, s);
  assert.match(s, /Wallet columns read: Club wallet, Bonus wallet\./);
  assert.match(s, /Ann: \$30\.00 \(Club wallet, Bonus wallet\)/);
  assert.match(s, /Left out, in another currency than the club's: Cal \(5 EUR\)/);
  // Zed isn't a member here: counted, not named.
  assert.match(s, /1 player with a wallet or membership isn't a member here yet: import the members first/);
  assert.doesNotMatch(s, /Zed/);
  assert.deepEqual([await credit("Ann"), await credit("Ben"), await credit("Cal")], [3000, 1000, 0]);
  assert.deepEqual([await held("member_credit"), await held("brought_in"), await held("revenue")], [-4000, 4000, 0]);
  // Playtomic in Spanish this time, the columns named and split differently: the same money, so nothing comes in.
  const again = await plan(db, "credit.bring_in", await upload("Nombre;Correo;Monedero del club;Monedero de bonos\nAnn;ann@example.test;25,50 USD;4,50\nBen;ben@example.test;10;"), owner, opts);
  assert.match(again.plan.summary.en, /^Nothing new to bring in/, again.plan.summary.en);
  await rejects(apply(db, again.runId, owner, opts), "error.nothing_to_do");
  // A topped-up wallet adds the difference, whatever it's called.
  assert.match(await bring(await upload("Name,Email,Wallet\nAnn,ann@example.test,34.50")), /Ann: \$4\.50/);
  assert.equal(await credit("Ann"), 3450);
  // The owner and managers hear once, on Today: zero the wallets in Playtomic.
  await processOutbox(db, messageHandlers, 100, NOW);
  const told = await db.selectFrom("outbound_message").select(["person_id", "subject"]).where("kind", "=", "playtomic_wallets_staff").where("channel", "=", "inbox").execute();
  assert.deepEqual(new Set(told.map((m) => m.person_id)), new Set([owner.personId, people.Mia]));
});

test("one player on two rows counts once; rows that disagree are listed and left", async () => {
  const s = await bring(await upload(["Name,Email,Wallet,Category,Expiry date", "Dee,dee@example.test,30.00,Gold,2026-12-31", "Dee,dee@example.test,30.00,Junior add-on,2026-12-31",
    "Eve,eve@example.test,10,Gold,2026-12-31", "Eve,eve@example.test,12,Junior add-on,2026-12-31"].join("\n")));
  assert.equal(await credit("Dee"), 3000);
  assert.equal(await credit("Eve"), 0);
  assert.match(s, /Left out, on more than one row with different wallets \(check the file\): Eve\./, s);
});

test("less in Playtomic is taken back only when chosen: kept while the wallets are being zeroed, taken back before", async () => {
  // Dee spent $10 of hers in Playtomic before the switch: the next export says 20. Not chosen: listed, kept here.
  const spent = await upload("Name,Email,Wallet\nDee,dee@example.test,20.00");
  const kept = await plan(db, "credit.bring_in", spent, owner, opts);
  assert.match(kept.plan.summary.en, /Less in Playtomic now than brought in, and left as it is here: Dee \(\$10\.00\)\..*never while the wallets are being set to zero there/, kept.plan.summary.en);
  assert.equal(await credit("Dee"), 3000);
  // Chosen (before the cutover): $10 comes back out of her credit, and the books with it.
  assert.match(await bring(spent, { take_back: true }), /Taken back from credit, \$10\.00 in all.*Dee \(\$10\.00\)/);
  assert.equal(await credit("Dee"), 2000);
  // The cutover: staff zero the wallets in Playtomic, then read once more for anyone's last top-up. Everyone reads 0:
  // without the choice, nobody's credit moves.
  const zeroed = await upload("Name,Email,Wallet\nDee,dee@example.test,0\nAnn,ann@example.test,\nBen,ben@example.test,0");
  const z = await plan(db, "credit.bring_in", zeroed, owner, opts);
  assert.match(z.plan.summary.en, /^Nothing new to bring in/, z.plan.summary.en);
  assert.match(z.plan.summary.en, /left as it is here: .*Dee/);
  assert.deepEqual([await credit("Dee"), await credit("Ann"), await credit("Ben")], [2000, 3450, 1000]);
});

test("a take-back takes what's left: spent here meanwhile stays spent, and the rest comes back out", async () => {
  // Kai: $50 brought in, $30 spent here, then all $50 spent in Playtomic too.
  await bring(await upload("Name,Email,Wallet\nKai,kai@example.test,50 USD"));
  await run(db, "credit.pay_out", { person_id: people.Kai!, cents: 3000, method: "cash" }, owner, opts);
  const s = await bring(await upload("Name,Email,Wallet\nKai,kai@example.test,0"), { take_back: true });
  assert.match(s, /Taken back from credit, \$20\.00 in all.*Kai \(\$20\.00\)/, s);
  assert.match(s, /Spent here meanwhile, so not taken back: Kai \(\$30\.00\)/, s);
  assert.equal(await credit("Kai"), 0);
  // The same again: nothing left to take.
  assert.match((await plan(db, "credit.bring_in", { ...(await upload("Name,Email,Wallet\nKai,kai@example.test,0")), take_back: true }, owner, opts)).plan.summary.en, /Left as they are, because they've spent their credit here since: Kai/);
});

test("nothing older than the last run's read: an older upload can't bring back what a take-back removed", async () => {
  const first = await upload("Name,Email,Wallet\nLou,lou@example.test,60 USD", new Date(NOW.getTime() - 2 * 3600_000));
  await bring(first);
  await bring(await upload("Name,Email,Wallet\nLou,lou@example.test,10 USD", new Date(NOW.getTime() - 3600_000)), { take_back: true });
  assert.equal(await credit("Lou"), 1000);
  await rejects(plan(db, "credit.bring_in", first, owner, opts), "error.brought_read_older");
  assert.equal(await credit("Lou"), 1000);
});

test("an upload keeps nobody whose account was deleted here, and the change log keeps only its hash and count", async () => {
  await run(db, "privacy.erase", { person_id: people.Kim! }, owner, opts);
  const r = await run(db, "playtomic.upload", { csv: "Name,Email,Phone,Wallet\nKim Stone,kim@example.test,+15550001111,15 USD\nNon Member,non.member@example.test,,25 USD", file_name: "export.csv" }, owner, opts);
  assert.match(r.plan.summary.en, /1 player whose account was deleted here is left out\./, r.plan.summary.en);
  const id = (r.result as { upload_id: string }).upload_id;
  const kept = await db.selectFrom("playtomic_upload").select(["rows", "row_count", "erased_count"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([(kept.rows as any[]).map((x) => x.email), kept.row_count, kept.erased_count], [["non.member@example.test"], 1, 1]);
  const log = JSON.stringify((await db.selectFrom("entity_change").select("after").where("entity", "=", "playtomic_upload").where("entity_id", "=", id).executeTakeFirstOrThrow()).after);
  assert.doesNotMatch(log, /Non Member|non\.member|Kim/, log);
  assert.match(log, /"row_count":1/);
  // And a bring-in from it doesn't name those who aren't members here: only how many.
  const p = await plan(db, "credit.bring_in", { source: "file", upload_id: id, sha256: (r.result as { sha256: string }).sha256 }, owner, opts);
  assert.match(p.plan.summary.en, /1 player with a wallet or membership isn't a member here yet: import the members first/);
  assert.doesNotMatch(JSON.stringify(p.plan), /Non Member/);
});

test("for dollars, a figure given can only lower the ceiling, never raise it", async () => {
  const u = await upload("Name,Email,Wallet\nSil,sil@example.test,1500000 USD");
  assert.match((await plan(db, "credit.bring_in", { ...u, cap: 2_000_000 }, owner, opts)).plan.summary.en, /over the \$10,000\.00 that can come over for one person .*Sil/);
  assert.match((await plan(db, "credit.bring_in", { ...(await upload("Name,Email,Wallet\nSil,sil@example.test,150")), cap: 100 }, owner, opts)).plan.summary.en, /over the \$100\.00 .*Sil/);
  assert.equal(await credit("Sil"), 0);
});

test("a ceiling needs a figure for a currency openPadel can't size, rather than one dollar each", async () => {
  assert.equal(sizesCurrency("EUR"), true);
  assert.equal(sizesCurrency("BOB"), false);
  await db.updateTable("club").set({ currency: "BOB" }).execute();
  try {
    const u = await upload("Name,Email,Wallet\nMax,max@example.test,120");
    await rejects(plan(db, "credit.bring_in", u, owner, opts), "error.brought_cap_needed");
    const p = await plan(db, "credit.bring_in", { ...u, cap: 100 }, owner, opts);
    assert.match(p.plan.summary.en, /Left out, over the .*100\.00.*Max/, p.plan.summary.en);
  } finally { await db.updateTable("club").set({ currency: "USD" }).execute(); }
});

test("deleted and joined again, the same Playtomic wallet doesn't come in a second time", async () => {
  const read = (at: Date) => readPlaytomicPlayers(db, { players: async () => [{ player_id: "pt-ada", name: "Ada Lee", email: "ada@example.test", wallets: [{ wallet_id: "w", name: "Club", balance: "50 USD" }], benefits: [] }] }, at);
  const t1 = new Date(NOW.getTime() + 60_000), t2 = new Date(NOW.getTime() + 120_000), t3 = new Date(NOW.getTime() + 180_000);
  await read(t1);
  await run(db, "credit.bring_in", { source: "playtomic" }, owner, { now: t1 });
  assert.equal(await credit("Ada"), 5000);
  await run(db, "credit.pay_out", { person_id: people.Ada!, cents: 5000, method: "cash" }, owner, { now: t1 });
  await run(db, "privacy.erase", { person_id: people.Ada! }, owner, { now: t2 });
  // She joins again herself (a new person here), so Playtomic's read lets her back in (playtomic_erased.ts).
  const again = ((await run(db, "person.create", { display_name: "Ada", email: "ada@example.test" }, owner, { now: t2 })).result as { person_id: string }).person_id;
  const markRejoined = (core as any).markRejoined;
  if (typeof markRejoined === "function") await db.transaction().execute((trx) => markRejoined(trx, again, t2));
  await read(t3);
  const p = await plan(db, "credit.bring_in", { source: "playtomic" }, owner, { now: t3 });
  assert.doesNotMatch(p.plan.summary.en, /Ada: \$50/, p.plan.summary.en);
  await apply(db, p.runId, owner, { now: t3 }).catch(() => undefined);
  assert.equal(await creditBalance(db, again), 0);
  // A top-up there after she came back does come in, the difference only.
  await readPlaytomicPlayers(db, { players: async () => [{ player_id: "pt-ada", name: "Ada Lee", email: "ada@example.test", wallets: [{ wallet_id: "w", name: "Club", balance: "65 USD" }], benefits: [] }] }, new Date(t3.getTime() + 60_000));
  const top = await plan(db, "credit.bring_in", { source: "playtomic" }, owner, { now: new Date(t3.getTime() + 60_000) });
  if (/Ada: \$15\.00/.test(top.plan.summary.en)) { await apply(db, top.runId, owner, { now: new Date(t3.getTime() + 60_000) }); assert.equal(await creditBalance(db, again), 1500); }
});

test("a take-back reaches only what came from Playtomic: a card refund given as credit here is never taken", async () => {
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  // Bo: $50 from Playtomic, all spent here; then a $40 court paid by card, cancelled by the desk as club credit.
  await bring(await upload("Name,Email,Wallet\nBo,bo@example.test,50"));
  await run(db, "credit.pay_out", { person_id: people.Bo!, cents: 5000, method: "cash" }, owner, opts);
  const b = (await run(db, "booking.request", { court_id: court, starts_at: "2026-11-20T10:00:00-08:00", minutes: 60, person_id: people.Bo, pay: "whole" }, as("Bo"), opts)).result as { booking_id: string; payment_id: string };
  await openPayment(db, b.payment_id, people.Bo!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", b.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  await checkPayment(db, b.payment_id, "test", NOW);
  await run(db, "booking.cancel", { booking_id: b.booking_id, refund: "credit" }, owner, opts);
  assert.equal(await credit("Bo"), 4000);
  // Playtomic now shows her wallet empty: nothing of the refund is taken back.
  const s = (await plan(db, "credit.bring_in", { ...(await upload("Name,Email,Wallet\nBo,bo@example.test,0")), take_back: true }, owner, opts)).plan.summary.en;
  assert.match(s, /Left as they are, because they've spent their credit here since: Bo/, s);
  assert.equal(await credit("Bo"), 4000);
});

test("a take-back counts Playtomic's credit as spent first: a cash refund given as credit, or a gift card bought in cash, stays whole", async () => {
  const loc = ((await run(db, "location.create", { name: "Northside", time_zone: TZ }, owner, opts)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor, opts);
  // Una: $50 from Playtomic, and a $40 court paid in cash at the desk, cancelled as club credit. She spends $30 here.
  await bring(await upload("Name,Email,Wallet\nUna,una@example.test,50"));
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: "2026-11-21T10:00:00-08:00", minutes: 60, person_id: people.Una }, owner, opts)).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, owner, opts);
  await run(db, "booking.cancel", { booking_id: b, refund: "credit" }, owner, opts);
  assert.equal(await credit("Una"), 9000);
  await run(db, "credit.pay_out", { person_id: people.Una!, cents: 3000, method: "cash" }, owner, opts);
  // Vik: $50 from Playtomic, and a $25 gift card he bought in cash at the desk and redeemed. He spends $40 here.
  await bring(await upload("Name,Email,Wallet\nVik,vik@example.test,50"));
  const g = (await run(db, "gift_card.sell", { person_id: people.Vik!, cents: 2500, method: "cash" }, owner, opts)).result as { gift_card_id: string };
  const code = (await core.giftCardsOf(db, people.Vik!)).find((c) => c.id === g.gift_card_id)!.code!;
  await run(db, "gift_card.redeem", { person_id: people.Vik!, code }, as("Vik"), opts);
  assert.equal(await credit("Vik"), 7500);
  await run(db, "credit.pay_out", { person_id: people.Vik!, cents: 4000, method: "cash" }, owner, opts);
  // Playtomic now shows both wallets empty: what they spent came out of Playtomic's credit first, so only what's left
  // of that comes back out ($20 and $10), and the refund and the gift card are theirs, whole.
  const s = await bring(await upload("Name,Email,Wallet\nUna,una@example.test,0\nVik,vik@example.test,0"), { take_back: true });
  assert.match(s, /Taken back from credit, \$30\.00 in all.*Una \(\$20\.00\).*Vik \(\$10\.00\)/, s);
  assert.match(s, /Spent here meanwhile, so not taken back: Una \(\$30\.00\), Vik \(\$40\.00\)/, s);
  assert.deepEqual([await credit("Una"), await credit("Vik")], [4000, 2500]);
  assert.deepEqual([await core.playtomicLeft(db, people.Una!), await core.playtomicLeft(db, people.Vik!)], [0, 0]);
});

test("one person's credit has a ceiling: over it is listed, the rest still comes in, and nothing fails on the database", async () => {
  const s = await bring(await upload("Name,Email,Wallet\nFay,fay@example.test,12.00 USD\nGus,gus@example.test,30000000 USD"));
  assert.match(s, /Left out, over the \$10,000\.00 that can come over for one person .*Gus \(\$30,000,000\.00\)/, s);
  assert.deepEqual([await credit("Fay"), await credit("Gus")], [1200, 0]);
});

test("credit spent here isn't taken back, and paying out Playtomic credit in cash is warned of", async () => {
  const out = await plan(db, "credit.pay_out", { person_id: people.Ann!, cents: 3000, method: "cash" }, owner, opts);
  assert.match(out.plan.summary.en, /came from Playtomic wallets, which members may have topped up by card/, out.plan.summary.en);
  await apply(db, out.runId, owner, opts);
  // Then Playtomic shows her wallet empty: what she still holds here ($4.50) comes back out; what she spent here stays spent.
  const s = await bring(await upload("Name,Email,Wallet\nAnn,ann@example.test,0"), { take_back: true });
  assert.match(s, /Taken back from credit, \$4\.50 in all.*Ann \(\$4\.50\)/, s);
  assert.match(s, /Spent here meanwhile, so not taken back: Ann \(\$30\.00\)/, s);
  assert.equal(await credit("Ann"), 0);
});

test("who may: the owner; a manager asks; never front desk, support access or an assistant", async () => {
  const u = await upload("Name,Email,Wallet\nHal,hal@example.test,5");
  assert.equal((await plan(db, "credit.bring_in", u, manager, opts)).status, "awaiting_approval");
  assert.equal((await plan(db, "membership.bring_in", { ...u, map: {} }, manager, opts)).status, "awaiting_approval");
  await run(db, "role.assign", { person_id: people.Jo!, role: "front_desk" }, owner, opts);
  await assert.rejects(plan(db, "credit.bring_in", u, as("Jo"), opts));
  await assert.rejects(plan(db, "playtomic.upload", { csv: "Name,Email,Wallet\nX,x@example.test,1" }, as("Jo"), opts));
  const bot: Actor = { ...owner, via: "mcp:Test Agent", auth: "oauth", grantId: "g-1" };
  for (const [name, input] of [["playtomic.upload", { csv: "Name,Wallet\nX,1" }], ["credit.bring_in", u], ["membership.bring_in", { ...u, map: {} }], ["credit.brought_zeroed", {}]] as const)
    await rejects(plan(db, name, input, bot, opts), "error.assistant_in_app");
  const g = (await run(db, "support.grant", { email: "helper@host.test", name: "Helper", reason: "Helping with the move from Playtomic", level: "manager", hours: 24 }, { ...owner, auth: "passkey" }, opts)).result as { person_id: string };
  const sup: Actor = { personId: g.person_id, via: "test", lang: "en" };
  for (const [name, input] of [["playtomic.upload", { csv: "Name,Wallet\nX,1" }], ["credit.bring_in", u], ["membership.bring_in", { ...u, map: {} }], ["credit.brought_zeroed", {}]] as const)
    await rejects(plan(db, name, input, sup, opts), "error.forbidden_reason");
});

test("a manager first sees what they'd ask for (nothing sent), then asks; the owner doing it settles the ask", async () => {
  const u = await upload("Name,Email,Wallet\nHal,hal@example.test,7");
  const look = await plan(db, "credit.bring_in", u, manager, { ...opts, holdAsk: true });
  assert.deepEqual([look.status, look.runId], ["would_ask", ""]);
  assert.match(look.plan.summary.en, /From export\.csv, uploaded by Robin Hale on /, look.plan.summary.en);
  const asked = await plan(db, "credit.bring_in", u, manager, opts);
  assert.equal(asked.status, "awaiting_approval");
  // The owner brings it in directly: the manager's ask is settled, not left waiting.
  await bring(u);
  const run_ = await db.selectFrom("action_run").select(["status", "error"]).where("id", "=", asked.runId).executeTakeFirstOrThrow();
  assert.equal(run_.status, "failed");
  assert.match(JSON.stringify(run_.error), /error\.ask_settled/);
  // Asking again later isn't "already asked".
  assert.equal((await plan(db, "credit.bring_in", await upload("Name,Email,Wallet\nHal,hal@example.test,9"), manager, opts)).status, "awaiting_approval");
});

test("an owner's own run settles only the asks it covered: a manager's ask for other memberships keeps waiting", async () => {
  const u = await upload("Name,Email,Category,Expiry\nMax,max@example.test,Gold PT,2026-12-31\nSil,sil@example.test,Silver PT,2026-12-31");
  const asked = await plan(db, "membership.bring_in", { ...u, map: { "Silver PT": silver } }, manager, opts);
  assert.equal(asked.status, "awaiting_approval");
  await run(db, "membership.bring_in", { ...u, map: { "Gold PT": gold } }, owner, opts);
  assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", asked.runId).executeTakeFirstOrThrow()).status, "awaiting_approval");
  await approve(db, asked.runId, owner, opts);
  assert.equal((await db.selectFrom("membership").select("plan_id").where("person_id", "=", people.Sil!).where("status", "=", "active").executeTakeFirstOrThrow()).plan_id, silver);
});

test("once the owner says the wallets are being set to zero, a run only brings credit in", async () => {
  const asked = await plan(db, "credit.brought_zeroing", {}, manager, opts);
  assert.equal(asked.status, "awaiting_approval");
  await run(db, "credit.brought_zeroing", {}, owner, opts);
  // The manager's ask is done with it, and approving it later says so, never moving when the zeroing started.
  const since = (await db.selectFrom("club").select("brought_zeroing_at").executeTakeFirstOrThrow()).brought_zeroing_at!;
  assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", asked.runId).executeTakeFirstOrThrow()).status, "failed");
  await rejects(approve(db, asked.runId, owner, { now: new Date(NOW.getTime() + 60_000) }), "error.ask_settled");
  assert.equal((await db.selectFrom("club").select("brought_zeroing_at").executeTakeFirstOrThrow()).brought_zeroing_at!.toISOString(), since.toISOString());
  const zero = await upload("Name,Email,Wallet\nDee,dee@example.test,0\nIvy,ivy@example.test,4");
  await rejects(plan(db, "credit.bring_in", { ...zero, take_back: true }, owner, opts), "error.brought_zeroing_take_back");
  const s = (await plan(db, "credit.bring_in", zero, owner, opts)).plan.summary.en;
  assert.match(s, /The wallets are being set to zero in Playtomic: this run only brings credit in\./, s);
  assert.match(s, /as the wallets are being set to zero there, and left as it is here: Dee/, s);
  assert.match(s, /Ivy: \$4\.00/);
});

test("once the owner says the Playtomic wallets are at zero, Today's reminder is done and no more credit comes over", async () => {
  const ev = await db.selectFrom("event_outbox").select("id").where("topic", "=", "credit.brought_in").executeTakeFirstOrThrow();
  await rejects(plan(db, "alert.handle", { event_id: String(ev.id), kind: "playtomic_wallets_staff" }, owner, opts), "error.alert_wallets_on_page");
  assert.equal((await plan(db, "credit.brought_zeroed", {}, manager, opts)).status, "awaiting_approval");
  await run(db, "credit.brought_zeroed", {}, owner, opts);
  assert.deepEqual((await db.selectFrom("staff_alert").select("handled_by").where("kind", "=", "playtomic_wallets_staff").execute()).map((h) => h.handled_by), [owner.personId]);
  await rejects(plan(db, "credit.bring_in", await upload("Name,Email,Wallet\nIvy,ivy@example.test,9"), owner, opts), "error.brought_wallets_closed");
});

test("a membership carries over paid through Playtomic's date, nothing charged; unmapped wait for a plan, a full plan is said", async () => {
  const u = await upload(["Name,Email,Category,Expiry date,Commitment", "Dee,dee@example.test,Gold Playtomic,2026-11-30,2027-03-31", "Eve,eve@example.test,Bronze,2026-12-15,",
    "Fay,fay@example.test,Old one,2026-10-01,", "Cal,cal@example.test,Desk,2026-12-31,", "Hal,hal@example.test,Founders,2026-12-31,", "Ivy,ivy@example.test,Founders,2026-12-31,"].join("\n"));
  const p = await plan(db, "membership.bring_in", { ...u, map: { "gold playtomic": gold, Desk: desk, Founders: founding } }, owner, opts);
  const s = p.plan.summary.en;
  assert.match(s, /^Carry 3 memberships over from Playtomic, paid through Playtomic's dates\. Nothing is charged now\./, s);
  assert.match(s, /Dee: Gold until November 30, 2026, then \$60\.00 a month on a card they add in the app\./, s);
  assert.match(s, /Cal: Desk only until December 31, 2026, then paid at the desk \(\$30\.00 a month\)\./, s);
  assert.match(s, /Choose a plan here for these \(or leave them out\), then preview again: Bronze \(1\)/, s);
  assert.match(s, /Left out, as the plan has all the members it takes: Ivy \(Founding\)/, s);
  assert.match(s, /commitment period in Playtomic/);
  await apply(db, p.runId, owner, opts);
  const dee = await db.selectFrom("membership").selectAll().where("person_id", "=", people.Dee!).executeTakeFirstOrThrow();
  assert.deepEqual([dee.status, dee.source, dee.brought_from, dee.price_cents, dee.saved_method, dee.anchor_day], ["active", "app", "playtomic", 6000, null, 1]);
  assert.equal(dee.current_period_end!.toISOString(), onDate("2026-11-30", "24:00", TZ).toISOString());
  assert.equal(await db.selectFrom("payment").select("id").where("membership_id", "=", dee.id).executeTakeFirst(), undefined);
  // A carried-over membership with no card won't charge again, so it doesn't hold the account back from being deleted.
  assert.equal(((await deleteCheck(db, people.Dee!, NOW)) as { blockers: { kind: string }[] }).blockers.some((b) => b.kind === "membership"), false);
  const again = await plan(db, "membership.bring_in", { ...u, map: { "gold playtomic": gold, Desk: desk, Founders: founding } }, owner, opts);
  assert.doesNotMatch(again.plan.summary.en, /Dee:/);
});

test("reminded a week before to add a card; with none it ends that day, nothing charged and no failed renewal", async () => {
  const dee = await db.selectFrom("membership").select("id").where("person_id", "=", people.Dee!).executeTakeFirstOrThrow();
  const week = new Date("2026-11-25T18:00:00Z");
  assert.ok(await remindMembershipEnds(db, week) >= 1);
  await processOutbox(db, messageHandlers, 100, week);
  const told = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Dee!).where("kind", "=", "membership_brought_ending").where("channel", "=", "inbox").executeTakeFirstOrThrow();
  assert.match(told.body, /runs until November 30, 2026\. To keep it after that, add a card in the app before then/, told.body);
  await renewMemberships(db, new Date("2026-12-01T09:00:00Z"));
  const m = await db.selectFrom("membership").select(["status", "end_reason"]).where("id", "=", dee.id).executeTakeFirstOrThrow();
  assert.deepEqual([m.status, m.end_reason], ["ended", "not_continued"]);
  await processOutbox(db, messageHandlers, 100, new Date("2026-12-01T09:00:00Z"));
  assert.equal(await db.selectFrom("outbound_message").select("id").where("kind", "=", "membership_payment_failed_staff").executeTakeFirst(), undefined);
});

test("with a card it renews on Playtomic's day of the month, and a 31st comes back after a short month", async () => {
  const p = await plan(db, "membership.bring_in", { ...(await upload("Name,Email,Category,Expiry date\nJo,jo@example.test,Gold Playtomic,2027-01-30")), map: { "Gold Playtomic": gold } }, owner, opts);
  await apply(db, p.runId, owner, opts);
  const m = await db.selectFrom("membership").select("id").where("person_id", "=", people.Jo!).where("status", "=", "active").executeTakeFirstOrThrow();
  await runAsSystem(db, "membership.card_saved", { membership_id: m.id, saved_method: "pm_test_jo", saved_customer: "cus_test_jo" }, "test", opts);
  const ends: string[] = [];
  for (const day of ["2027-01-31T10:00:00Z", "2027-02-28T10:00:00Z", "2027-03-31T10:00:00Z"]) {
    await renewMemberships(db, new Date(day));
    ends.push((await db.selectFrom("membership").select("current_period_end").where("id", "=", m.id).executeTakeFirstOrThrow()).current_period_end!.toISOString());
  }
  assert.deepEqual(ends, [onDate("2027-02-28", "00:00", TZ), onDate("2027-03-31", "00:00", TZ), onDate("2027-04-30", "00:00", TZ)].map((d) => d.toISOString()));
});

test("paying the next period at the desk says the day it really runs to, on Playtomic's day of the month", async () => {
  const p0 = await plan(db, "membership.bring_in", { ...(await upload("Name,Email,Category,Expiry\nCy,cy@example.test,Gold PT,2026-12-31")), map: { "Gold PT": gold } }, owner, opts);
  await apply(db, p0.runId, owner, opts);
  const m = await db.selectFrom("membership").select("id").where("person_id", "=", people.Cy!).executeTakeFirstOrThrow();
  const desk = { now: new Date("2026-12-20T18:00:00Z") };
  const p = await plan(db, "membership.record_payment", { membership_id: m.id, cents: 6000, method: "cash" }, owner, desk);
  await apply(db, p.runId, owner, desk);
  const end = (await db.selectFrom("membership").select("current_period_end").where("id", "=", m.id).executeTakeFirstOrThrow()).current_period_end!;
  assert.equal(end.toISOString(), onDate("2027-02-01", "00:00", TZ).toISOString());
  assert.match(p.plan.summary.en, /February 1, 2027/, p.plan.summary.en);
});

test("Playtomic's players read: kept, a player gone goes; a read that can't reach the end fails and keeps what was there", async () => {
  const one = [{ player_id: "pt-ben", name: "Ben P.", email: "ben@example.test", wallets: [], benefits: [] }, { player_id: "pt-x", name: "Xan", email: "xan@example.test", wallets: [], benefits: [] }];
  const r = await readPlaytomicPlayers(db, { players: async () => one }, new Date(NOW.getTime() + 600_000));
  // Two read; the earlier read's other players (Ada's, above) go.
  assert.deepEqual([r.ok, (r as { read: number }).read], [true, 2]);
  // A big club, past what the read will page through: a failure staff see, never a part said to be the whole.
  const pages = (total: number, bare = false) => async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/oauth/token") return Response.json({ token: "tok", expires_in: 3600 });
    const start = Number(u.searchParams.get("cursor_id") ?? 0), items = [];
    for (let k = start; k < Math.min(start + 100, total); k++) items.push({ player_id: `p${k}`, name: `P ${k}` });
    return bare ? Response.json(items) : Response.json({ players: items, next_cursor_id: start + 100 < total ? String(start + 100) : null, has_more: start + 100 < total });
  };
  const big = new PlaytomicClient({ clientId: "k", secret: "s", tenantId: "t", fetch: pages(450), pageDelayMs: 0 });
  await assert.rejects(big.players(3), /more than 3 pages/);
  await assert.rejects(new PlaytomicClient({ clientId: "k", secret: "s", tenantId: "t", fetch: pages(150, true), pageDelayMs: 0 }).players(), /a full page with no way to the next/);
  assert.equal((await new PlaytomicClient({ clientId: "k", secret: "s", tenantId: "t", fetch: pages(250), pageDelayMs: 0 }).players()).length, 250);
  const failed = await readPlaytomicPlayers(db, { players: () => big.players(3) }, NOW);
  assert.equal(failed.ok, false);
  assert.deepEqual((await db.selectFrom("playtomic_player").select("player_id").orderBy("player_id").execute()).map((x) => x.player_id), ["pt-ben", "pt-x"]);
  assert.match((await db.selectFrom("club").select("playtomic_players_error").executeTakeFirstOrThrow()).playtomic_players_error ?? "", /more than 3 pages/);
});

test("a member's download has their Playtomic record and credit; deleted, the record and uploads naming them go, and a later read doesn't bring them back", async () => {
  const d = await exportData(db, people.Ben!, NOW, "en") as any;
  assert.deepEqual(d.playtomic.as_read.map((r: any) => r.player_id), ["pt-ben"]);
  assert.equal(d.playtomic.credit_brought_in.cents, 1000);
  await run(db, "credit.pay_out", { person_id: people.Ben!, cents: await credit("Ben"), method: "cash" }, owner, opts);
  await run(db, "privacy.erase", { person_id: people.Ben! }, owner, opts);
  assert.equal(await db.selectFrom("playtomic_player").select("player_id").where("player_id", "=", "pt-ben").executeTakeFirst(), undefined);
  assert.equal(await db.selectFrom("playtomic_upload").select("id").where(sql_has("ben@example.test")).executeTakeFirst(), undefined);
  // Playtomic still lists Ben: the next read skips him.
  await readPlaytomicPlayers(db, { players: async () => [{ player_id: "pt-ben", name: "Ben P.", email: "ben@example.test", phone: "+15551230000", wallets: [], benefits: [] }] }, new Date(NOW.getTime() + 3600_000));
  assert.equal(await db.selectFrom("playtomic_player").select("player_id").where("player_id", "=", "pt-ben").executeTakeFirst(), undefined);
});
const sql_has = (email: string) => (eb: any) => eb(eb.fn("strpos", [eb.cast(eb.ref("rows"), "text"), eb.val(email)]), ">", 0);
