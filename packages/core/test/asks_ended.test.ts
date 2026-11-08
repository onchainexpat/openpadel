// An ask waiting for a yes that a change has made out of date (it read what that change changed) says so at once, with
// a reason in words, instead of waiting for a yes that would be refused; and a club setting's preview says what it
// changes to.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { approve, plan, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const m = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: m, role: "manager" }, owner);
  manager = { personId: m, via: "test", lang: "en" };
});
after(async () => drop());

test("a club setting's preview says what it changes to", async () => {
  const p = await plan(db, "club.update", { legal_name: "Kestrel Padel LLC", court_bookings: true, tax_rate_bp: 825 }, owner);
  assert.match(p.plan.summary.en, /the legal name to Kestrel Padel LLC/, p.plan.summary.en);
  assert.match(p.plan.summary.en, /whether members book courts in the app \(yes\)/);
  assert.match(p.plan.summary.en, /the tax rate to 8\.25%/);
  assert.match(p.plan.summary.es, /el nombre legal a Kestrel Padel LLC/);
});

test("the owner making the change directly: the manager's waiting ask is out of date, and says so", async () => {
  // A first look sends nothing; asking does.
  const look = await plan(db, "club.update", { legal_name: "Kestrel Padel Inc." }, manager, { holdAsk: true });
  assert.equal(look.status, "would_ask");
  assert.equal(await db.selectFrom("action_run").select("id").where("action", "=", "club.update").where("status", "=", "awaiting_approval").executeTakeFirst(), undefined);
  const asked = await plan(db, "club.update", { legal_name: "Kestrel Padel Inc." }, manager);
  assert.equal(asked.status, "awaiting_approval");
  await run(db, "club.update", { legal_name: "Kestrel Padel Inc." }, owner);
  const r = await db.selectFrom("action_run").select(["status", "error"]).where("id", "=", asked.runId).executeTakeFirstOrThrow();
  assert.equal(r.status, "failed");
  assert.equal((r.error as { code: string }).code, "error.ask_out_of_date");
  await assert.rejects(approve(db, asked.runId, owner), (e: unknown) => {
    assert.ok(e instanceof KumiError); assert.equal(e.code, "error.ask_out_of_date");
    assert.match(e.text.en, /^Out of date/); return true;
  });
  // An ask that read something nobody changed keeps waiting.
  const other = await plan(db, "location.create", { name: "Westside", time_zone: "America/Los_Angeles" }, manager);
  await run(db, "club.update", { name: "Kestrel" }, owner);
  if (other.status === "awaiting_approval") assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", other.runId).executeTakeFirstOrThrow()).status, "awaiting_approval");
});
