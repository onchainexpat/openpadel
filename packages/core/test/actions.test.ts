import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/mini";
import { en, es } from "@kumi/i18n";
import { freshDb } from "./helpers.ts";
import { apply, approve, defineAction, plan, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, ownerId: string;
const as = (personId: string, lang: "en" | "es" = "en"): Actor => ({ personId, via: "test", lang });
async function person(name: string, role?: string, locationId?: string) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}@example.test`, created_via: "desk" }).execute();
  if (role) {
    const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
    await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: locationId ?? null }).execute();
  }
  return id;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const club = () => db.selectFrom("club").selectAll().executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  const r = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  ownerId = (r.result as { owner_person_id: string }).owner_person_id;
  owner = as(ownerId);
});
after(async () => drop());

test("every Spanish key exists and plurals work", async () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  const { t } = await import("@kumi/i18n");
  assert.equal(t("en", "count.changes", { count: 1 }), "1 change");
  assert.equal(t("es", "count.changes", { count: 3 }), "3 cambios");
});

test("setup is an action run, with its change log and outbox, and can't run twice", async () => {
  const runs = await db.selectFrom("action_run").selectAll().where("action", "=", "club.setup").execute();
  assert.equal(runs.length, 1); assert.equal(runs[0]!.status, "applied"); assert.equal(runs[0]!.via, "setup");
  const changes = await db.selectFrom("entity_change").select("entity").where("action_run_id", "=", runs[0]!.id).execute();
  assert.deepEqual(changes.map((c) => c.entity).sort(), ["club", "person", "person_role", "staff_member"]);
  assert.ok(await db.selectFrom("event_outbox").select("id").where("topic", "=", "club.set_up").executeTakeFirst());
  await rejects(runAsSystem(db, "club.setup", { name: "Again", time_zone: "America/Los_Angeles", owner_email: "x@example.test", owner_name: "X" }, "setup"), "error.forbidden_reason");
  await rejects(runAsSystem(db, "club.update", { name: "Sneaky" }, "schedule"), "error.forbidden_reason");
});

test("plan shows the change in both languages; apply makes it and logs before and after", async () => {
  const p = await plan(db, "club.update", { name: "Kestrel Padel Club" }, owner);
  assert.equal(p.status, "planned");
  assert.equal(p.plan.summary.en, "Change the name.");
  assert.equal(p.plan.summary.es, "Cambiar el nombre.");
  assert.equal((await club()).name, "Kestrel Padel", "nothing changes at plan time");
  await apply(db, p.runId, owner);
  assert.equal((await club()).name, "Kestrel Padel Club");
  const ch = await db.selectFrom("entity_change").selectAll().where("action_run_id", "=", p.runId).executeTakeFirstOrThrow();
  assert.equal((ch.before as any).name, "Kestrel Padel"); assert.equal((ch.after as any).name, "Kestrel Padel Club");
});

test("applying a plan whose rows changed since fails with 'look again'", async () => {
  const stale = await plan(db, "club.update", { brand_colour: "#123456" }, owner);
  await run(db, "club.update", { legal_name: "Kestrel Padel LLC" }, owner);
  await rejects(apply(db, stale.runId, owner), "error.changed");
  assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", stale.runId).executeTakeFirstOrThrow()).status, "failed");
  assert.notEqual((await club()).brand_colour, "#123456");
});

test("a plan expires after 15 minutes", async () => {
  const t0 = new Date();
  const p = await plan(db, "club.update", { brand_colour: "#222222" }, owner, { now: t0 });
  await rejects(apply(db, p.runId, owner, { now: new Date(t0.getTime() + 16 * 60_000) }), "error.plan_expired");
});

test("the same idempotency key applies once", async () => {
  const key = uuidv7();
  const p1 = await plan(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner);
  const r1 = await apply(db, p1.runId, owner, { idempotencyKey: key });
  const p2 = await plan(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner);
  const r2 = await apply(db, p2.runId, owner, { idempotencyKey: key });
  assert.deepEqual(r2, r1);
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Eastside").execute()).length, 1);
});

test("a manager's setup change asks the owner; nobody approves their own", async () => {
  const mgr = await person("Mo", "manager");
  const p = await plan(db, "club.update", { brand_colour: "#0B5A55" }, as(mgr));
  assert.equal(p.status, "awaiting_approval");
  await rejects(approve(db, p.runId, as(mgr)), "error.own_approval");
  await rejects(apply(db, p.runId, as(mgr)), "error.not_planned");
  await approve(db, p.runId, owner);
  const r = await db.selectFrom("action_run").select(["status", "approved_by"]).where("id", "=", p.runId).executeTakeFirstOrThrow();
  assert.equal(r.status, "applied"); assert.equal(r.approved_by, ownerId);
});

test("a member is refused with the reason in their language, and the refusal is logged", async () => {
  const m = await person("Ana", "member");
  await assert.rejects(plan(db, "club.update", { name: "Mine now" }, as(m, "es")), (e: any) => { assert.equal(e.text.es, "No puedes hacer eso: no tienes un rol que lo permita."); return true; });
  const logged = await db.selectFrom("action_run").select(["status", "error"]).where("actor_person_id", "=", m).executeTakeFirstOrThrow();
  assert.equal(logged.status, "failed");
});

test("own-rows grants: a member changes their own profile, not someone else's", async () => {
  const a = await person("Bea", "member"), b = await person("Cy", "member");
  // A new language says what it changes (phone check 5: "Change your language on your profile." and no more).
  const p = await plan(db, "person.update_profile", { person_id: a, locale: "es" }, as(a));
  assert.equal(p.plan.summary.en, "Change your language on your profile. From now on Kumi speaks to you in Spanish: the app, emails, texts and notifications.");
  assert.match(p.plan.summary.es, /Desde ahora Kumi te habla en español/);
  await apply(db, p.runId, as(a));
  await rejects(plan(db, "person.update_profile", { person_id: b, display_name: "Hacked" }, as(a)), "error.forbidden_reason");
});

test("undo puts things back exactly, once, and only if nothing changed since", async () => {
  const before = (await club()).name;
  const r = await run(db, "club.update", { name: "Temporary" }, owner);
  const u = await run(db, "action.undo", { run_id: r.runId }, owner);
  assert.equal((await club()).name, before);
  assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", r.runId).executeTakeFirstOrThrow()).status, "undone");
  await rejects(plan(db, "action.undo", { run_id: u.runId }, owner), "error.cannot_undo");
  const r1 = await run(db, "club.update", { name: "First" }, owner);
  await run(db, "club.update", { name: "Second" }, owner);
  await rejects(plan(db, "action.undo", { run_id: r1.runId }, owner), "error.undo_changed");
});

test("undoing a role assignment retires it rather than deleting it", async () => {
  const p = await person("Dee");
  const r = await run(db, "role.assign", { person_id: p, role: "coach" }, owner);
  await run(db, "action.undo", { run_id: r.runId }, owner);
  const rows = await db.selectFrom("person_role").select("active").where("person_id", "=", p).execute();
  assert.deepEqual(rows.map((x) => x.active), [false]);
});

test("the last owner can't be removed; with two owners one can go", async () => {
  await rejects(plan(db, "role.remove", { person_id: ownerId, role: "owner" }, owner), "error.last_owner");
  const second = await person("Sam", "owner");
  await run(db, "role.remove", { person_id: second, role: "owner" }, owner);
});

test("a role at one location doesn't reach another", async () => {
  const east = (await run(db, "location.create", { name: "East", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string };
  const river = (await run(db, "location.create", { name: "Riverfront", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string };
  const m = await person("Lee", "manager", east.location_id);
  assert.equal((await plan(db, "location.update", { location_id: east.location_id, address: "1 Main St" }, as(m))).status, "awaiting_approval");
  await rejects(plan(db, "location.update", { location_id: river.location_id, address: "2 Main St" }, as(m)), "error.forbidden_reason");
});

test("an agent is capped below the person it acts for", async () => {
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  const agentId = uuidv7();
  await db.insertInto("agent").values({ id: agentId, kind: "desk", capped_role_id: member.id, acts_for_person_id: ownerId }).execute();
  await rejects(plan(db, "club.update", { name: "By the bot" }, { ...owner, agentId }), "error.forbidden_reason");
});

test("a failed apply leaves no change log or outbox rows behind", async () => {
  defineAction({ name: "test.fail_midway", version: 1, input: z.object({}),
    async plan() { return { title: { en: "t", es: "t" }, summary: { en: "t", es: "t" }, reads: [], undo: { kind: "reversible" } }; },
    async apply(ctx) { await ctx.insert("location", { id: uuidv7(), name: "Ghost", time_zone: "UTC" }); await ctx.emit("ghost", {}); throw new Error("boom"); } });
  const g = await db.selectFrom("role").select("id").where("key", "=", "owner").executeTakeFirstOrThrow();
  await db.insertInto("role_grant").values({ id: uuidv7(), role_id: g.id, pattern: "test.*", mode: "allow" }).execute();
  const p = await plan(db, "test.fail_midway", {}, owner);
  await assert.rejects(apply(db, p.runId, owner), /boom/);
  assert.equal(await db.selectFrom("location").select("id").where("name", "=", "Ghost").executeTakeFirst(), undefined);
  assert.equal(await db.selectFrom("entity_change").select("id").where("action_run_id", "=", p.runId).executeTakeFirst(), undefined);
  assert.equal(await db.selectFrom("event_outbox").select("id").where("topic", "=", "ghost").executeTakeFirst(), undefined);
});
