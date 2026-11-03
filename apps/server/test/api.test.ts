import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, uuidv7, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
const OWNER = "robin@example.test";

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; lang?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.lang) headers["accept-language"] = opts.lang;
  const res = await app.request(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, json: await res.json() as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
async function signIn(email: string): Promise<string> {
  assert.equal((await call("/auth/email/start", { body: { email } })).status, 200);
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await call("/auth/email/verify", { body: { email, code } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.cookie!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: OWNER, owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, secureCookies: false });
});
after(async () => drop());

test("sign in by emailed code, then /me shows the owner role", async () => {
  const cookie = await signIn(OWNER);
  const me = await call("/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.person.display_name, "Robin Hale");
  assert.deepEqual(me.json.roles.map((r: any) => r.key), ["owner"]);
});

test("an unknown email gets the same answer: a code to join, or nothing when sign-up is closed", async () => {
  const r = await call("/auth/email/start", { body: { email: "nobody@example.test" } });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { sent: true });
  assert.match(mailer.last("nobody@example.test")!.subject, /^Your code to join Kestrel Padel: \d{6}$/);
  await db.updateTable("club").set({ sign_up_open: false }).execute();
  try {
    const before = mailer.sent.length;
    const closed = await call("/auth/email/start", { body: { email: "nobody2@example.test" } });
    assert.equal(closed.status, 200); assert.deepEqual(closed.json, { sent: true });
    assert.equal(mailer.sent.length, before);
  } finally { await db.updateTable("club").set({ sign_up_open: true }).execute(); }
});

test("joining: the code, then a name and a club-news answer, and they're a member", async () => {
  const email = "Nadia@Example.test";
  await call("/auth/email/start", { body: { email }, lang: "es" });
  const join = mailer.last(email)!;
  assert.match(join.subject, /^Tu código para unirte a Kestrel Padel/);   // in the language they asked in
  const code = join.text.match(/\b(\d{6})\b/)![1]!;
  const v = await call("/auth/email/verify", { body: { email, code } });
  assert.equal(v.status, 200); assert.equal(v.json.sign_up, true); assert.equal(v.cookie, undefined, "no session until they've joined");
  const done = await call("/auth/sign-up", { body: { ticket: v.json.ticket, display_name: " Nadia Torres ", locale: "es", club_news: true } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const me = await call("/me", { cookie: done.cookie });
  assert.equal(me.json.person.display_name, "Nadia Torres");
  assert.deepEqual(me.json.roles.map((r: any) => r.key), ["member"]);
  const p = await db.selectFrom("person").selectAll().where("email", "=", "nadia@example.test").executeTakeFirstOrThrow();
  assert.equal(p.created_via, "signup"); assert.equal(p.locale, "es");
  const consent = await db.selectFrom("channel_consent").selectAll().where("person_id", "=", p.id).execute();
  assert.deepEqual(consent.map((c) => [c.channel, c.purpose, c.granted, c.source]), [["email", "club_news", true, "sign_up"]]);
  // The ticket works once; the next time they sign in normally.
  assert.equal((await call("/auth/sign-up", { body: { ticket: v.json.ticket, display_name: "Again", locale: "en", club_news: false } })).json.error, "error.sign_up_expired");
  assert.ok(await signIn(email));
});

test("a sign-up ticket runs out, and joining can't take an address that's already used", async () => {
  const email = "late@example.test";
  await call("/auth/email/start", { body: { email } });
  const v = await call("/auth/email/verify", { body: { email, code: mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]! } });
  await db.updateTable("auth_challenge").set({ expires_at: new Date(Date.now() - 1000) }).where("kind", "=", "sign_up").where("target", "=", email).execute();
  assert.equal((await call("/auth/sign-up", { body: { ticket: v.json.ticket, display_name: "Late", locale: "en", club_news: false } })).status, 401);
});

test("wrong codes run out after five tries, in the person's language", async () => {
  const email = "lee@example.test";
  await db.insertInto("person").values({ id: uuidv7(), display_name: "Lee", email, locale: "es", created_via: "desk" }).execute();
  await call("/auth/email/start", { body: { email } });
  assert.match(mailer.last(email)!.subject, /^Tu código para entrar a Kestrel Padel/);
  for (let i = 0; i < 4; i++) assert.equal((await call("/auth/email/verify", { body: { email, code: "000000" }, lang: "es" })).json.error, "error.bad_code");
  const fifth = await call("/auth/email/verify", { body: { email, code: "000000" }, lang: "es" });
  assert.equal(fifth.status, 429); assert.equal(fifth.json.message, "Demasiados intentos. Pide un código nuevo.");
});

test("signed out callers are turned away", async () => {
  const r = await call("/actions/club.update/plan", { body: { name: "X" } });
  assert.equal(r.status, 401); assert.equal(r.json.error, "error.signed_out");
});

test("preview, then confirm once, through the API; the change shows in Changes", async () => {
  const cookie = await signIn(OWNER);
  const p = await call("/actions/club.update/plan", { body: { name: "Kestrel Padel Club" }, cookie });
  assert.equal(p.status, 200); assert.equal(p.json.summary, "Change the name."); assert.equal(p.json.undo, "reversible");
  const key = uuidv7();
  assert.equal((await call(`/runs/${p.json.run_id}/apply`, { method: "POST", cookie, headers: { "idempotency-key": key } })).status, 200);
  assert.equal((await call(`/runs/${p.json.run_id}/apply`, { method: "POST", cookie, headers: { "idempotency-key": key } })).status, 200);
  const changes = await call("/staff/changes", { cookie });
  assert.equal(changes.json[0].summary, "Change the name."); assert.equal(changes.json[0].by, "Robin Hale");
});

test("a member is refused in Spanish and can't read Changes", async () => {
  const email = "ana@example.test", id = uuidv7();
  await db.insertInto("person").values({ id, display_name: "Ana", email, locale: "es", created_via: "desk" }).execute();
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: member.id, location_id: null }).execute();
  const cookie = await signIn(email);
  const r = await call("/actions/club.update/plan", { body: { name: "Mío" }, cookie });
  assert.equal(r.status, 403); assert.equal(r.json.message, "No puedes hacer eso: no tienes un rol que lo permita.");
  assert.equal((await call("/staff/changes", { cookie })).json.message, "Solo el personal puede ver esto.");
  const own = await call("/actions/person.update_profile/plan", { body: { person_id: id, display_name: "Ana R." }, cookie });
  assert.equal(own.json.summary, "Cambiar tu nombre visible en tu perfil.");
});

test("the action list carries each action's form schema", async () => {
  const cookie = await signIn(OWNER);
  const list = (await call("/actions", { cookie })).json;
  const club = list.find((a: any) => a.name === "club.update");
  assert.ok(club.input.properties.brand_colour);
  assert.ok(!list.some((a: any) => a.name === "club.setup"), "system actions aren't offered");
});

test("sign out ends the session", async () => {
  const cookie = await signIn(OWNER);
  await call("/auth/sign-out", { method: "POST", cookie });
  assert.equal((await call("/me", { cookie })).status, 401);
});
