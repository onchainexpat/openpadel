import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { SoftPasskey } from "./authenticator.ts";

const BASE = "https://club.example.test", OWNER = "robin@example.test";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, clock = new Date();
const mailer = new MemoryMailer();
const key = new SoftPasskey(BASE);

async function call(path: string, opts: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.request(`${BASE}${path}`, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, json: await res.json() as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
async function emailSignIn(): Promise<string> {
  await call("/auth/email/start", { body: { email: OWNER } });
  const code = mailer.last(OWNER)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await call("/auth/email/verify", { body: { email: OWNER, code } })).cookie!;
}
async function passkeySignIn(k = key): Promise<{ status: number; cookie?: string; json: any }> {
  const o = await call("/auth/passkey/sign-in/options", { body: {} });
  return call("/auth/passkey/sign-in/verify", { body: { challenge_id: o.json.challenge_id, response: k.get(o.json.options) } });
}

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: OWNER, owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, publicUrl: BASE, secureCookies: false, now: () => clock });
});
after(async () => drop());

test("before any passkey, an emailed code is enough for settings", async () => {
  const cookie = await emailSignIn();
  assert.equal((await call("/actions/club.update/plan", { body: { brand_colour: "#111111" }, cookie })).status, 200);
});

test("add a passkey: it's in Changes and the person gets an email", async () => {
  const cookie = await emailSignIn();
  const o = await call("/auth/passkey/add/options", { body: {}, cookie });
  assert.equal(o.status, 200); assert.equal(o.json.options.rp.id, "club.example.test");
  const v = await call("/auth/passkey/add/verify", { body: { challenge_id: o.json.challenge_id, response: key.create(o.json.options), name: "Robin's phone" }, cookie });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const runRow = await db.selectFrom("action_run").select(["status", "via"]).where("action", "=", "person.passkey_add").executeTakeFirstOrThrow();
  assert.equal(runRow.status, "applied");
  assert.equal(mailer.last(OWNER)!.subject, "A passkey was added to your Kestrel Padel account");
});

test("sign in with the passkey; settings now need it, and an emailed code isn't enough", async () => {
  const pk = await passkeySignIn();
  assert.equal(pk.status, 200, JSON.stringify(pk.json));
  assert.equal((await call("/me", { cookie: pk.cookie })).json.signed_in_with, "passkey");
  assert.equal((await call("/actions/club.update/plan", { body: { brand_colour: "#222222" }, cookie: pk.cookie })).status, 200);
  const email = await emailSignIn();
  const r = await call("/actions/club.update/plan", { body: { brand_colour: "#333333" }, cookie: email });
  assert.equal(r.status, 403); assert.equal(r.json.message, "A change like this needs your second step: sign in with your passkey, or give your authenticator app's code.");
  assert.equal((await call("/actions/person.update_profile/plan", { body: { person_id: (await call("/me", { cookie: email })).json.person.id, display_name: "Robin H." }, cookie: email })).status, 200, "everyday changes still work with an emailed code");
});

test("a replayed sign-in fails, and so does a passkey nobody registered", async () => {
  const o = await call("/auth/passkey/sign-in/options", { body: {} });
  const response = key.get(o.json.options);
  assert.equal((await call("/auth/passkey/sign-in/verify", { body: { challenge_id: o.json.challenge_id, response } })).status, 200);
  assert.equal((await call("/auth/passkey/sign-in/verify", { body: { challenge_id: o.json.challenge_id, response } })).status, 400);
  assert.equal((await passkeySignIn(new SoftPasskey(BASE))).status, 400);
});

test("adding a passkey needs a fresh sign-in", async () => {
  const cookie = await emailSignIn();
  const later = clock; clock = new Date(clock.getTime() + 20 * 60_000);
  const r = await call("/auth/passkey/add/options", { body: {}, cookie });
  clock = later;
  assert.equal(r.status, 403); assert.equal(r.json.error, "error.recent_sign_in");
});

test("the passkey-adding action can't be called through the API", async () => {
  const pk = await passkeySignIn();
  const r = await call("/actions/person.passkey_add/plan", { body: { person_id: "00000000-0000-7000-8000-000000000001", credential_id: "abcdefgh", public_key: "x", counter: 0 }, cookie: pk.cookie });
  assert.equal(r.status, 404);
});

test("removing a passkey, with a passkey sign-in, stops it working", async () => {
  const pk = await passkeySignIn();
  const me = (await call("/me", { cookie: pk.cookie })).json.person.id;
  const p = await call("/actions/person.passkey_remove/plan", { body: { person_id: me, credential_id: key.credId.toString("base64url") }, cookie: pk.cookie });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await call(`/runs/${p.json.run_id}/apply`, { method: "POST", cookie: pk.cookie })).status, 200);
  assert.equal((await passkeySignIn()).status, 400);
});
