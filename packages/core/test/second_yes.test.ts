// A second yes (role.second_yes, actions.ts secondYesNeeded): the changes the club names, and any change by staff over
// an amount, wait for two different people's yes. Never the asker, never the same person twice, and two people saying
// yes at once are counted one after the other. A no is kept with when it was said.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { approve, decline, isYesWaiting, mayAnswer, plan, run, runAsSystem, secondYesNeeded, KumiError, type Actor, type Db, type Plan } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, sam: Actor, lee: Actor, mia: Actor, member: Actor;
const as = (personId: string, auth: Actor["auth"] = "two_factor"): Actor => ({ personId, via: "test", lang: "en", auth });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function person(name: string, role: string | null) {
  const id = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as { person_id: string }).person_id;
  if (role) await run(db, "role.assign", { person_id: id, role }, owner);
  return as(id);
}
const runRow = (id: string) => db.selectFrom("action_run").select(["id", "action", "input", "plan", "location_id", "actor_person_id", "status", "approved_by", "yeses", "yeses_needed", "ended_at", "error"])
  .where("id", "=", id).executeTakeFirstOrThrow();
const yesBy = async (id: string) => ((await runRow(id)).yeses as { by: string }[]).map((y) => y.by);
let n = 0;
const askTag = (who: Actor = mia) => plan(db, "tag.create", { name: `Tag ${++n}` }, who);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id, "passkey");
  sam = await person("Sam", "owner");
  lee = await person("Lee", "owner");
  mia = await person("Mia", "manager");
  member = await person("Pat", null);
});
after(async () => drop());

test("the rule: the owner's to set, a manager asks; it names real changes, never itself; its undo puts it back", async () => {
  const asked = await plan(db, "role.second_yes", { actions: ["tag.create"], over_cents: 5000 }, mia);
  assert.equal(asked.status, "awaiting_approval");
  assert.equal(asked.yesesNeeded, 1);
  await rejects(plan(db, "role.second_yes", { actions: ["role.second_yes"], over_cents: null }, owner), "error.second_yes_not_here");
  await rejects(plan(db, "role.second_yes", { actions: ["nothing.here"], over_cents: null }, owner), "error.second_yes_not_here");
  await rejects(plan(db, "role.second_yes", { actions: ["tag.create", "tag.create"], over_cents: null }, owner), "error.role_grant_twice");
  const p = await plan(db, "role.second_yes", { actions: ["tag.create"], over_cents: 5000 }, owner);
  assert.match(p.plan.summary.en, /two different people have to say yes.*Make a tag.*more than \$50\.00/i);
  assert.match(p.plan.summary.es, /dos personas distintas/);
  assert.equal(p.plan.undo.kind, "reversible");
  const off = await plan(db, "role.second_yes", { actions: [], over_cents: null }, owner);
  assert.match(off.plan.summary.en, /no change needs a second yes/);
  const set = await run(db, "role.second_yes", { actions: ["tag.create"], over_cents: 5000 }, owner);
  const rule = () => db.selectFrom("club").select(["second_yes_actions", "second_yes_over_cents"]).executeTakeFirstOrThrow();
  assert.deepEqual(await rule(), { second_yes_actions: ["tag.create"], second_yes_over_cents: 5000 });
  await run(db, "action.undo", { run_id: set.runId }, owner);
  assert.deepEqual(await rule(), { second_yes_actions: [], second_yes_over_cents: null });
});

test("a named change waits for two yeses: not the asker's, the same person twice counts once, and the audit keeps both", async () => {
  await run(db, "role.second_yes", { actions: ["tag.create"], over_cents: null }, owner);
  const asked = await askTag();
  assert.equal(asked.status, "awaiting_approval");
  assert.equal(asked.yesesNeeded, 2);
  await rejects(approve(db, asked.runId, mia), "error.own_approval");
  const first = await approve(db, asked.runId, owner);
  assert.ok(isYesWaiting(first));
  assert.deepEqual(first.yes_waiting, { yeses: 1, needed: 2 });
  assert.equal((await runRow(asked.runId)).status, "awaiting_approval");
  // Saying yes again gives the same answer and adds nothing.
  assert.deepEqual(await approve(db, asked.runId, owner), { yes_waiting: { yeses: 1, needed: 2 } });
  assert.deepEqual(await yesBy(asked.runId), [owner.personId]);
  // Whoever said yes isn't asked again; someone else is.
  const row = await runRow(asked.runId);
  assert.equal(await mayAnswer(db, row, owner.personId, new Date()), false);
  assert.equal(await mayAnswer(db, row, sam.personId, new Date()), true);
  const done = await approve(db, asked.runId, sam);
  assert.ok(!isYesWaiting(done));
  const after = await runRow(asked.runId);
  assert.deepEqual([after.status, after.approved_by], ["applied", sam.personId]);
  assert.deepEqual(await yesBy(asked.runId), [owner.personId, sam.personId]);
  // A late yes from the first approver: the change is done, and they get its answer, not an error.
  assert.deepEqual(await approve(db, asked.runId, owner), done);
  await rejects(approve(db, asked.runId, lee), "error.not_planned");
});

test("the owner's own change under the rule still needs two other people", async () => {
  const asked = await askTag(owner);
  assert.equal(asked.status, "awaiting_approval");
  await rejects(approve(db, asked.runId, owner), "error.own_approval");
  assert.ok(isYesWaiting(await approve(db, asked.runId, sam)));
  assert.ok(!isYesWaiting(await approve(db, asked.runId, lee)));
  assert.equal((await runRow(asked.runId)).status, "applied");
});

test("two people saying yes at once are counted one after the other: it happens once, with both yeses", async () => {
  const asked = await askTag();
  const answers = await Promise.allSettled([approve(db, asked.runId, owner), approve(db, asked.runId, sam)]);
  assert.deepEqual(answers.map((a) => a.status), ["fulfilled", "fulfilled"]);
  const values = answers.map((a) => (a as PromiseFulfilledResult<unknown>).value);
  assert.equal(values.filter(isYesWaiting).length, 1, "one is the first yes, the other makes it happen");
  const row = await runRow(asked.runId);
  assert.equal(row.status, "applied");
  assert.deepEqual((await yesBy(asked.runId)).sort(), [owner.personId, sam.personId].sort());
  assert.equal(await db.selectFrom("tag").select("id").where("name", "=", `Tag ${n}`).execute().then((r) => r.length), 1);

  // The last yes given twice at once: one makes it happen, the other is told it's no longer waiting.
  const again = await askTag();
  await approve(db, again.runId, owner);
  const last = await Promise.allSettled([approve(db, again.runId, sam), approve(db, again.runId, lee)]);
  assert.equal(last.filter((a) => a.status === "fulfilled").length, 1);
  const refused = last.find((a) => a.status === "rejected") as PromiseRejectedResult;
  assert.equal((refused.reason as KumiError).code, "error.not_planned");
  assert.equal((await yesBy(again.runId)).length, 2);
});

test("a no after the first yes ends it, with when", async () => {
  const asked = await askTag();
  await approve(db, asked.runId, owner);
  const at = new Date("2026-11-15T18:00:00Z");
  await decline(db, asked.runId, sam, { now: at, reason: "Not now" });
  const row = await runRow(asked.runId);
  assert.equal(row.status, "failed");
  assert.equal(row.ended_at?.toISOString(), at.toISOString());
  await rejects(approve(db, asked.runId, lee), "error.declined");
});

test("money over the amount: staff changes only, never a member's own", async () => {
  await run(db, "role.second_yes", { actions: [], over_cents: 5000 }, owner);
  const p = (cents: number) => ({ moneyCents: cents } as Plan);
  assert.equal(await secondYesNeeded(db, "booking.refund", null, mia, p(5001)), true);
  assert.equal(await secondYesNeeded(db, "booking.refund", null, mia, p(5000)), false);
  assert.equal(await secondYesNeeded(db, "booking.create", null, member, p(9000)), false);
  // An undo is judged as the change it undoes.
  await run(db, "role.second_yes", { actions: ["tag.create"], over_cents: null }, owner);
  assert.equal(await secondYesNeeded(db, "action.undo", "tag.create", mia, p(0)), true);
  // Off again: one yes, as before.
  await run(db, "role.second_yes", { actions: [], over_cents: null }, owner);
  const plain = await askTag();
  assert.equal(plain.status, "planned");
});
