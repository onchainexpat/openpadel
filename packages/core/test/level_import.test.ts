// A starting level from another app (level_import.ts): staff record what they saw, a player claims their own (at
// once below the club's line, checked by staff above it), a club moving in brings its Playtomic levels, and a player
// can take one away while still new. Never a floor, never surer than a staff-set level, never through an assistant.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { messageHandlers, plan, processOutbox, replay, run, runAsSystem, startSigma, toKumi, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor;
const NOW = new Date("2026-12-01T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function staff(name: string, role: string): Promise<Actor> {
  const id = ((await run(db, "person.create", { display_name: name, email: `${name.split(" ")[0]!.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  return { personId: id, via: "test", lang: "en" };
}
const rating = (who: string) => db.selectFrom("rating").selectAll().where("person_id", "=", people[who] ?? who).executeTakeFirst();
const lastEvent = (who: string) => db.selectFrom("rating_event").selectAll().where("person_id", "=", people[who] ?? who).orderBy("id", "desc").executeTakeFirstOrThrow();
const inbox = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who] ?? who).where("kind", "=", kind).where("channel", "=", "inbox").execute();
async function person(name: string) { people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id; }

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  desk = await staff("Dana Desk", "front_desk"); people.Dana = desk.personId!;
  for (const name of ["Ann", "Ben", "Cy", "Dot", "Eve", "Fay", "Gus", "Ida"]) await person(name);
});
after(async () => drop());

test("how unsure a start is comes from the evidence, never surer than a level staff set", () => {
  assert.equal(startSigma("playtomic", "club_data", {}), 0.6);
  assert.equal(startSigma("playtomic", "staff_seen", { reliability: 80 }), 0.6);
  assert.equal(startSigma("playtomic", "staff_seen", { reliability: 30 }), 0.85);
  assert.equal(startSigma("playtomic", "staff_seen", {}), 0.85);
  assert.equal(startSigma("playtomic", "self", { reliability: 95 }), 1);
  assert.equal(startSigma("matchi", "staff_seen", {}), 1);          // MATCHi's levels are the player's own choice
  assert.equal(startSigma("lta", "public_lookup", {}), 1);
  assert.equal(startSigma("wpr", "staff_seen", { wpr: "HC" }), 0.7);
  assert.equal(startSigma("wpr", "staff_seen", { wpr: "LC" }), 0.85);
  assert.equal(startSigma("wpr", "staff_seen", { wpr: "NC" }), null);
  assert.equal(startSigma("playbypoint", "staff_seen", { matches: 25 }), 0.7);
  assert.equal(startSigma("padellevels", "partner_link", { percent: 73 }), 0.7);
  assert.equal(startSigma("padelmates", "staff_seen", {}), 0.85);
  for (const p of ["playtomic", "playbypoint", "wpr", "matchi", "lta", "padellevels", "padelmates", "other"] as const)
    for (const e of ["club_data", "staff_seen", "public_lookup", "self", "partner_link"] as const) { const s = startSigma(p, e, { reliability: 100, matches: 999, wpr: "HC", percent: 100 }); assert.ok(s === null || s >= 0.6, `${p} ${e}`); }
  // The interim conversions to the club's 0 to 7.
  assert.deepEqual([toKumi("playtomic", 4.25), toKumi("wpr", 8.5), toKumi("wpr", 10.5), toKumi("wpr", 21), toKumi("matchi", 6), toKumi("matchi", 8), toKumi("lta", 3.5)], [4.25, 4.25, 4.75, 7, 4.25, 5.5, 3.5]);
  assert.equal(toKumi("padellevels", 3.46), null);
});

test("staff record a level they saw in the player's app: a provisional start, where it came from kept, never a floor", async () => {
  const r = await run(db, "level.import", { person_id: people.Ann, platform: "playtomic", value: 4.25, reliability: 80, evidence: "staff_seen", last_played: "2026-11-20" }, desk, opts);
  assert.equal(r.plan.summary.en, "Start Ann at 4.25 (now no level yet), from Playtomic (4.25, reliability 80%). It's provisional, games at the club take over, and it never sets a floor.");
  const a = (await rating("Ann"))!;
  assert.deepEqual([a.level, a.sigma, a.floor, a.provisional, a.rated_games], ["4.25", 0.6, null, true, 0]);
  const ev = await lastEvent("Ann");
  assert.equal(ev.kind, "import_seed");
  assert.equal((ev.explanation as any).en, "Starting level 4.25, from Playtomic (4.25, reliability 80%). Seen in the player's app by Dana Desk on December 1, 2026. It's provisional: games at the club take over.");
  assert.deepEqual(ev.factors, { platform: "playtomic", raw: 4.25, conf: { reliability: 80 }, start_level: 4.25, sigma: 0.6, evidence: "staff_seen", external_id: null, last_played: "2026-11-20",
    checked_by: desk.personId, table: "interim-2026-11-07" });
  // Once per app; a WPR rating marked NC is self-assigned and isn't used.
  await rejects(plan(db, "level.import", { person_id: people.Ann, platform: "playtomic", value: 4.5, evidence: "staff_seen" }, desk, opts), "error.import_already");
  await rejects(plan(db, "level.import", { person_id: people.Ben, platform: "wpr", value: 9, wpr: "NC", evidence: "staff_seen" }, desk, opts), "error.import_wpr_nc");
  await rejects(plan(db, "level.import", { person_id: people.Ben, platform: "matchi", value: 6.5, evidence: "staff_seen" }, desk, opts), "error.import_range");
  // An app whose scale isn't converted: staff give the start themselves.
  await rejects(plan(db, "level.import", { person_id: people.Ben, platform: "padelmates", value: 3.2, evidence: "staff_seen" }, desk, opts), "error.import_needs_level");
  // A floor a coach set still holds; the import doesn't set or move one.
  await run(db, "level.set_floor", { person_id: people.Dot, floor: 3, reason: "Coach assessment" }, owner, opts);
  await run(db, "level.import", { person_id: people.Dot, platform: "playtomic", value: 2.5, reliability: 30, evidence: "public_lookup" }, desk, opts);
  const d = (await rating("Dot"))!;
  assert.deepEqual([d.level, d.floor, d.sigma], ["3.00", "3.00", 0.85]);
  assert.equal(((await replay(db)).get(people.Dot!))!.level, 3);
});

test("only while new: before 5 rated games here", async () => {
  await run(db, "level.set", { person_id: people.Eve, level: 3.1, reason: "Starting level" }, owner, opts);
  await db.updateTable("rating").set({ rated_games: 5 }).where("person_id", "=", people.Eve!).execute();
  await rejects(plan(db, "level.import", { person_id: people.Eve, platform: "playtomic", value: 4, evidence: "staff_seen" }, desk, opts), "error.import_late",
    "A level from another app can only come in before 5 rated games here. Ask the club for a review instead.");
  await rejects(plan(db, "level.claim", { person_id: people.Eve, platform: "playtomic", value: 4 }, as("Eve"), opts), "error.import_late");
  await db.updateTable("rating").set({ rated_games: 0 }).where("person_id", "=", people.Eve!).execute();
});

test("a player's claim: at or below the club's line it starts as their own word; above it, staff check it first", async () => {
  // Below the line (4.50): at once, as unsure as a stranger's level but from a better middle.
  const low = await run(db, "level.claim", { person_id: people.Ben, platform: "playtomic", value: 3.8, reliability: 90 }, as("Ben"), opts);
  assert.equal(low.plan.summary.en, "Start your level at 3.80, from Playtomic (3.8, reliability 90%). It's provisional: your first games here move it quickly. You can take it away before 5 rated games.");
  const b = (await rating("Ben"))!;
  assert.deepEqual([b.level, b.sigma, (await lastEvent("Ben")).factors && ((await lastEvent("Ben")).factors as any).evidence], ["3.80", 1, "self"]);
  // Only their own (or their junior's).
  await rejects(plan(db, "level.claim", { person_id: people.Fay, platform: "playtomic", value: 3 }, as("Ben"), opts), "error.forbidden_reason");
  // Above the line: it waits for staff, and staff hear.
  const high = await run(db, "level.claim", { person_id: people.Cy, platform: "playtomic", value: 5.2, reliability: 80 }, as("Cy"), opts);
  assert.equal(high.plan.summary.en, "Send your level on Playtomic (5.2, reliability 80%) to the club. Staff check levels above 4.50 first, for example by looking at your app. You'll hear in the app.");
  assert.equal(await rating("Cy"), undefined);
  const review = await db.selectFrom("level_review").selectAll().where("person_id", "=", people.Cy!).executeTakeFirstOrThrow();
  assert.deepEqual([review.kind, review.status, (review.claim as any).start_level], ["import", "open", 5.2]);
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Dana", "level_import_claimed_staff"))[0]!.body, "Cy says their level on Playtomic is 5.2, reliability 80%. Check it on the Levels page, for example by looking at their app.");
  // Staff check it (Cy shows them the app) and start them there, at the confidence the app shows.
  await rejects(plan(db, "level.import", { person_id: people.Cy, platform: "playtomic", value: 5.2, evidence: "staff_seen" }, desk, opts), "error.import_claim_open");
  const acc = await run(db, "level.answer_review", { person_id: people.Cy, outcome: "accept" }, desk, opts);
  assert.equal(acc.plan.summary.en, "Start Cy at 5.20, from Playtomic (5.2, reliability 80%), as you checked it. They're told.");
  const c = (await rating("Cy"))!;
  assert.deepEqual([c.level, c.sigma], ["5.20", 0.6]);
  assert.equal(((await lastEvent("Cy")).explanation as any).en, "Starting level 5.20, from Playtomic (5.2, reliability 80%). Given in the app and checked by Dana Desk on December 1, 2026. It's provisional: games at the club take over.");
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Cy", "level_import_accepted"))[0]!.body, "The club checked your level from Playtomic, and your level here starts at 5.20. It's provisional: your games at the club take over.");
  // From an app whose scale isn't converted: always staff, who give the start; or they don't use it, and say so.
  await run(db, "level.claim", { person_id: people.Fay, platform: "padelmates", value: 2 }, as("Fay"), opts);
  await rejects(plan(db, "level.answer_review", { person_id: people.Fay, outcome: "accept" }, desk, opts), "error.accept_needs_level");
  await run(db, "level.answer_review", { person_id: people.Fay, outcome: "keep", reason: "Let's see a few games first" }, desk, opts);
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Fay", "level_import_kept"))[0]!.body, "The club looked at your level from Padelmates and didn't use it: your games here set your level. Note: \"Let's see a few games first\"");
  assert.equal(await rating("Fay"), undefined);
  // The club's own line.
  await db.updateTable("club").set({ level_import_line: 3 }).execute();
  await run(db, "level.claim", { person_id: people.Gus, platform: "matchi", value: 5 }, as("Gus"), opts);   // MATCHi 5 is 3.50 here, above 3.00
  assert.equal(await rating("Gus"), undefined);
  await db.updateTable("club").set({ level_import_line: 4.5 }).execute();
});

test("a player takes an import away while new: the level is worked out again without it", async () => {
  // Ben's start was the only thing behind his level: he's back to none, and can bring one again.
  const r = await run(db, "level.remove_import", { person_id: people.Ben }, as("Ben"), opts);
  assert.equal(r.plan.summary.en, "Take away your starting level from Playtomic (3.80). Your level is worked out again without it: no level yet.");
  assert.equal(await rating("Ben"), undefined);
  assert.equal((await replay(db)).get(people.Ben!), undefined);
  assert.equal((await lastEvent("Ben")).kind, "import_removed");
  await rejects(plan(db, "level.remove_import", { person_id: people.Ben }, as("Ben"), opts), "error.no_import");
  await run(db, "level.claim", { person_id: people.Ben, platform: "playtomic", value: 3.6 }, as("Ben"), opts);
  assert.equal((await rating("Ben"))!.level, "3.60");
  // Eve had a level set by staff before her import: taking it away goes back to that.
  await run(db, "level.import", { person_id: people.Eve, platform: "wpr", value: 10.5, wpr: "HC", evidence: "staff_seen" }, desk, opts);
  assert.deepEqual([(await rating("Eve"))!.level, (await rating("Eve"))!.sigma], ["4.75", 0.7]);
  await run(db, "level.remove_import", { person_id: people.Eve }, as("Eve"), opts);
  assert.equal((await rating("Eve"))!.level, "3.10");
  assert.equal(((await replay(db)).get(people.Eve!))!.level, 3.1);
  // Not once they've played 5 rated games here.
  await db.updateTable("rating").set({ rated_games: 5 }).where("person_id", "=", people.Ann!).execute();
  await rejects(plan(db, "level.remove_import", { person_id: people.Ann }, as("Ann"), opts), "error.import_remove_late");
  await db.updateTable("rating").set({ rated_games: 0 }).where("person_id", "=", people.Ann!).execute();
});

test("an assistant or the command line can't claim a level or take one away: that's in the app", async () => {
  const bot: Actor = { personId: people.Ida!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: "g" };
  await rejects(plan(db, "level.claim", { person_id: people.Ida, platform: "playtomic", value: 3 }, bot, opts), "error.assistant_in_app");
  await rejects(plan(db, "level.remove_import", { person_id: people.Ann }, { ...bot, personId: people.Ann! }, opts), "error.assistant_in_app");
});

test("a club moving in: its Playtomic file brings ids, phones, a yes to club news and levels; a re-run updates the same people", async () => {
  // Ann already said no to club news: a yes in the file never overrides an answer.
  await run(db, "consent.club_news", { person_id: people.Ann, granted: false }, as("Ann"), opts);
  const rows = [
    { display_name: "Gil Moss", email: "gil@example.test", phone: "(503) 226-1234", club_news: true, playtomic_id: "pt-111", level: { value: 4.1, reliability: 70 } },
    { display_name: "Hal Ng", email: "hal@example.test", phone: "12", club_news: false, playtomic_id: "pt-222" },
    { display_name: "Ann", email: "ann@example.test", club_news: true, playtomic_id: "pt-333" },
  ];
  const p = await plan(db, "person.import", { rows }, owner, opts);
  assert.equal(p.plan.summary.en, "Add 2 people as members. Nobody is emailed. 1 already here gets what's new in the file (a Playtomic id, a phone, a level or a yes to club news). 1 Playtomic level starts as a provisional level. 1 said yes to club news in the file. 1 phone number couldn't be read and is left out.");
  await run(db, "person.import", { rows }, owner, opts);
  const gil = await db.selectFrom("person").selectAll().where("email", "=", "gil@example.test").executeTakeFirstOrThrow();
  people.Gil = gil.id;
  const hal = await db.selectFrom("person").selectAll().where("email", "=", "hal@example.test").executeTakeFirstOrThrow();
  assert.equal(gil.phone, "+15032261234");
  assert.equal(hal.phone, null);
  const refs = await db.selectFrom("external_ref").select(["external_id", "entity_id"]).where("system", "=", "playtomic").where("entity", "=", "person").orderBy("external_id").execute();
  assert.deepEqual(refs, [{ external_id: "pt-111", entity_id: gil.id }, { external_id: "pt-222", entity_id: hal.id }, { external_id: "pt-333", entity_id: people.Ann }]);
  const consent = async (id: string) => (await db.selectFrom("channel_consent").select(["granted", "source"]).where("person_id", "=", id).where("purpose", "=", "club_news").orderBy("at").execute());
  assert.deepEqual(await consent(gil.id), [{ granted: true, source: "import" }]);
  assert.deepEqual(await consent(hal.id), []);                     // a no in the file adds nothing
  assert.deepEqual(await consent(people.Ann!), [{ granted: false, source: "profile" }]);
  const g = (await rating("Gil"))!;
  assert.deepEqual([g.level, g.sigma], ["4.10", 0.6]);
  assert.equal(((await lastEvent("Gil")).factors as any).evidence, "club_data");
  assert.equal(((await lastEvent("Gil")).factors as any).external_id, "pt-111");
  // The same file again: nobody twice, and nothing new. With Gil's level changed in Playtomic (and no games here yet), it moves;
  // found by the Playtomic id even under another email.
  assert.equal((await plan(db, "person.import", { rows }, owner, opts)).plan.summary.en, "Add 0 people as members; 3 are already here and stay as they are. Nobody is emailed. 1 phone number couldn't be read and is left out.");
  const again = [{ display_name: "Gil Moss", email: "gil.moss@example.test", playtomic_id: "pt-111", level: { value: 4.3 } }];
  await run(db, "person.import", { rows: again }, owner, opts);
  assert.equal(Number((await db.selectFrom("person").select((eb) => eb.fn.countAll<string>().as("n")).where("display_name", "=", "Gil Moss").executeTakeFirstOrThrow()).n), 1);
  assert.deepEqual([(await rating("Gil"))!.level, (await db.selectFrom("person").select("email").where("id", "=", gil.id).executeTakeFirstOrThrow()).email], ["4.30", "gil@example.test"]);
  // Once they've played here, the club's own games count: a later file doesn't move them.
  await db.updateTable("rating").set({ rated_games: 1 }).where("person_id", "=", gil.id).execute();
  assert.equal((await plan(db, "person.import", { rows: [{ ...again[0]!, level: { value: 5 } }] }, owner, opts)).plan.summary.en, "Add 0 people as members; 1 is already here and stays as it is. Nobody is emailed.");
});
