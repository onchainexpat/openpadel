// Asks in the staff app: Changes shows the owner what waits for them, with Approve and Decline; the manager who asked
// can't answer it; Decline takes a reason and says who.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, ownerA: Actor, samId = "";
const cookies: Record<string, string> = {};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const req = async (path: string, who: string, body?: unknown) => {
  const cookie = cookies[who]!;
  const r = await app.request(path, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
/** A signed-in session with a passkey (both steps at once), as staff with a role sign in. */
async function session(who: string, personId: string) {
  await db.insertInto("web_session").values({ token_hash: sha(who), person_id: personId, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[who] = `kumi_session=${who}`;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  const owner: Actor = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const mia = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner);
  const sam = ((await run(db, "person.create", { display_name: "Sam", email: "sam@example.test" }, owner)).result as { person_id: string }).person_id;
  ownerA = owner; samId = sam;
  await run(db, "role.assign", { person_id: sam, role: "owner" }, owner);
  await session("owner", owner.personId!);
  await session("mia", mia);
  await session("sam", sam);
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false });
});
after(async () => drop());

test("the owner can answer what the manager asked for; the manager sees it waiting, without the buttons", async () => {
  const asked = await req("/actions/club.usage_cap_set/plan", "mia", { cap_cents: 9000 });
  assert.equal(asked.json.status, "awaiting_approval");
  const mine = (await req("/staff/changes", "mia")).json.find((r: any) => r.id === asked.json.run_id);
  assert.deepEqual([mine.status, mine.can_answer], ["awaiting_approval", false]);
  const theirs = (await req("/staff/changes", "owner")).json.find((r: any) => r.id === asked.json.run_id);
  assert.deepEqual([theirs.status, theirs.can_answer, theirs.by], ["awaiting_approval", true, "Mia"]);
  assert.equal((await req(`/runs/${asked.json.run_id}/decline`, "mia", {})).json.error, "error.own_approval");
  const ok = await req(`/runs/${asked.json.run_id}/approve`, "owner", {});
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const done = (await req("/staff/changes", "owner")).json.find((r: any) => r.id === asked.json.run_id);
  assert.deepEqual([done.status, done.can_answer, done.approved_by], ["applied", false, "Robin Hale"]);
});

test("declining keeps it in Changes as declined, with who and why", async () => {
  const asked = await req("/actions/club.usage_cap_set/plan", "mia", { cap_cents: 12000 });
  const no = await req(`/runs/${asked.json.run_id}/decline`, "owner", { reason: "Not this month" });
  assert.equal(no.status, 200, JSON.stringify(no.json));
  const row = (await req("/staff/changes", "mia")).json.find((r: any) => r.id === asked.json.run_id);
  assert.deepEqual([row.status, row.declined_by, row.reason, row.can_answer], ["declined", "Robin Hale", "Not this month", false]);
  // Approving it later says someone said no, not "it is failed".
  assert.equal((await req(`/runs/${asked.json.run_id}/approve`, "owner", {})).json.error, "error.declined");
});

test("a change the club's rule names waits for two yeses: Approvals says how many and who, and Changes keeps both", async () => {
  const rule = await req("/actions/role.second_yes/plan", "owner", { actions: ["tag.create"], over_cents: null });
  assert.equal((await req(`/runs/${rule.json.run_id}/apply`, "owner", {})).status, 200);
  assert.deepEqual((await req("/staff/roles/second_yes", "owner")).json.actions, ["tag.create"]);
  const asked = await req("/actions/tag.create/plan", "mia", { name: "Early birds" });
  assert.deepEqual([asked.json.status, asked.json.yeses_needed], ["awaiting_approval", 2]);
  const id = asked.json.run_id;
  const before = (await req("/staff/approvals", "owner")).json.waiting.find((a: any) => a.id === id);
  assert.deepEqual([before.needed, before.yeses], [2, []]);
  const first = await req(`/runs/${id}/approve`, "owner", {});
  assert.deepEqual(first.json, { result: null, yes_waiting: { yeses: 1, needed: 2 } });
  // The first to say yes sees it waiting for someone else; the next person sees who said yes.
  const owners = (await req("/staff/approvals", "owner")).json;
  assert.equal(owners.waiting.find((a: any) => a.id === id), undefined);
  assert.deepEqual(owners.mine.find((a: any) => a.id === id).yeses.map((y: any) => [y.name, y.me]), [["Robin Hale", true]]);
  const sams = (await req("/staff/approvals", "sam")).json.waiting.find((a: any) => a.id === id);
  assert.deepEqual(sams.yeses.map((y: any) => [y.name, y.me]), [["Robin Hale", false]]);
  const second = await req(`/runs/${id}/approve`, "sam", {});
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.yes_waiting, undefined);
  const done = (await req("/staff/approvals", "owner")).json.done.find((a: any) => a.id === id);
  assert.deepEqual([done.outcome, done.answered_by, done.yeses.length], ["approved", "Sam", 2]);
  assert.deepEqual((await req(`/staff/changes/${id}`, "owner")).json.yeses, ["Robin Hale", "Sam"]);
  const off = await req("/actions/role.second_yes/plan", "owner", { actions: [], over_cents: null });
  await req(`/runs/${off.json.run_id}/apply`, "owner", {});
});

test("an ask left with nobody to give its second yes says so on the card", async () => {
  const rule = await req("/actions/role.second_yes/plan", "owner", { actions: ["tag.create"], over_cents: null });
  await req(`/runs/${rule.json.run_id}/apply`, "owner", {});
  const asked = await req("/actions/tag.create/plan", "mia", { name: "Night owls" });
  await req(`/runs/${asked.json.run_id}/approve`, "owner", {});
  const mine = () => req("/staff/approvals", "mia").then((r) => r.json.mine.find((a: any) => a.id === asked.json.run_id));
  assert.equal((await mine()).stuck, false);
  await run(db, "role.remove", { person_id: samId, role: "owner" }, ownerA);
  assert.equal((await mine()).stuck, true, "Robin said yes, Mia asked, and Sam is no longer on the staff");
  await run(db, "role.assign", { person_id: samId, role: "owner" }, ownerA);
  assert.equal((await mine()).stuck, false);
});
