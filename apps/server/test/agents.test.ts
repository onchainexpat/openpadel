// Club agents (agents.ts) and signed webhooks (webhooks.ts) through the door: a token shown once and kept out of the
// change log, the agent acting as itself on behalf of the club within its role, asks that wait for a person, the weekly
// limit on money it moves, what it can never do (make agents, take a role by role.assign), revoking, and webhooks that
// reach only what its role reads, signed, retried and paused with the owner told once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { approve, defineAction, fanOutWebhooks, mayAnswer, messageHandlers, processOutbox, run, runAsSystem, sendWebhooks, uuidv7, verifyWebhookSignature, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, ownerCookie = "", roleKey = "";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

// A change that moves money, for the weekly limit: only tests have it.
defineAction({
  name: "test.agent_money", version: 1, input: z.object({ cents: z.number() }),
  async plan(_ctx, i) { return { title: both("action.tag.create"), summary: both("action.tag.create"), reads: [], moneyCents: i.cents, undo: { kind: "none" } }; },
  async apply() { return null; },
});

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status === 401) return { error: "signed_out" };
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}
const noTool = (r: any) => typeof r.error === "string" && /not found/.test(r.error);
const req = async (path: string, cookie: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
/** Make an agent as the owner: its id, its person and its token (shown once). */
async function makeAgent(name: string, cap = 0, role = roleKey) {
  const r = await run(db, "agent.create", { name, role, weekly_cap_cents: cap }, owner);
  const res = r.result as { agent_id: string; token: string; token_last4: string };
  const a = await db.selectFrom("agent").select(["person_id", "grant_id"]).where("id", "=", res.agent_id).executeTakeFirstOrThrow();
  return { id: res.agent_id, token: res.token, last4: res.token_last4, person: a.person_id!, grant: a.grant_id!, runId: r.runId };
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  // A role made for agents: tags (making them outright, changing one with someone's yes), so it reads the members' area.
  roleKey = ((await run(db, "role.create", { name: "Tagger", grants: [{ action: "tag.create", scope: "any" }, { action: "tag.update", scope: "any", approval: true }] }, owner)).result as any).key;
  const role = await db.selectFrom("role").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  await db.insertInto("role_grant").values({ id: uuidv7(), role_id: role.id, pattern: "test.agent_money", mode: "allow", rows_scope: "any" }).execute();
  const token = "owner-session";
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: owner.personId!, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  ownerCookie = `kumi_session=${token}`;
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
});
after(async () => drop());

test("a club agent's token is shown once to whoever made it, never kept in the change log, and works at the door as the agent", async () => {
  const a = await makeAgent("Night desk");
  assert.match(a.token, /^opa_[A-Za-z0-9_-]{43}$/);
  assert.equal(a.token.slice(-4), a.last4);
  // Shown once: the stored result and the change log hold its last four only, and the sealed copy is gone.
  const runRow = await db.selectFrom("action_run").select(["result", "agent_id", "actor_person_id"]).where("id", "=", a.runId).executeTakeFirstOrThrow();
  assert.ok(!JSON.stringify(runRow.result).includes(a.token));
  const log = await db.selectFrom("entity_change").select(["before", "after"]).where("action_run_id", "=", a.runId).execute();
  assert.ok(!JSON.stringify(log).includes(a.token) && !JSON.stringify(log).includes('"token_once":'), "never in the change log");
  assert.equal((await db.selectFrom("agent").select("token_once").where("id", "=", a.id).executeTakeFirstOrThrow()).token_once, null);
  assert.equal((await db.selectFrom("oauth_token").select("token_hash").where("grant_id", "=", a.grant).executeTakeFirstOrThrow()).token_hash, sha(a.token), "kept as a hash");

  const who = await call(a.token, "whoami");
  assert.equal(who.agent.id, a.id);
  assert.equal(who.person, "Night desk");
  assert.equal(who.spending.weekly_limit, "$0.00");
  // It acts as itself, on behalf of the club: the change log has the agent and its own person row.
  const p = await call(a.token, "tag_create_preview", { name: "Night owls" });
  assert.equal(p.status, "planned", JSON.stringify(p));
  const done = await call(a.token, "tag_create_confirm", { run_id: p.run_id });
  assert.equal(done.done, true, JSON.stringify(done));
  const made = await db.selectFrom("action_run").select(["agent_id", "actor_person_id", "via", "oauth_grant_id"]).where("id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.deepEqual(made, { agent_id: a.id, actor_person_id: a.person, via: "mcp:Night desk", oauth_grant_id: a.grant });
  // Its role's reads (members, through its tags) and nothing past them; never the tools for making agents.
  assert.ok(Array.isArray(await call(a.token, "people")), "the members' area");
  assert.ok(noTool(await call(a.token, "booking_create_preview", {})), "no bookings");
  assert.ok(noTool(await call(a.token, "agent_create_preview", { name: "x", role: roleKey })), "never makes agents");
  assert.ok((await db.selectFrom("agent").select("last_used_at").where("id", "=", a.id).executeTakeFirstOrThrow()).last_used_at, "its last use is kept");
});

test("what its role says to ask about waits in Approvals for a person; an agent never answers an ask", async () => {
  const a = await makeAgent("Tag keeper");
  const tag = ((await run(db, "tag.create", { name: "Juniors" }, owner)).result as any).tag_id;
  const p = await call(a.token, "tag_update_preview", { tag_id: tag, name: "Juniors 2027" });
  assert.equal(p.status, "awaiting_approval", JSON.stringify(p));
  const asked = await db.selectFrom("action_run").selectAll().where("id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.equal(asked.agent_id, a.id);
  const other = await makeAgent("Another agent");
  assert.equal(await mayAnswer(db, asked, other.person, new Date()), false, "an agent never says yes");
  assert.equal(await mayAnswer(db, asked, owner.personId, new Date()), true);
  await approve(db, p.run_id, owner);
  const done = await db.selectFrom("action_run").select(["status", "approved_by", "agent_id"]).where("id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.deepEqual(done, { status: "applied", approved_by: owner.personId, agent_id: a.id });
});

test("the weekly limit on money an agent's changes move: past it, the preview is refused", async () => {
  const a = await makeAgent("Money bot", 1000);
  const actor: Actor = { personId: a.person, agentId: a.id, via: "test", lang: "en", auth: "oauth", grantId: a.grant };
  await run(db, "test.agent_money", { cents: 600 }, actor);
  await assert.rejects(run(db, "test.agent_money", { cents: 600 }, actor), (e: any) => e.code === "error.agent_over_cap" && /\$4\.00 left/.test(e.text.en));
  await run(db, "test.agent_money", { cents: 400 }, actor);
  assert.equal((await call(a.token, "whoami")).spending.left, "$0.00");
  // Raised by the owner, it goes on.
  await run(db, "agent.update", { agent_id: a.id, weekly_cap_cents: 2000 }, owner);
  await run(db, "test.agent_money", { cents: 600 }, actor);
});

test("only people make agents: a manager asks, an assistant can't give more than its own limit, an agent can't, never the owner's role", async () => {
  const mgr = ((await run(db, "person.create", { display_name: "Mo Manager", email: "mo@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: mgr, role: "manager" }, owner);
  const asked = await run(db, "agent.create", { name: "Asked for", role: roleKey }, { personId: mgr, via: "test", lang: "en" });
  assert.equal(asked.status, "awaiting_approval");
  await assert.rejects(run(db, "agent.create", { name: "Boss bot", role: "owner" }, owner), (e: any) => e.code === "error.agent_role_not_allowed");
  await assert.rejects(run(db, "agent.create", { name: "Coach bot", role: "coach" }, owner), (e: any) => e.code === "error.agent_role_not_allowed");
  await db.insertInto("oauth_client").values({ client_id: "c-owner", kind: "registered", name: "Claude", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  const grant = uuidv7();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: owner.personId!, client_id: "c-owner", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 2500 }).execute();
  await assert.rejects(run(db, "agent.create", { name: "Rich bot", role: roleKey, weekly_cap_cents: 5000 }, { ...owner, auth: "oauth", grantId: grant }), (e: any) => e.code === "error.agent_cap_over_yours");
  const a = await makeAgent("Lone agent");
  await assert.rejects(run(db, "agent.create", { name: "Child", role: roleKey }, { personId: a.person, agentId: a.id, via: "test", lang: "en", auth: "oauth", grantId: a.grant }),
    (e: any) => e.code === "error.agent_not_for_agents" || e.code === "error.forbidden_reason");
  await assert.rejects(run(db, "role.assign", { person_id: a.person, role: "manager" }, owner), (e: any) => e.code === "error.agent_role_on_its_page");
});

test("a new token ends the old one; revoking ends the token, its webhooks and its previews; undoing a new agent ends it too", async () => {
  const a = await makeAgent("Rotating");
  const nt = (await run(db, "agent.new_token", { agent_id: a.id }, owner)).result as { token: string };
  assert.equal((await call(a.token, "whoami")).error, "signed_out");
  assert.equal((await call(nt.token, "whoami")).agent.id, a.id);
  const preview = await call(nt.token, "tag_create_preview", { name: "Left waiting" });
  await call(nt.token, "webhook_subscribe_preview", { url: "http://hooks.example.test/a", topics: ["person.created"] }).then((p) => call(nt.token, "webhook_subscribe_confirm", { run_id: p.run_id }));
  await run(db, "agent.revoke", { agent_id: a.id }, owner);
  assert.equal((await call(nt.token, "whoami")).error, "signed_out");
  assert.equal((await db.selectFrom("webhook_subscription").select("active").where("agent_id", "=", a.id).executeTakeFirstOrThrow()).active, false);
  const person = await db.selectFrom("person").select("status").where("id", "=", a.person).executeTakeFirstOrThrow();
  assert.equal(person.status, "archived");
  await assert.rejects(run(db, "agent.update", { agent_id: a.id, name: "Back" }, owner), (e: any) => e.code === "error.agent_revoked");
  assert.ok(preview.run_id);
  const left = await db.selectFrom("action_run").select("status").where("id", "=", preview.run_id).executeTakeFirstOrThrow();
  assert.equal(left.status, "planned", "never confirmed, and now it can't be");

  const b = await makeAgent("Made by mistake");
  await run(db, "action.undo", { run_id: b.runId }, owner);
  assert.equal((await call(b.token, "whoami")).error, "signed_out");
});

test("the club's list: agents with their role, spending and last use; people's assistants; agents aren't among the club's people", async () => {
  const r = await req("/staff/agents", ownerCookie);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const night = r.json.agents.find((a: any) => a.name === "Night desk");
  assert.equal(night.role_name, "Tagger");
  assert.match(night.can, /tag/i);
  assert.equal(night.created_by, "Robin Hale");
  assert.ok(night.last_used_at);
  assert.equal(r.json.agents.find((a: any) => a.name === "Money bot").spent_cents, 1600);
  assert.ok(r.json.assistants.some((x: any) => x.name === "Claude" && x.person === "Robin Hale"), "the owner's own assistant");
  assert.ok(!r.json.roles.some((x: any) => x.key === "owner" || x.key === "member"));
  assert.ok(r.json.topics.some((x: any) => x.topic === "booking.cancelled"));
  const people = await req("/staff/people?q=", ownerCookie);
  assert.equal(people.status, 200);
  assert.ok(!JSON.stringify(people.json).includes("Night desk"), "an agent isn't one of the club's people");
});

test("webhooks: an agent subscribes itself, gets only what its role reads, signed; a failing address is paused and the owner told once", async () => {
  const a = await makeAgent("Hooked", 0);
  const p = await call(a.token, "webhook_subscribe_preview", { url: "http://hooks.example.test/in", topics: ["person.created", "booking.cancelled"] });
  assert.equal(p.status, "planned", JSON.stringify(p));
  assert.match(p.summary, /won't get booking\.cancelled/);
  const c = await call(a.token, "webhook_subscribe_confirm", { run_id: p.run_id });
  const secret: string = c.result.secret;
  assert.match(secret, /^whsec_/);
  const sub = c.result.subscription_id as string;
  assert.ok(!JSON.stringify((await db.selectFrom("action_run").select("result").where("id", "=", p.run_id).executeTakeFirstOrThrow()).result).includes(secret), "never in the change log");
  // The owner's own webhook, which reads everything.
  const mine = ((await run(db, "webhook.subscribe", { url: "http://hooks.example.test/owner", topics: ["booking.cancelled"] }, owner)).result as any);
  await fanOutWebhooks(db);   // copies nothing made before
  await run(db, "person.create", { display_name: "Pat New", email: "pat@example.test" }, owner);
  await db.insertInto("event_outbox").values({ action_run_id: null, topic: "booking.cancelled", payload: JSON.stringify({ booking_id: uuidv7(), by: null }) }).execute();
  await fanOutWebhooks(db);
  await fanOutWebhooks(db);   // twice: still one delivery each
  const ds = await db.selectFrom("webhook_delivery").select(["subscription_id", "topic"]).where("subscription_id", "in", [sub, mine.subscription_id]).execute();
  assert.deepEqual(ds.map((d) => `${d.subscription_id === sub ? "agent" : "owner"}:${d.topic}`).sort(), ["agent:person.created", "owner:booking.cancelled"]);

  const got: { url: string; body: string; headers: Record<string, string> }[] = [];
  const r1 = await sendWebhooks(db, async (url, body, headers) => { got.push({ url, body, headers }); return 204; });
  assert.equal(r1.sent, 2);
  const toAgent = got.find((g) => g.url.endsWith("/in"))!;
  assert.equal(toAgent.headers["openpadel-event"], "person.created");
  assert.ok(verifyWebhookSignature(secret, toAgent.headers["openpadel-signature"]!, toAgent.body), "signed with its secret");
  assert.ok(!verifyWebhookSignature(secret, toAgent.headers["openpadel-signature"]!, toAgent.body.replace("person", "persona")), "a changed body fails");
  const body = JSON.parse(toAgent.body);
  assert.equal(body.type, "person.created");
  assert.match(body.id, /^evt_\d+$/);
  assert.ok(body.data.person_id);

  // A test event, then an address that keeps failing: tried again later, then paused after a day, the owner told once.
  await call(a.token, "webhook_test_preview", { subscription_id: sub }).then((t) => call(a.token, "webhook_test_confirm", { run_id: t.run_id }));
  const t0 = new Date();
  const failing = async (at: Date) => sendWebhooks(db, async (url) => { if (url.endsWith("/in")) throw new Error("connect ECONNREFUSED"); return 200; }, at);
  assert.equal((await failing(t0)).failed, 1);
  const w = await db.selectFrom("webhook_delivery").select(["status", "attempts", "next_attempt_at"]).where("subscription_id", "=", sub).where("topic", "=", "webhook.test").executeTakeFirstOrThrow();
  assert.equal(w.status, "waiting");
  assert.ok(w.next_attempt_at.getTime() > t0.getTime(), "tried again later");
  const later = await failing(new Date(t0.getTime() + 25 * 3600_000));
  assert.equal(later.paused, 1);
  const s = await db.selectFrom("webhook_subscription").select(["paused_at", "paused_why"]).where("id", "=", sub).executeTakeFirstOrThrow();
  assert.ok(s.paused_at);
  assert.match(s.paused_why!, /ECONNREFUSED/);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["person_id", "subject", "channel"]).where("kind", "=", "webhook_paused_owner").execute();
  assert.ok(told.length >= 1 && told.every((m) => m.person_id === owner.personId));
  assert.match(told[0]!.subject, /hooks\.example\.test/);
  // Paused, nothing more is copied for it; started again by the agent, it gets new events.
  await run(db, "person.create", { display_name: "Quinn Paused", email: "quinn@example.test" }, owner);
  await fanOutWebhooks(db);
  assert.equal(Number((await db.selectFrom("webhook_delivery").select((eb) => eb.fn.countAll<string>().as("n")).where("subscription_id", "=", sub).where("status", "=", "waiting").where("topic", "!=", "webhook.test").executeTakeFirstOrThrow()).n), 0);
  const resume = await call(a.token, "webhook_update_preview", { subscription_id: sub, resume: true });
  assert.equal(resume.status, "planned", JSON.stringify(resume));
  await call(a.token, "webhook_update_confirm", { run_id: resume.run_id });
  // Another agent can't touch it.
  const b = await makeAgent("Nosy");
  assert.equal((await call(b.token, "webhook_remove_preview", { subscription_id: sub })).error, "error.forbidden_reason");
});

test("the command line signs in with a club agent's token (piped or from KUMI_AGENT_TOKEN) and runs the agent's commands", async () => {
  const { remoteMain } = await import("../src/cli_remote.ts");
  const { Store } = await import("../src/cli_store.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const a = await makeAgent("Command line agent");
  const dir = mkdtempSync(join(tmpdir(), "kumi-cli-agent-"));
  try {
    const store = new Store(dir, false), out: string[] = [];
    const kumi = (env: Record<string, string>, ...argv: string[]) => remoteMain(argv, { store, out: (s) => out.push(s), err: (s) => out.push(s), sleep: async () => {}, now: () => Date.now(),
      hostname: "night-box", env, openBrowser: null, fetch: async (u, init) => (String(u).startsWith(BASE) ? app.request(String(u), init as RequestInit) : fetch(u, init)) });
    assert.notEqual(await kumi({ KUMI_AGENT_TOKEN: "not-a-token" }, "login", BASE, "--agent-token"), 0);
    assert.equal(await kumi({ KUMI_AGENT_TOKEN: a.token }, "login", BASE, "--agent-token", "--json"), 0, out.join("\n"));
    assert.match(out.join("\n"), /"person":"Command line agent"/);
    out.length = 0;
    assert.equal(await kumi({}, "tag", "create", "--name", "From the night box", "--yes", "--json"), 0, out.join("\n"));
    const made = await db.selectFrom("action_run").select(["agent_id", "via"]).where("action", "=", "tag.create").where("agent_id", "=", a.id).executeTakeFirst();
    assert.ok(made, "done as the agent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
