// Undoing a change to the club's details: what the move-in from Playtomic writes (its runs, a read of Playtomic's
// players, the wallets being set to zero) is kept off the club's row (110), so it never stands in the way, and the
// undo's preview says what goes back, as the change said what it changed to.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, plan, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner);
});
after(async () => drop());

test("the move-in after a details change doesn't stop its undo, and the undo says what goes back", async () => {
  await run(db, "club.update", { legal_name: "Kestrel Padel Co.", court_bookings: false }, owner);
  const change = await run(db, "club.update", { legal_name: "Kestrel Padel LLC", court_bookings: true }, owner);
  // Then the move-in: a read of Playtomic's players asked for, a file's wallets brought in, the wallets being zeroed.
  await run(db, "playtomic.read_players", {}, owner);
  const up = (await run(db, "playtomic.upload", { csv: "Name,Email,Wallet\nMia,mia@example.test,5", file_name: "export.csv" }, owner)).result as { upload_id: string; sha256: string };
  await run(db, "credit.bring_in", { source: "file", ...up }, owner);
  await run(db, "credit.brought_zeroing", {}, owner);
  const undo = await plan(db, "action.undo", { run_id: change.runId }, owner);
  assert.match(undo.plan.summary.en, /^Undo: /, undo.plan.summary.en);
  assert.match(undo.plan.summary.en, /the legal name goes back to Kestrel Padel Co\./);
  assert.match(undo.plan.summary.en, /whether members book courts in the app goes back to no/);
  assert.doesNotMatch(undo.plan.summary.en, /\.\.$/);
  assert.match(undo.plan.summary.es, /^Deshacer: .*el nombre legal vuelve a Kestrel Padel Co\./, undo.plan.summary.es);
  await apply(db, undo.runId, owner);
  const club = await db.selectFrom("club").select(["legal_name", "court_bookings"]).executeTakeFirstOrThrow();
  assert.deepEqual(club, { legal_name: "Kestrel Padel Co.", court_bookings: false });
  // The move-in's own state is as it was: the undo put back only the club's details.
  const m = await db.selectFrom("move_in").select(["brought_wallets_at", "brought_zeroing_at", "playtomic_players_wanted_at"]).executeTakeFirstOrThrow();
  assert.ok(m.brought_wallets_at && m.brought_zeroing_at && m.playtomic_players_wanted_at, JSON.stringify(m));
});

test("one setting's undo is one sentence, and an emptied one goes back to nothing", async () => {
  const set = await run(db, "club.update", { legal_name: "Kestrel Padel Club" }, owner);
  assert.equal((await plan(db, "action.undo", { run_id: set.runId }, owner)).plan.summary.en, "Undo: the legal name goes back to Kestrel Padel Co.");
  await run(db, "club.update", { legal_name: "" }, owner);
  const named = await run(db, "club.update", { legal_name: "Kestrel Padel Club" }, owner);
  const back = (await plan(db, "action.undo", { run_id: named.runId }, owner)).plan.summary;
  assert.deepEqual(back, { en: "Undo: the legal name goes back to nothing.", es: "Deshacer: el nombre legal vuelve a quedar en blanco." });
});
