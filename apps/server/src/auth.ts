// Sign-in by an emailed code, or a texted one, then a session cookie. No passwords anywhere.
// Codes are hashed, live 10 minutes, allow 5 tries, and at most 5 are sent per address an hour (3 per number:
// texts.ts's limits, shared with confirming a number on the profile, since each text costs the club).
// A new address or number gets a code to join instead (unless the club has closed sign-up); after the code, a
// sign-up ticket lets them give their name (and, with an email, their club-news answer), and then they're in.
// Every answer is the same whether or not the address or number has an account, so neither can be probed.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { sql } from "kysely";
import { t, type Lang } from "@kumi/i18n";
import { hasSecondFactor, secondStepForChanges, countText, KumiError, markRejoined, runAsSystem, segments, textAllowed, textingOn, textWords, TextError, UNSUBSCRIBED, uuidv7, type Db, type Texter, type Trx } from "@kumi/core";
import type { Mailer } from "./mailer.ts";
import { countCodes, lockCodes, PER_CLUB, PER_NUMBER } from "./texts.ts";

export const CODE_MINUTES = 10, MAX_TRIES = 5, MAX_CODES_PER_HOUR = 5, SESSION_DAYS = 30, SIGN_UP_MINUTES = 30;
/** Join codes to new addresses, club-wide, per hour: anyone can ask for one, so this caps how much mail a stranger can make the club send. */
export const JOIN_CODES_PER_HOUR = 30;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const codeHash = (challengeId: string, code: string) => sha(`${challengeId}:${code}`);

/** One try at a code: counted before it's compared, so tries made at once can't get past MAX_TRIES, and a right
 *  one is used up in the same single step, so of two at once only one gets in. `wrong` is what a wrong one says. */
export async function tryCode(db: Db, ch: { id: string; expires_at: Date }, code: string, now: Date, wrong: "error.bad_code" | "error.bad_text_code"): Promise<void> {
  if (ch.expires_at.getTime() < now.getTime()) throw new KumiError("error.code_expired", {}, 401);
  const taken = await db.updateTable("auth_challenge").set({ attempts: sql`attempts + 1` }).where("id", "=", ch.id).where("attempts", "<", MAX_TRIES)
    .where("consumed_at", "is", null).returning(["attempts", "code_hash"]).executeTakeFirst();
  if (!taken) {
    const now_ = await db.selectFrom("auth_challenge").select(["attempts"]).where("id", "=", ch.id).executeTakeFirst();
    throw (now_?.attempts ?? 0) >= MAX_TRIES ? new KumiError("error.too_many_attempts", {}, 429) : new KumiError(wrong, {}, 401);
  }
  if (taken.code_hash !== codeHash(ch.id, code.trim())) {
    const exhausted = taken.attempts >= MAX_TRIES;
    throw new KumiError(exhausted ? "error.too_many_attempts" : wrong, {}, exhausted ? 429 : 401);
  }
  const used = await db.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", ch.id).where("consumed_at", "is", null).returning("id").executeTakeFirst();
  if (!used) throw new KumiError(wrong, {}, 401);
}

async function personByEmail(db: Db, email: string) {
  return db.selectFrom("person").select(["id", "locale", "display_name", "status"]).where(sql<boolean>`lower(email) = lower(${email})`).where("status", "!=", "archived").executeTakeFirst();
}
/** Who an emailed code signs in: the account whose own sign-in address this is (its auth_identity), not merely whose
 *  email field says it. After a restore the field can hold an address the person had already taken off (an attacker's,
 *  undone), and that must not sign anyone in. A junior only with a login of their own, as by text. */
async function signInByEmail(db: Db, email: string) {
  return db.selectFrom("person").select(["person.id", "person.locale", "person.display_name", "person.status"])
    .where(sql<boolean>`lower(person.email) = lower(${email})`).where("person.status", "!=", "archived")
    .where((eb) => eb.or([eb("person.junior", "=", false), eb("person.own_login", "=", true)]))
    // One of its email sign-in addresses, or, for an account that has none yet (added by the staff, never signed in),
    // its email field.
    .where((eb) => eb.or([eb.exists(eb.selectFrom("auth_identity").select("auth_identity.id").whereRef("auth_identity.person_id", "=", "person.id")
      .where("auth_identity.kind", "=", "email").where(sql<boolean>`lower(auth_identity.value) = lower(${email})`)),
      eb.not(eb.exists(eb.selectFrom("auth_identity").select("auth_identity.id").whereRef("auth_identity.person_id", "=", "person.id").where("auth_identity.kind", "=", "email")))]))
    .executeTakeFirst();
}

/** Always answers the same way whether or not the email has an account, so it can't be probed. */
export async function startEmailSignIn(db: Db, mailer: Mailer, email: string, lang: Lang, now = new Date(), opts: { signUp?: boolean } = {}): Promise<void> {
  const recent = await db.selectFrom("auth_challenge").select((eb) => eb.fn.countAll<string>().as("n"))
    .where(sql<boolean>`lower(target) = lower(${email})`).where("created_at", ">", new Date(now.getTime() - 3600_000)).executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_CODES_PER_HOUR) throw new KumiError("error.too_many_codes", {}, 429);
  const person = await signInByEmail(db, email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = uuidv7(now.getTime());
  await db.insertInto("auth_challenge").values({ id, kind: "email_code", target: email, code_hash: codeHash(id, code), expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000), consumed_at: null }).execute();
  const club = await db.selectFrom("club").select(["name", "sign_up_open"]).executeTakeFirstOrThrow();
  if (!person) {
    // The address is on an account, but isn't that account's way in (taken off since, say): nothing goes, and no new
    // account is offered for it either. The same answer as always.
    if (await personByEmail(db, email)) return;
    if (!club.sign_up_open || opts.signUp === false) return;
    const joins = await db.selectFrom("auth_challenge as a").select((eb) => eb.fn.countAll<string>().as("n")).where("a.kind", "=", "email_code").where("a.created_at", ">", new Date(now.getTime() - 3600_000))
      .where((eb) => eb.not(eb.exists(eb.selectFrom("person").select("person.id").where(sql<boolean>`lower(person.email) = lower(a.target)`)))).executeTakeFirstOrThrow();
    // The same answer either way; the log says why nothing went.
    if (Number(joins.n) > JOIN_CODES_PER_HOUR) { console.warn(`sign-up: over ${JOIN_CODES_PER_HOUR} join codes this hour; not sending more until it calms down`); return; }
    await mailer.send({ to: email, subject: t(lang, "auth.join_subject", { club: club.name, code }), text: t(lang, "auth.join_body", { club: club.name, code }) });
    return;
  }
  const l = (person.locale as Lang) ?? lang;
  await mailer.send({ to: email, subject: t(l, "auth.code_subject", { club: club.name, code }), text: t(l, "auth.code_body", { club: club.name, code }) });
}

export async function verifyEmailCode(db: Db, email: string, code: string, userAgent: string | null, now = new Date(), opts: { signUp?: boolean } = {}): Promise<{ token: string; personId: string } | { signUpTicket: string }> {
  const ch = await db.selectFrom("auth_challenge").selectAll().where(sql<boolean>`lower(target) = lower(${email})`).where("kind", "=", "email_code")
    .where("consumed_at", "is", null).orderBy("created_at", "desc").executeTakeFirst();
  if (!ch) throw new KumiError("error.bad_code", {}, 401);
  await tryCode(db, ch, code, now, "error.bad_code");
  const person = await signInByEmail(db, email);
  if (!person) {
    if (await personByEmail(db, email)) throw new KumiError("error.no_account", {}, 404);
    const club = await db.selectFrom("club").select("sign_up_open").executeTakeFirstOrThrow();
    if (!club.sign_up_open || opts.signUp === false) throw new KumiError("error.no_account", {}, 404);
    // The address is proven; the ticket holds that while they fill in their name.
    const ticket = randomBytes(32).toString("base64url");
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", ch.id).execute();
      await trx.insertInto("auth_challenge").values({ id: uuidv7(now.getTime()), kind: "sign_up", target: email.trim().toLowerCase(), code_hash: sha(ticket), expires_at: new Date(now.getTime() + SIGN_UP_MINUTES * 60_000), consumed_at: null }).execute();
    });
    return { signUpTicket: ticket };
  }
  return { token: await startSession(db, person.id, userAgent, now, ch.id), personId: person.id };
}

async function startSession(db: Db, personId: string, userAgent: string | null, now: Date, challengeId: string, method: "email_code" | "phone_code" = "email_code"): Promise<string> {
  await refuseQueued(db, personId);
  const token = randomBytes(32).toString("base64url");
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", challengeId).execute();
    await trx.insertInto("web_session").values({ token_hash: sha(token), person_id: personId, expires_at: new Date(now.getTime() + SESSION_DAYS * 864e5), last_seen_at: now, user_agent: userAgent, revoked_at: null, method }).execute();
    if (method === "email_code") {
      const proven = await trx.updateTable("auth_identity").set({ verified_at: now }).where("person_id", "=", personId).where("kind", "=", "email").where("verified_at", "is", null).returning("id").execute();
      // The first sign-in that proves an address someone else entered for them (the desk, a parent giving a kid their own
      // login, a junior made an adult, the owner's address at setup): only whoever reads that mailbox can, so it's their
      // own act, and an account deleted here at this address comes back from now (playtomic_erased.ts). Entering the
      // address lifts nothing; an import leaves a deleted member's address out altogether; support logins never lift.
      if (proven.length) await markRejoined(trx, personId, now);
    }
  });
  return token;
}

// ---- By a texted code ----
/** Who a number signs in: the account whose confirmed number it is, if that account may sign in at all (a
 *  junior only with a login of their own, which their parents gave). */
async function personByPhone(db: Db | Trx, phone: string) {
  return db.selectFrom("auth_identity").innerJoin("person", "person.id", "auth_identity.person_id").select(["person.id", "person.locale"])
    .where("auth_identity.kind", "=", "phone").where("auth_identity.value", "=", phone).where("auth_identity.verified_at", "is not", null)
    .where("person.status", "!=", "archived").where("person.redacted_at", "is", null).where("person.phone", "=", phone)
    .where((eb) => eb.or([eb("person.junior", "=", false), eb("person.own_login", "=", true)])).executeTakeFirst();
}
/** Whether this server can text sign-in codes: the club's Twilio account is set up. */
export const phoneSignInOn = (texter: Texter | null) => Boolean(texter) && textingOn();

/** A code by text to a US or Canadian number (already checked by usPhone). The same answer whether or not the
 *  number has an account; a number that can't take texts, or replied STOP, is told so, since that's about the
 *  number, not about an account. A sign-in code is an account text they asked for: it needs no yes to texts. */
export async function startPhoneSignIn(db: Db, texter: Texter, phone: string, lang: Lang, now = new Date(), opts: { signUp?: boolean; memberUrl?: string } = {}): Promise<void> {
  const club = await db.selectFrom("club").select(["name", "sign_up_open"]).executeTakeFirstOrThrow();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = uuidv7(now.getTime());
  // The club's texts paused past the monthly meter's ceiling (usage.ts): the same answer for every number.
  if (!(await textAllowed(db, "code", segments(textWords(club.name, t(lang, "sms.code", { code: "000000" }), lang, null, opts.memberUrl ?? "")), now)).ok) throw new KumiError("error.texts_paused", {}, 429);
  // Counted and written under one lock (shared with the profile's confirm-number codes), so codes asked for at
  // the same moment can't all slip under the hourly limits. Only the transaction's own connection is used inside.
  const person = await db.transaction().execute(async (trx) => {
    await lockCodes(trx);
    if (await countCodes(trx, now, { target: phone }) >= PER_NUMBER) throw new KumiError("error.too_many_codes", {}, 429);
    if (await countCodes(trx, now) >= PER_CLUB) { console.warn(`sign-in by text: ${PER_CLUB} codes this hour already; not sending more until it calms down`); throw new KumiError("error.too_many_codes", {}, 429); }
    const p = await personByPhone(trx, phone);
    // A number with no account, at a club that isn't taking sign-ups: nothing is sent, and the answer is the same.
    if (!p && (!club.sign_up_open || opts.signUp === false)) return false;
    // Taken by someone the number can't sign in (a junior whose parents haven't given them a login): the same.
    if (!p && await trx.selectFrom("auth_identity").select("id").where("kind", "=", "phone").where("value", "=", phone).executeTakeFirst()) return false;
    await trx.insertInto("auth_challenge").values({ id, kind: "phone_sign_in", person_id: p?.id ?? null, target: phone, code_hash: codeHash(id, code), expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000), consumed_at: null }).execute();
    return p ?? null;
  });
  if (person === false) return;
  const l = (person?.locale as Lang | undefined) ?? lang;
  const body = textWords(club.name, t(l, "sms.code", { code }), l, null, opts.memberUrl ?? "");
  try { if ((await texter.send({ to: phone, body })).ref) await countText(db, "code", segments(body), now); }
  catch (e) {
    await db.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", id).execute();
    if (e instanceof TextError && e.code === UNSUBSCRIBED) throw new KumiError("error.phone_stopped", {}, 409);
    if (e instanceof TextError && e.permanent) throw new KumiError("error.phone_cant_text", {}, 400);
    throw e;
  }
}

/** The texted code back: signed in, or (a number new here) a ticket to finish joining. */
export async function verifyPhoneCode(db: Db, phone: string, code: string, userAgent: string | null, now = new Date(), opts: { signUp?: boolean } = {}): Promise<{ token: string; personId: string } | { signUpTicket: string }> {
  const ch = await db.selectFrom("auth_challenge").selectAll().where("target", "=", phone).where("kind", "=", "phone_sign_in")
    .where("consumed_at", "is", null).orderBy("created_at", "desc").executeTakeFirst();
  if (!ch) throw new KumiError("error.bad_text_code", {}, 401);
  await tryCode(db, ch, code, now, "error.bad_text_code");
  const person = await personByPhone(db, phone);
  if (!person) {
    const club = await db.selectFrom("club").select("sign_up_open").executeTakeFirstOrThrow();
    if (!club.sign_up_open || opts.signUp === false) throw new KumiError("error.no_account", {}, 404);
    const ticket = randomBytes(32).toString("base64url");
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", ch.id).execute();
      await trx.insertInto("auth_challenge").values({ id: uuidv7(now.getTime()), kind: "sign_up", target: phone, code_hash: sha(ticket), expires_at: new Date(now.getTime() + SIGN_UP_MINUTES * 60_000), consumed_at: null }).execute();
    });
    return { signUpTicket: ticket };
  }
  return { token: await startSession(db, person.id, userAgent, now, ch.id, "phone_code"), personId: person.id };
}

// ---- Their email: added (an account that joined by phone) or changed ----
export const UNDO_DAYS = 14;
/** A code to the address they typed. With an address already on the account it's a change: whoever a sensitive change
 *  asks a second step of (someone with a passkey or an authenticator, and the roles the club's rule names: second_step.ts)
 *  makes it signed in with it, like other sensitive changes. Otherwise an old, code-only session could move the account
 *  to an address of its own, sign in fresh there and set up a second step of its own. An address another
 *  account uses gets the same answer as a free one (so addresses can't be probed); that address hears someone
 *  tried, and no code that could work is made. */
export async function startEmailAdd(db: Db, mailer: Mailer, personId: string, email: string, lang: Lang, now = new Date(), auth?: string): Promise<void> {
  const target = email.trim().toLowerCase();
  const p = await db.selectFrom("person").select(["email"]).where("id", "=", personId).executeTakeFirstOrThrow();
  if (p.email?.toLowerCase() === target) throw new KumiError("error.email_same", {}, 409);
  if (p.email && auth !== "passkey" && auth !== "two_factor" && await secondStepForChanges(db, personId))
    throw new KumiError((await hasSecondFactor(db, personId)) ? "error.need_passkey" : "error.second_step_to_change", {}, 403);
  const recent = await db.selectFrom("auth_challenge").select((eb) => eb.fn.countAll<string>().as("n")).where("kind", "=", "email_add")
    .where((eb) => eb.or([eb(sql`lower(target)`, "=", target), eb("person_id", "=", personId)])).where("created_at", ">", new Date(now.getTime() - 3600_000)).executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_CODES_PER_HOUR) throw new KumiError("error.too_many_codes", {}, 429);
  const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
  const taken = await personByEmail(db, target)
    ?? await db.selectFrom("auth_identity").innerJoin("person", "person.id", "auth_identity.person_id").select(["person.id", "person.locale"])
      .where("auth_identity.kind", "=", "email").where(sql<boolean>`lower(auth_identity.value) = ${target}`).executeTakeFirst();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0"), id = uuidv7(now.getTime());
  // Taken: a challenge still counts toward the limits, with a code nobody was sent.
  await db.insertInto("auth_challenge").values({ id, kind: "email_add", person_id: personId, target, code_hash: codeHash(id, taken ? randomBytes(16).toString("hex") : code),
    expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000), consumed_at: null }).execute();
  if (taken) {
    const l = (taken.locale as Lang) ?? lang;
    await mailer.send({ to: target, subject: t(l, "auth.email_taken_subject", { club: club.name }), text: t(l, "auth.email_taken_body", { club: club.name }) });
    return;
  }
  await mailer.send({ to: target, subject: t(lang, "auth.email_add_subject", { club: club.name, code }), text: t(lang, "auth.email_add_body", { club: club.name, code }) });
}
/** The code back: the address is theirs. A change tells the old address, with a link to put it back. */
export async function verifyEmailAdd(db: Db, personId: string, code: string, now = new Date(), o?: { mailer: Mailer; undoUrl: (token: string) => string; by?: string }): Promise<string> {
  const ch = await db.selectFrom("auth_challenge").selectAll().where("kind", "=", "email_add").where("person_id", "=", personId).where("consumed_at", "is", null).orderBy("created_at", "desc").executeTakeFirst();
  if (!ch) throw new KumiError("error.bad_code", {}, 401);
  await tryCode(db, ch, code, now, "error.bad_code");
  const p = await db.selectFrom("person").select(["email", "display_name", "locale"]).where("id", "=", personId).executeTakeFirstOrThrow();
  // Done by staff at the desk: who, kept with the change.
  const by = o?.by ? { by: o.by } : {}, via = o?.by ? "staff" : "web";
  if (!p.email) { await runAsSystem(db, "email.add", { person_id: personId, email: ch.target, ...by }, via, { now }); return ch.target; }
  await runAsSystem(db, "email.change", { person_id: personId, email: ch.target, ...by }, via, { now });
  if (o) await sendUndoLink(db, o.mailer, personId, p.email, "auth.email_changed_subject", "auth.email_changed_body", { email: ch.target }, o.undoUrl, now);
  return ch.target;
}

/** A change to how someone signs in, told to `to` (their email) with a link that takes it back for UNDO_DAYS:
 *  the address goes back to `to` if it was changed, and every way in made lately is taken off (undoEmailChange). */
export async function sendUndoLink(db: Db, mailer: Mailer, personId: string, to: string, subject: "auth.email_changed_subject" | "auth.phone_changed_subject",
  body: "auth.email_changed_body" | "auth.phone_changed_body", params: Record<string, string>, undoUrl: (token: string) => string, now: Date): Promise<void> {
  const p = await db.selectFrom("person").select(["display_name", "locale"]).where("id", "=", personId).executeTakeFirstOrThrow();
  const token = randomBytes(32).toString("base64url"), l = (p.locale as Lang) ?? "en";
  await db.insertInto("auth_challenge").values({ id: uuidv7(now.getTime()), kind: "email_undo", person_id: personId, target: to, code_hash: sha(token), expires_at: new Date(now.getTime() + UNDO_DAYS * 864e5), consumed_at: null }).execute();
  const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
  await mailer.send({ to, subject: t(l, subject, { club: club.name }), text: t(l, body, { name: p.display_name, club: club.name, link: undoUrl(token), days: UNDO_DAYS, ...params }) });
}

/** The old address's link, for a change its owner didn't make: who it's for, if it still works. */
export async function emailUndoTarget(db: Db, token: string, now = new Date()) {
  const ch = await db.selectFrom("auth_challenge").innerJoin("person", "person.id", "auth_challenge.person_id").select(["auth_challenge.id", "auth_challenge.target", "auth_challenge.consumed_at",
    "auth_challenge.expires_at", "auth_challenge.created_at", "person.id as person_id", "person.locale", "person.email"]).where("auth_challenge.kind", "=", "email_undo").where("auth_challenge.code_hash", "=", sha(token)).executeTakeFirst();
  if (!ch || ch.expires_at.getTime() < now.getTime()) return null;
  return { ...ch, lang: ((ch.locale as Lang) ?? "en") as Lang, club: (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name };
}
/** "This wasn't me": the old address back, every session and connected assistant signed out, any other
 *  address change waiting for its code called off, and every way back in the changer could have made: the
 *  passkeys, the authenticator and its recovery codes, and a sign-in number confirmed in the days before the
 *  change or since. The old address is told it's done. */
export async function undoEmailChange(db: Db, mailer: Mailer, token: string, now = new Date()): Promise<boolean> {
  const u = await emailUndoTarget(db, token, now);
  if (!u || u.consumed_at) return false;
  if (u.email?.toLowerCase() !== u.target.toLowerCase()) await runAsSystem(db, "email.change", { person_id: u.person_id, email: u.target }, "email_undo", { now });
  await runAsSystem(db, "person.sign_in_undo", { person_id: u.person_id, since: new Date(u.created_at.getTime() - UNDO_DAYS * 864e5).toISOString() }, "email_undo", { now });
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("auth_challenge").set({ consumed_at: now }).where("person_id", "=", u.person_id).where("kind", "in", ["email_add", "email_undo"]).where("consumed_at", "is", null).execute();
    await trx.updateTable("web_session").set({ revoked_at: now }).where("person_id", "=", u.person_id).where("revoked_at", "is", null).execute();
    const grants = trx.selectFrom("oauth_grant").select("id").where("person_id", "=", u.person_id);
    await trx.updateTable("oauth_token").set({ revoked_at: now }).where("grant_id", "in", grants).where("revoked_at", "is", null).execute();
    await trx.updateTable("oauth_grant").set({ revoked_at: now }).where("person_id", "=", u.person_id).where("revoked_at", "is", null).execute();
  });
  const same = u.email?.toLowerCase() === u.target.toLowerCase();   // a sign-in number's change: the address never moved
  await mailer.send({ to: u.target, subject: t(u.lang, same ? "auth.sign_in_taken_back_subject" : "auth.email_restored_subject", { club: u.club }),
    text: t(u.lang, same ? "auth.sign_in_taken_back_body" : "auth.email_restored_body", { club: u.club, email: u.target }) });
  return true;
}

/** The last step of joining: their name, language and (with an email) club-news answer, with the ticket from the code,
 *  and the club's terms and privacy links the page showed them (person.sign_up keeps them). */
export async function completeSignUp(db: Db, ticket: string, input: { display_name: string; locale: Lang; club_news: boolean; policies?: { terms_url: string | null; privacy_policy_url: string | null } }, userAgent: string | null, now = new Date()): Promise<{ token: string; personId: string }> {
  const ch = await db.selectFrom("auth_challenge").selectAll().where("kind", "=", "sign_up").where("code_hash", "=", sha(ticket)).where("consumed_at", "is", null).executeTakeFirst();
  if (!ch || ch.expires_at.getTime() < now.getTime()) throw new KumiError("error.sign_up_expired", {}, 401);
  const byPhone = /^\+1\d{10}$/.test(ch.target);
  const r = await runAsSystem(db, "person.sign_up", { ...(byPhone ? { phone: ch.target, club_news: false } : { email: ch.target, club_news: input.club_news }), display_name: input.display_name, locale: input.locale, ...(input.policies ? { policies: input.policies } : {}) }, "sign_up", { now });
  const personId = (r.result as { person_id: string }).person_id;
  return { token: await startSession(db, personId, userAgent, now, ch.id, byPhone ? "phone_code" : "email_code"), personId };
}

/** An account a restore brought back that is waiting to be deleted again (erase_after_restore): nobody signs in as it. */
export async function refuseQueued(db: Db, personId: string) {
  if (await db.selectFrom("erase_after_restore").select("person_id").where("person_id", "=", personId).executeTakeFirst().catch(() => undefined))
    throw new KumiError("error.privacy_already", {}, 403);
}

export async function sessionPerson(db: Db, token: string | undefined, now = new Date()) {
  if (!token) return null;
  const s = await db.selectFrom("web_session").innerJoin("person", "person.id", "web_session.person_id")
    .select(["person.id", "person.display_name", "person.locale", "web_session.token_hash", "web_session.method", "web_session.second_factor", "web_session.created_at"])
    .where("web_session.token_hash", "=", sha(token)).where("web_session.revoked_at", "is", null).where("web_session.expires_at", ">", now)
    .where("person.status", "!=", "archived")
    // Deleted on the database a restore replaced, and not deleted again here yet (after_restore.ts): signed out.
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM erase_after_restore q WHERE q.person_id = person.id)`).executeTakeFirst();
  if (s) await db.updateTable("web_session").set({ last_seen_at: now }).where("token_hash", "=", s.token_hash).execute();
  return s ?? null;
}

export async function signOut(db: Db, token: string | undefined, now = new Date()) {
  if (token) await db.updateTable("web_session").set({ revoked_at: now }).where("token_hash", "=", sha(token)).execute();
}

