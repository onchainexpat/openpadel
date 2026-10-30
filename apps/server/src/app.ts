// The HTTP API. Every write goes through the action registry; reads answer in the person's
// language (their profile, or Accept-Language before they sign in).
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { clientIp, RateLimiter } from "./limits.ts";
import { VERSION } from "./version.ts";
import * as z from "zod/mini";
import { toJSONSchema } from "zod/v4/core";
import { pickLang, isLang, type Lang } from "@kumi/i18n";
import { actions, apply, approve, plan, decide, KumiError, type Actor, type Db } from "@kumi/core";
import { completeSignUp, sessionPerson, signOut, startEmailSignIn, verifyEmailCode, SESSION_DAYS } from "./auth.ts";
import { bearerPerson, defaultFetchMetadata, oauthRoutes, type FetchMetadata } from "./oauth.ts";
import { handleMcp, mcpServerFor } from "./mcp.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { readRoutes } from "./reads.ts";
import { memberRoutes } from "./member.ts";
import { paymentRoutes, type StripeConfig } from "./payments.ts";
import type { Mailer } from "./mailer.ts";

export interface AppDeps { clientIp?: (c: Context<any>) => string | null; db: Db; mailer: Mailer; publicUrl?: string; secureCookies?: boolean; now?: () => Date; fetchMetadata?: FetchMetadata; production?: boolean; stripe?: StripeConfig }
type Me = { id: string; display_name: string; locale: string; method: "email_code" | "passkey"; created_at: Date } | null;
type Env = { Variables: { me: Me; lang: Lang } };
const COOKIE = "kumi_session";
const EmailStart = z.object({ email: z.email() });
const EmailVerify = z.object({ email: z.email(), code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const SignUp = z.object({ ticket: z.string().check(z.minLength(20)), display_name: z.string().check(z.minLength(1), z.maxLength(80)), locale: z.enum(["en", "es"]), club_news: z.boolean() });

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
  // forms. Stripe's webhook and the agent endpoint use signatures and tokens, not the session cookie.
  app.use("*", async (c, next) => {
    const path = c.req.path, m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !path.startsWith("/webhooks/") && !path.startsWith("/mcp")) {
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
    ["/auth/passkey/sign-in/verify", new RateLimiter(30, 15 * 60_000)],
  ]);
  app.use("*", async (c, next) => {
    const l = c.req.method === "POST" ? limits.get(c.req.path) : undefined, ip = l ? ipOf(c) : null;
    if (l && ip && !l.take(ip)) throw new KumiError("error.too_many_requests", {}, 429);
    await next();
  });

  app.use("*", async (c, next) => {
    const me = await sessionPerson(db, getCookie(c, COOKIE), now());
    c.set("me", me);
    c.set("lang", me && isLang(me.locale) ? me.locale : pickLang(c.req.header("accept-language")));
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof KumiError) return c.json({ error: e.code, message: e.text[c.get("lang") ?? "en"] }, e.status as 400);
    console.error(e);
    return c.json({ error: "internal", message: "Something went wrong." }, 500);
  });

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

  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));
  // What the sign-in page needs before anyone signs in: the club's name, colour and languages.
  app.get("/club", async (c) => c.json(await db.selectFrom("club").select(["name", "brand_colour", "languages", "default_language"]).executeTakeFirstOrThrow()));

  // ---- The MCP door: OAuth, then tools generated from the registry ----
  const publicUrl = (deps.publicUrl ?? "http://127.0.0.1:8790").replace(/\/$/, "");
  app.route("/", oauthRoutes({ db, mailer, publicUrl, secureCookies: deps.secureCookies ?? true, fetchMetadata: deps.fetchMetadata ?? defaultFetchMetadata, now, lang: (c) => c.get("lang"), me: (c) => c.get("me") }));
  app.route("/", passkeyRoutes({ db, mailer, publicUrl, secureCookies: deps.secureCookies ?? true, now, lang: (c) => c.get("lang"), me: (c) => c.get("me") }));
  app.route("/", readRoutes(db, (c) => c.get("me"), (c) => c.get("lang")));
  app.route("/", memberRoutes(db, (c) => c.get("me"), (c) => c.get("lang"), { production: deps.production ?? false }));
  app.route("/", paymentRoutes(db, (c) => c.get("me"), actor, publicUrl, deps.stripe));
  app.all("/mcp", async (c) => {
    const who = await bearerPerson(db, c.req.header("authorization"), `${publicUrl}/mcp`, now());
    if (!who) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp", scope="kumi"` });
    return handleMcp(c.req.raw, await mcpServerFor(db, who, now));
  });

  // ---- Sign in by an emailed code ----
  app.post("/auth/email/start", async (c) => {
    const { email } = await body(c, EmailStart);
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
  app.post("/auth/sign-up", async (c) => {
    const b = await body(c, SignUp);
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
      .select(["role.key", "person_role.location_id"]).where("person_role.person_id", "=", a.personId!).where("person_role.active", "=", true).execute();
    const me = c.get("me")!;
    return c.json({ person: { id: me.id, display_name: me.display_name, locale: me.locale }, signed_in_with: me.method, lang: c.get("lang"), roles });
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
  app.post("/runs/:id/apply", async (c) => c.json({ result: await apply(db, c.req.param("id"), actor(c), { now: now(), idempotencyKey: c.req.header("idempotency-key") }) }));
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
