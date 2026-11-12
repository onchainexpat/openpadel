// A second step at sign-in is the club's choice (migration 112), off unless the owner turns it on: staff sign in with
// the emailed code alone, while sensitive changes still ask the roles the club's rule names for one (and offer to set
// it up there), whoever set one up still gives it at sign-in, and an assistant connected without one reaches no more
// than a member's. On, sign-in is as before: those roles give it every time.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { base32Decode, connectionReach, run, runAsSystem, totp, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, clock = new Date();
const mailer = new MemoryMailer(), people: Record<string, string> = {};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const req = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function signIn(email: string) {
  await db.deleteFrom("auth_challenge").where("target", "=", email).execute();
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const setting = async (on: boolean) => { await run(db, "club.update", { second_step_sign_in: on }, owner); };

before(async () => {
  // The club's rule as a real club has it (owners, managers and the club's own roles), the new default: not at sign-in.
  ({ db, drop } = await freshDb({ twoFactor: true, secondStepOff: true }));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  people.Robin = owner.personId!;
  for (const name of ["Mia", "Sam", "Lou", "Kit"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  for (const name of ["Mia", "Lou", "Kit"]) await run(db, "role.assign", { person_id: people[name], role: "manager" }, owner);
  app = makeApp({ db, mailer, secureCookies: false, now: () => clock });
});
after(async () => drop());

test("a new and an existing club start with the second step at sign-in off", async () => {
  assert.equal((await db.selectFrom("club").select("second_step_sign_in").executeTakeFirstOrThrow()).second_step_sign_in, false);
});

test("off: a manager signs in with the emailed code alone and reaches the staff app", async () => {
  const mia = await signIn("mia@example.test");
  const me = await req("/me", mia);
  assert.deepEqual([me.status, me.json.gate, me.json.signed_in_with], [200, null, "email_code"]);
  assert.equal((await req("/staff/people", mia)).status, 200);
  assert.equal((await req("/staff/changes", mia)).status, 200);
  // Optional at sign-in, needed for sensitive changes: what Profile says.
  assert.deepEqual((await req("/my/two-factor", mia)).json, { required: false, for_changes: true, authenticator: false, passkeys: 0, recovery_left: 0, two_step_now: false });
  // A member hears nothing of it.
  assert.deepEqual((await req("/my/two-factor", await signIn("sam@example.test"))).json.for_changes, false);
});

test("off: a sensitive change is refused without a second step, offered to set one up there, and goes on once given", async () => {
  const robin = await signIn("robin@example.test");
  assert.equal((await req("/me", robin)).json.gate, null);
  for (const [action, input] of [["club.update", { name: "Kestrel Padel Club" }], ["role.assign", { person_id: people.Sam, role: "front_desk" }], ["club.export", {}]] as const) {
    const r = await req(`/actions/${action}/plan`, robin, input);
    assert.deepEqual([r.status, r.json.error], [403, "error.second_step_to_change"], action);
  }
  // Ordinary changes need nothing more.
  assert.equal((await req("/actions/person.create/plan", robin, { display_name: "Ana", email: "ana@example.test" })).status, 200);
  // Set up right there (the sign-in is fresh): the session is two-step, and the change goes on.
  const s = await req("/auth/totp/setup", robin, {});
  assert.equal(s.status, 200);
  const secret = s.json.key.replaceAll(" ", "");
  assert.equal((await req("/auth/totp/confirm", robin, { challenge_id: s.json.challenge_id, code: totp(base32Decode(secret), clock) })).status, 200);
  assert.equal((await req("/me", robin)).json.signed_in_with, "two_factor");
  const p = await req("/actions/club.update/plan", robin, { name: "Kestrel Padel Club" });
  assert.equal(p.status, 200);
  assert.equal((await req(`/runs/${p.json.run_id}/apply`, robin, {})).status, 200);
  assert.equal((await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name, "Kestrel Padel Club");
});

test("off: a second step is added only right after a sign-in; a code emailed again makes the session fresh", async () => {
  const lou = await signIn("lou@example.test");
  clock = new Date(clock.getTime() + 20 * 60_000);
  assert.equal((await req("/actions/club.update/plan", lou, { name: "X" })).json.error, "error.second_step_to_change");
  assert.equal((await req("/auth/totp/setup", lou, {})).json.error, "error.recent_sign_in");
  assert.equal((await req("/auth/passkey/add/options", lou, {})).json.error, "error.recent_sign_in");
  clock = new Date();   // sessions start on the database's clock: back to it, as a sign-in now
  const again = await signIn("lou@example.test");
  assert.equal((await req("/auth/totp/setup", again, {})).status, 200);
});

test("off: someone who has set up a second step still gives it at sign-in, and nothing else answers until then", async () => {
  // Robin set up an authenticator above.
  const robin = await signIn("robin@example.test");
  assert.equal((await req("/me", robin)).json.gate, "verify");
  for (const path of ["/staff/people", "/staff/changes", "/my/inbox"]) assert.equal((await req(path, robin)).json.error, "error.two_step_needed", path);
  assert.equal((await req("/actions/club.update/plan", robin, { name: "X" })).json.error, "error.two_step_needed");
  // A passkey counts too: a manager with only a passkey signs in with it (the emailed code alone stops at the gate).
  await db.insertInto("passkey").values({ credential_id: `cred-${uuidv7()}`, person_id: people.Kit!, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Phone", last_used_at: null, revoked_at: null } as any).execute();
  const kit = await signIn("kit@example.test");
  assert.equal((await req("/me", kit)).json.gate, "verify");
  assert.equal((await req("/staff/people", kit)).json.error, "error.two_step_needed");
});

test("the setting is the owner's: a manager can't change it, or ask to", async () => {
  const mia: Actor = { personId: people.Mia!, via: "test", lang: "en", auth: "passkey" };
  await assert.rejects(run(db, "club.update", { second_step_sign_in: true }, mia), (e: any) => e.code === "error.owner_only_setting");
  assert.equal((await db.selectFrom("club").select("second_step_sign_in").executeTakeFirstOrThrow()).second_step_sign_in, false);
  // Other settings a manager still asks the owner for, as before.
  assert.equal((await run(db, "club.update", { about: "Six courts." }, mia)).status, "awaiting_approval");
});

test("off: a code-only session can't move the account's email, open the vault, or undo the owner's setting (from the review)", async () => {
  // Moving the email would let it sign in fresh at an address of its own and set up a second step there.
  const mia = await signIn("mia@example.test");
  assert.equal((await req("/my/email/start", mia, { email: "mia.new@example.test" })).json.error, "error.second_step_to_change");
  // A member still changes theirs with the code alone.
  assert.equal((await req("/my/email/start", await signIn("sam@example.test"), { email: "sam.new@example.test" })).status, 200);
  // The vault's reads ask what its changes ask.
  await run(db, "role.assign", { person_id: people.Mia, role: "owner" }, owner);
  try {
    const owned = await signIn("mia@example.test");
    assert.equal((await req("/staff/vault", owned)).json.error, "error.second_step_to_change");
  } finally { await run(db, "role.remove", { person_id: people.Mia, role: "owner" }, owner); }
  // Undoing the owner's setting is the owner's too: a manager can't even ask.
  const on = await run(db, "club.update", { second_step_sign_in: true }, owner);
  try {
    const kit: Actor = { personId: people.Kit!, via: "test", lang: "en", auth: "passkey" };
    await assert.rejects(run(db, "action.undo", { run_id: on.runId }, kit), (e: any) => e.code === "error.owner_only_setting");
  } finally { await setting(false); }
});

test("on: today's sign-in, the roles named give a second step every time and set one up first", async () => {
  await setting(true);
  try {
    const mia = await signIn("mia@example.test");
    const me = await req("/me", mia);
    assert.deepEqual([me.json.gate, me.json.signed_in_with], ["setup", "email_code"]);
    for (const path of ["/staff/people", "/staff/changes", "/my/inbox"]) assert.equal((await req(path, mia)).json.error, "error.two_step_needed", path);
    assert.equal((await req("/actions/club.update/plan", mia, { name: "X" })).json.error, "error.two_step_needed");
    assert.equal((await req("/my/two-factor", mia)).json.required, true);
    // A member isn't asked.
    assert.equal((await req("/me", await signIn("sam@example.test"))).json.gate, null);
  } finally { await setting(false); }
  // And off again: in at once.
  assert.equal((await req("/me", await signIn("mia@example.test"))).json.gate, null);
});

test("an assistant connected without a second step reaches no more than a member's, setting on or off", async () => {
  await db.insertInto("oauth_client").values({ client_id: "c1", kind: "registered", name: "Claude", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  const grant = async (personId: string, second: boolean) => {
    const id = uuidv7();
    await db.insertInto("oauth_grant").values({ id, person_id: personId, client_id: "c1", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, second_step: second }).execute();
    return id;
  };
  const mia = await grant(people.Mia!, false), miaTwo = await grant(people.Mia!, true), sam = await grant(people.Sam!, false);
  for (const on of [false, true]) {
    await setting(on);
    assert.equal(await connectionReach(db, mia, people.Mia!, clock), "second_step", `on: ${on}`);
    assert.equal(await connectionReach(db, miaTwo, people.Mia!, clock), null);
    assert.equal(await connectionReach(db, sam, people.Sam!, clock), null);
  }
  await setting(false);
});

test("the sign-in page knows whether a code is really emailed", async () => {
  assert.equal((await (await app.request("/club")).json() as any).mail, "sent");
  const logged = makeApp({ db, mailer, secureCookies: false, now: () => clock, mailReach: "log" });
  assert.equal((await (await logged.request("/club")).json() as any).mail, "log");
});

test("a member is as before: no second step to delete their own account, unless they set one up", async () => {
  const sam = await signIn("sam@example.test");
  assert.equal((await req("/actions/privacy.erase/plan", sam, { person_id: people.Sam })).status, 200);
  // With a passkey of their own, deleting the account asks for it, as it always did.
  const token = `pk-sam-${Math.random()}`;
  await db.insertInto("passkey").values({ credential_id: `cred-${uuidv7()}`, person_id: people.Sam!, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Phone", last_used_at: null, revoked_at: null } as any).execute();
  assert.equal((await req("/me", sam)).json.gate, null, "a member's passkey doesn't gate the emailed code");
  assert.equal((await req("/actions/privacy.erase/plan", sam, { person_id: people.Sam })).json.error, "error.need_passkey");
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: people.Sam!, expires_at: new Date(clock.getTime() + 864e5), last_seen_at: clock, user_agent: null, revoked_at: null, method: "passkey" }).execute();
  assert.equal((await req("/actions/privacy.erase/plan", `kumi_session=${token}`, { person_id: people.Sam })).status, 200);
});
