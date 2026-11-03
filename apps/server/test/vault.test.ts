import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setSecretKeys, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {};
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1500, 66)]);
const get = (path: string, who?: string, env?: unknown) => app.request(path, { headers: who ? { cookie: cookies[who]! } : {} }, env as any);
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
async function act(who: string, action: string, input: unknown) {
  const p = await post(`/actions/${action}/plan`, who, input);
  if (p.status !== 200) return p;
  return post(`/runs/${p.json.run_id}/apply`, who);
}

before(async () => {
  ({ db, drop } = await freshDb());
  setSecretKeys({ current: Buffer.alloc(32, 1).toString("base64") });
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const mia = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner);
  await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
  for (const e of ["robin@example.test", "mia@example.test", "ann@example.test"]) await signIn(e);
});
after(async () => { setSecretKeys({}); await drop(); });

test("the owner keeps a secret: sent first, then previewed and confirmed; the list shows only its end", async () => {
  const up = await post("/staff/vault/upload", "robin@example.test", { kind: "secret", value: "door-code-58114729" });
  assert.equal(up.status, 200);
  assert.equal(up.json.last4, "4729");
  const p = await post("/actions/vault.add/plan", "robin@example.test", { name: "Front door", upload_id: up.json.upload_id });
  assert.equal(p.json.summary, "Keep a secret ending in 4729 in the vault as \"Front door\". Only the owner sees the vault, and what's in it is sealed with the server's own key.");
  assert.equal((await post(`/runs/${p.json.run_id}/apply`, "robin@example.test")).status, 200);
  const list = await (await get("/staff/vault", "robin@example.test")).text();
  assert.match(list, /"name":"Front door"/);
  assert.match(list, /"last4":"4729"/);
  assert.ok(!list.includes("58114729"));
  // The change log a manager can read has no value in it either.
  assert.ok(!(await (await get("/changes", "mia@example.test")).text()).includes("58114729"));
});

test("only the owner: a manager and a member are told no", async () => {
  assert.equal((await get("/staff/vault", "mia@example.test")).status, 403);
  assert.equal((await post("/staff/vault/upload", "mia@example.test", { kind: "secret", value: "x".repeat(20) })).status, 403);
  assert.equal((await get("/staff/vault", "ann@example.test")).status, 403);
  assert.equal((await get("/staff/vault")).status, 401);
});

test("a document: checked by its first bytes, kept, and downloaded only as a file", async () => {
  const bad = await post("/staff/vault/upload", "robin@example.test", { kind: "document", filename: "lease.pdf", data: Buffer.from("<html><script>x</script>").toString("base64") });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "error.vault_doc_type");
  const up = await post("/staff/vault/upload", "robin@example.test", { kind: "document", filename: "lease.pdf", data: PDF.toString("base64") });
  const r = await act("robin@example.test", "vault.add", { name: "Lease", upload_id: up.json.upload_id });
  const id = r.json.result.item_id;
  const file = await get(`/staff/vault/${id}/file`, "robin@example.test");
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.equal(file.headers.get("content-disposition"), "attachment; filename=\"lease.pdf\"");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  assert.equal((await get(`/staff/vault/${id}/file`, "mia@example.test")).status, 403);
  assert.equal((await get("/staff/vault/not-an-id/file", "robin@example.test")).status, 404);
  assert.match(await (await get("/staff/vault", "robin@example.test")).text(), /"downloads":\[\{"at":/);
});

test("/health names the release; /health/deep is for this machine, or an owner or manager", async () => {
  assert.deepEqual(await (await get("/health")).json(), { ok: true, version: "0.2.0", revision: "dev" });
  assert.equal((await get("/health/deep")).status, 401);
  assert.equal((await get("/health/deep", "ann@example.test")).status, 403);
  const deep = await get("/health/deep", "mia@example.test");
  const h = await deep.json() as any;
  assert.equal(h.database.ok, true);
  assert.deepEqual(Object.keys(h).sort(), ["answers", "backup", "database", "disks", "offsite", "ok", "outbox", "problems", "restore_test", "revision", "texts", "usage", "version"]);
  assert.equal(h.offsite.on, false);
  assert.deepEqual(h.texts, { on: false, sent: 0, failed: 0, dropped: 0, waiting: 0, month: { texts: 0, segments: 0, held: 0, estimate_cents: 0, actual_cents: null, paused: false } });
  assert.deepEqual([h.usage.spent_cents, h.usage.cap_cents, h.usage.limit_cents, h.usage.state], [0, 5000, 5000, "ok"]);
  assert.equal(deep.status, h.ok ? 200 : 503);
  // Straight from this machine it answers anyone; through the proxy (a forwarded address) it doesn't.
  const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
  assert.notEqual((await get("/health/deep", undefined, local)).status, 401);
  const proxied = await app.request("/health/deep", { headers: { "x-forwarded-for": "203.0.113.9" } }, local as any);
  assert.equal(proxied.status, 401);
});

test("/health/deep: an event nobody handles isn't the outbox falling behind; one given up on is", async () => {
  const outbox = async () => (await (await get("/health/deep", "mia@example.test")).json() as any).outbox;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  await db.updateTable("event_outbox").set({ delivered_at: new Date() }).where("delivered_at", "is", null).execute();
  await db.insertInto("event_outbox").values({ topic: "club.set_up", payload: JSON.stringify({}), created_at: hoursAgo(50) }).execute();
  assert.deepEqual(await outbox(), { events_behind_s: 0, events_given_up: 0, messages_behind_s: 0 });
  const stuck = await db.insertInto("event_outbox").values({ topic: "refund.requested", payload: JSON.stringify({}), created_at: hoursAgo(2) }).returning("id").executeTakeFirstOrThrow();
  const o = await outbox();
  assert.ok(o.events_behind_s >= 7190 && o.events_behind_s < 7300, String(o.events_behind_s));
  await db.updateTable("event_outbox").set({ attempts: 8 }).where("id", "=", stuck.id).execute();
  assert.deepEqual(await outbox(), { events_behind_s: 0, events_given_up: 1, messages_behind_s: 0 });
  await db.updateTable("event_outbox").set({ created_at: hoursAgo(8 * 24) }).where("id", "=", stuck.id).execute();
  assert.equal((await outbox()).events_given_up, 0);   // a week on, it's no longer news
  await db.deleteFrom("event_outbox").where("id", "=", stuck.id).execute();
});
