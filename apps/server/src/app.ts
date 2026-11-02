// The HTTP API. Every write goes through the action registry; reads answer in the person's
// language (their profile, or Accept-Language before they sign in).
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { clientIp, RateLimiter } from "./limits.ts";
import { REVISION, VERSION } from "./version.ts";
import { deepHealth, mayReadDeepHealth } from "./health.ts";
import { vaultRoutes } from "./vault.ts";
import { manifestRoutes } from "./manifest.ts";
import * as z from "zod/mini";
import { sql } from "kysely";
import { toJSONSchema } from "zod/v4/core";
import { pickLang, isLang, formerMember, t, FORMER_MEMBER, type Lang } from "@kumi/i18n";
import { actions, apply, approve, plan, decide, kidOf, KumiError, payKidRun, needsTwoFactor, hasSecondFactor, customAreas, customCan, usPhone, type Actor, type Db, type Texter } from "@kumi/core";
import { BotCheck } from "./bot.ts";
import { twoFactorRoutes } from "./two_factor.ts";
import { completeSignUp, emailUndoTarget, phoneSignInOn, sessionPerson, signOut, startEmailAdd, startEmailSignIn, startPhoneSignIn, undoEmailChange, verifyEmailAdd, verifyEmailCode, verifyPhoneCode, SESSION_DAYS } from "./auth.ts";
import { bearerPerson, defaultFetchMetadata, oauthRoutes, type FetchMetadata } from "./oauth.ts";
import { handleMcp, mcpServerFor } from "./mcp.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { readRoutes } from "./reads.ts";
import { calendarRoutes } from "./calendar.ts";
import { broadcastRoutes } from "./broadcasts.ts";
import { publicRoutes } from "./public.ts";
import { memberUrl } from "./addresses.ts";
import { memberRoutes } from "./member.ts";
import { paymentRoutes, type StripeConfig } from "./payments.ts";
import { textRoutes } from "./texts.ts";
import { receiptRoutes } from "./receipts.ts";
import type { Mailer } from "./mailer.ts";

/** The changes a staff screen offers a button for, which /me reports for people with only the club's own roles. */
const CLIENT_ACTIONS = ["person.create", "person.import", "booking.create", "booking.move", "booking.extend", "booking.record_payment", "booking.cancel", "court.block", "court.unblock", "court.block_repeat", "court.block_repeat_end", "court.block_repeat_edit", "booking.add_player", "booking.remove_player", "alert.handle", "series.edit"];

export interface AppDeps { clientIp?: (c: Context<any>) => string | null; db: Db; mailer: Mailer; publicUrl?: string;
  /** The members' app's address (addresses.ts), for the public page's own links; from publicUrl when not given. */
  memberUrl?: string; secureCookies?: boolean; now?: () => Date; fetchMetadata?: FetchMetadata; production?: boolean; stripe?: StripeConfig
  /** Bot protection on sign-up, sign-in codes and checkout. On in production, always; tests and practice can leave it off. */
  botCheck?: boolean
  /** Texts, when the club's Twilio account is set up (twilio.ts): what sends them, and the token Twilio signs its posts with. */
  texts?: { texter: Texter; authToken: string | null } }
/** gate: this session still owes its second step ("verify"), or there's none set up yet ("setup"). */
type Me = { id: string; display_name: string; locale: string; method: "email_code" | "phone_code" | "passkey" | "two_factor"; created_at: Date; token_hash: string; gate: "setup" | "verify" | null } | null;
type Env = { Variables: { me: Me; lang: Lang } };
const COOKIE = "kumi_session";
const EmailStart = z.object({ email: z.email() });
const EmailVerify = z.object({ email: z.email(), code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const PhoneStart = z.object({ phone: z.string().check(z.maxLength(40)) });
const PhoneVerify = z.object({ phone: z.string().check(z.maxLength(40)), code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const CodeOnly = z.object({ code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const SignUp = z.object({ ticket: z.string().check(z.minLength(20)), display_name: z.string().check(z.minLength(1), z.maxLength(80)), locale: z.enum(["en", "es"]), club_news: z.boolean() });


const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export function makeApp(deps: AppDeps) {
  const { db, mailer } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono<Env>();

  // Security headers on everything the API answers. The only HTML it serves is the agent sign-in and
  // consent pages, with their own inline styles and no scripts. The apps' headers are set by Caddy.
  app.use("*", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], imgSrc: ["'self'", "data:"], frameAncestors: ["'none'"], baseUri: ["'none'"] } }));
  app.use("*", bodyLimit({ maxSize: 3 * 1024 * 1024, onError: () => { throw new KumiError("error.too_big", {}, 413); } }));
  // A change must come from the club's own pages: refuse what the browser marks as from another site,
  // and form-style posts (which another site could make) except on the agent sign-in pages, which are
  // forms. Stripe's webhook and the agent endpoint use signatures and tokens, not the session cookie, and
  // so does a club news email's unsubscribe link (its key does that one thing; mail apps post to it), and
  // the link that puts back an email someone else changed.
  app.use("*", async (c, next) => {
    const path = c.req.path, m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !path.startsWith("/webhooks/") && !path.startsWith("/mcp") && !path.startsWith("/unsubscribe/") && !path.startsWith("/auth/email-undo/")) {
      const site = c.req.header("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") throw new KumiError("error.cross_site", {}, 403);
      const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(type) && !path.startsWith("/oauth/")) throw new KumiError("error.json_only", {}, 415);
    }
    await next();
  });
  // How often one address can try to sign in, join or guess a code.
  const ipOf = deps.clientIp ?? clientIp;
  const limits = new Map<string, RateLimiter>([
    ["/auth/email/start", new RateLimiter(10, 15 * 60_000)], ["/oauth/sign-in", new RateLimiter(10, 15 * 60_000)],
    ["/auth/email/verify", new RateLimiter(20, 15 * 60_000)], ["/auth/sign-up", new RateLimiter(10, 60 * 60_000)],
    ["/auth/phone/start", new RateLimiter(10, 15 * 60_000)], ["/auth/phone/verify", new RateLimiter(20, 15 * 60_000)],
    ["/my/email/start", new RateLimiter(10, 60 * 60_000)], ["/my/email/verify", new RateLimiter(20, 15 * 60_000)],
    ["/auth/passkey/sign-in/verify", new RateLimiter(30, 15 * 60_000)], ["/my/phone/start", new RateLimiter(10, 60 * 60_000)], ["/my/phone/verify", new RateLimiter(20, 15 * 60_000)],
    ["/auth/totp/verify", new RateLimiter(20, 15 * 60_000)], ["/auth/recovery", new RateLimiter(20, 15 * 60_000)], ["/oauth/two-step", new RateLimiter(10, 15 * 60_000)],
  ]);
  app.use("*", async (c, next) => {
    const l = c.req.method === "POST" ? limits.get(c.req.path) : undefined, ip = l ? ipOf(c) : null;
    if (l && ip && !l.take(ip)) throw new KumiError("error.too_many_requests", {}, 429);
    await next();
  });

  app.use("*", async (c, next) => {
    const s = await sessionPerson(db, getCookie(c, COOKIE), now());
    let me: Me = null;
    if (s) {
      // A passkey is both steps; an emailed or texted code then an authenticator or recovery code is too.
      const method = s.method === "passkey" ? "passkey" : s.second_factor ? "two_factor" : s.method === "phone_code" ? "phone_code" : "email_code";
      let gate: "setup" | "verify" | null = null;
      if ((method === "email_code" || method === "phone_code") && await needsTwoFactor(db, s.id)) gate = (await hasSecondFactor(db, s.id)) ? "verify" : "setup";
      me = { id: s.id, display_name: s.display_name, locale: s.locale, method, created_at: s.created_at, token_hash: s.token_hash, gate };
    }
    c.set("me", me);
    c.set("lang", me && isLang(me.locale) ? me.locale : pickLang(c.req.header("accept-language")));
    await next();
  });
  // Someone who must sign in with two steps and hasn't given the second yet can only finish signing in (or
  // set the second step up): nothing else answers, so no staff page or action works on half a sign-in.
  app.use("*", async (c, next) => {
    const me = c.get("me"), path = c.req.path;
    if (me?.gate && !(path === "/me" || path === "/club" || path === "/health" || path.startsWith("/auth/") || path.startsWith("/manifest/")
      || path === "/my/two-factor" || (path.startsWith("/oauth/") && path !== "/oauth/decide"))) throw new KumiError("error.two_step_needed", {}, 403);
    await next();
  });

  // A deleted account's stored name is one string; a Spanish reader gets the Spanish one, wherever it shows.
  app.use("*", async (c, next) => {
    await next();
    const l = c.get("lang");
    if (l === "en" || !(c.res.headers.get("content-type") ?? "").startsWith("application/json")) return;
    const text = await c.res.clone().text();
    if (!text.includes(FORMER_MEMBER)) return;
    const headers = new Headers(c.res.headers), status = c.res.status;
    headers.delete("content-length");
    c.res = undefined as any;   // so the new answer doesn't take the old one's headers back
    c.res = new Response(text.replaceAll(FORMER_MEMBER, formerMember[l]), { status, headers });
  });

  app.onError((e, c) => {
    if (e instanceof KumiError) return c.json({ error: e.code, message: e.text[c.get("lang") ?? "en"] }, e.status as 400);
    console.error(e);
    return c.json({ error: "internal", message: "Something went wrong." }, 500);
  });

  // Bot protection: a challenge to solve before sign-up, sign-in codes and checkout (bot.ts).
  if (deps.production && deps.botCheck === false) throw new Error("bot protection can't be switched off in production");
  const bot = (deps.botCheck ?? deps.production ?? false) ? new BotCheck(() => now().getTime()) : null;
  /** "ok", or "honeypot" (a script filled in the hidden field: answer as if all went well). Anything else is refused. */
  const botGuard = async (c: Context<Env>): Promise<"ok" | "honeypot"> => {
    if (!bot) return "ok";
    const raw = await c.req.json().catch(() => ({})) as { pow?: { challenge?: unknown; counter?: unknown }; website?: unknown };
    const v = bot.check(ipOf(c), raw.pow, raw.website);
    if (v === "ok" || v === "honeypot") return v;
    throw new KumiError("error.bot_check", {}, 400);
  };
  app.get("/auth/challenge", (c) => c.json(bot ? bot.issue(ipOf(c)) : { challenge: null, bits: 0 }));

  const actor = (c: Context<Env>): Actor => {
    const me = c.get("me");
    if (!me) throw new KumiError("error.signed_out", {}, 401);
    return { personId: me.id, via: "web", lang: c.get("lang"), auth: me.method };
  };
  const body = async <S extends z.ZodMiniObject>(c: Context<Env>, schema: S): Promise<z.infer<S>> => {
    const parsed = z.safeParse(schema, await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new KumiError("error.invalid_input", { details: z.prettifyError(parsed.error) }, 400);
    return parsed.data;
  };

  app.get("/health", (c) => c.json({ ok: true, version: VERSION, revision: REVISION }));
  // The fuller picture (backups, outbox, disk): from the server itself, or for an owner or manager (health.ts).
  app.get("/health/deep", async (c) => {
    await mayReadDeepHealth(db, c, c.get("me")?.id ?? null);
    const h = await deepHealth(db, { now: now() });
    return c.json(h, h.ok ? 200 : 503);
  });
  app.route("/", manifestRoutes(db));
  // What the sign-in page needs before anyone signs in: the club's name, colour and languages.
  app.get("/club", async (c) => {
    const club = await db.selectFrom("club").select(["name", "brand_colour", "languages", "default_language", "court_bookings", "public_page"]).executeTakeFirst();
    // Not set up yet (kumi setup apply): nothing to show, which isn't the server failing.
    if (!club) throw new KumiError("error.club_not_set_up", {}, 404);
    // Whether there's a membership to join in the app.
    const plan = await db.selectFrom("membership_plan").select("id").where("active", "=", true).where("join_in_app", "=", true).executeTakeFirst();
    // Whether any coach takes lessons in the app.
    const coach = await db.selectFrom("coach").select("person_id").where("active", "=", true).where("lessons", "=", true).where(sql<boolean>`rates <> '{}'::jsonb`).executeTakeFirst();
    // Whether the sign-in page offers a texted code: only when the club's texting account is set up.
    // The members' address, for the staff app's links members open (the public page, a booking's players link).
    return c.json({ ...club, memberships: Boolean(plan), lessons: Boolean(coach), phone_sign_in: phoneSignInOn(deps.texts?.texter ?? null),
      member_url: deps.memberUrl ?? memberUrl(publicUrl, {}) });
  });

  // ---- The MCP door: OAuth, then tools generated from the registry ----
  const publicUrl = (deps.publicUrl ?? "http://127.0.0.1:8790").replace(/\/$/, "");
  app.route("/", oauthRoutes({ db, mailer, publicUrl, secureCookies: deps.secureCookies ?? true, fetchMetadata: deps.fetchMetadata ?? defaultFetchMetadata, now, lang: (c) => c.get("lang"), me: (c) => c.get("me"),
    texter: deps.texts?.texter ?? null, memberUrl: deps.memberUrl ?? memberUrl(publicUrl, {}) }));
  app.route("/", passkeyRoutes({ db, mailer, publicUrl, secureCookies: deps.secureCookies ?? true, now, lang: (c) => c.get("lang"), me: (c) => c.get("me") }));
  app.route("/", twoFactorRoutes({ db, mailer, now, lang: (c) => c.get("lang"), me: (c) => c.get("me") }));
  app.route("/", readRoutes(db, (c) => c.get("me"), (c) => c.get("lang")));
  app.route("/", vaultRoutes(db, (c) => c.get("me"), now));
  app.route("/", calendarRoutes(db, (c) => c.get("me")));
  app.route("/", broadcastRoutes(db, (c) => c.get("me"), (c) => c.get("lang")));
  app.route("/", publicRoutes(db, (c) => c.get("lang"), deps.memberUrl ?? memberUrl(publicUrl, {})));
  app.route("/", memberRoutes(db, (c) => c.get("me"), (c) => c.get("lang"), { production: deps.production ?? false, now }));
  app.route("/", receiptRoutes(db, (c) => c.get("me"), (c) => c.get("lang")));
  // Checkout asks for the challenge too, except from staff (who are already signed in, at the desk).
  const checkoutGuard = async (c: Context<Env>) => {
    const me = c.get("me");
    if (!bot || !me) return;
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", me.id).where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
    if (!staff && (await botGuard(c)) !== "ok") throw new KumiError("error.bot_check", {}, 400);
  };
  app.route("/", paymentRoutes(db, (c) => c.get("me"), actor, publicUrl, deps.stripe, checkoutGuard));
  // Texts: a member's number and their yes, and what Twilio posts back (texts.ts).
  app.route("/", textRoutes({ db, texter: deps.texts?.texter ?? null, authToken: deps.texts?.authToken ?? null, publicUrl, memberUrl: deps.memberUrl ?? memberUrl(publicUrl, {}),
    me: (c) => c.get("me"), lang: (c) => c.get("lang"), now, botGuard }));
  app.all("/mcp", async (c) => {
    const who = await bearerPerson(db, c.req.header("authorization"), `${publicUrl}/mcp`, now());
    if (!who) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp", scope="kumi"` });
    return handleMcp(c.req.raw, await mcpServerFor(db, who, now));
  });

  // ---- Sign in by an emailed code ----
  app.post("/auth/email/start", async (c) => {
    const { email } = await body(c, EmailStart);
    if ((await botGuard(c)) === "honeypot") return c.json({ sent: true });   // the same answer; nothing is sent
    await startEmailSignIn(db, mailer, email, c.get("lang"), now());
    return c.json({ sent: true });   // the same answer whether or not the email has an account
  });
  app.post("/auth/email/verify", async (c) => {
    const { email, code } = await body(c, EmailVerify);
    const r = await verifyEmailCode(db, email, code, c.req.header("user-agent") ?? null, now());
    if ("signUpTicket" in r) return c.json({ sign_up: true, ticket: r.signUpTicket });
    setCookie(c, COOKIE, r.token, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.json({ signed_in: true });
  });
  // ---- Sign in (or join) by a texted code, when the club texts ----
  const texter = () => { const tx = deps.texts?.texter ?? null; if (!phoneSignInOn(tx)) throw new KumiError("error.phone_sign_in_off", {}, 409); return tx!; };
  const phoneOf = (raw: string) => { const p = usPhone(raw); if (!p) throw new KumiError("error.phone_bad", {}, 400); return p; };
  app.post("/auth/phone/start", async (c) => {
    const tx = texter();
    const parsed = z.safeParse(PhoneStart, await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new KumiError("error.phone_bad", {}, 400);
    const phone = phoneOf(parsed.data.phone);
    if ((await botGuard(c)) === "honeypot") return c.json({ sent: true });   // the same answer; nothing is sent
    await startPhoneSignIn(db, tx, phone, c.get("lang"), now(), { memberUrl: deps.memberUrl ?? memberUrl(publicUrl, {}) });
    return c.json({ sent: true });   // the same answer whether or not the number has an account
  });
  app.post("/auth/phone/verify", async (c) => {
    texter();
    const parsed = z.safeParse(PhoneVerify, await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new KumiError("error.bad_code", {}, 400);
    const r = await verifyPhoneCode(db, phoneOf(parsed.data.phone), parsed.data.code, c.req.header("user-agent") ?? null, now());
    if ("signUpTicket" in r) return c.json({ sign_up: true, ticket: r.signUpTicket, by: "phone" });
    setCookie(c, COOKIE, r.token, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.json({ signed_in: true });
  });
  // ---- Their email: added (an account that joined by phone) or changed ----
  const members = deps.memberUrl ?? memberUrl(publicUrl, {});
  app.post("/my/email/start", async (c) => {
    const a = actor(c), { email } = await body(c, EmailStart);
    await startEmailAdd(db, mailer, a.personId!, email, c.get("lang"), now(), a.auth);
    return c.json({ sent: true });
  });
  app.post("/my/email/verify", async (c) => {
    const a = actor(c), { code } = await body(c, CodeOnly);
    return c.json({ email: await verifyEmailAdd(db, a.personId!, code, now(), { mailer, undoUrl: (t) => `${members}/auth/email-undo/${t}` }) });
  });
  // Staff changing a member's email for them, at the desk: a code goes to the new address and the member reads
  // it out, and the old address is told, with its link to put it back, as when members change it themselves.
  // Staff signed in with a passkey or two steps, who look after members (owners, managers, front desk, or a
  // role the club made covering members). A staff member's own email is theirs or the owner's to change.
  const deskForEmail = async (c: Context<Env>, personId: string) => {
    const a = actor(c);
    if (a.auth !== "passkey" && a.auth !== "two_factor") throw new KumiError("error.need_passkey", {}, 403);
    const keys = async (id: string) => (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", id).where("person_role.active", "=", true).where("role.active", "=", true).execute()).map((r) => r.key);
    const mine = await keys(a.personId!), areas = await customAreas(db, a.personId!);
    if (areas ? !areas.includes("members") : !mine.some((k) => ["owner", "manager", "front_desk"].includes(k))) throw new KumiError("error.staff_only", {}, 403);
    const p = await db.selectFrom("person").select(["locale"]).where("id", "=", personId).where("status", "!=", "archived").executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: { en: "person", es: "la persona" } }, 404);
    if (personId === a.personId || ((await keys(personId)).some((k) => k !== "member") && !mine.includes("owner"))) throw new KumiError("error.staff_email_change", {}, 403);
    return { a, lang: ((p.locale as Lang) ?? "en") as Lang };
  };
  app.post("/staff/people/:id/email/start", async (c) => {
    const id = c.req.param("id"), { lang: l } = await deskForEmail(c, id), { email } = await body(c, EmailStart);
    await startEmailAdd(db, mailer, id, email, l, now(), "two_factor");
    return c.json({ sent: true });
  });
  app.post("/staff/people/:id/email/verify", async (c) => {
    const id = c.req.param("id"), { a } = await deskForEmail(c, id), { code } = await body(c, CodeOnly);
    return c.json({ email: await verifyEmailAdd(db, id, code, now(), { mailer, undoUrl: (t) => `${members}/auth/email-undo/${t}`, by: a.personId! }) });
  });
  // The old address's link. Opening it (or a mail scanner checking it) changes nothing: the button does.
  const undoPage = (l: Lang, club: string, body: string) => `<!doctype html><html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(t(l, "emailundo.title", { club }))}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1d2321;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #1d2321;background:#1d2321;color:#fff;cursor:pointer}</style></head>
<body><h1>${esc(t(l, "emailundo.title", { club }))}</h1>${body}</body></html>`;
  app.get("/auth/email-undo/:token", async (c) => {
    c.header("cache-control", "no-store");
    const u = await emailUndoTarget(db, c.req.param("token"), now());
    if (!u || u.consumed_at) return c.html(undoPage(c.get("lang"), u?.club ?? "", `<p>${esc(t(c.get("lang"), "emailundo.bad"))}</p>`), 404);
    return c.html(undoPage(u.lang, u.club, `<p>${esc(t(u.lang, "emailundo.ask", { email: u.target }))}</p><form method="post"><button type="submit">${esc(t(u.lang, "emailundo.button"))}</button></form>`));
  });
  app.post("/auth/email-undo/:token", async (c) => {
    c.header("cache-control", "no-store");
    const token = c.req.param("token"), u = await emailUndoTarget(db, token, now());
    if (!u || !(await undoEmailChange(db, mailer, token, now()))) return c.html(undoPage(c.get("lang"), u?.club ?? "", `<p>${esc(t(c.get("lang"), "emailundo.bad"))}</p>`), 404);
    return c.html(undoPage(u.lang, u.club, `<p>${esc(t(u.lang, "emailundo.done", { email: u.target }))}</p>`));
  });

  app.post("/auth/sign-up", async (c) => {
    const b = await body(c, SignUp);
    if ((await botGuard(c)) !== "ok") throw new KumiError("error.bot_check", {}, 400);
    const { token } = await completeSignUp(db, b.ticket, { display_name: b.display_name, locale: b.locale, club_news: b.club_news }, c.req.header("user-agent") ?? null, now());
    setCookie(c, COOKIE, token, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.json({ signed_in: true });
  });
  app.post("/auth/sign-out", async (c) => {
    await signOut(db, getCookie(c, COOKIE), now());
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ signed_out: true });
  });

  app.get("/me", async (c) => {
    const a = actor(c);
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id")
      .select(["role.key", "role.name", "person_role.location_id"]).where("person_role.person_id", "=", a.personId!).where("person_role.active", "=", true).where("role.active", "=", true).execute();
    const me = c.get("me")!;
    const kid = await kidOf(db, me.id);
    // Someone whose only staff roles are ones the club made sees the areas those roles cover.
    const areas = me.gate ? null : await customAreas(db, me.id);
    // For those people, which of the buttons that start a change their roles allow (the server checks again).
    const can = areas ? await customCan(db, me.id, CLIENT_ACTIONS) : null;
    // An account with no email (it joined by phone): the apps ask, never require, for one.
    const email = (await db.selectFrom("person").select("email").where("id", "=", me.id).executeTakeFirst())?.email ?? null;
    return c.json({ person: { id: me.id, display_name: me.display_name, locale: me.locale }, signed_in_with: me.method, lang: c.get("lang"), roles, kid: kid ? { friends: kid.friends } : null, gate: me.gate, areas, can,
      has_email: Boolean(email), email });
  });

  // ---- Actions: one description each, the same one the MCP tools and forms use ----
  app.get("/actions", (c) => {
    const lang = c.get("lang");
    return c.json(actions().filter((a) => !a.system && !a.name.startsWith("test.")).map((a) => ({ name: a.name, input: toJSONSchema(a.input as any), lang })));
  });
  app.post("/actions/:name/plan", async (c) => {
    const p = await plan(db, c.req.param("name"), await c.req.json().catch(() => ({})), actor(c), { now: now() });
    const lang = c.get("lang");
    return c.json({ run_id: p.runId, status: p.status, title: p.plan.title[lang], summary: p.plan.summary[lang], undo: p.plan.undo.kind, expires_at: p.expiresAt });
  });
  app.post("/runs/:id/apply", async (c) => {
    const a = actor(c), id = c.req.param("id");
    const result = await apply(db, id, a, { now: now(), idempotencyKey: c.req.header("idempotency-key") });
    // A kid's booking or sign-up: what it costs goes on the family card now, so there's no card form to open.
    const family = await payKidRun(db, id, a.personId, now());
    return c.json({ result: family ? { ...(result && typeof result === "object" ? result : {}), payment_id: undefined, family } : result });
  });
  app.post("/runs/:id/approve", async (c) => c.json({ result: await approve(db, c.req.param("id"), actor(c), { now: now() }) }));

  // ---- Changes: the audit log, for the people allowed to see it ----
  app.get("/changes", async (c) => {
    const a = actor(c);
    const d = await decide(db, "changes.view", { personId: a.personId, at: now() });
    if (d.mode !== "allow") throw new KumiError("error.staff_only", {}, 403);
    const lang = c.get("lang");
    const rows = await db.selectFrom("action_run").leftJoin("person", "person.id", "action_run.actor_person_id")
      .select(["action_run.id", "action_run.action", "action_run.status", "action_run.plan", "action_run.via", "action_run.created_at", "action_run.applied_at", "person.display_name"])
      .orderBy("action_run.id", "desc").limit(Number(c.req.query("limit") ?? 50)).execute();
    return c.json(rows.map((r) => ({ id: r.id, action: r.action, status: r.status, by: r.display_name ?? "Kumi", via: r.via, summary: (r.plan as any)?.summary?.[lang] ?? null, at: r.applied_at ?? r.created_at })));
  });

  return app;
}
