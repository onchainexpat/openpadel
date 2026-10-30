import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { checkPayment, deleteCheck, exportData, exportRun, managersOf, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, subscribePush,
  KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, match: string, mia: string, leo: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z"), LATER = new Date("2026-12-03T20:00:00Z");
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
/** Ann has a passkey, so deleting needs her signed in with it. */
const strong = (name: string): Actor => ({ ...as(name), auth: "passkey" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const count = async (table: string, text: string) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)} t WHERE t::text ILIKE ${`%${text}%`}`.execute(db)).rows[0]!.n);
const level = async (who: string) => Number((await db.selectFrom("rating").select("level").where("person_id", "=", people[who]!).executeTakeFirstOrThrow()).level);

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const [name, full, lv, locale] of [["Ann", "Annabel Quist", 3.5, "en"], ["Ben", "Benito Ortiz", 3.4, "es"], ["Cara", "Cara Lund", 3.6, "en"], ["Dee", "Dee Marsh", 3.3, "en"], ["Eve", "Eve Park", 3.0, "en"]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: full, email: `${name.toLowerCase()}@example.test`, locale }, owner, opts)).result as { person_id: string }).person_id;
    await run(db, "level.set", { person_id: people[name], level: lv, reason: "Starting level" }, owner, opts);
  }
  // Ann opens a rated match; Ben, Cara and Dee join and pay; Ann enters the score and Ben confirms it.
  const r = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-02", "18:00").toISOString(), minutes: 90, pay: "split", person_id: people.Ann, open: { level_min: 3, level_max: 4 } }, as("Ann"), opts);
  match = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Ann");
  for (const who of ["Ben", "Cara", "Dee"]) await pay(((await run(db, "booking.join", { booking_id: match, person_id: people[who] }, as(who), opts)).result as any).payment_id, who);
  const g = await run(db, "result.enter", { booking_id: match, person_id: people.Ann, partner_id: people.Cara, sets: [{ us: 6, them: 3 }, { us: 6, them: 4 }] }, as("Ann"), { now: at("2026-12-02", "20:00") });
  await run(db, "result.confirm", { game_id: (g.result as any).game_id, person_id: people.Ben }, as("Ben"), { now: at("2026-12-02", "20:30") });
  await run(db, "friend.add", { person_id: people.Ann, friend_id: people.Ben }, as("Ann"), opts);
  await run(db, "friend.add", { person_id: people.Ben, friend_id: people.Ann }, as("Ben"), opts);
  // Families: Cara alone with Mia; Dee and Eve both with Leo.
  mia = ((await run(db, "household.add_junior", { person_id: people.Cara, display_name: "Mia Lund", birth_year: 2016 }, as("Cara"), opts)).result as any).person_id;
  leo = ((await run(db, "household.add_junior", { person_id: people.Dee, display_name: "Leo Marsh", birth_year: 2012 }, as("Dee"), opts)).result as any).person_id;
  const inv = await run(db, "household.invite", { person_id: people.Dee }, as("Dee"), opts);
  await run(db, "household.accept_invite", { person_id: people.Eve, code: (inv.result as any).code }, as("Eve"), opts);
  // Ways to reach and recognise Ann: a device, a passkey, a session.
  await subscribePush(db, people.Ann!, "member", { endpoint: "https://fcm.googleapis.com/fcm/send/ann-phone-secret-path", p256dh: "BPk", auth: "aa" }, "Ann's phone");
  await db.insertInto("passkey").values({ credential_id: "ann-passkey-1", person_id: people.Ann!, public_key: Buffer.from("key"), counter: "0", transports: null, name: "Ann's phone" }).execute();
  await db.insertInto("web_session").values({ token_hash: "ann-session", person_id: people.Ann!, expires_at: new Date("2027-01-01"), last_seen_at: NOW, user_agent: "Ann's phone", revoked_at: null }).execute();
  await processOutbox(db, messageHandlers);
});
after(async () => drop());

test("a member downloads their data: everything about them, other people only by name", async () => {
  const r = await run(db, "privacy.export", { person_id: people.Ann }, as("Ann"), { now: LATER });
  assert.equal(r.plan.summary.en, "Download a copy of your data: one file with your profile, bookings, payments, memberships, levels and games, messages, consents, friends and family. Kumi doesn't keep the file; once it's on your device, it's yours.");
  assert.equal((r.result as any).download, `/my/privacy/export/${r.runId}`);
  assert.equal(await exportRun(db, r.runId, people.Ann!, new Date(LATER.getTime() + 60_000)), people.Ann);
  await rejects(exportRun(db, r.runId, people.Ben!, LATER), "error.privacy_export_gone");                                        // not Ben's to fetch
  await rejects(exportRun(db, r.runId, people.Ann!, new Date(LATER.getTime() + 16 * 60_000)), "error.privacy_export_gone");     // and not for long
  const data: any = await exportData(db, people.Ann!, LATER, "en");
  assert.equal(data.profile.email, "ann@example.test");
  assert.equal(data.bookings.length, 1);
  assert.deepEqual([...data.bookings[0].other_players].sort(), ["Benito Ortiz", "Cara Lund", "Dee Marsh"]);
  assert.equal(data.bookings[0].organised_by_you, true);
  assert.deepEqual(data.games[0].partner, ["Cara Lund"]);
  assert.deepEqual(data.games[0].sets, [{ you: 6, them: 3 }, { you: 6, them: 4 }]);
  assert.equal(data.payments.length, 1);
  assert.ok(data.level_history.some((h: any) => /^Won 12 to 7 with Cara Lund/.test(h.why)), JSON.stringify(data.level_history));
  assert.deepEqual(data.friends.map((f: any) => f.name), ["Benito Ortiz"]);
  assert.ok(data.messages.length > 0);
  assert.deepEqual(data.push_devices.map((d: any) => d.service), ["fcm.googleapis.com"]);
  assert.deepEqual(data.sign_in.passkeys.map((p: any) => p.name), ["Ann's phone"]);
  const text = JSON.stringify(data);
  for (const other of ["ben@example.test", "cara@example.test", "dee@example.test", "ann-phone-secret-path"]) assert.ok(!text.includes(other), other);
  // A parent's file has their juniors in it.
  const cara: any = await exportData(db, people.Cara!, LATER, "en");
  assert.deepEqual(cara.juniors.map((j: any) => j.profile.name), ["Mia Lund"]);
  // The club for a member who asked; the member hears of it either way, the club when they did it themselves.
  const o = await run(db, "privacy.export", { person_id: people.Ben }, owner, { now: LATER });
  assert.match(o.plan.summary.en, /^Download a copy of Benito Ortiz's data, as they asked/);
  await processOutbox(db, messageHandlers);
  const kinds = await db.selectFrom("outbound_message").select(["person_id", "kind"]).where("kind", "like", "privacy_%").where("channel", "=", "inbox").execute();
  assert.deepEqual(kinds.map((k) => [k.person_id, k.kind]).sort(), [[people.Ann, "privacy_exported"], [people.Ben, "privacy_exported_by_club"], [people.Robin, "privacy_exported_staff"]].sort());
});

test("deleting waits for what's still running, and says how to clear each", async () => {
  // A court to come, and a membership that renews from the card.
  const b = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-05", "10:00").toISOString(), minutes: 90, pay: "whole", person_id: people.Ann }, as("Ann"), { now: LATER });
  const plans = await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, { now: LATER });
  const m = await run(db, "membership.grant", { person_id: people.Ann, plan_id: (plans.result as any).plan_id }, owner, { now: LATER });
  await db.updateTable("membership").set({ source: "app", current_period_end: new Date("2026-12-30T08:00:00Z") }).where("id", "=", (m.result as any).membership_id).execute();   // as if joined in the app
  const c = await deleteCheck(db, people.Ann!, LATER);
  assert.deepEqual(c.blockers.map((x) => [x.kind, x.text.en, x.how.en]), [
    ["bookings", "1 booking or match place still to come", "cancel them, or leave the matches, on My places"],
    ["membership", "The Monthly membership, which still charges or covers other people", "cancel it on the Membership page, and take anyone else off it; once it won't charge again, the account can go"]]);
  await rejects(plan(db, "privacy.erase", { person_id: people.Ann }, as("Ann"), { now: LATER }), "error.need_passkey");
  await rejects(plan(db, "privacy.erase", { person_id: people.Ann }, strong("Ann"), { now: LATER }), "error.privacy_blocked");
  // Cleared: the court cancelled, the membership set to end (it then simply ends with the account).
  await run(db, "booking.cancel", { booking_id: (b.result as any).booking_id }, as("Ann"), { now: LATER });
  await run(db, "membership.cancel", { membership_id: (m.result as any).membership_id }, as("Ann"), { now: LATER });
  const c2 = await deleteCheck(db, people.Ann!, LATER);
  assert.deepEqual(c2.blockers, []);
  assert.deepEqual(c2.ends.map((e) => e.en), ["The membership, which won't be charged again, stops now, with nothing back for the rest of it."]);
  // Staff are staff first; a kid asks a parent.
  assert.deepEqual((await deleteCheck(db, people.Robin!, LATER)).blockers.map((x) => x.kind), ["staff"]);
  await run(db, "kid.give_login", { person_id: leo, email: "leo@example.test" }, as("Dee"), { now: LATER });
  await rejects(plan(db, "privacy.erase", { person_id: leo }, { personId: leo, via: "test", lang: "en" }, { now: LATER }), "error.privacy_kid_parent");
});

test("deleting an account: nothing to reach or recognise them by, while the books and other players' levels stand", async () => {
  const benBefore = await level("Ben"), annLevel = await level("Ann");
  const p = await plan(db, "privacy.erase", { person_id: people.Ann }, strong("Ann"), { now: LATER });
  assert.equal(p.plan.summary.en, "Delete your account for good. Your name, email, phone, sign-ins, devices, friends and family links are removed, and you're signed out everywhere. "
    + "The membership, which won't be charged again, stops now, with nothing back for the rest of it. Payments, refunds and game results stay, for the club's books and other players' levels, under \"Former member\". This can't be undone.");
  await run(db, "privacy.erase", { person_id: people.Ann }, strong("Ann"), { now: LATER });
  const ann = await db.selectFrom("person").selectAll().where("id", "=", people.Ann!).executeTakeFirstOrThrow();
  assert.deepEqual([ann.display_name, ann.email, ann.phone, ann.status, Boolean(ann.redacted_at)], ["Former member", null, null, "archived", true]);
  for (const t of ["auth_identity", "passkey", "web_session", "push_subscription"])
    assert.equal(Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)} WHERE person_id = ${people.Ann}`.execute(db)).rows[0]!.n), 0, t);
  assert.equal((await db.selectFrom("friend").select("id").where("removed_at", "is", null).where((w) => w.or([w("person_id", "=", people.Ann!), w("friend_id", "=", people.Ann!)])).execute()).length, 0);
  assert.equal((await db.selectFrom("membership").select("status").where("person_id", "=", people.Ann!).executeTakeFirstOrThrow()).status, "ended");
  // Her messages are a record that something was sent, without the words.
  assert.deepEqual([...new Set((await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).execute()).map((m) => m.body))], ["[removed]"]);
  // Nowhere in the history: not the change log, the events, or anyone's messages or level reasons.
  for (const t of ["action_run", "entity_change", "event_outbox", "outbound_message", "rating_event", "kid_request"]) {
    assert.equal(await count(t, "ann@example.test"), 0, `${t}: email`);
    assert.equal(await count(t, "Annabel"), 0, `${t}: name`);
  }
  // Others' words say "Former member" in their own language (Ben reads Spanish).
  const ben = await db.selectFrom("rating_event").select("explanation").where("person_id", "=", people.Ben!).where("game_id", "is not", null).executeTakeFirstOrThrow();
  assert.match((ben.explanation as any).en, /Former member/);
  assert.match((ben.explanation as any).es, /Exmiembro/);
  const toBen = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ben!).where("kind", "=", "result_to_confirm").where("channel", "=", "inbox").executeTakeFirstOrThrow();
  assert.match(toBen.body, /^Exmiembro anotó Exmiembro y Cara Lund 6-3 6-4 Benito Ortiz y Dee Marsh/);
  // Level history keeps its numbers whatever happens: only the words could change.
  await assert.rejects(db.updateTable("rating_event").set({ level_after: "1.00" }).where("person_id", "=", people.Ben!).execute(), /append-only/);
  // The game still counts: the same sides, and nobody's level moved.
  assert.equal(await level("Ben"), benBefore);
  assert.equal(await level("Ann"), annLevel);
  assert.equal((await db.selectFrom("game_side").select("person_id").where("person_id", "=", people.Ann!).execute()).length, 1);
  assert.equal(Number((await db.selectFrom("payment").select(sql<string>`count(*)`.as("n")).where("person_id", "=", people.Ann!).where("status", "=", "succeeded").executeTakeFirstOrThrow()).n), 1);
  await rejects(plan(db, "privacy.erase", { person_id: people.Ann }, owner, { now: LATER }), "error.privacy_already");
  // The club hears, without a name.
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Robin!).where("kind", "=", "privacy_erased_staff").where("channel", "=", "inbox").executeTakeFirstOrThrow();
  assert.equal(told.subject, "An account was deleted");
  assert.match(told.body, /^An account was deleted on .+, by the member\. The name and contact details are gone/);
});

test("juniors: one only this parent manages goes with them; one with another parent stays with that parent", async () => {
  const p = await plan(db, "privacy.erase", { person_id: people.Cara }, as("Cara"), { now: LATER });
  assert.match(p.plan.summary.en, /Mia Lund is deleted too, as nobody else in the family manages them\. /);
  await run(db, "privacy.erase", { person_id: people.Cara }, as("Cara"), { now: LATER });
  const m = await db.selectFrom("person").select(["display_name", "status", "redacted_at"]).where("id", "=", mia).executeTakeFirstOrThrow();
  assert.deepEqual([m.display_name, m.status, Boolean(m.redacted_at)], ["Former member", "archived", true]);
  await run(db, "privacy.erase", { person_id: people.Dee }, as("Dee"), { now: LATER });
  const l = await db.selectFrom("person").select(["display_name", "status"]).where("id", "=", leo).executeTakeFirstOrThrow();
  assert.deepEqual([l.display_name, l.status], ["Leo Marsh", "active"]);
  assert.deepEqual(await managersOf(db, leo), [people.Eve]);
});

test("for anyone else, a manager asks the owner; front desk can't", async () => {
  const mgr = ((await run(db, "person.create", { display_name: "Mo Grant", email: "mo@example.test" }, owner, { now: NOW })).result as any).person_id;
  await run(db, "role.assign", { person_id: mgr, role: "manager" }, owner, { now: NOW });
  const p = await plan(db, "privacy.erase", { person_id: people.Eve }, { personId: mgr, via: "test", lang: "en" }, { now: LATER });
  assert.equal(p.status, "awaiting_approval");
  const desk = ((await run(db, "person.create", { display_name: "Dot Desk", email: "dot@example.test" }, owner, { now: NOW })).result as any).person_id;
  await run(db, "role.assign", { person_id: desk, role: "front_desk" }, owner, { now: NOW });
  await rejects(plan(db, "privacy.export", { person_id: people.Eve }, { personId: desk, via: "test", lang: "en" }, { now: LATER }), "error.forbidden_reason");
});
