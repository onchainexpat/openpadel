import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { base32Decode, base32Encode, hotp, matchStep, needsTwoFactor, hasSecondFactor, makeRecoveryCodes, messageHandlers, newSecret, processOutbox, recoveryLeft, run, runAsSystem,
  totp, useAuthenticatorCode, useRecoveryCode, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const NOW = new Date("2026-11-30T16:00:00Z");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en", auth: "two_factor" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
/** What /auth/totp/setup does: a secret waiting for its first code. */
async function waiting(name: string, secret: string) {
  const id = uuidv7();
  await db.insertInto("auth_challenge").values({ id, kind: "totp_setup", person_id: people[name]!, target: "totp_setup", code_hash: secret, expires_at: new Date(NOW.getTime() + 900_000), consumed_at: null }).execute();
  return id;
}

test("authenticator codes match RFC 6238's test vectors (SHA-1, SHA-256 and SHA-512)", () => {
  const seeds = { sha1: "12345678901234567890", sha256: "12345678901234567890123456789012", sha512: "1234567890123456789012345678901234567890123456789012345678901234" } as const;
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"], [1111111109, "07081804", "68084774", "25091201"], [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"], [2000000000, "69279037", "90698825", "38618901"], [20000000000, "65353130", "77737706", "47863826"]];
  for (const [secs, a, b, c] of vectors) {
    const at = new Date(secs * 1000);
    assert.deepEqual([totp(Buffer.from(seeds.sha1), at, 8, "sha1"), totp(Buffer.from(seeds.sha256), at, 8, "sha256"), totp(Buffer.from(seeds.sha512), at, 8, "sha512")], [a, b, c], String(secs));
  }
  // RFC 4226's first HOTP values, and base32 as RFC 4648 has it.
  assert.deepEqual([0, 1, 2].map((c) => hotp(Buffer.from(seeds.sha1), c)), ["755224", "287082", "359152"]);
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(base32Decode("MZXW 6YTB OI").toString(), "foobar");
});

test("a code counts for its 30 seconds and one step either side, and never twice", () => {
  const secret = newSecret(), key = base32Decode(secret);
  const step = matchStep(secret, totp(key, NOW), NOW)!;
  assert.ok(step > 0);
  assert.equal(matchStep(secret, totp(key, new Date(NOW.getTime() - 30_000)), NOW), step - 1);   // a phone a little slow
  assert.equal(matchStep(secret, totp(key, new Date(NOW.getTime() - 90_000)), NOW), null);       // too old
  assert.equal(matchStep(secret, totp(key, NOW), NOW, step), null);                                // already used
  assert.equal(matchStep(secret, "12345", NOW), null);
});

before(async () => {
  ({ db, drop } = await freshDb({ twoFactor: true }));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "two_factor" };
  people.Robin = owner.personId!;
  for (const [name, role] of [["Mia", "manager"], ["Fran", "front_desk"], ["Sam", null]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as any).person_id;
    if (role) await run(db, "role.assign", { person_id: people[name], role }, owner, { now: NOW });
  }
});
after(async () => drop());

test("who signs in with two steps: owners and managers by default, every staff role if the club says, never members", async () => {
  const who = async () => Object.fromEntries(await Promise.all(["Robin", "Mia", "Fran", "Sam"].map(async (n) => [n, await needsTwoFactor(db, people[n]!)])));
  assert.deepEqual(await who(), { Robin: true, Mia: true, Fran: false, Sam: false });
  await run(db, "club.update", { two_factor: "all_staff" }, owner, { now: NOW });
  assert.deepEqual(await who(), { Robin: true, Mia: true, Fran: true, Sam: false });
  await run(db, "club.update", { two_factor: "owner_manager" }, owner, { now: NOW });
  // It can't be switched off by an action.
  await rejects(run(db, "club.update", { two_factor: "off" }, owner, { now: NOW }), "error.invalid_input");
});

test("setting up an authenticator: the first code proves it, and the secret never reaches the change log", async () => {
  const secret = newSecret(), id = await waiting("Mia", secret);
  assert.equal(await hasSecondFactor(db, people.Mia!), false);
  await rejects(run(db, "person.factor_add", { person_id: people.Mia, challenge_id: id, code: "000000" }, as("Mia"), { internal: true, now: NOW }), "error.bad_factor_code");
  const r = await run(db, "person.factor_add", { person_id: people.Mia, challenge_id: id, code: totp(base32Decode(secret), NOW) }, as("Mia"), { internal: true, now: NOW });
  assert.equal(r.plan.summary.en, "Turn on your authenticator app for signing in. You also get ten recovery codes, for when you don't have your phone.");
  assert.equal(await hasSecondFactor(db, people.Mia!), true);
  const logged = await db.selectFrom("entity_change").select(["before", "after"]).where("entity", "=", "staff_factor").execute();
  assert.ok(logged.length && !JSON.stringify(logged).includes(secret), "the secret isn't in the change log");
  const input = await db.selectFrom("action_run").select("input").where("action", "=", "person.factor_add").where("status", "=", "applied").executeTakeFirstOrThrow();
  assert.ok(!JSON.stringify(input.input).includes(secret));
  // The set-up is used up, and the code that proved it was its step: the next sign-in needs a newer code.
  await rejects(run(db, "person.factor_add", { person_id: people.Mia, challenge_id: id, code: totp(base32Decode(secret), NOW) }, as("Mia"), { internal: true, now: NOW }), "error.factor_exists");
  assert.equal(await useAuthenticatorCode(db, people.Mia!, totp(base32Decode(secret), NOW), NOW), false);
  const later = new Date(NOW.getTime() + 30_000);
  assert.equal(await useAuthenticatorCode(db, people.Mia!, totp(base32Decode(secret), later), later), true);
  assert.equal(await useAuthenticatorCode(db, people.Mia!, totp(base32Decode(secret), later), later), false);   // the same code again
});

test("a member who chooses an authenticator signs in with two steps too, and can take it off again", async () => {
  const secret = newSecret();
  await run(db, "person.factor_add", { person_id: people.Sam, challenge_id: await waiting("Sam", secret), code: totp(base32Decode(secret), NOW) }, as("Sam"), { internal: true, now: NOW });
  assert.equal(await needsTwoFactor(db, people.Sam!), true);
  const r = await run(db, "person.factor_remove", { person_id: people.Sam }, as("Sam"), { now: NOW });
  assert.equal(r.plan.summary.en, "Remove your authenticator app and its recovery codes. Signing in won't ask for its code any more.");
  assert.equal(await needsTwoFactor(db, people.Sam!), false);
  // A manager has to use two steps: without a passkey, the authenticator stays.
  await rejects(run(db, "person.factor_remove", { person_id: people.Mia }, as("Mia"), { now: NOW }), "error.factor_needed");
});

test("recovery codes: ten, kept only as slow hashes, each good once", async () => {
  const codes = await makeRecoveryCodes(db, people.Mia!, NOW);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0]!, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  const stored = await db.selectFrom("recovery_code").select("code_hash").where("person_id", "=", people.Mia!).where("used_at", "is", null).execute();
  assert.ok(stored.every((r) => !codes.some((c) => r.code_hash.includes(c.replace("-", "")))));
  assert.equal(await useRecoveryCode(db, people.Mia!, codes[3]!.toUpperCase(), NOW), true);   // case and spacing don't matter
  assert.equal(await useRecoveryCode(db, people.Mia!, codes[3]!, NOW), false);
  assert.equal(await useRecoveryCode(db, people.Mia!, "nope-nope", NOW), false);
  assert.equal(await recoveryLeft(db, people.Mia!), 9);
  // New ones replace the rest.
  const fresh = await makeRecoveryCodes(db, people.Mia!, NOW);
  assert.equal(await useRecoveryCode(db, people.Mia!, codes[0]!, NOW), false);
  assert.equal(await useRecoveryCode(db, people.Mia!, fresh[0]!, NOW), true);
});

test("only the owner starts someone's second step over: it all goes, they're signed out, and they're told", async () => {
  await db.insertInto("web_session").values({ token_hash: "mia-phone", person_id: people.Mia!, expires_at: new Date(NOW.getTime() + 864e5), last_seen_at: NOW, user_agent: null, revoked_at: null }).execute();
  for (const n of ["Mia", "Robin"]) await db.insertInto("passkey").values({ credential_id: `${n}-key`, person_id: people[n]!, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Old phone" }).execute();
  await rejects(run(db, "person.reset_sign_in", { person_id: people.Robin }, as("Mia"), { now: NOW }), "error.forbidden_reason");   // a manager can't
  await rejects(run(db, "person.reset_sign_in", { person_id: people.Robin }, owner, { now: NOW }), "error.reset_own_sign_in");
  const r = await run(db, "person.reset_sign_in", { person_id: people.Mia }, owner, { now: NOW });
  assert.equal(r.plan.summary.en, "Start Mia's second sign-in step over: their authenticator app, 1 passkey and 9 recovery codes stop working, and they're signed out everywhere. They set it up again next time they sign in.");
  assert.equal(await hasSecondFactor(db, people.Mia!), false);
  assert.equal(await recoveryLeft(db, people.Mia!), 0);
  assert.ok((await db.selectFrom("web_session").select("revoked_at").where("token_hash", "=", "mia-phone").executeTakeFirstOrThrow()).revoked_at);
  await processOutbox(db, messageHandlers);
  const msg = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Mia!).where("kind", "=", "sign_in_reset").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(msg.body, "Robin Hale at the club reset the second step of your sign-in. Next time you sign in, you'll set up a passkey or an authenticator app again. If you didn't ask for this, contact the club.");
  await rejects(run(db, "person.reset_sign_in", { person_id: people.Mia }, owner, { now: NOW }), "error.nothing_to_reset");
});

test("Kumi's command line can reset an owner who is locked out", async () => {
  const secret = newSecret();
  await run(db, "person.factor_add", { person_id: people.Robin, challenge_id: await waiting("Robin", secret), code: totp(base32Decode(secret), NOW) }, owner, { internal: true, now: NOW });
  const r = await runAsSystem(db, "person.reset_sign_in", { person_id: people.Robin }, "cli", { now: NOW });
  assert.match(r.plan.summary.en, /^Start Robin Hale's second sign-in step over/);
  assert.equal(await hasSecondFactor(db, people.Robin!), false);
  await processOutbox(db, messageHandlers);
  assert.match((await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Robin!).where("kind", "=", "sign_in_reset").where("channel", "=", "email").executeTakeFirstOrThrow()).body, /^The club reset/);
});
