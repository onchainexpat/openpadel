// Asks in the staff app: Changes shows the owner what waits for them, with Approve and Decline; the manager who asked
// can't answer it; Decline takes a reason and says who.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
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
  await session("owner", owner.personId!);
  await session("mia", mia);
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
