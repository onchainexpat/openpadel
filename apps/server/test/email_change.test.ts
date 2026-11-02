import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

// A member changes their own email: a code to the new address, the old one told with a link that puts it back.
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, ann: string;
const mailer = new MemoryMailer();
const post = async (path: string, body: unknown, cookie = "") => {
  const r = await app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
};
const get = async (path: string, cookie = "") => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, text: await r.text() }; };
const codeIn = (to: string) => mailer.last(to)!.text.match(/\b(\d{6})\b/)![1]!;
async function signIn(email: string) {
  await post("/auth/email/start", { email });
  return (await post("/auth/email/verify", { email, code: codeIn(email) })).cookie;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  ann = ((await run(db, "person.create", { display_name: "Ann Lee", email: "ann@example.test" }, owner)).result as { person_id: string }).person_id;
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://staff.kestrel.example", memberUrl: "https://kestrel.example" });
});
after(async () => drop());

test("a member changes their email with a code to the new address; the old address is told, with a link back", async () => {
  const cookie = await signIn("ann@example.test");
  assert.equal(JSON.parse((await get("/me", cookie)).text).email, "ann@example.test");
  assert.equal((await post("/my/email/start", { email: "ANN@example.test" }, cookie)).json.error, "error.email_same");
  assert.deepEqual((await post("/my/email/start", { email: "ann.lee@example.test" }, cookie)).json, { sent: true });
  assert.deepEqual((await post("/my/email/verify", { code: codeIn("ann.lee@example.test") }, cookie)).json, { email: "ann.lee@example.test" });
  const told = mailer.last("ann@example.test")!;
  assert.equal(told.subject, "Your email at Kestrel Padel was changed");
  assert.match(told.text, /^Ann Lee, the email for your account at Kestrel Padel is now ann\.lee@example\.test\. If you made this change, there's nothing to do\./);
  assert.match(told.text, /https:\/\/kestrel\.example\/auth\/email-undo\/[A-Za-z0-9_-]{43}$/);
  // The new address signs in; the old one doesn't any more.
  assert.ok(await signIn("ann.lee@example.test"));
  const p = await db.selectFrom("person").select("email").where("id", "=", ann).executeTakeFirstOrThrow();
  assert.equal(p.email, "ann.lee@example.test");
  assert.equal((await db.selectFrom("auth_identity").select("value").where("person_id", "=", ann).where("kind", "=", "email").execute()).map((r) => r.value).join(), "ann.lee@example.test");
});

test("\"this wasn't me\": opening the link changes nothing; its button puts the old address back and signs everyone out, once", async () => {
  const link = mailer.last("ann@example.test")!.text.match(/(\/auth\/email-undo\/\S+)$/)![1]!;
  const cookie = await signIn("ann.lee@example.test");
  await db.insertInto("oauth_client").values({ client_id: "kc_x", kind: "registered", name: "X", redirect_uris: ["http://localhost/cb"], secret_hash: null, metadata: null }).execute();
  const grant = uuidv7();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: ann, client_id: "kc_x", scopes: ["kumi"], revoked_at: null }).execute();
  const page = await get(link);
  assert.equal(page.status, 200);
  assert.match(page.text, /Put ann@example\.test back on your account, and sign everyone out of it\?/);
  assert.equal((await db.selectFrom("person").select("email").where("id", "=", ann).executeTakeFirstOrThrow()).email, "ann.lee@example.test", "opening it changed nothing");
  const done = await app.request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Done: ann@example\.test is back on your account/);
  assert.equal((await db.selectFrom("person").select("email").where("id", "=", ann).executeTakeFirstOrThrow()).email, "ann@example.test");
  assert.equal((await post("/my/email/start", { email: "x@example.test" }, cookie)).status, 401, "signed out everywhere");
  assert.ok((await db.selectFrom("oauth_grant").select("revoked_at").where("id", "=", grant).executeTakeFirstOrThrow()).revoked_at, "assistants too");
  assert.equal(mailer.last("ann@example.test")!.subject, "Your email at Kestrel Padel is back");
  const again = await app.request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
  assert.equal(again.status, 404);
});

test("someone with a passkey changes their email only when signed in with it; another account's address gets the same answer", async () => {
  const cookie = await signIn("ann@example.test");
  await db.insertInto("passkey").values({ credential_id: "cred-ann", person_id: ann, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Phone", last_used_at: null, revoked_at: null }).execute();
  assert.equal((await post("/my/email/start", { email: "ann2@example.test" }, cookie)).json.error, "error.need_passkey");
  await db.updateTable("passkey").set({ revoked_at: new Date() }).where("credential_id", "=", "cred-ann").execute();
  const before = mailer.sent.length;
  assert.deepEqual((await post("/my/email/start", { email: "robin@example.test" }, cookie)).json, { sent: true });
  assert.equal(mailer.sent.length, before + 1);
  assert.equal(mailer.last("robin@example.test")!.subject, "Someone tried to use this email at Kestrel Padel");
  assert.equal((await post("/my/email/verify", { code: "123456" }, cookie)).status, 401);
  assert.equal((await db.selectFrom("person").select("email").where("id", "=", ann).executeTakeFirstOrThrow()).email, "ann@example.test");
});
