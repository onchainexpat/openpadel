// Support access through the apps (support.ts): two steps always, the staff screens as a manager reads them, the pages
// it never opens, every page recorded, the owner's banner and change log, and the end closing everything at once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { base32Decode, run, runAsSystem, totp, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, ownerCookie = "";
const mailer = new MemoryMailer(), grants: Record<string, string> = {}, secrets: Record<string, string> = {};
let clock = new Date();
/** The authenticator's next code: each one only works once, so time moves on a step. */
const nextCode = (secret: string) => { clock = new Date(clock.getTime() + 30_000); return totp(base32Decode(secret), clock); };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const req = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
/** Signed in by emailed code, then the authenticator (set up the first time): a two-step session. */
async function twoStep(email: string) {
  const cookie = await signIn(email);
  if (secrets[email]) {
    const v = await req("/auth/totp/verify", cookie, { code: nextCode(secrets[email]!) });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    return cookie;
  }
  const s = await req("/auth/totp/setup", cookie, {});
  assert.equal(s.status, 200, JSON.stringify(s.json));
  secrets[email] = s.json.key.replaceAll(" ", "");
  const c = await req("/auth/totp/confirm", cookie, { challenge_id: s.json.challenge_id, code: totp(base32Decode(secrets[email]!), clock) });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  return cookie;
}
/** Preview and confirm, as the staff app does. */
async function change(cookie: string, action: string, input: unknown) {
  const p = await req(`/actions/${action}/plan`, cookie, input);
  if (p.status !== 200) return p;
  return req(`/runs/${p.json.run_id}/apply`, cookie, {});
}

before(async () => {
  ({ db, drop } = await freshDb());   // the club's own two-step rule is off: support access needs two steps anyway
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const token = "owner-session";
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: owner.personId!, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  ownerCookie = `kumi_session=${token}`;
  for (const [email, level] of [["ada@help.test", "view"], ["bo@help.test", "manager"]] as const)
    grants[email] = ((await run(db, "support.grant", { email, name: email.split("@")[0]!, reason: "Checking the booking rules", level, hours: 4 }, owner)).result as { grant_id: string }).grant_id;
  clock = new Date();   // after the grants: they start when they're given
  app = makeApp({ db, mailer, secureCookies: false, now: () => clock });
});
after(async () => drop());

test("support signs in with two steps (though this club's staff don't need them), reads like a manager, and every page is recorded", async () => {
  const ada = await signIn("ada@help.test");
  assert.equal((await req("/me", ada)).json.gate, "setup");
  assert.equal((await req("/staff/people", ada)).json.error, "error.two_step_needed");
  const cookie = await twoStep("ada@help.test");
  const me = await req("/me", cookie);
  assert.deepEqual([me.json.gate, me.json.roles.map((r: { key: string }) => r.key), me.json.support.level], [null, ["manager"], "view"]);
  const people = await req("/staff/people", cookie);
  assert.equal(people.status, 200);
  assert.ok(!people.json.some((p: { email: string }) => p.email?.endsWith("@help.test")), "support's accounts aren't the club's people");
  for (const path of ["/staff/vault", "/staff/vault/items", "/staff/support", `/staff/support/${grants["bo@help.test"]}`, "/staff/export/x"])
    assert.deepEqual([(await req(path, cookie)).status, (await req(path, cookie)).json.error], [403, "error.support_closed"], path);
  const tried = await req("/actions/tag.create/plan", cookie, { name: "Beginners" });
  assert.equal(tried.status, 403);
  assert.match(tried.json.message, /to look only/);
  assert.equal((await req("/changes", cookie)).status, 200);
  const log = await db.selectFrom("support_access_log").select(["method", "path", "status"]).where("grant_id", "=", grants["ada@help.test"]!).orderBy("id").execute();
  assert.ok(log.some((l) => l.method === "GET" && l.path === "/staff/people" && l.status === 200));
  assert.ok(log.some((l) => l.method === "POST" && l.path === "/actions/tag.create/plan" && l.status === 403));
  assert.ok(log.some((l) => l.path === "/staff/vault" && l.status === 403), "the refused pages too");
  assert.equal((await db.selectFrom("event_outbox").select("id").where("topic", "=", "support.first_seen").execute()).length, 1, "the owner hears once");
});

test("like a manager: a change made through the app, the owner's banner, and the change log saying Support", async () => {
  const bo = await twoStep("bo@help.test");
  const made = await change(bo, "tag.create", { name: "Juniors" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const om = await req("/me", ownerCookie);
  assert.deepEqual(om.json.support_now.map((g: { name: string }) => g.name).sort(), ["ada", "bo"]);
  assert.equal(om.json.support, null);
  const log = (await req("/changes", ownerCookie)).json as { action: string; status: string; by: string; support: boolean }[];
  assert.deepEqual(log.filter((r) => r.action === "tag.create").map((r) => [r.by, r.status, r.support]).sort(), [["Support: ada", "failed", true], ["Support: bo", "applied", true]]);
  const list = await req("/staff/support", ownerCookie);
  assert.equal(list.json.owner, true);
  const row = list.json.grants.find((g: { id: string }) => g.id === grants["bo@help.test"]);
  assert.deepEqual([row.active, row.changes, row.reads > 0], [true, 2, true]);
  // Their authenticator counts too: the owner sees every change made while support access was on.
  const activity = await req(`/staff/support/${grants["bo@help.test"]}`, ownerCookie);
  assert.deepEqual(activity.json.changes.filter((c: { status: string }) => c.status === "applied").map((c: { action: string }) => c.action).sort(), ["person.factor_add", "tag.create"]);
});

test("ending it closes the staff screens at once, mid-session; access that runs out does the same", async () => {
  const bo = await twoStep("bo@help.test");
  assert.equal((await req("/staff/people", bo)).status, 200);
  const ended = await change(ownerCookie, "support.end", { grant_id: grants["bo@help.test"] });
  assert.equal(ended.status, 200, JSON.stringify(ended.json));
  assert.deepEqual([(await req("/staff/people", bo)).status, (await req("/staff/people", bo)).json.error], [403, "error.staff_only"]);
  const me = await req("/me", bo);
  assert.deepEqual([me.json.roles, me.json.support], [[], null]);
  // Ada's runs out while she's signed in.
  const ada = await twoStep("ada@help.test");
  assert.equal((await req("/staff/people", ada)).status, 200);
  await db.updateTable("support_grant").set({ starts_at: new Date(Date.now() - 3600_000), ends_at: new Date(Date.now() - 1000) }).where("id", "=", grants["ada@help.test"]!).execute();
  assert.equal((await req("/staff/people", ada)).status, 403);
  assert.deepEqual((await req("/me", ownerCookie)).json.support_now, []);
});
