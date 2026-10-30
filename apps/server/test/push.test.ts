import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, cookie: string;
const mailer = new MemoryMailer();
const call = async (path: string, body?: unknown) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() as any }; };

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, secureCookies: false });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => drop());

test("a device turns notifications on and off; only what a browser gives is taken", async () => {
  const key = (await call("/my/push/key")).json.public_key;
  assert.equal(Buffer.from(key, "base64url").length, 65);
  const e = createECDH("prime256v1"); e.generateKeys();
  const sub = { app: "staff", endpoint: "https://fcm.googleapis.com/fcm/send/abc123def456", keys: { p256dh: e.getPublicKey().toString("base64url"), auth: "AAECAwQFBgcICQoLDA0ODw" } };
  assert.equal((await call("/my/push", sub)).status, 200);
  assert.equal((await call("/my/push", { ...sub, endpoint: "http://evil.test/x" })).status, 400);   // https only
  assert.equal((await call("/my/push", { ...sub, app: "other" })).status, 400);
  const row = await db.selectFrom("push_subscription").selectAll().executeTakeFirstOrThrow();
  assert.deepEqual([row.app, row.revoked_at], ["staff", null]);
  await call("/my/push/off", { endpoint: sub.endpoint });
  assert.ok((await db.selectFrom("push_subscription").select("revoked_at").executeTakeFirstOrThrow()).revoked_at);
  assert.equal((await app.request("/my/push/key")).status, 401);   // signed in only
});
