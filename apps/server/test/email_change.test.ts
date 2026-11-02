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

test("staff change a member's email for them: signed in strongly, a code the member reads out, the old address told; never a staff member's unless the owner", async () => {
  const strong = async (email: string) => { const c = await signIn(email); await db.updateTable("web_session").set({ second_factor: "totp" }).where("person_id", "=", (await db.selectFrom("person").select("id").where("email", "=", email).executeTakeFirstOrThrow()).id).execute(); return c; };
  const lee = ((await run(db, "person.create", { display_name: "Lee Chen", email: "lee@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: lee, role: "front_desk" }, owner);
  const bo = ((await run(db, "person.create", { display_name: "Bo Park", email: "bo@example.test", locale: "es" }, owner)).result as { person_id: string }).person_id;
  const weak = await signIn("lee@example.test");
  assert.equal((await post(`/staff/people/${bo}/email/start`, { email: "bo.park@example.test" }, weak)).json.error, "error.need_passkey");
  const desk = await strong("lee@example.test");
  assert.deepEqual((await post(`/staff/people/${bo}/email/start`, { email: "bo.park@example.test" }, desk)).json, { sent: true });
  assert.match(mailer.last("bo.park@example.test")!.subject, /Kestrel Padel/);   // in Bo's language
  assert.equal((await post(`/staff/people/${bo}/email/verify`, { code: "000000" }, desk)).json.error, "error.bad_code");
  assert.deepEqual((await post(`/staff/people/${bo}/email/verify`, { code: codeIn("bo.park@example.test") }, desk)).json, { email: "bo.park@example.test" });
  assert.equal((await db.selectFrom("person").select("email").where("id", "=", bo).executeTakeFirstOrThrow()).email, "bo.park@example.test");
  assert.match(mailer.last("bo@example.test")!.text, /\/auth\/email-undo\//);   // the old address is told, with its way back
  const audit = await db.selectFrom("action_run").select(["via", "input"]).where("action", "=", "email.change").orderBy("created_at", "desc").executeTakeFirstOrThrow();
  assert.deepEqual([audit.via, (audit.input as any).by], ["staff", lee]);
  // A staff member's email is theirs or the owner's: the desk can't change the owner's, or its own here.
  assert.equal((await post(`/staff/people/${owner.personId}/email/start`, { email: "x@example.test" }, desk)).json.error, "error.staff_email_change");
  assert.equal((await post(`/staff/people/${lee}/email/start`, { email: "x@example.test" }, desk)).json.error, "error.staff_email_change");
  // A member signed in strongly isn't staff.
  const annCookie = await strong("ann.lee@example.test").catch(() => strong("ann@example.test"));
  assert.equal((await post(`/staff/people/${bo}/email/start`, { email: "y@example.test" }, annCookie)).json.error, "error.staff_only");
});

test("the members' address comes with the club, for the staff app's links members open", async () => {
  assert.equal(JSON.parse((await get("/club")).text).member_url, "https://kestrel.example");
});

test("the owner and managers see a member's connected assistants, to disconnect one; the desk doesn't", async () => {
  const bo = (await db.selectFrom("person").select("id").where("display_name", "=", "Bo Park").executeTakeFirstOrThrow()).id;
  await db.insertInto("oauth_client").values({ client_id: "kc_bo", kind: "registered", name: "Bo's Claude", redirect_uris: ["http://localhost/cb"], secret_hash: null, metadata: null }).execute();
  const grant = uuidv7();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: bo, client_id: "kc_bo", scopes: ["kumi"], revoked_at: null }).execute();
  const json = async (path: string, cookie: string) => { const r = await get(path, cookie); return { status: r.status, body: JSON.parse(r.text) }; };
  const robin = await signIn("robin@example.test");
  const seen = await json(`/staff/people/${bo}/assistants`, robin);
  assert.deepEqual([seen.status, seen.body.map((a: any) => [a.id, a.name, a.weekly_cap_cents, a.spent_cents])], [200, [[grant, "Bo's Claude", 0, 0]]]);
  assert.equal((await json(`/staff/people/${bo}/assistants`, await signIn("lee@example.test"))).status, 403);
});
