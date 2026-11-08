// The front desk kept to one location adds the people standing there: a person, their tags, a junior, a receipt sent
// again. People belong to no location (clubWide), so a desk role kept to Eastside does these too; a receipt from
// another place is still that place's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { decide, plan, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, lee: Actor, east: string, west: string;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  east = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  west = ((await run(db, "location.create", { name: "Westside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const l = ((await run(db, "person.create", { display_name: "Lee", email: "lee@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: l, role: "front_desk", location_id: east }, owner);
  lee = { personId: l, via: "test", lang: "en" };
});
after(async () => drop());

test("front desk at Eastside adds a walk-in, tags them, adds their junior", async () => {
  // Done at once, not asked: the desk's grants allow these outright.
  const done = async (name: string, input: object) => { const r = await run(db, name, input, lee); assert.notEqual(r.status, "awaiting_approval", name); return r.result; };
  const id = ((await done("person.create", { display_name: "Walk In", email: "walk.in@example.test" })) as { person_id: string }).person_id;
  await done("person.tag", { person_id: id, name: "Beginners" });
  const tag = await db.selectFrom("tag").select("id").where("name", "=", "Beginners").executeTakeFirstOrThrow();
  assert.ok(await db.selectFrom("person_tag").select("person_id").where("person_id", "=", id).where("tag_id", "=", tag.id).executeTakeFirst());
  await done("person.untag", { person_id: id, tag_id: tag.id });
  await done("household.add_junior", { person_id: id, display_name: "Tim", birth_year: 2016 });
  assert.ok(await db.selectFrom("person").select("id").where("display_name", "=", "Tim").where("junior", "=", true).executeTakeFirst());
  // Their address isn't held back, so there's nothing to let through, but it's not their location that says no.
  await assert.rejects(plan(db, "person.email_unsuppress", { person_id: id }, lee), (e: unknown) => {
    assert.ok(e instanceof KumiError); assert.notEqual(e.code, "error.forbidden_reason"); return true;
  });
});

test("a receipt from Westside is Westside's, one of no place anyone's at a desk", async () => {
  const at = new Date();
  assert.equal((await decide(db, "receipt.resend", { personId: lee.personId, locationId: west, at, clubWide: true })).mode, "no");
  assert.equal((await decide(db, "receipt.resend", { personId: lee.personId, locationId: east, at, clubWide: true })).mode, "allow");
  assert.equal((await decide(db, "receipt.resend", { personId: lee.personId, locationId: null, at, clubWide: true })).mode, "allow");
  // And the club's own settings stay out of the desk's reach.
  await assert.rejects(plan(db, "club.update", { legal_name: "Lee's Padel" }, lee), (e: unknown) => {
    assert.ok(e instanceof KumiError); assert.equal(e.code, "error.forbidden_reason"); return true;
  });
});
