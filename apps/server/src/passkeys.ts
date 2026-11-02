// Passkeys (WebAuthn). Adding one needs a fresh sign-in, is an action in Changes, and emails the
// person. Signing in with one makes a "passkey" session, which the strong-sign-in rule accepts.
import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { t, type Lang } from "@kumi/i18n";
import { hasSecondFactor, run, uuidv7, KumiError, type Actor, type Db } from "@kumi/core";
import { SESSION_DAYS } from "./auth.ts";
import type { Mailer } from "./mailer.ts";

export const FRESH_MINUTES = 15, CHALLENGE_MINUTES = 5;

/** Adding a passkey or an authenticator: right after an emailed or texted code, and, for someone who already has
 *  either, only from a session that used it (a passkey, or the code and then the authenticator). Otherwise whoever
 *  has the mailbox could make a second step of their own. */
export async function mayAddSecondStep(db: Db, me: { id: string; method: string; created_at: Date }, now: Date, what: "step" | "phone" = "step"): Promise<void> {
  const codeOnly = me.method === "email_code" || me.method === "phone_code";
  if (codeOnly && now.getTime() - me.created_at.getTime() > FRESH_MINUTES * 60_000) throw new KumiError(what === "phone" ? "error.recent_sign_in_phone" : "error.recent_sign_in", {}, 403);
  if (codeOnly && await hasSecondFactor(db, me.id)) throw new KumiError(what === "phone" ? "error.second_step_first_phone" : "error.second_step_first", {}, 403);
}
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
type Session = { id: string; display_name: string; locale: string; method: "email_code" | "phone_code" | "passkey" | "two_factor"; created_at: Date } | null;
export interface PasskeyDeps { db: Db; mailer: Mailer; publicUrl: string; secureCookies: boolean; now: () => Date; lang: (c: Context<any>) => Lang; me: (c: Context<any>) => Session }

export function passkeyRoutes(deps: PasskeyDeps) {
  const app = new Hono();
  const { db } = deps;
  const origin = new URL(deps.publicUrl).origin, rpID = new URL(deps.publicUrl).hostname;
  const challenge = async (kind: "passkey_add" | "passkey_sign_in", value: string, personId: string | null) => {
    const id = uuidv7();
    await db.insertInto("auth_challenge").values({ id, kind, person_id: personId, target: kind, code_hash: value, expires_at: new Date(deps.now().getTime() + CHALLENGE_MINUTES * 60_000), consumed_at: null }).execute();
    return id;
  };
  const takeChallenge = async (id: string, kind: "passkey_add" | "passkey_sign_in") => {
    const ch = await db.updateTable("auth_challenge").set({ consumed_at: deps.now() }).where("id", "=", id).where("kind", "=", kind).where("consumed_at", "is", null)
      .where("expires_at", ">", deps.now()).returningAll().executeTakeFirst();
    if (!ch) throw new KumiError("error.passkey_failed", {}, 400);
    return ch;
  };

  app.post("/auth/passkey/add/options", async (c) => {
    const me = deps.me(c);
    if (!me) throw new KumiError("error.signed_out", {}, 401);
    await mayAddSecondStep(db, me, deps.now());
    const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", me.id).executeTakeFirstOrThrow();
    const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
    const existing = await db.selectFrom("passkey").select(["credential_id", "transports"]).where("person_id", "=", me.id).where("revoked_at", "is", null).execute();
    const options = await generateRegistrationOptions({
      rpName: club.name, rpID, userName: person.email ?? person.display_name, userDisplayName: person.display_name,
      userID: Buffer.from(me.id.replace(/-/g, ""), "hex"), attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports ?? undefined })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    return c.json({ challenge_id: await challenge("passkey_add", options.challenge, me.id), options });
  });

  app.post("/auth/passkey/add/verify", async (c) => {
    const me = deps.me(c), lang = deps.lang(c);
    if (!me) throw new KumiError("error.signed_out", {}, 401);
    const b = await c.req.json() as { challenge_id: string; response: RegistrationResponseJSON; name?: string };
    await mayAddSecondStep(db, me, deps.now());
    const ch = await takeChallenge(String(b.challenge_id), "passkey_add");
    if (ch.person_id !== me.id) throw new KumiError("error.passkey_failed", {}, 400);
    const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: ch.code_hash, expectedOrigin: origin, expectedRPID: rpID }).catch(() => null);
    if (!v?.verified) throw new KumiError("error.passkey_failed", {}, 400);
    const cred = v.registrationInfo.credential, name = (b.name ?? "").slice(0, 60) || "Passkey";
    const actor: Actor = { personId: me.id, via: "web", lang, auth: me.method };
    await run(db, "person.passkey_add", { person_id: me.id, credential_id: cred.id, public_key: Buffer.from(cred.publicKey).toString("base64url"), counter: cred.counter, transports: cred.transports, name }, actor, { internal: true, now: deps.now() });
    const person = await db.selectFrom("person").select(["email", "locale"]).where("id", "=", me.id).executeTakeFirstOrThrow();
    const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
    if (person.email) { const l = person.locale as Lang; await deps.mailer.send({ to: person.email, subject: t(l, "mail.passkey_added_subject", { club }), text: t(l, "mail.passkey_added_body", { club, name }) }); }
    return c.json({ added: true, credential_id: cred.id });
  });

  app.post("/auth/passkey/sign-in/options", async (c) => {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    return c.json({ challenge_id: await challenge("passkey_sign_in", options.challenge, null), options });
  });

  app.post("/auth/passkey/sign-in/verify", async (c) => {
    const b = await c.req.json() as { challenge_id: string; response: AuthenticationResponseJSON };
    const ch = await takeChallenge(String(b.challenge_id), "passkey_sign_in");
    const pk = await db.selectFrom("passkey").innerJoin("person", "person.id", "passkey.person_id").selectAll("passkey")
      .where("passkey.credential_id", "=", String(b.response?.id ?? "")).where("passkey.revoked_at", "is", null).where("person.status", "!=", "archived").executeTakeFirst();
    if (!pk) throw new KumiError("error.passkey_failed", {}, 400);
    const v = await verifyAuthenticationResponse({ response: b.response, expectedChallenge: ch.code_hash, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports ?? undefined } }).catch(() => null);
    if (!v?.verified) throw new KumiError("error.passkey_failed", {}, 400);
    const token = randomBytes(32).toString("base64url"), now = deps.now();
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("passkey").set({ counter: String(v.authenticationInfo.newCounter), last_used_at: now }).where("credential_id", "=", pk.credential_id).execute();
      await trx.insertInto("web_session").values({ token_hash: sha(token), person_id: pk.person_id, expires_at: new Date(now.getTime() + SESSION_DAYS * 864e5), last_seen_at: now, user_agent: c.req.header("user-agent") ?? null, revoked_at: null, method: "passkey" }).execute();
    });
    setCookie(c, "kumi_session", token, { httpOnly: true, secure: deps.secureCookies, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.json({ signed_in: true });
  });

  return app;
}
