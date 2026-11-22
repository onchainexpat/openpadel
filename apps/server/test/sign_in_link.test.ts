// An owner's one-time sign-in link (auth.ts, `openpadel sign-in-link`): for the first sign-in on a new server with no
// email service yet, so nobody reads a code out of the server's log and passes it on. Only owners, only while there's no
// email service, once, for 15 minutes; opening it changes nothing, the button signs in. And `openpadel keys`, for an owner
// with no shell of their own to check the keys they keep: set or missing, and the last 4 characters only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { base32Decode, run, runAsSystem, totp, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { LINK_MINUTES, makeSignInLink, signInLinkTarget, useSignInLink } from "../src/auth.ts";

let db: Db, drop: () => Promise<void>, url: string, owner: Actor, ownerId: string;
const mailer = new MemoryMailer();
const NOW = new Date("2026-11-18T20:00:00Z");
const appWith = (mailReach: "log" | "practice" | "sent") => makeApp({ db, mailer, mailReach, secureCookies: false, publicUrl: "https://staff.kestrel.example", memberUrl: "https://kestrel.example", now: () => NOW });
const pathOf = (token: string) => `/auth/link/${token}`;

before(async () => {
  ({ db, drop } = await freshDb());
  const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
  url = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "Robin@Kestrel.example", owner_name: "Robin Hale" }, "setup");
  ownerId = (s.result as { owner_person_id: string }).owner_person_id;
  owner = { personId: ownerId, via: "test", lang: "en", auth: "passkey" };
  const dana = ((await run(db, "person.create", { display_name: "Dana Ortiz", email: "dana@kestrel.example" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: dana, role: "manager" }, owner);
});
after(async () => drop());

test("only an owner gets a link; it's kept as a hash, and a new one ends the one before", async () => {
  assert.equal(await makeSignInLink(db, "dana@kestrel.example", NOW), null, "a manager signs in by code");
  assert.equal(await makeSignInLink(db, "nobody@kestrel.example", NOW), null);
  const first = (await makeSignInLink(db, "robin@kestrel.example", NOW))!;
  assert.equal(first.personId, ownerId);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.expiresAt.getTime() - NOW.getTime(), LINK_MINUTES * 60_000);
  const rows = await db.selectFrom("auth_challenge").select(["code_hash", "target"]).where("kind", "=", "sign_in_link").execute();
  assert.ok(rows.every((r) => r.code_hash !== first.token), "the token itself isn't stored");
  const second = (await makeSignInLink(db, "robin@kestrel.example", NOW))!;
  assert.equal(await signInLinkTarget(db, first.token, NOW), null, "the first one ended");
  assert.equal((await signInLinkTarget(db, second.token, NOW))!.personId, ownerId);
  assert.equal(await signInLinkTarget(db, second.token, new Date(NOW.getTime() + LINK_MINUTES * 60_000 + 1000)), null, "it runs out");
});

test("opening the link changes nothing; its button signs the owner in once, into the staff app", async () => {
  const app = appWith("log"), { token } = (await makeSignInLink(db, "robin@kestrel.example", NOW))!;
  for (let i = 0; i < 2; i++) {   // a chat app's preview, then the owner
    const page = await app.request(pathOf(token), { headers: { "accept-language": "es" } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /Robin Hale \(Robin@Kestrel\.example\)/);
    assert.match(html, /<form method="post"><button type="submit">Sign in<\/button>/);
    assert.ok(!html.includes("—"));
  }
  const used = await app.request(pathOf(token), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
  assert.equal(used.status, 303); assert.equal(used.headers.get("location"), "/");
  const cookie = used.headers.get("set-cookie")!.split(";")[0]!;
  const me = await (await app.request("/me", { headers: { cookie } })).json() as { person: { id: string }; signed_in_with: string; gate: string | null };
  assert.equal(me.person.id, ownerId); assert.equal(me.signed_in_with, "email_code");
  assert.equal(me.gate, "setup", "a link's session owes a second step, though the club asks none at sign-in");
  // It proves nothing about the mailbox.
  const ids = await db.selectFrom("auth_identity").select("verified_at").where("person_id", "=", ownerId).where("kind", "=", "email").execute();
  assert.ok(ids.every((i) => i.verified_at === null));
  // Once only, and the page says what to do now, in the person's language.
  const again = await app.request(pathOf(token), { method: "POST", headers: { "accept-language": "es" } });
  assert.equal(again.status, 404);
  assert.match(await again.text(), /Este enlace para iniciar sesión ya se usó o venció \(cada uno funciona una vez, durante 15 minutos\)/);
  assert.equal((await app.request(pathOf(token))).status, 404);
});

test("a link's session can do nothing until a second step is set up; then it's a full session; with one already, it must be given", async () => {
  const app = appWith("log"), json = { "content-type": "application/json" };
  const signIn = async () => {
    const { token } = (await makeSignInLink(db, "robin@kestrel.example", NOW))!;
    return (await app.request(pathOf(token), { method: "POST" })).headers.get("set-cookie")!.split(";")[0]!;
  };
  const read = (cookie: string) => app.request("/staff/coaches", { headers: { cookie } });
  const act = (cookie: string) => app.request("/actions/location.create/plan", { method: "POST", headers: { cookie, ...json }, body: JSON.stringify({ name: "Northside", time_zone: "America/Los_Angeles" }) });
  const gateOf = async (cookie: string) => ((await (await app.request("/me", { headers: { cookie } })).json()) as { gate: string | null }).gate;

  // No passkey or authenticator yet: setup, and nothing else answers.
  const first = await signIn();
  assert.equal(await gateOf(first), "setup");
  for (const r of [await read(first), await act(first)]) { assert.equal(r.status, 403); assert.equal(((await r.json()) as { error: string }).error, "error.two_step_needed"); }
  const status = await (await app.request("/my/two-factor", { headers: { cookie: first } })).json() as { by_link?: boolean; two_step_now: boolean };
  assert.equal(status.by_link, true); assert.equal(status.two_step_now, false);
  // The device and consent pages on such a session: finish signing in in the club's app first, in the person's language.
  const reg = await (await app.request("/oauth/register", { method: "POST", headers: json, body: JSON.stringify({ client_name: "openpadel (laptop)", redirect_uris: ["http://127.0.0.1/kumi-device"], token_endpoint_auth_method: "none", software_id: "kumi-cli" }) })).json() as { client_id: string };
  const started = await (await app.request("/oauth/device_authorization", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: reg.client_id, resource: "https://staff.kestrel.example/mcp", scope: "kumi" }).toString() })).json() as { user_code: string };
  const device = await (await app.request("/oauth/device", { method: "POST", headers: { cookie: first, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: started.user_code }).toString() })).text();
  assert.match(device, /Finish signing in in the club&#39;s app \(with your passkey, or by setting one up\)/);
  assert.ok(!/name="req"/.test(device), "no consent to allow on half a sign-in");
  // Setting up an authenticator, with its recovery codes, makes the session two-step: everything answers.
  const setup = await (await app.request("/auth/totp/setup", { method: "POST", headers: { cookie: first, ...json }, body: "{}" })).json() as { challenge_id: string; key: string };
  const secret = base32Decode(setup.key.replaceAll(" ", ""));
  const confirmed = await app.request("/auth/totp/confirm", { method: "POST", headers: { cookie: first, ...json }, body: JSON.stringify({ challenge_id: setup.challenge_id, code: totp(secret, NOW) }) });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.equal(((await confirmed.json()) as { codes: string[] }).codes.length, 10);
  assert.equal(await gateOf(first), null);
  assert.equal((await read(first)).status, 200);
  assert.equal((await act(first)).status, 200);

  // The next link: they have an authenticator, so they give its code before anything works.
  const second = await signIn();
  assert.equal(await gateOf(second), "verify");
  assert.equal((await read(second)).status, 403);
  assert.equal((await app.request("/auth/totp/setup", { method: "POST", headers: { cookie: second, ...json }, body: "{}" })).status, 403, "no second authenticator from a link: only giving the one they have");
  const later = new Date(NOW.getTime() + 60_000), app2 = makeApp({ db, mailer, mailReach: "log", secureCookies: false, publicUrl: "https://staff.kestrel.example", memberUrl: "https://kestrel.example", now: () => later });
  assert.equal((await app2.request("/auth/totp/verify", { method: "POST", headers: { cookie: second, ...json }, body: JSON.stringify({ code: totp(secret, later) }) })).status, 200);
  assert.equal((await app2.request("/staff/coaches", { headers: { cookie: second } })).status, 200);
});

test("signing in by an emailed code is as before: no second step unless the club or the person asks one", async () => {
  const app = makeApp({ db, mailer, mailReach: "sent", secureCookies: false, publicUrl: "https://staff.kestrel.example", memberUrl: "https://kestrel.example", now: () => NOW });
  const lee = ((await run(db, "person.create", { display_name: "Lee Chen", email: "lee@kestrel.example" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: lee, role: "manager" }, owner);
  const json = { "content-type": "application/json" };
  await app.request("/auth/email/start", { method: "POST", headers: json, body: JSON.stringify({ email: "lee@kestrel.example" }) });
  const code = mailer.last("lee@kestrel.example")!.text.match(/\b(\d{6})\b/)![1]!;
  const cookie = (await app.request("/auth/email/verify", { method: "POST", headers: json, body: JSON.stringify({ email: "lee@kestrel.example", code }) })).headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(((await (await app.request("/me", { headers: { cookie } })).json()) as { gate: string | null }).gate, null);
  assert.equal((await app.request("/staff/coaches", { headers: { cookie } })).status, 200);
  assert.equal((await db.selectFrom("web_session").select("second_step_owed").where("person_id", "=", lee).executeTakeFirstOrThrow()).second_step_owed, false);
});

test("of two at once only one gets in; an owner no longer an owner gets nothing", async () => {
  const { token } = (await makeSignInLink(db, "robin@kestrel.example", NOW))!;
  const both = await Promise.all([useSignInLink(db, token, null, NOW), useSignInLink(db, token, null, NOW)]);
  assert.equal(both.filter(Boolean).length, 1);
  const dana = (await db.selectFrom("person").select("id").where("email", "=", "dana@kestrel.example").executeTakeFirstOrThrow()).id;
  await run(db, "role.assign", { person_id: dana, role: "owner" }, owner);
  const link = (await makeSignInLink(db, "dana@kestrel.example", NOW))!;
  const role = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id").where("person_role.person_id", "=", dana).where("role.key", "=", "owner").executeTakeFirstOrThrow();
  await db.updateTable("person_role").set({ active: false }).where("id", "=", role.id).execute();
  assert.equal(await useSignInLink(db, link.token, null, NOW), null);
});

test("with an email service, links don't work: the page says to sign in with the emailed code", async () => {
  const { token } = (await makeSignInLink(db, "robin@kestrel.example", NOW))!;
  for (const reach of ["practice", "sent"] as const) {
    const app = appWith(reach);
    const page = await app.request(pathOf(token));
    assert.equal(page.status, 404); assert.match(await page.text(), /only work before the club&#39;s email is set up/);
    assert.equal((await app.request(pathOf(token), { method: "POST" })).status, 404);
  }
  assert.ok(await signInLinkTarget(db, token, NOW), "still unused: refusing it used nothing up");
});

test("openpadel sign-in-link: prints the link for an owner, and refuses once email is set up or for anyone else", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const go = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [cli, "sign-in-link", ...args], { encoding: "utf8",
    env: { PATH: process.env.PATH!, KUMI_LANG: "en", DATABASE_URL: url, KUMI_PUBLIC_URL: "https://staff.kestrel.example/", NODE_ENV: "production", KUMI_PRACTICE: "1", ...env } });
  const ok = go({}, "robin@kestrel.example", "--json");
  assert.equal(ok.status, 0, ok.stderr);
  const r = JSON.parse(ok.stdout) as { ok: boolean; url: string; works_once: boolean; expires_at: string };
  assert.equal(r.ok, true); assert.equal(r.works_once, true);
  assert.match(r.url, /^https:\/\/staff\.kestrel\.example\/auth\/link\/[A-Za-z0-9_-]{43}$/);
  const plain = go({}, "robin@kestrel.example");
  assert.match(plain.stdout, /It works once, for the next 15 minutes, and only for them: give it to them, and don't open it yourself\./);
  assert.equal(go({ KUMI_RESEND_API_KEY: "re_x" }, "robin@kestrel.example").status, 2);
  assert.match(go({ KUMI_RESEND_API_KEY: "re_x" }, "robin@kestrel.example").stderr, /Email is set up on this server/);
  assert.equal(go({ KUMI_PRACTICE: "" }, "robin@kestrel.example").status, 2, "live, never");
  assert.match(go({}, "dana@kestrel.example").stderr, /isn't an owner of this club/);
});

test("openpadel keys: whether each key is set and its last 4 characters, never the key", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const secret = Buffer.alloc(32, 7).toString("base64"), backup = Buffer.alloc(32, 9).toString("base64");
  const r = spawnSync(process.execPath, [cli, "keys", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH!, KUMI_SECRET_KEY: secret, KUMI_BACKUP_KEY: backup } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(secret) && !r.stdout.includes(backup.slice(0, 20)));
  assert.deepEqual(JSON.parse(r.stdout).keys, [{ name: "OPENPADEL_SECRET_KEY", set: true, ends_in: secret.replace(/=+$/, "").slice(-4) }, { name: "OPENPADEL_BACKUP_KEY", set: true, ends_in: backup.replace(/=+$/, "").slice(-4) }]);
  const none = spawnSync(process.execPath, [cli, "keys", "--lang=es"], { encoding: "utf8", env: { PATH: process.env.PATH!, KUMI_SECRET_KEY: secret } });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /OPENPADEL_BACKUP_KEY: no está en \/etc\/kumi\/kumi\.env\./);
  assert.match(none.stdout, /OPENPADEL_SECRET_KEY: definida, termina en/);
});
