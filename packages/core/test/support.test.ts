// Support access (support.ts): what it lets a person do at each level, what it never does, that it ends on time
// (mid-session too), the manager's request and the owner's yes, and what the owner hears.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { activeSupport, apply, approve, decide, expireSupport, messageHandlers, needsTwoFactor, plan, processOutbox, registerMessageTopics, run, runAsSystem,
  pageWords, segmentMembers, supportActivity, supportGrants, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, mia: Actor;
const as = (personId: string, auth: Actor["auth"] = "two_factor"): Actor => ({ personId, via: "test", lang: "en", auth });
async function rejects(p: Promise<unknown>, code: string, reason?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code);
    if (reason) assert.match(e.text.en, reason);
    return true;
  });
}
/** Lets someone in, as the owner: their grant and the person they sign in as. */
async function grant(email: string, level: "view" | "manager", hours = 24) {
  const r = (await run(db, "support.grant", { email, name: email.split("@")[0]!, reason: "Looking at the booking rules", level, hours }, owner)).result as { grant_id: string; person_id: string };
  return { ...r, actor: as(r.person_id) };
}

before(async () => {
  ({ db, drop } = await freshDb());
  await registerMessageTopics(db, new Date(Date.now() - 60_000));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id, "passkey");
  const m = (await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as { person_id: string };
  await run(db, "role.assign", { person_id: m.person_id, role: "manager" }, owner);
  mia = as(m.person_id);
});
after(async () => drop());

test("to look only: a person of their own, two steps always, every change refused with the reason, the change log readable", async () => {
  const g = await grant("ada@help.test", "view");
  const p = await db.selectFrom("person").select(["display_name", "created_via"]).where("id", "=", g.person_id).executeTakeFirstOrThrow();
  assert.deepEqual(p, { display_name: "ada (support)", created_via: "support" });
  assert.equal((await db.selectFrom("person_role").select("id").where("person_id", "=", g.person_id).execute()).length, 0, "no role, not even member");
  assert.equal(await needsTwoFactor(db, g.person_id), true, "two steps, though this club's own rule is off");
  await rejects(plan(db, "tag.create", { name: "Beginners" }, g.actor), "error.forbidden_reason", /to look only/);
  const refused = await db.selectFrom("action_run").select(["status", "support_grant_id"]).where("actor_person_id", "=", g.person_id).executeTakeFirstOrThrow();
  assert.deepEqual(refused, { status: "failed", support_grant_id: g.grant_id }, "the refusal is logged as support's");
  assert.equal((await decide(db, "changes.view", { personId: g.person_id, at: new Date() })).mode, "allow");
  // Their own account they look after like anyone.
  assert.equal((await decide(db, "person.factor_add", { personId: g.person_id, ownerIds: [g.person_id], at: new Date() })).mode, "allow");
  assert.equal((await decide(db, "person.factor_add", { personId: g.person_id, ownerIds: [mia.personId!], at: new Date() })).mode, "no");
  // Not one of the club's people: no member list, no audience.
  assert.ok(!(await segmentMembers(db, {}, new Date())).some((x) => x.id === g.person_id));
  await run(db, "support.end", { grant_id: g.grant_id }, owner);
});

test("like a manager: what a manager does, what a manager asks the owner still asks, never the list, never through an assistant", async () => {
  const g = await grant("bo@help.test", "manager");
  const tag = await run(db, "tag.create", { name: "Juniors" }, g.actor);
  assert.equal(tag.status, "planned");
  assert.equal((await db.selectFrom("action_run").select("support_grant_id").where("id", "=", tag.runId).executeTakeFirstOrThrow()).support_grant_id, g.grant_id);
  const loc = (await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string };
  assert.equal((await plan(db, "location.update", { location_id: loc.location_id, name: "East" }, g.actor)).status, "awaiting_approval", "a manager asks the owner for this");
  await rejects(plan(db, "club.update", { name: "Kestrel" }, g.actor), "error.forbidden_reason", /support access never reaches this/);   // needs a strong sign-in
  const person = (await run(db, "person.create", { display_name: "Lee", email: "lee@example.test" }, owner)).result as { person_id: string };
  await rejects(plan(db, "tag.update", { tag_id: (tag.result as { tag_id: string }).tag_id, name: "Kids" }, { ...g.actor, auth: "oauth" }), "error.forbidden_reason", /through an assistant/);
  await assert.rejects(plan(db, "role.assign", { person_id: person.person_id, role: "front_desk" }, g.actor));
  // The never list, at the permission check itself (some of these refuse earlier for reasons of their own).
  for (const action of ["role.assign", "role.create", "club.usage_cap_set", "club.export", "club.read_only", "club.leaving_set", "privacy.erase", "privacy.export",
    "person.reset_sign_in", "person.import", "vault.add", "support.grant", "support.end", "club.payment_account_set", "assistant.set_cap"]) {
    const d = await decide(db, action, { personId: g.person_id, at: new Date() });
    assert.deepEqual([d.mode, d.reason], ["no", "reason.support_never"], action);
  }
  // Nor anything that needs a strong sign-in, whatever its name.
  assert.equal((await decide(db, "booking.create", { personId: g.person_id, at: new Date(), strongAuth: true })).reason, "reason.support_never");
  assert.equal((await decide(db, "booking.create", { personId: g.person_id, at: new Date() })).mode, "allow");
  await rejects(plan(db, "tag.create", { name: "Late" }, { ...g.actor, auth: "oauth", grantId: null }), "error.forbidden_reason", /through an assistant/);
  await run(db, "support.end", { grant_id: g.grant_id }, owner);
});

test("it ends on time, mid-session: a change previewed before the end can't be applied after it, and the owner hears once", async () => {
  const g = await grant("di@help.test", "manager");
  const now = new Date(), soon = new Date(now.getTime() + 5 * 60_000);
  await db.updateTable("support_grant").set({ ends_at: soon }).where("id", "=", g.grant_id).execute();
  const p = await plan(db, "tag.create", { name: "Evening" }, g.actor, { now });
  await rejects(apply(db, p.runId, g.actor, { now: new Date(soon.getTime() + 60_000) }), "error.forbidden_reason");
  assert.equal(await activeSupport(db, g.person_id, new Date(soon.getTime() + 1)), null);
  assert.equal(await expireSupport(db, new Date(soon.getTime() + 60_000)), 1);
  assert.equal(await expireSupport(db, new Date(soon.getTime() + 120_000)), 0, "told once");
  const ev = await db.selectFrom("event_outbox").select(["topic", "payload"]).where("topic", "=", "support.ended").orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.deepEqual(ev.payload, { grant_id: g.grant_id, how: "expired", by: null });
});

test("ending early: a manager may, it can't end twice, and the person's next step is refused", async () => {
  const g = await grant("ed@help.test", "manager");
  await run(db, "support.end", { grant_id: g.grant_id }, mia);
  await rejects(plan(db, "tag.create", { name: "Again" }, g.actor), "error.forbidden_reason");
  await rejects(plan(db, "support.end", { grant_id: g.grant_id }, owner), "error.support_over");
  const row = await db.selectFrom("support_grant").select(["ended_by", "end_told_at"]).where("id", "=", g.grant_id).executeTakeFirstOrThrow();
  assert.equal(row.ended_by, mia.personId);
  assert.ok(row.end_told_at, "ending it tells the owner straight away, so the job doesn't again");
});

test("a manager asks and the owner says yes, with a strong sign-in; staff and someone already in are refused", async () => {
  const asked = await plan(db, "support.grant", { email: "fay@help.test", name: "Fay", reason: "Setting up the courts", level: "view" }, mia);
  assert.equal(asked.status, "awaiting_approval");
  // The owner has a passkey: saying yes on an emailed code alone isn't enough.
  await db.insertInto("passkey").values({ credential_id: "owner-key", person_id: owner.personId!, public_key: Buffer.from("k"), counter: "0", transports: null, name: "Phone" }).execute();
  await rejects(approve(db, asked.runId, { ...owner, auth: "email_code" }), "error.need_passkey");
  const r = await approve(db, asked.runId, owner) as { grant_id: string };
  const row = await db.selectFrom("support_grant").select(["granted_by", "level"]).where("id", "=", r.grant_id).executeTakeFirstOrThrow();
  assert.deepEqual(row, { granted_by: owner.personId, level: "view" });
  await rejects(plan(db, "support.grant", { email: "fay@help.test", name: "Fay", reason: "Again", level: "view" }, owner), "error.support_already");
  await rejects(plan(db, "support.grant", { email: "MIA@example.test", name: "Mia", reason: "Help", level: "view" }, owner), "error.support_is_staff");
  await rejects(plan(db, "support.grant", { email: "gus@help.test", name: "Gus", reason: "Help", level: "view", hours: 24 * 7 + 1 }, owner), "error.invalid_input");
  await run(db, "support.end", { grant_id: r.grant_id }, owner);
});

test("the owner hears when it's first used and when it ends; the list and the activity show what they did", async () => {
  const g = await grant("hal@help.test", "manager");
  await processOutbox(db, messageHandlers);
  const you = await db.selectFrom("outbound_message").select(["kind", "channel", "body"]).where("person_id", "=", g.person_id).where("channel", "=", "email").execute();
  assert.equal(you[0]?.kind, "support_granted_you");
  assert.match(you[0]!.body, /work like a manager/);
  await runAsSystem(db, "support.seen", { grant_id: g.grant_id }, "web");
  await runAsSystem(db, "support.seen", { grant_id: g.grant_id }, "web");
  assert.equal((await db.selectFrom("event_outbox").select("id").where("topic", "=", "support.first_seen").execute()).length, 1, "once");
  await run(db, "tag.create", { name: "Hal's tag" }, g.actor);
  await db.insertInto("support_access_log").values({ grant_id: g.grant_id, method: "GET", path: "/staff/people?q=a", status: 200 }).execute();
  await run(db, "support.end", { grant_id: g.grant_id }, owner);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["kind", "body"]).where("person_id", "=", owner.personId!).where("channel", "=", "email").where("kind", "like", "support_%").where("body", "like", "%hal%").orderBy("created_at").execute();
  assert.deepEqual(told.map((m) => m.kind), ["support_first_seen_owner", "support_ended_owner"]);
  assert.match(told[1]!.body, /Robin Hale ended it/);
  const list = (await supportGrants(db)).find((x) => x.id === g.grant_id)!;
  assert.deepEqual([list.reads, list.changes, list.active], [1, 1, false]);
  const a = await supportActivity(db, g.grant_id, "es");
  assert.deepEqual([a.reads[0]!.path, a.reads[0]!.what], ["/staff/people?q=a", "Abrió Personas"]);   // the owner reads words, not addresses
  assert.equal(a.changes.find((c) => c.action === "tag.create")?.status, "applied");
});

test("the record of support access is in the staff app's words: pages, previews and confirms, never a bare address", () => {
  assert.equal(pageWords("GET", "/staff/grid?location_id=x&date=2026-11-03", "en"), "Opened Courts");
  assert.equal(pageWords("POST", "/actions/person.create/plan", "en"), "Previewed: Add a person");
  assert.equal(pageWords("POST", "/actions/club.nothing/plan", "en"), "Opened other staff data");
  assert.equal(pageWords("POST", "/runs/01a1/apply", "es"), "Confirmó un cambio (en la lista de arriba)");
  assert.equal(pageWords("GET", "/staff/unknown-thing", "en"), "Opened other staff data");
});
