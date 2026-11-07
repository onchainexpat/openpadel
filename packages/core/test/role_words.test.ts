import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { plan, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

// Front desk can't give roles. The refusal names what the role would let them do in words staff read
// ("Undo a change"), not the action's internal name ("action.undo").
let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, ben: string;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const d = ((await run(db, "person.create", { display_name: "Dana Desk", email: "dana@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: d, role: "front_desk" }, owner);
  desk = { personId: d, via: "test", lang: "en" };
  ben = ((await run(db, "person.create", { display_name: "Ben Lee", email: "ben@example.test" }, owner)).result as any).person_id;
});
after(async () => { await drop(); });

test("front desk is refused every staff role, owner included, and the reason names the action in words", async () => {
  for (const role of ["owner", "manager", "front_desk", "coach"]) {
    const e: any = await plan(db, "role.assign", { person_id: ben, role }, desk).then(() => null, (x) => x);
    assert.ok(e, `front desk planned ${role}`);
    assert.equal(e.code, "error.role_more_than_you");
    assert.ok(!e.text.en.includes("action.") && !e.text.es.includes("action."), e.text.en);
    const a = e.params.action;
    assert.equal(typeof a, "object");
    assert.ok(!/^[a-z_]+\.[a-z_.]+$/.test(a.en) && !/^[a-z_]+\.[a-z_.]+$/.test(a.es), `${role}: ${a.en} / ${a.es}`);
  }
  const self: any = await plan(db, "role.assign", { person_id: desk.personId, role: "owner" }, desk).then(() => null, (x) => x);
  assert.ok(self, "front desk made themselves owner");
});
