// Levels players bring from other apps (level_claims.ts): each app's conversion at its edges, several claims with the
// surest one as the start, a screenshot kept private and deleted, staff and coaches confirming, changing and turning
// claims down, nothing once a player has 5 rated games here, and the preview's words in English and Spanish.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { claimProof, IMPORT_TABLE, importOptions, messageHandlers, plan, processOutbox, replay, run, runAsSystem, stageProof, tidyLevelProofs, toKumi, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, coach: Actor;
const NOW = new Date("2026-12-01T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string, lang: "en" | "es" = "en"): Actor => ({ personId: people[name]!, via: "test", lang });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function staff(name: string, role: string): Promise<Actor> {
  const id = ((await run(db, "person.create", { display_name: name, email: `${name.split(" ")[0]!.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  return { personId: id, via: "test", lang: "en" };
}
const rating = (who: string) => db.selectFrom("rating").selectAll().where("person_id", "=", people[who]!).executeTakeFirst();
const claimFrom = (who: string, platform: string) => db.selectFrom("level_claim").selectAll().where("person_id", "=", people[who]!).where("platform", "=", platform).orderBy("created_at", "desc").executeTakeFirstOrThrow();
const inbox = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "inbox").execute();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a screenshot of the other app")]);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  desk = await staff("Dana Desk", "front_desk");
  coach = await staff("Cole Coach", "coach");
  for (const name of ["Ann", "Ben", "Cy", "Dot", "Eve", "Fay", "Gus", "Hal"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  }
});
after(async () => drop());

test("each app's scale at its edges: converted where it's published, staff decide where it isn't", async () => {
  assert.equal(IMPORT_TABLE, "interim-2026-11-18");
  assert.deepEqual([toKumi("playtomic", 0), toKumi("playtomic", 7), toKumi("playbypoint", 1), toKumi("playbypoint", 7)], [0, 7, 1, 7]);
  assert.deepEqual([toKumi("wpr", 0), toKumi("wpr", 2), toKumi("wpr", 15), toKumi("wpr", 21)], [1.5, 2.25, 6, 7]);
  assert.deepEqual([toKumi("matchi", 1), toKumi("matchi", 10), toKumi("lta", 1), toKumi("lta", 7)], [1, 6.5, 1, 7]);
  for (const p of ["padellevels", "padelmates", "courtreserve", "other"] as const) assert.equal(toKumi(p, 3.5), null, p);
  const try_ = (platform: string, value: number, more = {}) => plan(db, "level.claim", { person_id: people.Hal, platform, value, ...more }, as("Hal"), opts);
  await rejects(try_("playtomic", 7.01), "error.import_range");
  await rejects(try_("playbypoint", 0.9), "error.import_range");
  await rejects(try_("wpr", 21.5), "error.import_range");
  await rejects(try_("matchi", 0), "error.import_range");
  await rejects(try_("matchi", 4.5), "error.import_range");          // MATCHi's levels are whole numbers
  await rejects(try_("wpr", 9, { wpr: "NC" }), "error.import_wpr_nc");
  // CourtReserve's own ratings are each club's scale: always staff.
  const cr = await try_("courtreserve", 3.5);
  assert.equal(cr.plan.summary.en, "Send your level on CourtReserve (a club's own rating) (3.5) to the club. Staff choose your starting level from it, since levels from CourtReserve (a club's own rating) aren't converted here. You'll hear in the app.");
});

test("several apps at once: the surest sets the start, every claim is shown, and the next takes over when one goes", async () => {
  // MATCHi is the player's own choice of level: a start, but the least sure kind.
  await run(db, "level.claim", { person_id: people.Ann, platform: "matchi", value: 6 }, as("Ann"), opts);
  assert.equal((await rating("Ann"))!.level, "4.25");
  // Playtomic at 80% reliability: still their word, but its app is surer of it, so it's the start now.
  const pt = await run(db, "level.claim", { person_id: people.Ann, platform: "playtomic", value: 3.9, reliability: 80 }, as("Ann"), opts);
  assert.match(pt.plan.summary.en, /^Your level from Playtomic \(3\.9, reliability 80%\) starts you at 3\.90 here/);
  assert.equal((await rating("Ann"))!.level, "3.90");
  // A WPR with low confidence is kept beside it, not used.
  const wpr = await run(db, "level.claim", { person_id: people.Ann, platform: "wpr", value: 8.5, wpr: "LC" }, as("Ann"), opts);
  assert.equal(wpr.plan.summary.en, "Keep your level from World Padel Rating (WPR) (8.5, confidence LC) with your others. Your start stays at 3.90, from Playtomic, which is surer.");
  assert.equal((await rating("Ann"))!.level, "3.90");
  // One per app.
  await rejects(plan(db, "level.claim", { person_id: people.Ann, platform: "playtomic", value: 4 }, as("Ann"), opts), "error.import_already");
  const o = await importOptions(db, people.Ann!);
  assert.deepEqual(o.claims.map((c) => [c.platform, c.status, c.is_start]).sort(), [["matchi", "standing", false], ["playtomic", "standing", true], ["wpr", "standing", false]]);
  // Staff see the WPR in the app: seen, it's surer than any word alone, and becomes the start.
  const w = await claimFrom("Ann", "wpr");
  const conf = await run(db, "level.answer_claim", { claim_id: w.id, outcome: "confirm" }, desk, opts);
  assert.equal(conf.plan.summary.en, "Confirm Ann's level from World Padel Rating (WPR) (8.5, confidence LC) as seen: a start of 4.25, surer than their word alone. It becomes their start here, 4.25, provisional. They're told.");
  assert.deepEqual([(await rating("Ann"))!.level, (await rating("Ann"))!.sigma], ["4.25", 0.85]);
  // Ann takes the WPR away: Playtomic is the surest left.
  const rm = await run(db, "level.remove_claim", { claim_id: w.id }, as("Ann"), opts);
  assert.equal(rm.plan.summary.en, "Take away the level from World Padel Rating (WPR) (8.5, confidence LC). The start becomes 3.90, from Playtomic.");
  assert.deepEqual([(await rating("Ann"))!.level, (await rating("Ann"))!.sigma], ["3.90", 1]);
  assert.equal((await replay(db)).get(people.Ann!)!.level, 3.9);
  // Staff turn the Playtomic one down: MATCHi's is what's left.
  const p2 = await claimFrom("Ann", "playtomic");
  const rej = await run(db, "level.answer_claim", { claim_id: p2.id, outcome: "reject", reason: "The app shows another player" }, desk, opts);
  assert.equal(rej.plan.summary.en, "Turn down Ann's level from Playtomic (3.9, reliability 80%): \"The app shows another player\". The start becomes 4.25, from MATCHi. They're told.");
  assert.equal((await rating("Ann"))!.level, "4.25");
  assert.equal((await replay(db)).get(people.Ann!)!.level, 4.25);
  const after = await importOptions(db, people.Ann!);
  assert.deepEqual(after.claims.find((c) => c.platform === "playtomic")!.answer, "The app shows another player");
  assert.equal(after.claims.find((c) => c.platform === "matchi")!.is_start, true);
  assert.equal(after.claims.some((c) => c.platform === "wpr"), false);   // taken away: not listed
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Ann", "level_claim_rejected"))[0]!.body, "The club looked at your level from Playtomic and didn't use it: your games here set your level. Note: \"The app shows another player\"");
});

test("a screenshot as proof: only for that player's claim, kept for them and staff, deleted once answered or after 60 days", async () => {
  await rejects(stageProof(db, people.Ben!, people.Ben!, Buffer.from("not a picture"), NOW), "error.proof_type");
  await rejects(stageProof(db, people.Ben!, people.Ben!, Buffer.alloc(2_000_001, 1), NOW), "error.proof_big");
  const { proof_id } = await stageProof(db, people.Ben!, people.Ben!, PNG, NOW);
  // Someone else can't name it, nor can Ben for another person.
  await rejects(plan(db, "level.claim", { person_id: people.Cy, platform: "playtomic", value: 5, proof_id }, as("Cy"), opts), "error.proof_gone");
  const sent = await run(db, "level.claim", { person_id: people.Ben, platform: "playtomic", value: 5, reliability: 70, proof_id, profile_url: "https://playtomic.com/profile/ben" }, as("Ben"), opts);
  assert.equal(sent.plan.summary.en, "Send your level on Playtomic (5, reliability 70%) to the club. Staff check levels above 4.50 first, for example by looking at your app. You'll hear in the app. The screenshot is seen only by you and the club's staff, and is deleted once they answer, or after 60 days.");
  const c = await claimFrom("Ben", "playtomic");
  assert.deepEqual([c.status, c.proof, c.profile_url], ["waiting", "kept", "https://playtomic.com/profile/ben"]);
  assert.ok((await claimProof(db, c.id))!.bytes.equals(PNG));
  await rejects(plan(db, "level.claim", { person_id: people.Ben, platform: "wpr", value: 9, proof_id }, as("Ben"), opts), "error.proof_gone");   // used once
  // Staff answer it: the screenshot goes.
  await run(db, "level.answer_claim", { claim_id: c.id, outcome: "confirm" }, desk, opts);
  assert.equal(await claimProof(db, c.id), null);
  assert.equal((await claimFrom("Ben", "playtomic")).proof, "deleted");
  assert.deepEqual([(await rating("Ben"))!.level, (await rating("Ben"))!.sigma], ["5.00", 0.6]);
  // Nobody answers Dot's: 60 days on, it's deleted anyway. One never named by a claim goes after an hour.
  const dot = await stageProof(db, people.Dot!, people.Dot!, PNG, NOW);
  await run(db, "level.claim", { person_id: people.Dot, platform: "padelmates", value: 40, proof_id: dot.proof_id }, as("Dot"), opts);
  await stageProof(db, people.Dot!, people.Dot!, PNG, NOW);
  assert.deepEqual(await tidyLevelProofs(db, new Date(NOW.getTime() + 2 * 3600_000)), { dropped: 1, expired: 0 });
  assert.deepEqual(await tidyLevelProofs(db, new Date(NOW.getTime() + 61 * 86400_000)), { dropped: 0, expired: 1 });
  assert.equal((await claimFrom("Dot", "padelmates")).proof, "deleted");
  // Taking a claim back deletes its screenshot too.
  const fay = await stageProof(db, people.Fay!, people.Fay!, PNG, NOW);
  await run(db, "level.claim", { person_id: people.Fay, platform: "courtreserve", value: 4, proof_id: fay.proof_id }, as("Fay"), opts);
  const fc = await claimFrom("Fay", "courtreserve");
  const back = await run(db, "level.remove_claim", { claim_id: fc.id }, as("Fay"), opts);
  assert.equal(back.plan.summary.en, "Take back the level from CourtReserve (a club's own rating) (4) before the club answers.");
  assert.equal(await claimProof(db, fc.id), null);
});

test("staff give another start, or a coach turns one down; the player hears either way", async () => {
  await run(db, "level.claim", { person_id: people.Gus, platform: "courtreserve", value: 3.5 }, as("Gus"), opts);
  const g = await claimFrom("Gus", "courtreserve");
  await rejects(plan(db, "level.answer_claim", { claim_id: g.id, outcome: "change", level: 3.8 }, desk, opts), "error.change_needs_level");
  const ch = await run(db, "level.answer_claim", { claim_id: g.id, outcome: "change", level: 3.8, reason: "Their club's 3.5 is our 3.8" }, desk, opts);
  assert.equal(ch.plan.summary.en, "Start Gus at 3.80, not as CourtReserve (a club's own rating) shows it (3.5): \"Their club's 3.5 is our 3.8\". It becomes their start here, 3.80, provisional. They're told.");
  assert.deepEqual([(await rating("Gus"))!.level, (await rating("Gus"))!.sigma], ["3.80", 0.85]);
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Gus", "level_claim_changed"))[0]!.body, "The club looked at your level from CourtReserve (a club's own rating) and gave it a start of 3.80 here. Your level is 3.80, provisional: your games at the club take over. Note: \"Their club's 3.5 is our 3.8\"");
  await rejects(plan(db, "level.answer_claim", { claim_id: g.id, outcome: "confirm" }, desk, opts), "error.claim_answered");
  // A coach (level.* is theirs) turns another down.
  await run(db, "level.claim", { person_id: people.Gus, platform: "padelmates", value: 55 }, as("Gus"), opts);
  const pm = await claimFrom("Gus", "padelmates");
  await run(db, "level.answer_claim", { claim_id: pm.id, outcome: "reject", reason: "Padelmates levels vary a lot" }, coach, opts);
  assert.equal((await claimFrom("Gus", "padelmates")).status, "rejected");
  assert.equal((await rating("Gus"))!.level, "3.80");
  // A player can't answer their own.
  await run(db, "level.claim", { person_id: people.Gus, platform: "other", value: 3 }, as("Gus"), opts);
  await rejects(plan(db, "level.answer_claim", { claim_id: (await claimFrom("Gus", "other")).id, outcome: "confirm", level: 6 }, as("Gus"), opts), "error.forbidden_reason");
});

test("only while new: no claim, confirm or taking away after 5 rated games; a claim turned down then leaves the level alone", async () => {
  await run(db, "level.claim", { person_id: people.Eve, platform: "playtomic", value: 3.2 }, as("Eve"), opts);
  await run(db, "level.claim", { person_id: people.Eve, platform: "padelmates", value: 30 }, as("Eve"), opts);   // waits for staff
  await db.updateTable("rating").set({ rated_games: 5 }).where("person_id", "=", people.Eve!).execute();
  await rejects(plan(db, "level.claim", { person_id: people.Eve, platform: "wpr", value: 7, wpr: "HC" }, as("Eve"), opts), "error.import_late");
  const pt = await claimFrom("Eve", "playtomic");
  await rejects(plan(db, "level.answer_claim", { claim_id: pt.id, outcome: "confirm" }, desk, opts), "error.import_late");
  await rejects(plan(db, "level.remove_claim", { claim_id: pt.id }, as("Eve"), opts), "error.import_remove_late");
  const rej = await run(db, "level.answer_claim", { claim_id: pt.id, outcome: "reject", reason: "Not the same player" }, desk, opts);
  assert.match(rej.plan.summary.en, /The level stays as the games here have it\./);
  assert.equal((await rating("Eve"))!.level, "3.20");
  // One still waiting can be taken back whenever.
  await run(db, "level.remove_claim", { claim_id: (await claimFrom("Eve", "padelmates")).id }, as("Eve"), opts);
  // And the staff queue lists neither now.
  const q = await (await import("../src/index.ts")).claimQueue(db);
  assert.equal(q.some((c) => c.person_id === people.Eve), false);
});

test("in Spanish, and through a player's assistant: the same preview, ready to show", async () => {
  const bot: Actor = { personId: people.Cy!, via: "mcp:Test Agent", lang: "es", auth: "oauth" };
  await run(db, "level.claim", { person_id: people.Cy, platform: "matchi", value: 5 }, bot, opts);
  const p = await plan(db, "level.claim", { person_id: people.Cy, platform: "lta", value: 3.5 }, bot, opts);
  assert.equal(p.plan.summary.es, "Guardar tu nivel de rating LTA (3.5) con los demás. Tu inicio se queda en 3.50, de MATCHi, que es más seguro.");
  // A screenshot only comes from the app: an assistant can't have one to name.
  await rejects(plan(db, "level.claim", { person_id: people.Cy, platform: "lta", value: 3.5, proof_id: uuidv7() }, bot, opts), "error.proof_gone");
  const c = await claimFrom("Cy", "matchi");
  const r = await plan(db, "level.answer_claim", { claim_id: c.id, outcome: "reject", reason: "Necesitamos ver tu app" }, { ...desk, lang: "es" }, opts);
  assert.equal(r.plan.summary.es, "Rechazar el nivel de Cy de MATCHi (5): \"Necesitamos ver tu app\". Sin nada más detrás, no hay nivel hasta jugar aquí. Se le avisa.");
});
