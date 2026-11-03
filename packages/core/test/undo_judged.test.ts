// An undo is judged as the change it undoes (actions.ts, judgedAs): what only the owner may do, or only in the
// app, can't be put back by a manager or an assistant through "undo".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { approve, apply, plan, registerMessageTopics, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, mia: Actor, noah: Actor, leo: string;
const as = (personId: string, auth: Actor["auth"] = "two_factor"): Actor => ({ personId, via: "test", lang: "en", auth });
const cap = async () => (await db.selectFrom("club").select(["usage_cap_cents"]).executeTakeFirstOrThrow()).usage_cap_cents;
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  await registerMessageTopics(db, new Date(Date.now() - 60_000));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id, "passkey");
  const manager = async (name: string) => {
    const m = (await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as { person_id: string };
    await run(db, "role.assign", { person_id: m.person_id, role: "manager" }, owner);
    return m.person_id;
  };
  mia = as(await manager("Mia"), "email_code");
  noah = as(await manager("Noah"), "email_code");
  leo = await manager("Leo");
});
after(async () => drop());

test("a manager's undo of the owner's cap change waits for the owner", async () => {
  const r = await run(db, "club.usage_cap_set", { cap_cents: 1000, over_cents: 0 }, owner);
  assert.equal(await cap(), 1000);
  const u = await plan(db, "action.undo", { run_id: r.runId }, mia);
  assert.equal(u.status, "awaiting_approval");
  await rejects(apply(db, u.runId, mia), "error.not_planned");
  assert.equal(await cap(), 1000, "nothing changed until the owner says yes");
  // Another manager can't say yes for the owner: they may only ask for the change itself.
  await rejects(approve(db, u.runId, noah), "error.forbidden_reason");
  await approve(db, u.runId, owner);
  assert.notEqual(await cap(), 1000, "the owner's yes put the cap back");
});

test("a manager's assistant can't undo the owner's cap change at all", async () => {
  const r = await run(db, "club.usage_cap_set", { cap_cents: 777, over_cents: 0 }, owner);
  await rejects(plan(db, "action.undo", { run_id: r.runId }, { ...mia, auth: "oauth" }), "error.assistant_in_app");
  assert.equal(await cap(), 777);
});

test("a manager can't put back a manager the owner removed", async () => {
  const r = await run(db, "role.remove", { person_id: leo, role: "manager" }, owner);
  const u = await plan(db, "action.undo", { run_id: r.runId }, mia);
  assert.equal(u.status, "awaiting_approval");
  const back = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.active")
    .where("person_role.person_id", "=", leo).where("role.key", "=", "manager").executeTakeFirstOrThrow();
  assert.equal(back.active, false);
});

test("the owner still undoes their own change at once", async () => {
  const r = await run(db, "club.usage_cap_set", { cap_cents: 4321, over_cents: 0 }, owner);
  const u = await run(db, "action.undo", { run_id: r.runId }, owner);
  assert.deepEqual(u.result, { undone: r.runId });
  assert.notEqual(await cap(), 4321);
});
