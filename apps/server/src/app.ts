// The HTTP API. Every write goes through the action registry; reads answer in the person's
// language (their profile, or Accept-Language before they sign in).
import { Hono, type Context } from "hono";
import { clearSession, readSession, setSession, type CookieMode } from "./session_cookie.ts";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { clientIp, networkOf, RateLimiter } from "./limits.ts";
import { REVISION, VERSION } from "./version.ts";
import { deepHealth, mayReadDeepHealth } from "./health.ts";
import { vaultRoutes } from "./vault.ts";
import { exportRoutes } from "./export_routes.ts";
import { brandTag, manifestRoutes } from "./manifest.ts";
import * as z from "zod/mini";
import { sql } from "kysely";
import { toJSONSchema } from "zod/v4/core";
import { pickLang, isLang, formerMember, t, FORMER_MEMBER, isHosted, type Lang } from "@kumi/i18n";
import { comingFrom } from "@kumi/i18n/presets";
import { welcomeDue, greetDue, greeted, connectionReach, anyPhone, promosOn, unsubscribePush, actions, apply, plainIssues, nameInput, personEmailProblem, approve, isYesWaiting, decline, plan, decide, kidOf, KumiError, leavingOn, payKidRun, needsTwoFactor, hasSecondFactor, customAreas, customCan, rolesCan, readAreas, staffReach, textablePhone, activeSupport, logSupportRead, runAsSystem, supportUnderWay, SUPPORT_CLOSED_PATHS, serviceEnv, type Actor, type Db, type Texter } from "@kumi/core";
import { BotCheck } from "./bot.ts";
import { secondStepTries, twoFactorRoutes } from "./two_factor.ts";
import { completeSignUp, emailUndoTarget, LINK_MINUTES, phoneSignInOn, signInLinkTarget, useSignInLink, sessionPerson, signOut, startEmailAdd, startEmailSignIn, startPhoneSignIn, undoEmailChange, verifyEmailAdd, verifyEmailCode, verifyPhoneCode } from "./auth.ts";
import { bearerPerson, defaultFetchMetadata, mcpResourceOf, mcpResources, OAUTH_PAGES, oauthErrorPage, oauthRoutes, type FetchMetadata } from "./oauth.ts";
import { serviceRoutes } from "./service_routes.ts";
import { handleMcp, mcpServerFor } from "./mcp.ts";
import { previewWords } from "./preview_words.ts";
import { assistantRoutes, type ModelClient } from "./assistant.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { readRoutes } from "./reads.ts";
import { supportRoutes } from "./support_routes.ts";
import { agentRoutes } from "./agent_routes.ts";
import { pluginRoutes, usePluginIo } from "./plugins.ts";
import { calendarRoutes } from "./calendar.ts";
import { translateRoutes, translatorOn } from "./translate.ts";
import { broadcastRoutes } from "./broadcasts.ts";
import { publicRoutes } from "./public.ts";
import { memberUrl } from "./addresses.ts";
import { memberRoutes } from "./member.ts";
import { staffChatRoutes } from "./chats.ts";
import { changeRoutes } from "./changes.ts";
import { paymentRoutes, type StripeConfig } from "./payments.ts";
import { textRoutes } from "./texts.ts";
import { emailEventRoutes } from "./email_events.ts";
import { receiptRoutes } from "./receipts.ts";
import { startFromChecks } from "./getting_started.ts";
import type { Mailer } from "./mailer.ts";

/** The changes a staff screen offers a button for, which /me reports for people with only the club's own roles. */
/** Every change a staff or members' app button asks mayDo about (client_actions.test.ts checks the apps' sources): /me
 *  says which of them the roles of a coach, or of a role the club made, allow. One left out reads as "not allowed". */
export const CLIENT_ACTIONS = ["person.create", "person.import", "person.email_unsuppress", "booking.create", "booking.create_lesson", "booking.repeat", "program.create", "booking.move", "booking.extend", "booking.record_payment", "booking.cancel", "booking.refund",
  "booking.add_player", "booking.remove_player", "booking.paid_in_playtomic", "booking.check_in", "court.block", "court.unblock", "court.block_repeat", "court.block_repeat_end", "court.block_repeat_edit", "alert.handle",
  "series.edit", "weekly.end_all", "membership.sell", "membership.record_payment", "membership.bring_in", "enrolment.record_payment", "enrolment.remove", "enrolment.comp", "enrolment.join_dates",
  "refund.give_back", "refund.resend", "credit.bring_in", "credit.pay_out", "gift_card.sell", "gift_card.resend", "gift_card.void", "pass.sell", "pass.refund", "pass_product.set", "promo_code.set",
  "payment_found.refund", "payment_found.paid_elsewhere", "mirror.take_over", "broadcast.send", "broadcast.cancel", "segment.save", "segment.update", "template.save", "template.update",
  "tag.create", "tag.update", "fact.create", "fact.update", "program.set_name", "program.set_prices", "program.set_sign_up", "program.set_gender", "program.set_minimum", "program.publish", "program.cancel",
  "session.set_coach", "session.add", "series.cancel", "membership.grant", "membership.pause", "membership.unpause", "membership.resume", "membership.cancel", "membership.end",
  "household.add_junior", "person.tag", "person.untag", "attendance.mark", "role.create", "move.step", "move.upload", "move.members", "move.memberships", "move.credit", "move.bookings", "move.programs"];

/** The changes the Schedule's + Create starts, for /me's `creates`; and making a role, for the staff menu's Roles item
 *  (an owner's, or a manager's to ask for). */
export const CREATE_ACTIONS = ["program.create", "booking.create", "booking.create_lesson", "booking.repeat", "court.block", "role.create"];

export interface AppDeps { clientIp?: (c: Context<any>) => string | null; db: Db; mailer: Mailer; publicUrl?: string;
  /** The members' app's address (addresses.ts), for the public page's own links; from publicUrl when not given. */
  memberUrl?: string; secureCookies?: boolean; now?: () => Date; fetchMetadata?: FetchMetadata; production?: boolean; stripe?: StripeConfig
  /** Bot protection on sign-up, sign-in codes and checkout. On in production, always; tests and practice can leave it off. */
  botCheck?: boolean
  /** Texts, when the club's Twilio account is set up (twilio.ts): what sends them, and the token Twilio signs its posts with. */
  texts?: { texter: Texter; authToken: string | null }
  /** The database's address for the tools that copy it whole (the owner's "Download everything"). */
  databaseUrl?: string
  /** The email service's webhook (email_events.ts): the secret its posts are signed with, and the club's sender. */
  /** How the Connectors cards' test calls reach Resend and Stripe (a stand-in in tests). */
  serviceFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  emailEvents?: { secret: string | null; from: string | null }
  /** Over HTTPS, a session under the cookie's old name is still read and moved to the new one, for a release (on unless
   *  OPENPADEL_LEGACY_SESSION_COOKIE=0: session_cookie.ts). */
  legacySessionCookie?: boolean
  /** Where a sign-in code emailed goes (main.ts): "sent" by the email service; "log", with no email service set up, only
   *  to the server's log; "practice", only to the server's test addresses (the rest are held in its log). The sign-in
   *  page then says so, rather than that it was emailed. */
  /** Where email goes now (main.ts reads it from the mailer, which follows the settings as they change). */
  mailReach?: "sent" | "log" | "practice" | (() => "sent" | "log" | "practice")
  /** Ask openPadel's model (assistant.ts): on with OPENPADEL_ANTHROPIC_API_KEY, off (and the apps say how to turn it on)
   *  without one. Tests give a fake. */
  /** Ask openPadel's model, or what gives it as the settings are now. */
  assistant?: ModelClient | null | (() => ModelClient | null)
  /** Where the plugin catalog's index is (OPENPADEL_PLUGIN_CATALOG_URL): an address or a file; the bundled sample without one. */
  pluginCatalogUrl?: string | null }
/** gate: this session still owes its second step ("verify"), or there's none set up yet ("setup"). */
type Me = { id: string; display_name: string; locale: string; method: "email_code" | "phone_code" | "passkey" | "two_factor"; created_at: Date; token_hash: string; gate: "setup" | "verify" | null;
  /** Started by a sign-in link (auth.ts): it owes a second step whatever the club's rules say. */ owed?: boolean } | null;
type Env = { Variables: { me: Me; lang: Lang } };
const EmailStart = z.object({ email: z.email() });
const EmailVerify = z.object({ email: z.email(), code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const PhoneStart = z.object({ phone: z.string().check(z.maxLength(40)) });
const PhoneVerify = z.object({ phone: z.string().check(z.maxLength(40)), code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const CodeOnly = z.object({ code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const shownLink = z.nullable(z.string().check(z.maxLength(2000)));
const SignUp = z.object({ ticket: z.string().check(z.minLength(20)), display_name: nameInput(80), locale: z.enum(["en", "es"]), club_news: z.boolean(),
  policies: z.optional(z.object({ terms_url: shownLink, privacy_policy_url: shownLink })) });


const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
/** What a half sign-in can still reach: giving the second step, signing in again (as anyone) or out. */
const HALF_SIGNED_IN = new Set(["/auth/totp/verify", "/auth/recovery", "/auth/passkey/sign-in/options", "/auth/passkey/sign-in/verify", "/auth/sign-out",
  "/auth/challenge", "/auth/email/start", "/auth/email/verify", "/auth/phone/start", "/auth/phone/verify", "/auth/sign-up"]);
/** And for someone with no second step yet: setting the first one up. */
const FIRST_SECOND_STEP = new Set(["/auth/totp/setup", "/auth/totp/confirm", "/auth/passkey/add/options", "/auth/passkey/add/verify"]);

export function makeApp(deps: AppDeps) {
  const { db, mailer } = deps;
  const now = deps.now ?? (() => new Date());
  const cookieMode: CookieMode = { secure: deps.secureCookies ?? true, legacy: deps.legacySessionCookie ?? true };
  const app = new Hono<Env>();
  const reach = () => typeof deps.mailReach === "function" ? deps.mailReach() : deps.mailReach;

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
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !path.startsWith("/webhooks/") && !path.startsWith("/plugins/") && !path.startsWith("/mcp") && !path.startsWith("/unsubscribe/") && !path.startsWith("/auth/email-undo/") && !path.startsWith("/auth/link/")) {
      const site = c.req.header("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") throw new KumiError("error.cross_site", {}, 403);
      const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(type) && !path.startsWith("/oauth/")) throw new KumiError("error.json_only", {}, 415);
    }
    await next();
  });
  // How often one address can try to sign in, join or guess a code.
  const ipOf = deps.clientIp ?? clientIp;
  const secondStep = secondStepTries();   // wrong authenticator codes per person, in the apps and the assistant's sign-in alike
  const limits = new Map<string, RateLimiter>([
    ["/auth/email/start", new RateLimiter(10, 15 * 60_000)], ["/oauth/sign-in", new RateLimiter(10, 15 * 60_000)],
    ["/auth/email/verify", new RateLimiter(20, 15 * 60_000)], ["/auth/sign-up", new RateLimiter(10, 60 * 60_000)],
    ["/auth/phone/start", new RateLimiter(10, 15 * 60_000)], ["/auth/phone/verify", new RateLimiter(20, 15 * 60_000)],
    ["/my/email/start", new RateLimiter(10, 60 * 60_000)], ["/my/email/verify", new RateLimiter(20, 15 * 60_000)],
    ["/auth/passkey/sign-in/verify", new RateLimiter(30, 15 * 60_000)], ["/my/phone/start", new RateLimiter(10, 60 * 60_000)], ["/my/phone/verify", new RateLimiter(20, 15 * 60_000)],
    ["/auth/totp/verify", new RateLimiter(20, 15 * 60_000)], ["/auth/recovery", new RateLimiter(20, 15 * 60_000)], ["/oauth/two-step", new RateLimiter(10, 15 * 60_000)],
    ["/oauth/register", new RateLimiter(10, 60 * 60_000)], ["/auth/passkey/sign-in/options", new RateLimiter(60, 15 * 60_000)],
    ["/oauth/device_authorization", new RateLimiter(10, 15 * 60_000)], ["/oauth/device/decide", new RateLimiter(20, 15 * 60_000)],
    // A typed device code: guessing one would take billions of tries, and this keeps it that way.
    ["/oauth/device", new RateLimiter(30, 15 * 60_000)],
  ]);
  // The consent page can make the server fetch a client's published identity from an address in the request, so
  // it's limited too (a sign-in on it reloads it a few times; 30 in 15 minutes is plenty).
  const getLimits = new Map<string, RateLimiter>([["/oauth/authorize", new RateLimiter(30, 15 * 60_000)], ["/oauth/device", new RateLimiter(60, 15 * 60_000)]]);
  app.use("*", async (c, next) => {
    const l = c.req.method === "POST" ? limits.get(c.req.path) : c.req.method === "GET" ? getLimits.get(c.req.path) : undefined, ip = l ? ipOf(c) : null;
    if (l && ip && !l.take(networkOf(ip))) throw new KumiError("error.too_many_requests", {}, 429);   // an IPv6 /64 counts as one
    await next();
  });

  app.use("*", async (c, next) => {
    const brought = readSession(c, cookieMode);
    const s = await sessionPerson(db, brought.token, now());
    // A session still under the old name moves to the new one, so nobody is signed out by the update.
    if (s && brought.legacy) setSession(c, brought.token!, cookieMode);
    let me: Me = null;
    if (s) {
      // A passkey is both steps; an emailed or texted code then an authenticator or recovery code is too.
      const method = s.method === "passkey" ? "passkey" : s.second_factor ? "two_factor" : s.method === "phone_code" ? "phone_code" : "email_code";
      let gate: "setup" | "verify" | null = null;
      // A sign-in link's session owes one whatever the club says (auth.ts); otherwise the club's rules and their own choice.
      const owed = (method === "email_code" || method === "phone_code") && s.second_step_owed;
      if ((method === "email_code" || method === "phone_code") && (owed || await needsTwoFactor(db, s.id))) gate = (await hasSecondFactor(db, s.id)) ? "verify" : "setup";
      me = { id: s.id, display_name: s.display_name, locale: s.locale, method, created_at: s.created_at, token_hash: s.token_hash, gate, ...(owed ? { owed } : {}) };
    }
    c.set("me", me);
    c.set("lang", me && isLang(me.locale) ? me.locale : pickLang(c.req.header("accept-language")));
    await next();
  });
  // Someone who must sign in with two steps (needsTwoFactor: the club asks it at sign-in, or they set one up) and
  // hasn't given the second yet can only finish signing in (or set the second step up): nothing else answers, so no staff page or action works on half a sign-in. Who
  // already has a second step can only give it: adding another passkey or authenticator on half a sign-in would
  // let whoever has the mailbox (or the phone) make their own second step.
  app.use("*", async (c, next) => {
    const me = c.get("me"), path = c.req.path;
    if (me?.gate && !(path === "/me" || path === "/club" || path === "/health" || path.startsWith("/manifest/") || path === "/my/two-factor"
      || HALF_SIGNED_IN.has(path) || path.startsWith("/auth/email-undo/") || path.startsWith("/auth/link/") || (me.gate === "setup" && FIRST_SECOND_STEP.has(path))
      || (path.startsWith("/oauth/") && path !== "/oauth/decide"))) throw new KumiError("error.two_step_needed", {}, 403);
    await next();
  });

  // Support access (support.ts), looked up on every request so it ends on time, mid-session too: its first use
  // tells the owner, the pages it never opens are refused, and every staff page and change it touches is recorded.
  app.use("*", async (c, next) => {
    const me = c.get("me");
    const g = me && !me.gate ? await activeSupport(db, me.id, now()) : null;
    if (!g) return next();
    const path = c.req.path, shown = `${path}${new URL(c.req.url).search}`;
    const record = (status: number) => logSupportRead(db, g.id, c.req.method, shown, status).catch((e) => console.error("support: recording a page:", (e as Error).message));
    if (SUPPORT_CLOSED_PATHS.test(path)) { await record(403); throw new KumiError("error.support_closed", {}, 403); }
    if (!g.first_seen_at) await runAsSystem(db, "support.seen", { grant_id: g.id }, "web", { now: now() }).catch((e) => console.error("support: first use:", (e as Error).message));
    await next();
    if (/^\/(staff\/|actions\/|runs\/)/.test(path)) await record(c.res.status);
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
    // The sign-in and consent pages are a person's browser, not an app: a plain page in their language, saying what to do.
    const lang = c.get("lang") ?? "en", onPage = OAUTH_PAGES.has(c.req.path);
    if (e instanceof KumiError) return onPage ? c.html(oauthErrorPage(lang, e.text[lang]), e.status as 400) : c.json({ error: e.code, message: e.text[lang] }, e.status as 400);
    console.error(e);
    return onPage ? c.html(oauthErrorPage(lang, t(lang, "consent.error_internal")), 500) : c.json({ error: "internal", message: "Something went wrong." }, 500);
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
    const raw = await c.req.json().catch(() => ({}));
    const parsed = z.safeParse(schema, raw);
    if (!parsed.success) throw new KumiError("error.invalid_input", { details: plainIssues(parsed.error.issues, raw) }, 400);
    return parsed.data;
  };

  app.get("/health", (c) => c.json({ ok: true, version: VERSION, revision: REVISION }));
  // The fuller picture (backups, outbox, disk): from the server itself, or for an owner or manager (health.ts).
  app.get("/health/deep", async (c) => {
    await mayReadDeepHealth(db, c, c.get("me")?.id ?? null);
    const h = await deepHealth(db, { now: now(), env: await serviceEnv(db) });
    return c.json(h, h.ok ? 200 : 503);
  });
  app.route("/", manifestRoutes(db));
  // What the sign-in page needs before anyone signs in: the club's name, colour and languages.
  app.get("/club", async (c) => {
    const club = await db.selectFrom("club").select(["name", "brand_colour", "coming_from", "languages", "default_language", "court_bookings", "players_chat", "weekly_bookings", "weekly_max_weeks", "gift_cards", "gift_card_min_cents", "gift_card_max_cents", "public_page", "terms_url", "privacy_policy_url", "time_zone", "currency", "format_locale", "country", "tax_label", "prices_include_tax", "read_only_since", "moved_at", "moved_to", "logo_id", "logo_for"]).executeTakeFirst();
    // Not set up yet (kumi setup apply): nothing to show, which isn't the server failing.
    if (!club) throw new KumiError("error.club_not_set_up", {}, 404);
    // Whether there's a membership to join in the app.
    const plan = await db.selectFrom("membership_plan").select("id").where("active", "=", true).where("join_in_app", "=", true).executeTakeFirst();
    // Whether any coach takes lessons in the app.
    const coach = await db.selectFrom("coach").select("person_id").where("active", "=", true).where("lessons", "=", true).where(sql<boolean>`rates <> '{}'::jsonb`).executeTakeFirst();
    // Whether a tournament or league is open or under way (the members' app then shows Tournaments).
    const competing = await db.selectFrom("program").select("id").where("kind", "in", ["tournament", "league"]).where("status", "=", "published").executeTakeFirst();
    // Whether the club sells a pass (passes.ts): the profile then links to Passes.
    const passes = await db.selectFrom("pass_product").select("id").where("on_sale", "=", true).executeTakeFirst();
    // Whether a promo code could be used now (promo_codes.ts): the pay sheet then asks for one before the card.
    const promos = await promosOn(db, new Date());
    // Whether the sign-in page offers a texted code: only when the club's texting account is set up.
    // The members' address, for the staff app's links members open (the public page, a booking's players link).
    // Whether the staff forms offer a draft in the club's other language (translate.ts).
    // Read-only (read_only.ts): both apps say so at the top.
    // Whether a sign-in code really goes by email (mail): with no email service it's only in the server's log.
    // Moved to another server (club_exit.ts): both apps say where, instead of read-only.
    // The club's own terms and privacy policy: linked where people join, beside the yes to texts and on the profile.
    // Hosted by Kumi (OPENPADEL_HOSTED=1): staff read "Kumi" for the product, and the apps show "Runs on Kumi".
    // The software staff used before (coming_from), always one the staff app knows: words and order only.
    // The club's logo, as its icon (the logo on what it sits on), for the apps' headers: named by the brand's tag.
    const { read_only_since, moved_at, moved_to, logo_id, logo_for, ...shown } = club;
    // And the start screen's mark (the logo or the drawn one) under the same tag, so the welcome shows a new one at once.
    const v = brandTag(club.name, club.brand_colour, logo_id && `${logo_id}:${logo_for ?? ""}`);
    const logo = logo_id ? `/manifest/icon-192.png?v=${v}` : null, mark = `/manifest/mark.png?v=${v}`;
    return c.json({ ...shown, logo, mark, coming_from: comingFrom(club.coming_from), read_only: Boolean(read_only_since), moved: Boolean(moved_at), moved_to: moved_at ? moved_to : null, memberships: Boolean(plan), lessons: Boolean(coach), competitions: Boolean(competing), passes: Boolean(passes), promos, phone_sign_in: phoneSignInOn(deps.texts?.texter ?? null), drafts: translatorOn(),
      member_url: deps.memberUrl ?? memberUrl(publicUrl, {}), hosted: isHosted(), mail: reach() ?? "sent" });
  });

  // ---- The MCP door: OAuth, then tools generated from the registry ----
  const publicUrl = (deps.publicUrl ?? "http://127.0.0.1:8790").replace(/\/$/, "");
  app.route("/", oauthRoutes({ db, mailer, publicUrl, secureCookies: deps.secureCookies ?? true, fetchMetadata: deps.fetchMetadata ?? defaultFetchMetadata, now, lang: (c) => c.get("lang"), me: (c) => c.get("me"),
    texter: deps.texts?.texter ?? null, memberUrl: deps.memberUrl ?? memberUrl(publicUrl, {}), secondStepTries: secondStep, ip: ipOf, get mailReach() { return reach(); } }));
  app.route("/", passkeyRoutes({ db, mailer, publicUrl, secureCookies: deps.secureCookies ?? true, now, lang: (c) => c.get("lang"), me: (c) => c.get("me") }));
  app.route("/", twoFactorRoutes({ db, mailer, now, lang: (c) => c.get("lang"), me: (c) => c.get("me"), tries: secondStep }));
  // Getting started's card payments, email and practice mode, as doctor's checks say (getting_started.ts).
  startFromChecks(db);
  app.route("/", readRoutes(db, (c) => c.get("me"), (c) => c.get("lang"), { production: deps.production ?? false }));
  // Plugins (plugins.ts): the club's key for what it sends them, and what outside services post for them, passed on.
  usePluginIo({ production: deps.production ?? false, publicUrl, catalogUrl: deps.pluginCatalogUrl ?? null });
  app.route("/", pluginRoutes(db, { production: deps.production ?? false, now }));
  app.route("/", staffChatRoutes(db, (c) => c.get("me"), now));
  app.route("/", supportRoutes(db, (c) => c.get("me"), (c) => c.get("lang"), now));
  app.route("/", agentRoutes(db, (c) => c.get("me"), (c) => c.get("lang"), now));
  app.route("/", vaultRoutes(db, (c) => c.get("me"), now, (c) => c.get("lang")));
  app.route("/", exportRoutes(db, (c) => c.get("me"), { databaseUrl: deps.databaseUrl ?? null, now }));
  app.route("/", calendarRoutes(db, (c) => c.get("me")));
  app.route("/", translateRoutes(db, (c) => c.get("me"), { now }));
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
  app.route("/", emailEventRoutes(db, { get secret() { return deps.emailEvents?.secret ?? null; }, get from() { return deps.emailEvents?.from ?? null; }, now }));
  // Texts: a member's number and their yes, and what Twilio posts back (texts.ts).
  app.route("/", textRoutes({ db, texter: deps.texts?.texter ?? null, get authToken() { return deps.texts?.authToken ?? null; }, publicUrl, memberUrl: deps.memberUrl ?? memberUrl(publicUrl, {}),
    me: (c) => c.get("me"), lang: (c) => c.get("lang"), now, botGuard, mailer, undoUrl: (t) => `${deps.memberUrl ?? memberUrl(publicUrl, {})}/auth/email-undo/${t}` }));
  // The MCP door, at either address. What an assistant reads is what the person reads in the app: the same
  // member routes, run in-process for the person behind the token.
  const mcpAt = mcpResources(publicUrl, deps.memberUrl ?? memberUrl(publicUrl, {}));
  // A service's settings, from its card or the owner's command line (service_routes.ts): the owner only, never a value back.
  app.route("/", serviceRoutes({ db, now, publicUrl, production: deps.production ?? false, me: (c) => c.get("me"), lang: (c) => c.get("lang"), resources: mcpAt, ...(deps.serviceFetch ? { fetch: deps.serviceFetch } : {}) }));
  /** What the door reads for a person: the members' app's reads as them, and for staff the staff screens' reads with
   *  their own checks, never through support access (reads.ts). */
  const doorReads = (who: { id: string; locale: string }) => {
    const lang = isLang(who.locale) ? who.locale : "en";
    const reads = memberRoutes(db, () => ({ id: who.id }), () => lang, { production: deps.production ?? false, now });
    reads.onError((e) => { throw e; });
    const staffReads = readRoutes(db, () => ({ id: who.id, locale: lang }), () => lang, { assistant: true, production: deps.production ?? false });
    staffReads.onError((e) => { throw e; });
    return { read: async (path: string) => (await reads.request(`http://kumi${path}`)).json(), readStaff: async (path: string) => (await staffReads.request(`http://kumi${path}`)).json() };
  };
  app.all("/mcp", async (c) => {
    const who = await bearerPerson(db, c.req.header("authorization"), mcpAt, now());
    if (!who) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${new URL(mcpResourceOf(mcpAt, c.req.url)).origin}/.well-known/oauth-protected-resource/mcp", scope="kumi"` });
    const { read, readStaff } = doorReads(who);
    // Never further than the person allowed when they connected it: a role given since, or a second step the club
    // now asks for, and it works as a member's until they connect it again (assistant_reach.ts).
    // A club agent's reach is its role, capped as it acts (permissions.ts): nothing of a person's to hold back.
    const limited = who.agent_id ? null : await connectionReach(db, who.grant_id, who.id, now());
    return handleMcp(c.req.raw, await mcpServerFor(db, who, now, read, readStaff, limited));
  });
  // Ask openPadel, the hosted assistant: the same door, opened in-process for the person signed in (assistant.ts).
  app.route("/", assistantRoutes({ db, now, get model() { return typeof deps.assistant === "function" ? deps.assistant() : deps.assistant ?? null; }, me: (c) => c.get("me"), lang: (c) => c.get("lang"), reads: doorReads }));

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
    setSession(c, r.token, cookieMode);
    return c.json({ signed_in: true });
  });
  // ---- Sign in (or join) by a texted code, when the club texts ----
  const texter = () => { const tx = deps.texts?.texter ?? null; if (!phoneSignInOn(tx)) throw new KumiError("error.phone_sign_in_off", {}, 409); return tx!; };
  const phoneOf = (raw: string) => { const p = textablePhone(raw); if (!p) throw new KumiError(anyPhone(raw) ? "error.phone_not_textable" : "error.phone_bad", {}, 400); return p; };
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
    if (!parsed.success) throw new KumiError("error.bad_text_code", {}, 400);
    const r = await verifyPhoneCode(db, phoneOf(parsed.data.phone), parsed.data.code, c.req.header("user-agent") ?? null, now());
    if ("signUpTicket" in r) return c.json({ sign_up: true, ticket: r.signUpTicket, by: "phone" });
    setSession(c, r.token, cookieMode);
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
    if (a.auth !== "passkey" && a.auth !== "two_factor") throw new KumiError((await hasSecondFactor(db, a.personId!)) ? "error.need_passkey" : "error.second_step_to_change", {}, 403);
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
    const same = u.email?.toLowerCase() === u.target.toLowerCase();   // a sign-in number's change: the address never moved
    return c.html(undoPage(u.lang, u.club, `<p>${esc(t(u.lang, same ? "emailundo.ask_same" : "emailundo.ask", { email: u.target }))}</p><form method="post"><button type="submit">${esc(t(u.lang, same ? "emailundo.button_same" : "emailundo.button"))}</button></form>`));
  });
  app.post("/auth/email-undo/:token", async (c) => {
    c.header("cache-control", "no-store");
    const token = c.req.param("token"), u = await emailUndoTarget(db, token, now());
    const same = u?.email?.toLowerCase() === u?.target.toLowerCase();
    if (!u || !(await undoEmailChange(db, mailer, token, now()))) return c.html(undoPage(c.get("lang"), u?.club ?? "", `<p>${esc(t(c.get("lang"), "emailundo.bad"))}</p>`), 404);
    return c.html(undoPage(u.lang, u.club, `<p>${esc(t(u.lang, same ? "emailundo.done_same" : "emailundo.done", { email: u.target }))}</p>`));
  });

  // An owner's one-time sign-in link (auth.ts, `openpadel sign-in-link`), only while the server has no email service.
  // Opening it shows whom it signs in and changes nothing (a chat app's preview can't use it up): the button does, then
  // the staff app opens signed in.
  const linkPage = (l: Lang, club: string, body: string) => `<!doctype html><html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(t(l, "signinlink.title", { club }))}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1d2321;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #1d2321;background:#1d2321;color:#fff;cursor:pointer}code{background:#eef1f0;padding:0 .25rem;border-radius:.25rem}</style></head>
<body><h1>${esc(t(l, "signinlink.title", { club }))}</h1>${body}</body></html>`;
  const linksOn = () => reach() === "log";
  const clubName = async () => (await db.selectFrom("club").select("name").executeTakeFirst())?.name ?? "";
  const linkGone = async (c: Context<Env>) => c.html(linkPage(c.get("lang"), await clubName(), `<p>${esc(t(c.get("lang"), linksOn() ? "signinlink.bad" : "signinlink.email_on", { count: LINK_MINUTES }))}</p>`), 404);
  app.get("/auth/link/:token", async (c) => {
    c.header("cache-control", "no-store"); c.header("referrer-policy", "no-referrer");
    const who = linksOn() ? await signInLinkTarget(db, c.req.param("token"), now()) : null;
    if (!who) return linkGone(c);
    const l: Lang = isLang(who.locale) ? who.locale : c.get("lang"), club = await clubName();
    return c.html(linkPage(l, club, `<p>${esc(t(l, "signinlink.ask", { name: who.name, email: who.email, club }))}</p><form method="post"><button type="submit">${esc(t(l, "signinlink.button"))}</button></form><p>${esc(t(l, "signinlink.not_you"))}</p>`));
  });
  app.post("/auth/link/:token", async (c) => {
    c.header("cache-control", "no-store"); c.header("referrer-policy", "no-referrer");
    const r = linksOn() ? await useSignInLink(db, c.req.param("token"), c.req.header("user-agent") ?? null, now()) : null;
    if (!r) return linkGone(c);
    console.log(`sign-in link: used for an owner (${r.personId})`);
    setSession(c, r.token, cookieMode);
    return c.redirect("/", 303);
  });

  app.post("/auth/sign-up", async (c) => {
    const b = await body(c, SignUp);
    if ((await botGuard(c)) !== "ok") throw new KumiError("error.bot_check", {}, 400);
    const { token } = await completeSignUp(db, b.ticket, { display_name: b.display_name, locale: b.locale, club_news: b.club_news, policies: b.policies }, c.req.header("user-agent") ?? null, now());
    setSession(c, token, cookieMode);
    return c.json({ signed_in: true });
  });
  app.post("/auth/sign-out", async (c) => {
    // This device's notifications end with the sign-out (the app sends its push endpoint): on a shared phone the next
    // person doesn't get the last one's messages. Only the signed-in person's own subscription is touched.
    const b = await c.req.json().catch(() => ({})) as { endpoint?: unknown }, me = c.get("me");
    if (me && typeof b.endpoint === "string" && b.endpoint.length <= 2000) await unsubscribePush(db, me.id, b.endpoint);
    await signOut(db, readSession(c, cookieMode).token, now());
    clearSession(c, cookieMode);
    return c.json({ signed_out: true });
  });

  app.get("/me", async (c) => {
    const a = actor(c);
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id")
      .select(["role.key", "role.name", "person_role.location_id"]).where("person_role.person_id", "=", a.personId!).where("person_role.active", "=", true).where("role.active", "=", true).execute();
    const me = c.get("me")!;
    // Support access reads the staff screens as a manager would, for as long as it lasts (what it may change is the
    // server's to decide); the owner and managers see when anyone has it.
    const support = me.gate ? null : await activeSupport(db, me.id, now());
    if (support) roles.push({ key: "manager", name: null, location_id: null });
    const supportNow = !support && roles.some((r) => r.key === "owner" || r.key === "manager") ? await supportUnderWay(db, now()) : [];
    const kid = await kidOf(db, me.id);
    // Someone whose only staff roles are ones the club made sees the areas those roles cover.
    const areas = me.gate ? null : await customAreas(db, me.id);
    // For those people, and a coach (whose roles don't read every area), which of the buttons that start a change their
    // roles allow (the server checks again).
    const coaching = !me.gate && !support && !areas && roles.some((r) => r.key === "coach") && (await readAreas(db, me.id)) !== null;
    const can = areas || coaching ? await customCan(db, me.id, CLIENT_ACTIONS) : null;
    // What the Schedule's + Create may offer: what any of their roles allows, built-in roles included (a front desk
    // books courts but doesn't make programs; an accountant does neither). Support access reads as a manager would.
    const creates = me.gate ? [] : support ? CREATE_ACTIONS : await rolesCan(db, me.id, CREATE_ACTIONS);
    // The Playtomic page, as /staff/mirror decides it: a role reading every area (support access too), or one the
    // club made covering bookings; never bookings that come only from coaching.
    const reach = me.gate ? null : await staffReach(db, me.id, support ? ["manager"] : []);
    const playtomic = Boolean(reach && (reach.all || reach.custom?.includes("bookings")));
    // A staff role kept to one location: the whole club's changes it can't make (a message to a group, the club's
    // facts, someone's data), so the staff app hides their buttons (the server refuses them either way).
    const cannot = roles.some((r) => r.key !== "member" && r.location_id) ? (await Promise.all(actions().filter((d) => d.wholeClub && !d.internal)
      .map(async (d) => ((await decide(db, d.name, { personId: me.id, locationId: null, at: now(), wholeClub: d.wholeClub })).mode === "no" ? d.name : null)))).filter((x): x is string => Boolean(x)) : [];
    // An account with no email (it joined by phone): the apps ask, never require, for one.
    const row = await db.selectFrom("person").select(["email", "created_via"]).where("id", "=", me.id).executeTakeFirst(), email = row?.email ?? null;
    // The day the club's Kumi ends (leaving.ts): for the top of the staff app, the owner's and managers' to see.
    const leaving = !me.gate && roles.some((r) => r.key === "owner" || r.key === "manager") ? await leavingOn(db) : null;
    return c.json({ person: { id: me.id, display_name: me.display_name, locale: me.locale }, signed_in_with: me.method, lang: c.get("lang"), roles, kid: kid ? { friends: kid.friends } : null, gate: me.gate, areas, can, cannot, creates, playtomic,
      has_email: Boolean(email), email, email_problem: email ? await personEmailProblem(db, me.id) : null, leaving, support: support ? { name: support.name, level: support.level, ends_at: support.ends_at } : null, support_now: supportNow,
      // An account made for support access whose access has ended: the staff app says so, rather than showing empty pages.
      support_ended: !support && row?.created_via === "support",
      // Moved in from Playtomic and not welcomed yet: the members' app shows its welcome once (welcome.ts).
      welcome: !me.gate && !support ? await welcomeDue(db, me.id) : false,
      // The short welcome each app plays at a first sign-in there (Greeting.tsx): the staff app's only for staff.
      ...await greetings(me.id, Boolean(me.gate || support), roles.some((r) => r.key !== "member")) });
  });
  const greetings = async (id: string, skip: boolean, staff: boolean) => {
    if (skip) return { greet_member: false, greet_staff: false };
    const g = await greetDue(db, id);
    return { greet_member: g.member, greet_staff: g.staff && staff };
  };
  // Played: noted on the person, so it never plays again in that app, on this phone or any other.
  app.post("/me/greeted", async (c) => {
    const a = actor(c), { app: which } = await body(c, z.object({ app: z.enum(["member", "staff"]) }));
    return c.json({ first: await greeted(db, a.personId!, which, now()) });
  });

  // ---- Actions: one description each, the same one the MCP tools and forms use ----
  app.get("/actions", (c) => {
    const lang = c.get("lang");
    return c.json(actions().filter((a) => !a.system && !a.name.startsWith("test.")).map((a) => ({ name: a.name, input: toJSONSchema(a.input as any), lang })));
  });
  app.post("/actions/:name/plan", async (c) => {
    // ?ask=hold: a change that needs someone else's yes is only shown, until the person says to ask (Preview.tsx).
    const p = await plan(db, c.req.param("name"), await c.req.json().catch(() => ({})), actor(c), { now: now(), holdAsk: c.req.query("ask") === "hold" });
    // A change that charges money says it line by line too (charge.ts): the members' app shows it before the yes.
    const w = previewWords(p.plan, c.get("lang"), actor(c).personId);
    return c.json({ run_id: p.runId, status: p.status, title: w.title, summary: w.summary, undo: p.plan.undo.kind, expires_at: p.expiresAt, yeses_needed: p.yesesNeeded, ...(w.charge ? { charge: w.charge } : {}), ...(p.plan.image ? { image: p.plan.image } : {}),
      ...(w.rows ? { rows: w.rows } : {}) });
  });
  app.post("/runs/:id/apply", async (c) => {
    const a = actor(c), id = c.req.param("id");
    const result = await apply(db, id, a, { now: now(), idempotencyKey: c.req.header("idempotency-key") });
    // A kid's booking or sign-up: what it costs goes on the family card now, so there's no card form to open.
    const family = await payKidRun(db, id, a.personId, now());
    // Whether it can be taken back (its undo kind isn't "none"), so the app can offer Undo right away. Undo itself
    // is planned and judged like any change (action.undo), as the person who'd take it back.
    const run = await db.selectFrom("action_run").select(["undo_kind", "action", "status"]).where("id", "=", id).executeTakeFirst();
    const undoable = Boolean(run && run.status === "applied" && run.undo_kind !== "none" && run.action !== "action.undo");
    return c.json({ result: family ? { ...(result && typeof result === "object" ? result : {}), payment_id: undefined, family } : result, undoable });
  });
  // A yes. Under the club's second-yes rule the first of two only counts: the change still waits (yes_waiting says how
  // many yeses it has and needs), and the same person saying yes again gets the same answer.
  app.post("/runs/:id/approve", async (c) => {
    const r = await approve(db, c.req.param("id"), actor(c), { now: now() });
    return c.json(isYesWaiting(r) ? { result: null, yes_waiting: r.yes_waiting } : { result: r });
  });
  // Saying no to an ask: nothing changes, and the person who asked hears (with the reason, if one is given).
  app.post("/runs/:id/decline", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { reason?: unknown };
    await decline(db, c.req.param("id"), actor(c), { now: now(), reason: typeof body.reason === "string" ? body.reason : null });
    return c.json({ ok: true });
  });

  // ---- Changes: the audit log, for the people allowed to see it (changes.ts).
  app.route("/", changeRoutes(db, actor, (c) => c.get("lang"), now));

  return app;
}
