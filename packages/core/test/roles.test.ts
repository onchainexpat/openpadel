import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { customAreas, decide, grantableActions, plan, roleCatalogue, roleGrantsView, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, coordinator: string;
const NOW = new Date("2026-11-30T16:00:00Z");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en", auth: "two_factor" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const may = async (name: string, action: string, own = false) => (await decide(db, action, { personId: people[name]!, ownerIds: own ? [people[name]!] : [], at: NOW })).mode;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "two_factor" };
  people.Robin = owner.personId!;
  for (const name of ["Mia", "Fran"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Mia, role: "manager" }, owner, { now: NOW });
});
after(async () => drop());

test("a club's role can hold what a manager does without asking, never the owner's own", async () => {
  const names = await grantableActions(db);
  for (const a of ["booking.cancel", "program.create", "enrolment.join", "person.tag", "broadcast.send"]) assert.ok(names.includes(a), a);
  for (const a of ["club.update", "location.create", "role.create", "role.assign", "privacy.erase", "person.reset_sign_in", "booking.lapse", "person.passkey_add"]) assert.ok(!names.includes(a), a);
  // Each one is worded for the editor, in both languages.
  for (const lang of ["en", "es"] as const) for (const area of await roleCatalogue(db, lang)) for (const x of area.actions) assert.ok(!x.title.startsWith("action."), `${lang} ${x.name}`);
});

test("the owner makes a role; the preview says in plain words what it can and can't do", async () => {
  const grants = [{ action: "booking.cancel", scope: "any" as const }, { action: "program.create", scope: "any" as const, approval: true }, { action: "person.update_profile", scope: "own" as const }];
  await rejects(plan(db, "role.create", { name: "Manager", grants }, owner, { now: NOW }), "error.role_name_taken");
  await rejects(plan(db, "role.create", { name: "Desk lead", grants: [{ action: "club.update", scope: "any" }] }, owner, { now: NOW }), "error.role_owner_only");
  await rejects(plan(db, "role.create", { name: "Desk lead", grants: [...grants, grants[0]!] }, owner, { now: NOW }), "error.role_grant_twice");
  const r = await run(db, "role.create", { name: "Junior coordinator", grants }, owner, { now: NOW });
  assert.equal(r.plan.summary.en, "Make the role \"Junior coordinator\". It can: Bookings: Cancel a booking (everyone's). Programs: Create a program (everyone's, with approval). Members: Change your profile (their own). Nothing in: courts and hours, memberships, money, messages, levels and scores, coaches, settings.");
  coordinator = (r.result as { key: string }).key;
  assert.match(coordinator, /^custom_[0-9a-f]{8}$/);
  assert.deepEqual((await roleGrantsView(db, coordinator)).map((g) => `${g.action}:${g.scope}:${g.approval}`).sort(), ["booking.cancel:any:false", "person.update_profile:own:false", "program.create:any:true"]);
});

test("someone given it can do exactly that: approval where it says, nothing else, and sees only those areas", async () => {
  assert.equal(await may("Fran", "booking.cancel"), "no");
  const r = await run(db, "role.assign", { person_id: people.Fran, role: coordinator }, owner, { now: NOW });
  assert.equal(r.plan.summary.en, "Make Fran Junior coordinator.");
  assert.equal(await may("Fran", "booking.cancel"), "allow");
  assert.equal(await may("Fran", "program.create"), "ask");
  assert.equal(await may("Fran", "program.publish"), "no");
  assert.equal(await may("Fran", "club.update"), "no");
  assert.deepEqual(await customAreas(db, people.Fran!), ["bookings", "programs", "members"]);
  assert.equal(await customAreas(db, people.Mia!), null);   // a built-in staff role sees what it always has
});

test("nobody gives more than they hold, and the built-in roles stay as they are", async () => {
  // A manager asks to make someone owner: more than a manager can do, so it's refused outright.
  await rejects(plan(db, "role.assign", { person_id: people.Fran, role: "owner" }, as("Mia"), { now: NOW }), "error.role_more_than_you");
  // The club's role is within a manager's: it goes to the owner to approve, as roles always do for managers.
  const p = await plan(db, "role.assign", { person_id: people.Mia, role: coordinator }, as("Mia"), { now: NOW });
  assert.equal(p.status, "awaiting_approval");
  await rejects(plan(db, "role.update", { role: "manager", grants: [] }, owner, { now: NOW }), "error.role_built_in");
});

test("changing the role changes what its people can do; retiring takes it away", async () => {
  const r = await run(db, "role.update", { role: coordinator, grants: [{ action: "program.create", scope: "any" }] }, owner, { now: NOW });
  assert.equal(r.plan.summary.en, "Change the role \"Junior coordinator\" (held by 1 person). It can: Programs: Create a program (everyone's). Nothing in: bookings, courts and hours, members, memberships, money, messages, levels and scores, coaches, settings.");
  assert.equal(await may("Fran", "booking.cancel"), "no");
  assert.equal(await may("Fran", "program.create"), "allow");
  const ret = await run(db, "role.retire", { role: coordinator }, owner, { now: NOW });
  assert.equal(ret.plan.summary.en, "Retire the role \"Junior coordinator\". It's taken away from: Fran.");
  assert.equal(await may("Fran", "program.create"), "no");
  await rejects(plan(db, "role.assign", { person_id: people.Fran, role: coordinator }, owner, { now: NOW }), "error.not_found");
});
