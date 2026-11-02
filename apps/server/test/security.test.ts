import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, uuidv7, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { RateLimiter } from "../src/limits.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
let ip = "203.0.113.5";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, secureCookies: false, clientIp: () => ip });
});
after(async () => drop());

test("the limiter counts tries in a window, per key", () => {
  const l = new RateLimiter(2, 1000);
  assert.equal(l.take("a", 0), true); assert.equal(l.take("a", 10), true); assert.equal(l.take("a", 20), false);
  assert.equal(l.take("b", 20), true);
  assert.equal(l.take("a", 1015), true);   // the first try has left the window
});

test("one address can ask for 10 codes in 15 minutes, then waits", async () => {
  ip = "203.0.113.10";
  for (let i = 0; i < 10; i++) assert.equal((await post("/auth/email/start", { email: `p${i}@example.test` })).status, 200);
  const r = await post("/auth/email/start", { email: "p10@example.test" });
  assert.equal(r.status, 429); assert.equal(((await r.json()) as any).error, "error.too_many_requests");
  ip = "203.0.113.11";   // someone else isn't affected
  assert.equal((await post("/auth/email/start", { email: "q@example.test" })).status, 200);
});

test("join codes are capped club-wide each hour; the answer doesn't change", async () => {
  for (let i = 0; i < 31; i++) await db.insertInto("auth_challenge").values({ id: uuidv7(), kind: "email_code", target: `flood${i}@example.test`, code_hash: "x", expires_at: new Date(Date.now() + 600_000), consumed_at: null }).execute();
  ip = "203.0.113.12";
  const before = mailer.sent.length;
  const r = await post("/auth/email/start", { email: "stranger@example.test" });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { sent: true });
  assert.equal(mailer.sent.length, before, "no join email past the cap");
  // A member's own sign-in code still goes.
  await post("/auth/email/start", { email: "robin@example.test" });
  assert.match(mailer.last("robin@example.test")!.subject, /sign-in code/);
});

test("changes from another site, or as a form, are refused", async () => {
  ip = "203.0.113.13";
  assert.equal((await post("/auth/email/start", { email: "robin@example.test" }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/auth/email/start", { email: "robin@example.test" }, { "sec-fetch-site": "same-site" })).status, 403);   // a sibling subdomain
  const form = await app.request("/auth/sign-out", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415);
  assert.equal((await post("/auth/email/start", { email: "robin@example.test" }, { "sec-fetch-site": "same-origin" })).status, 200);
  // Stripe's webhook isn't a browser and checks its own signature.
  assert.notEqual((await app.request("/webhooks/stripe", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
});

test("security headers, and a limit on how much can be sent", async () => {
  const r = await app.request("/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(((await r.json()) as any).version, /^\d+\.\d+\.\d+$/);
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.ok(r.headers.get("strict-transport-security"));
  const big = await post("/staff/people/import-preview", { csv: "x".repeat(4 * 1024 * 1024) });
  assert.equal(big.status, 413);
});

test("the apps can be installed: a manifest in the club's name and color, and icons", async () => {
  const m = await app.request("/manifest/staff.webmanifest");
  assert.equal(m.headers.get("content-type"), "application/manifest+json");
  const j = await m.json() as any;
  assert.equal(j.name, "Kestrel Padel Staff"); assert.equal(j.display, "standalone"); assert.match(j.theme_color, /^#[0-9A-Fa-f]{6}$/);
  assert.deepEqual(j.icons.map((i: any) => i.sizes), ["192x192", "512x512"]);
  const png = Buffer.from(await (await app.request("/manifest/icon-192.png")).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 192); assert.equal(png.readUInt32BE(20), 192);
});

test("tries at one code made at once can't get past five, and of two right ones at once only one signs in", async () => {
  const { startEmailSignIn, verifyEmailCode } = await import("../src/auth.ts");
  await startEmailSignIn(db, mailer, "robin@example.test", "en");
  const real = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const guesses = Array.from({ length: 40 }, (_, i) => String((Number(real) + 1 + i) % 1e6).padStart(6, "0"));
  await Promise.allSettled(guesses.map((g) => verifyEmailCode(db, "robin@example.test", g, null)));
  const ch = await db.selectFrom("auth_challenge").select(["attempts", "consumed_at"]).where("kind", "=", "email_code").where("target", "=", "robin@example.test").orderBy("created_at", "desc").executeTakeFirstOrThrow();
  assert.equal(ch.attempts, 5, "five compared, no more");
  await assert.rejects(verifyEmailCode(db, "robin@example.test", real, null), /too_many_attempts|Too many/);
  await db.deleteFrom("auth_challenge").where("target", "=", "robin@example.test").execute();
  await startEmailSignIn(db, mailer, "robin@example.test", "en");
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const both = await Promise.allSettled([verifyEmailCode(db, "robin@example.test", code, null), verifyEmailCode(db, "robin@example.test", code, null)]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
});

test("registering an assistant: a few an hour from one address, a few kilobytes, and only what's used is kept; unused ones are tidied", async () => {
  ip = "203.0.113.40";
  const reg = (body: unknown) => post("/oauth/register", body);
  const big = await reg({ redirect_uris: ["https://a.example/cb"], client_name: "A", junk: "x".repeat(20_000) });
  assert.equal(big.status, 413);
  const ok = await reg({ redirect_uris: ["https://a.example/cb"], client_name: "A".repeat(200), logo: "y".repeat(3000) });
  assert.equal(ok.status, 201);
  const id = ((await ok.json()) as any).client_id as string;
  const row = await db.selectFrom("oauth_client").select(["name", "metadata"]).where("client_id", "=", id).executeTakeFirstOrThrow();
  assert.equal(row.name, "A".repeat(80));
  assert.deepEqual(row.metadata, { client_name: "A".repeat(80) });
  for (let i = 0; i < 8; i++) assert.equal((await reg({ redirect_uris: ["https://a.example/cb"] })).status, 201);
  assert.equal((await reg({ redirect_uris: ["https://a.example/cb"] })).status, 429, "the eleventh in an hour, counting the refused one");
  const { tidySignIns } = await import("../src/oauth.ts");
  const later = new Date(Date.now() + 8 * 864e5);
  const t = await tidySignIns(db, later);
  assert.ok(t.clients >= 9 && t.challenges >= 1, JSON.stringify(t));
  assert.equal(await db.selectFrom("oauth_client").select("client_id").where("client_id", "=", id).executeTakeFirst(), undefined);
});
