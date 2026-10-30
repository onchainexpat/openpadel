// Sign-in by an emailed code, then a session cookie. No passwords anywhere.
// Codes are hashed, live 10 minutes, allow 5 tries, and at most 5 are sent per address an hour.
// A new address gets a code to join instead (unless the club has closed sign-up); after the code, a
// sign-up ticket lets them give their name and their email-consent answer, and then they're in.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { sql } from "kysely";
import { t, type Lang } from "@kumi/i18n";
import { KumiError, runAsSystem, uuidv7, type Db } from "@kumi/core";
import type { Mailer } from "./mailer.ts";

export const CODE_MINUTES = 10, MAX_TRIES = 5, MAX_CODES_PER_HOUR = 5, SESSION_DAYS = 30, SIGN_UP_MINUTES = 30;
/** Join codes to new addresses, club-wide, per hour: anyone can ask for one, so this caps how much mail a stranger can make the club send. */
export const JOIN_CODES_PER_HOUR = 30;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const codeHash = (challengeId: string, code: string) => sha(`${challengeId}:${code}`);

async function personByEmail(db: Db, email: string) {
  return db.selectFrom("person").select(["id", "locale", "display_name", "status"]).where(sql<boolean>`lower(email) = lower(${email})`).where("status", "!=", "archived").executeTakeFirst();
}

/** Always answers the same way whether or not the email has an account, so it can't be probed. */
export async function startEmailSignIn(db: Db, mailer: Mailer, email: string, lang: Lang, now = new Date(), opts: { signUp?: boolean } = {}): Promise<void> {
  const recent = await db.selectFrom("auth_challenge").select((eb) => eb.fn.countAll<string>().as("n"))
    .where(sql<boolean>`lower(target) = lower(${email})`).where("created_at", ">", new Date(now.getTime() - 3600_000)).executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_CODES_PER_HOUR) throw new KumiError("error.too_many_codes", {}, 429);
  const person = await personByEmail(db, email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = uuidv7(now.getTime());
  await db.insertInto("auth_challenge").values({ id, kind: "email_code", target: email, code_hash: codeHash(id, code), expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000), consumed_at: null }).execute();
  const club = await db.selectFrom("club").select(["name", "sign_up_open"]).executeTakeFirstOrThrow();
  if (!person) {
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
  if (ch.expires_at.getTime() < now.getTime()) throw new KumiError("error.code_expired", {}, 401);
  if (ch.attempts >= MAX_TRIES) throw new KumiError("error.too_many_attempts", {}, 429);
  if (ch.code_hash !== codeHash(ch.id, code.trim())) {
    await db.updateTable("auth_challenge").set({ attempts: sql`attempts + 1` }).where("id", "=", ch.id).execute();
    const exhausted = ch.attempts + 1 >= MAX_TRIES;
    throw new KumiError(exhausted ? "error.too_many_attempts" : "error.bad_code", {}, exhausted ? 429 : 401);
  }
  const person = await personByEmail(db, email);
  if (!person) {
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

async function startSession(db: Db, personId: string, userAgent: string | null, now: Date, challengeId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", challengeId).execute();
    await trx.insertInto("web_session").values({ token_hash: sha(token), person_id: personId, expires_at: new Date(now.getTime() + SESSION_DAYS * 864e5), last_seen_at: now, user_agent: userAgent, revoked_at: null }).execute();
    await trx.updateTable("auth_identity").set({ verified_at: now }).where("person_id", "=", personId).where("kind", "=", "email").where("verified_at", "is", null).execute();
  });
  return token;
}

/** The last step of joining: their name, language and club-news answer, with the ticket from the code. */
export async function completeSignUp(db: Db, ticket: string, input: { display_name: string; locale: Lang; club_news: boolean }, userAgent: string | null, now = new Date()): Promise<{ token: string; personId: string }> {
  const ch = await db.selectFrom("auth_challenge").selectAll().where("kind", "=", "sign_up").where("code_hash", "=", sha(ticket)).where("consumed_at", "is", null).executeTakeFirst();
  if (!ch || ch.expires_at.getTime() < now.getTime()) throw new KumiError("error.sign_up_expired", {}, 401);
  const r = await runAsSystem(db, "person.sign_up", { email: ch.target, ...input }, "sign_up", { now });
  const personId = (r.result as { person_id: string }).person_id;
  return { token: await startSession(db, personId, userAgent, now, ch.id), personId };
}

export async function sessionPerson(db: Db, token: string | undefined, now = new Date()) {
  if (!token) return null;
  const s = await db.selectFrom("web_session").innerJoin("person", "person.id", "web_session.person_id")
    .select(["person.id", "person.display_name", "person.locale", "web_session.token_hash", "web_session.method", "web_session.created_at"])
    .where("web_session.token_hash", "=", sha(token)).where("web_session.revoked_at", "is", null).where("web_session.expires_at", ">", now)
    .where("person.status", "!=", "archived").executeTakeFirst();
  if (s) await db.updateTable("web_session").set({ last_seen_at: now }).where("token_hash", "=", s.token_hash).execute();
  return s ?? null;
}

export async function signOut(db: Db, token: string | undefined, now = new Date()) {
  if (token) await db.updateTable("web_session").set({ revoked_at: now }).where("token_hash", "=", sha(token)).execute();
}

