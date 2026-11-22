// A service's settings set in the app (core service_settings.ts, service_routes.ts): the owner's form, the owner's
// agent through `openpadel connect`, the one reader (the settings file first), the services picking a change up with
// no restart, doctor's sources and the old names' warning. Never a value back, in any read, preview or log.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { forgetServiceSettings, run, runAsSystem, serviceEnv, serviceSetting, setSecretKeys, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { LiveMailer, MemoryMailer } from "../src/mailer.ts";
import { connectors, forgetConnectorChecks } from "../src/connectors.ts";
import { doctor } from "../src/doctor.ts";
import { parseConnect, remoteMain } from "../src/cli_remote.ts";
import { Store } from "../src/cli_store.ts";

const BASE = "http://127.0.0.1:8790", MCP = `${BASE}/mcp`, CLIENT = "settings-cli";
const KEY = "re_test_abcdefghijkl4f2a", KEY2 = "re_test_zyxwvutsrqpo7c1d", FROM = "Kestrel Padel <hello@kestrel.test>";
const SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, dbUrl: string;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const calls: { url: string; auth: string | null; body: string }[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
  if (String(url).includes("api.stripe.com")) return Response.json({ id: "acct_test_123" });
  return Response.json({ id: "email-1" });
};
const get = (path: string, who: string) => app.request(path, { headers: { cookie: cookies[who]! } });
const post = async (path: string, who: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  cookies[email] = r.headers.get("set-cookie")!.split(";")[0]!;
}
/** A command line signed in as someone: its connection allowed with a second step (or not), so long ago. */
async function deviceToken(personId: string, o: { secondStep: boolean; minutesAgo?: number } = { secondStep: true }) {
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: personId, client_id: CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, second_step: o.secondStep,
    created_at: new Date(Date.now() - (o.minutesAgo ?? 1) * 60_000) } as any).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  return access;
}
const bearer = async (token: string, method: "GET" | "POST", path: string, body?: unknown) => {
  const r = await app.request(`${MCP}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: await r.json() as any, text: "" };
};
/** Everything kept about changes and the vault's list, as text: no value may be in any of it. */
async function everythingKept(): Promise<string> {
  const runs = await db.selectFrom("action_run").select(["input", "plan", "result", "error"]).execute();
  const changes = await db.selectFrom("entity_change").selectAll().execute();
  const items = await db.selectFrom("vault_item").select(["name", "note", "last4", "setting"]).execute();
  return JSON.stringify([runs, changes, items]);
}

before(async () => {
  ({ db, drop } = await freshDb());
  dbUrl = (process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres").replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`select current_database() as d`.execute(db)).rows[0]!.d}`);
  setSecretKeys({ current: SECRET_KEY });
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.robin = owner.personId!;
  for (const [k, name, role] of [["mia", "Mia", "manager"], ["dev", "Dev", "front_desk"]] as const) {
    people[k] = ((await run(db, "person.create", { display_name: name, email: `${k}@example.test` }, owner)).result as any).person_id;
    await run(db, "role.assign", { person_id: people[k], role }, owner);
  }
  await db.insertInto("oauth_client").values({ client_id: CLIENT, kind: "registered", name: "openpadel (night-box)", redirect_uris: [], auth_method: "none", secret_hash: null, metadata: "{}" } as any).execute();
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: BASE, serviceFetch: fakeFetch as any });
  for (const e of ["robin@example.test", "mia@example.test", "dev@example.test"]) await signIn(e);
});
after(async () => { setSecretKeys({}); await drop(); });

test("one reader: the settings file (OPENPADEL_, else KUMI_) before what the app holds, and the new name before the old", async () => {
  assert.deepEqual(await serviceSetting(db, "RESEND_API_KEY", {}), { value: undefined, source: null });
  assert.deepEqual(await serviceSetting(db, "RESEND_API_KEY", { KUMI_RESEND_API_KEY: "re_old_name_123456" }), { value: "re_old_name_123456", source: "server" });
  assert.deepEqual(await serviceSetting(db, "RESEND_API_KEY", { KUMI_RESEND_API_KEY: "re_old", OPENPADEL_RESEND_API_KEY: "re_new" }), { value: "re_new", source: "server" });
});

test("the owner sets Resend up on its card: sent once, previewed by its ending, kept in the vault, never shown again", async () => {
  const st = await post("/staff/connectors/resend/stage", "robin@example.test", { values: { api_key: KEY, from: FROM } });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.ok(!JSON.stringify(st.json).includes(KEY));
  const p = await post("/actions/vault.service_set/plan", "robin@example.test", { service: "resend", values: st.json.values });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.summary, /^Set up Resend in the app: API key: a secret ending in 4f2a; From address: Kestrel Padel <hello@kestrel\.test>\./);
  assert.ok(!p.json.summary.includes(KEY));
  assert.equal((await post(`/runs/${p.json.run_id}/apply`, "robin@example.test")).status, 200);
  // The reader has it now, from the app; the file still wins when it has one.
  assert.deepEqual(await serviceSetting(db, "RESEND_API_KEY", {}), { value: KEY, source: "app" });
  assert.deepEqual(await serviceSetting(db, "RESEND_API_KEY", { OPENPADEL_RESEND_API_KEY: "re_pinned_on_server" }), { value: "re_pinned_on_server", source: "server" });
  // The card: set, ending 4f2a, in the app; the address as it is.
  forgetConnectorChecks();
  const card = (await (await get("/staff/connectors", "robin@example.test")).json() as any).built_ins.find((b: any) => b.key === "resend");
  assert.deepEqual(card.settings.find((s: any) => s.field === "api_key"), { field: "api_key", name: "OPENPADEL_RESEND_API_KEY", secret: true, needed: true, set: true, source: "app", last4: "4f2a", value: null });
  assert.equal(card.settings.find((s: any) => s.field === "from").value, FROM);
  assert.equal(card.form.keys_at, "https://resend.com/api-keys");
  // Nowhere: not the card a manager reads, the vault's list, the change log, a run's input or preview, or what changed.
  const managerReads = await (await get("/staff/connectors", "mia@example.test")).text() + await (await get("/staff/changes", "mia@example.test")).text();
  assert.ok(!managerReads.includes(KEY) && !(await (await get("/staff/vault", "robin@example.test")).text()).includes(KEY));
  assert.ok(!(await everythingKept()).includes(KEY), "never kept in the clear");
});

test("a manager, the desk, an agent's preview: refused; a strong sign-in is needed when the club asks one", async () => {
  for (const who of ["mia@example.test", "dev@example.test"]) {
    assert.equal((await post("/staff/connectors/resend/stage", who, { values: { api_key: KEY2 } })).status, 403);
    assert.equal((await get("/staff/connectors/resend/settings", who)).status, 403);
  }
  // A manager naming an upload anyway (the owner's, say) is refused before anything is kept.
  const st = await post("/staff/connectors/resend/stage", "robin@example.test", { values: { api_key: KEY2 } });
  const m = await post("/actions/vault.service_set/plan", "mia@example.test", { service: "resend", values: st.json.values });
  assert.equal(m.status, 403);
  // The club asks a second step of owners and managers: an emailed code isn't enough to change a key.
  await db.updateTable("club").set({ two_factor: "owner_manager" } as any).execute();
  try {
    const r = await post("/actions/vault.service_set/plan", "robin@example.test", { service: "resend", values: st.json.values });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /second_step|need_passkey/);
  } finally { await db.updateTable("club").set({ two_factor: "off" } as any).execute(); }
});

test("a wrong paste is caught before it's kept, without saying it back; a live Stripe key waits for go-live", async () => {
  const bad = await post("/staff/connectors/resend/stage", "robin@example.test", { values: { api_key: "sk_live_not_resend_9999" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /OPENPADEL_RESEND_API_KEY/);
  assert.ok(!JSON.stringify(bad.json).includes("not_resend_9999"));
  const live = await post("/staff/connectors/stripe/stage", "robin@example.test", { values: { secret_key: "sk_live_abcdefghijklmnop" } });
  assert.equal(live.status, 409);
  assert.equal(live.json.error, "error.service_live_in_practice");
});

test("email picks up a key set in the app with no restart: the log first, then Resend", async () => {
  await post("/actions/vault.service_remove/plan", "robin@example.test", { service: "resend" }).then((p) => post(`/runs/${p.json.run_id}/apply`, "robin@example.test"));
  const log = new MemoryMailer();
  const live = new LiveMailer(async () => {
    const e = await serviceEnv(db, {}), apiKey = e.OPENPADEL_RESEND_API_KEY, from = e.OPENPADEL_MAIL_FROM;
    return apiKey && from ? { apiKey, from, testTo: [], practice: false } : null;
  }, { log, fetch: fakeFetch as any });
  await live.refresh();
  await live.send({ to: "ann@example.test", subject: "a", text: "a" });
  assert.equal(live.reach(), "log");
  assert.equal(log.sent.length, 1);
  calls.length = 0;
  const st = await post("/staff/connectors/resend/stage", "robin@example.test", { values: { api_key: KEY2, from: FROM } });
  const p = await post("/actions/vault.service_set/plan", "robin@example.test", { service: "resend", values: st.json.values });
  await post(`/runs/${p.json.run_id}/apply`, "robin@example.test");
  await live.refresh();   // the server does this as the apply is told (onServiceSettingsChange), or within 30 seconds
  await live.send({ to: "ann@example.test", subject: "b", text: "b" });
  assert.equal(live.reach(), "sent");
  assert.equal(log.sent.length, 1, "not to the log any more");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  assert.equal(calls[0]!.auth, `Bearer ${KEY2}`);
});

test("the card's test: an email to the owner's own address, and Stripe's account for a test key", async () => {
  calls.length = 0;
  const r = await post("/staff/connectors/resend/test", "robin@example.test");
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.match(r.json.text, /robin@example\.test/);
  assert.equal(JSON.parse(calls[0]!.body).to[0], "robin@example.test");
  assert.equal((await post("/staff/connectors/resend/test", "mia@example.test")).status, 403);
  const st = await post("/staff/connectors/stripe/stage", "robin@example.test", { values: { secret_key: "sk_test_abcdefghijklmnop", publishable_key: "pk_test_abcdefghijklmnop" } });
  const p = await post("/actions/vault.service_set/plan", "robin@example.test", { service: "stripe", values: st.json.values });
  await post(`/runs/${p.json.run_id}/apply`, "robin@example.test");
  const s = await post("/staff/connectors/stripe/test", "robin@example.test");
  assert.equal(s.json.ok, true);
  assert.match(s.json.text, /acct_test_123, in test mode/);
});

test("doctor: where the settings come from, and a gentle warning for the old names (never a fail)", async () => {
  const checks = await doctor(db, { KUMI_PRACTICE: "1", OPENPADEL_MAIL_FROM: FROM }, { fetch: fakeFetch as any, resolveTxt: async () => [] });
  const names = checks.find((c) => c.id === "setting_names")!;
  assert.equal(names.state, "warn");
  assert.match(names.text.en, /old names \(KUMI_\).*openpadel settings rename/);
  const src = checks.find((c) => c.id === "service_settings")!;
  assert.equal(src.state, "ok");
  assert.match(src.text.en, /^Set in the app: .*OPENPADEL_RESEND_API_KEY\. The settings file has OPENPADEL_MAIL_FROM too/);
  assert.ok(!JSON.stringify(checks).includes(KEY2), "doctor never says a key");
  // Both names with different values: the new one is used, and doctor says so.
  const both = await doctor(db, { OPENPADEL_PRACTICE: "1", KUMI_PRACTICE: "0" }, { fetch: fakeFetch as any, resolveTxt: async () => [] });
  assert.match(both.find((c) => c.id === "setting_names")!.text.en, /OPENPADEL_PRACTICE set under both/);
  const none = await doctor(db, { OPENPADEL_PRACTICE: "1" }, { fetch: fakeFetch as any, resolveTxt: async () => [] });
  assert.equal(none.find((c) => c.id === "setting_names"), undefined);
  assert.ok(!checks.concat(both, none).some((c) => c.id === "setting_names" && c.state === "fail"));
  // The Connectors card judges email from what the app holds, too.
  forgetConnectorChecks();
  const v = await connectors(db, "en", { production: false, env: { OPENPADEL_PRACTICE: "1" }, fresh: true });
  assert.equal(v.built_ins.find((b) => b.key === "resend")!.status, "waiting", "set, in practice");
});

test("the command line as the owner: preview by the ending only, confirm, and never on a stale or second-step-less sign-in", async () => {
  const token = await deviceToken(people.robin!);
  const value = "re_from_password_manager_9e3b";
  const p = await bearer(token, "POST", "/connect/resend/plan", { set: [{ field: "api_key", value }] });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.summary, /API key: a secret ending in 9e3b/);
  assert.ok(!JSON.stringify(p.json).includes(value));
  const c = await bearer(token, "POST", "/connect/confirm", { run_id: p.json.run_id });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal((await serviceSetting(db, "RESEND_API_KEY", {})).value, value);
  const run = await db.selectFrom("action_run").select(["via", "status", "actor_person_id"]).where("id", "=", p.json.run_id).executeTakeFirstOrThrow();
  assert.deepEqual(run, { via: "cli:openpadel (night-box)", status: "applied", actor_person_id: people.robin });
  // What's set and where: values never, for the owner or a manager.
  const shown = await bearer(token, "GET", "/connect");
  assert.equal(shown.status, 200);
  assert.ok(!JSON.stringify(shown.json).includes(value));
  // Not without a fresh second step, not a manager, and its door confirms nothing but these changes.
  for (const [t, why] of [[await deviceToken(people.robin!, { secondStep: false }), "error.connect_fresh_step"], [await deviceToken(people.robin!, { secondStep: true, minutesAgo: 90 }), "error.connect_fresh_step"],
    [await deviceToken(people.mia!), "error.service_owner_only"]] as const) {
    const r = await bearer(t, "POST", "/connect/resend/plan", { set: [{ field: "api_key", value: KEY }] });
    assert.equal(r.status, 403); assert.equal(r.json.error, why);
  }
  const other = await run_(owner);
  assert.equal((await bearer(token, "POST", "/connect/confirm", { run_id: other })).status, 404);
  assert.ok(!(await everythingKept()).includes(value));
});
async function run_(a: Actor): Promise<string> {
  const { plan } = await import("@kumi/core");
  return (await plan(db, "tag.create", { name: "Not a service" }, a)).runId;
}

test("openpadel connect: a value on the command line is refused; from an environment variable it's sent, never printed", async () => {
  assert.deepEqual(parseConnect(["resend", "--set", "api_key=re_typed_in_history"]), { refuse: "cli.connect_no_argv" });
  assert.deepEqual(parseConnect(["resend", "--set", "api_key", "re_typed_in_history"]), { refuse: "cli.connect_no_argv" });
  assert.deepEqual(parseConnect(["resend", "--value", "re_x"]), { refuse: "cli.connect_no_argv" });
  assert.deepEqual(parseConnect(["resend", "--set", "api_key", "--from-stdin", "--set", "from", "--from-stdin"]), { refuse: "cli.connect_one_stdin" });
  assert.deepEqual(parseConnect(["resend", "--set", "api_key", "--from-env", "RESEND"]), { service: "resend", set: [{ field: "api_key", from: "RESEND" }], remove: null, link: false, confirm: null });
  const dir = mkdtempSync(join(tmpdir(), "openpadel-connect-"));
  try {
    const store = new Store(dir, false), out: string[] = [];
    const token = await deviceToken(people.robin!);
    store.saveClub({ url: BASE, issuer: BASE, resource: MCP, token_endpoint: `${BASE}/oauth/token`, client_id: CLIENT, person: "Robin Hale", lang: "en", club_name: "Kestrel Padel",
      time_zone: "America/Los_Angeles", store: "file", server_version: "0.9.0" }, { access_token: token, refresh_token: "r", expires_at: Date.now() + 3600_000 });
    let reached = 0;
    const cli = (env: Record<string, string>, ...argv: string[]) => remoteMain(argv, { store, out: (s) => out.push(s), err: (s) => out.push(s), sleep: async () => {}, now: () => Date.now(),
      hostname: "night-box", env, openBrowser: null, fetch: async (u, init) => { reached++; return app.request(String(u), init as RequestInit); } });
    assert.equal(await cli({}, "connect", "resend", "--set", "api_key", "re_typed_in_history_1234"), 2);
    assert.equal(reached, 0, "refused before anything is sent");
    const value = "re_from_the_environment_5a6b";
    assert.equal(await cli({ RESEND: value }, "connect", "resend", "--set", "api_key", "--from-env", "RESEND", "--json"), 10, out.join("\n"));
    const preview = JSON.parse(out.at(-1)!);
    assert.equal(preview.status, "preview");
    assert.match(preview.summary, /ending in 5a6b/);
    assert.match(preview.next, /^openpadel connect --confirm [0-9a-f-]{36}$/);
    assert.equal(await cli({}, "connect", "--confirm", preview.run_id, "--json"), 0, out.join("\n"));
    assert.equal(await cli({}, "connect", "resend"), 0);
    assert.ok(out.some((l) => /OPENPADEL_RESEND_API_KEY: set, ending 5a6b, in the app/.test(l)), out.join("\n"));
    assert.ok(!out.join("\n").includes(value), "never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openpadel connect on the server, as root: piped in, previewed by its ending, confirmed; never echoed", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const env = { PATH: process.env.PATH!, DATABASE_URL: dbUrl, OPENPADEL_SECRET_KEY: SECRET_KEY };
  const value = "whsec_c2VydmVyIHNpZGUgc2VjcmV0X3Y4";
  const r = spawnSync(process.execPath, [cli, "connect", "resend", "--set", "webhook_secret", "--from-stdin", "--json"], { env, input: `${value}\n`, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 10, r.stderr);
  assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value));
  const p = JSON.parse(r.stdout);
  assert.match(p.summary, /Webhook signing secret: a secret ending in X3Y4/);
  const c = spawnSync(process.execPath, [cli, "connect", "--confirm", p.run_id, "--json"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(c.status, 0, c.stderr);
  const s = spawnSync(process.execPath, [cli, "connect", "resend"], { env, encoding: "utf8", timeout: 30_000 });
  assert.match(s.stdout, /OPENPADEL_RESEND_WEBHOOK_SECRET: set, ending X3Y4, in the app/);
  assert.ok(!s.stdout.includes(value));
  const argv = spawnSync(process.execPath, [cli, "connect", "resend", "--set", "api_key", "re_typed_on_the_server_1"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(argv.status, 2);
  forgetServiceSettings();
});

test("a link straight to a service's form: the owner's alone, and only for 15 minutes", async () => {
  const token = await deviceToken(people.robin!, { secondStep: false });
  const l = await bearer(token, "POST", "/connect/twilio/link", {});
  assert.equal(l.status, 200, JSON.stringify(l.json));
  const u = new URL(l.json.link);
  assert.equal(u.pathname, "/connectors"); assert.equal(u.searchParams.get("set"), "twilio");
  const t = u.searchParams.get("link")!;
  assert.deepEqual((await (await get(`/staff/connectors/link/${t}`, "robin@example.test")).json()), { service: "twilio" });
  assert.equal((await get(`/staff/connectors/link/${t}`, "mia@example.test")).status, 403);
  await db.updateTable("connector_link").set({ expires_at: new Date(Date.now() - 1000) }).execute();
  assert.equal((await get(`/staff/connectors/link/${t}`, "robin@example.test")).status, 410);
  assert.equal((await bearer(await deviceToken(people.mia!), "POST", "/connect/twilio/link", {})).status, 403);
});

test("a change to a service's settings is undone from Changes like any other: the key before comes back", async () => {
  const set = async (value: string) => {
    const st = await post("/staff/connectors/playtomic/stage", "robin@example.test", { values: { secret: value } });
    const p = await post("/actions/vault.service_set/plan", "robin@example.test", { service: "playtomic", values: st.json.values });
    assert.equal((await post(`/runs/${p.json.run_id}/apply`, "robin@example.test")).status, 200);
    return p.json.run_id as string;
  };
  await set("first-playtomic-secret-1111");
  const second = await set("second-playtomic-secret-2222");
  forgetServiceSettings();
  assert.equal((await serviceSetting(db, "PLAYTOMIC_SECRET", {})).value, "second-playtomic-secret-2222");
  const u = await post("/actions/action.undo/plan", "robin@example.test", { run_id: second });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.ok(!JSON.stringify(u.json).includes("first-playtomic") && !JSON.stringify(u.json).includes("second-playtomic"));
  assert.equal((await post(`/runs/${u.json.run_id}/apply`, "robin@example.test")).status, 200);
  forgetServiceSettings();
  assert.equal((await serviceSetting(db, "PLAYTOMIC_SECRET", {})).value, "first-playtomic-secret-1111");
});

test("doctor in the Docker image: no old-names warning for the image's own KUMI_ defaults, only for what the club set", async () => {
  const image = { KUMI_INSTALL: "docker", KUMI_BACKUP_DIR: "/var/lib/kumi-pitr", OPENPADEL_IMAGE_DEFAULTS: "KUMI_INSTALL=docker KUMI_BACKUP_DIR=/var/lib/kumi-pitr", OPENPADEL_PRACTICE: "1" };
  const deps = { fetch: fakeFetch as any, resolveTxt: async () => [] };
  assert.equal((await doctor(db, image, deps)).find((c) => c.id === "setting_names"), undefined);
  assert.equal((await doctor(db, { ...image, OPENPADEL_BACKUP_DIR: "/srv/backups" }, deps)).find((c) => c.id === "setting_names"), undefined);
  assert.equal((await doctor(db, { ...image, KUMI_BACKUP_DIR: "/srv/backups" }, deps)).find((c) => c.id === "setting_names")!.state, "warn");
});
