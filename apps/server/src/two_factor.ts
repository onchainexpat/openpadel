// The second step at sign-in. After the emailed code, someone who must use two steps gives a code from their
// authenticator app (or a recovery code), which marks this session as two-step. Setting an authenticator up
// shows its key as a QR code and as text, and ends with ten recovery codes, shown once.
import { Hono, type Context } from "hono";
import { both, t, type Lang } from "@kumi/i18n";
import { activeFactor, KumiError, makeRecoveryCodes, needsTwoFactor, newSecret, secondStepForChanges, otpauthUri, qrSvg, recoveryLeft, run, sealText, SETUP_MINUTES, useAuthenticatorCode, useRecoveryCode, uuidv7, type Actor, type Db } from "@kumi/core";
import { mayAddSecondStep } from "./passkeys.ts";
import { RateLimiter } from "./limits.ts";
import type { Mailer } from "./mailer.ts";

export type SessionMe = { id: string; display_name: string; locale: string; method: "email_code" | "phone_code" | "passkey" | "two_factor"; created_at: Date; token_hash: string; gate: "setup" | "verify" | null; owed?: boolean } | null;
export interface TwoFactorDeps { db: Db; mailer: Mailer; now: () => Date; lang: (c: Context<any>) => Lang; me: (c: Context<any>) => SessionMe;
  /** Wrong second-step codes per person, shared with the assistant's sign-in page (oauth.ts). */
  tries?: RateLimiter }

/** Five wrong second-step codes in 15 minutes, per person, then a wait (the emailed code came first). */
export const secondStepTries = () => new RateLimiter(5, 15 * 60_000);

/** "JBSW Y3DP EHPK 3PXP ...": the key, for typing into an app by hand. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)!.join(" ");

export function twoFactorRoutes(deps: TwoFactorDeps) {
  const app = new Hono();
  const { db } = deps;
  const tries = deps.tries ?? secondStepTries();
  const signedIn = (c: Context<any>) => { const me = deps.me(c); if (!me) throw new KumiError("error.signed_out", {}, 401); return me; };
  const actor = (c: Context<any>, me: NonNullable<SessionMe>): Actor => ({ personId: me.id, via: "web", lang: deps.lang(c), auth: me.method });
  const markSession = (me: NonNullable<SessionMe>, how: "totp" | "recovery") => db.updateTable("web_session").set({ second_factor: how }).where("token_hash", "=", me.token_hash).execute();
  const notify = async (personId: string, subject: "mail.authenticator_added_subject" | "mail.recovery_used_subject", body: "mail.authenticator_added_body" | "mail.recovery_used_body", params: Record<string, string | number> = {}) => {
    const person = await db.selectFrom("person").select(["email", "locale"]).where("id", "=", personId).executeTakeFirstOrThrow();
    if (!person.email) return;
    const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name, l = person.locale as Lang;
    await deps.mailer.send({ to: person.email, subject: t(l, subject, { club }), text: t(l, body, { club, ...params }) });
  };

  app.post("/auth/totp/setup", async (c) => {
    const me = signedIn(c), now = deps.now();
    if (await activeFactor(db, me.id)) throw new KumiError("error.factor_exists", {}, 409);
    // Like adding a passkey: right after signing in, and with the passkey itself for someone who has one.
    await mayAddSecondStep(db, me, now);
    const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", me.id).executeTakeFirstOrThrow();
    const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
    const secret = newSecret(), id = uuidv7(now.getTime()), uri = otpauthUri(secret, club, person.email ?? person.display_name);
    await db.insertInto("auth_challenge").values({ id, kind: "totp_setup", person_id: me.id, target: "totp_setup", code_hash: sealText(secret), expires_at: new Date(now.getTime() + SETUP_MINUTES * 60_000), consumed_at: null }).execute();
    return c.json({ challenge_id: id, key: grouped(secret), uri, qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(uri)).toString("base64")}` });
  });

  app.post("/auth/totp/confirm", async (c) => {
    const me = signedIn(c), b = await c.req.json().catch(() => ({})) as { challenge_id?: string; code?: string };
    if (!tries.take(me.id, deps.now().getTime())) throw new KumiError("error.too_many_attempts", {}, 429);
    await mayAddSecondStep(db, me, deps.now());
    await run(db, "person.factor_add", { person_id: me.id, challenge_id: String(b.challenge_id ?? ""), code: String(b.code ?? "") }, actor(c, me), { internal: true, now: deps.now() });
    // The emailed code and now the app's: this session has both steps.
    if (me.method === "email_code" || me.method === "phone_code") await markSession(me, "totp");
    const codes = await makeRecoveryCodes(db, me.id, deps.now());
    await notify(me.id, "mail.authenticator_added_subject", "mail.authenticator_added_body");
    return c.json({ added: true, codes });
  });

  app.post("/auth/totp/verify", async (c) => {
    const me = signedIn(c), b = await c.req.json().catch(() => ({})) as { code?: string };
    if (!tries.take(me.id, deps.now().getTime())) throw new KumiError("error.too_many_attempts", {}, 429);
    if (!(await useAuthenticatorCode(db, me.id, String(b.code ?? ""), deps.now()))) throw new KumiError("error.bad_factor_code", {}, 401);
    if (me.method === "email_code" || me.method === "phone_code") await markSession(me, "totp");
    return c.json({ signed_in: true });
  });

  app.post("/auth/recovery", async (c) => {
    const me = signedIn(c), b = await c.req.json().catch(() => ({})) as { code?: string };
    if (!tries.take(me.id, deps.now().getTime())) throw new KumiError("error.too_many_attempts", {}, 429);
    if (!(await useRecoveryCode(db, me.id, String(b.code ?? ""), deps.now()))) throw new KumiError("error.bad_recovery_code", {}, 401);
    if (me.method === "email_code" || me.method === "phone_code") await markSession(me, "recovery");
    const left = await recoveryLeft(db, me.id);
    await notify(me.id, "mail.recovery_used_subject", "mail.recovery_used_body", { left });
    return c.json({ signed_in: true, left });
  });

  app.get("/my/two-factor", async (c) => {
    const me = signedIn(c);
    const passkeys = (await db.selectFrom("passkey").select("credential_id").where("person_id", "=", me.id).where("revoked_at", "is", null).execute()).length;
    // required: at every sign-in; for_changes: for the club's most sensitive changes (actions.ts, requireStrongAuth).
    return c.json({ required: await needsTwoFactor(db, me.id), for_changes: await secondStepForChanges(db, me.id), authenticator: Boolean(await activeFactor(db, me.id)), passkeys,
      recovery_left: await recoveryLeft(db, me.id), two_step_now: me.method !== "email_code" && me.method !== "phone_code",
      // Signed in by a one-time link: the screen says the link was the first step.
      ...(me.owed && me.gate ? { by_link: true } : {}) });
  });

  app.post("/my/two-factor/codes", async (c) => {
    const me = signedIn(c);
    if (!(await activeFactor(db, me.id))) throw new KumiError("error.not_found", { thing: both("thing.authenticator") }, 404);
    await run(db, "person.factor_codes", { person_id: me.id }, actor(c, me), { internal: true, now: deps.now() });
    return c.json({ codes: await makeRecoveryCodes(db, me.id, deps.now()) });
  });

  return app;
}
