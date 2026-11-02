// OAuth 2.1 for the MCP door (spikes/mcp_signin.md): Claude's published identity (a client
// metadata document) and dynamic registration, PKCE S256, tokens bound to this club's MCP
// address, refresh tokens that rotate, and a reused refresh token revokes its whole family.
import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { setCookie } from "hono/cookie";
import { money, t, type Lang } from "@kumi/i18n";
import { activeFactor, KumiError, usPhone, useAuthenticatorCode, uuidv7, type Db, type Texter } from "@kumi/core";
import { phoneSignInOn, startEmailSignIn, startPhoneSignIn, verifyEmailCode, verifyPhoneCode, SESSION_DAYS } from "./auth.ts";
import type { Mailer } from "./mailer.ts";

export const ACCESS_SECONDS = 3600, REFRESH_DAYS = 30, CODE_SECONDS = 300, SCOPE = "kumi";
/** What a person can let an assistant spend for them a week, chosen as they connect it ($0 unless they pick more;
 *  any amount up to $500 later, in the app). */
export const CAP_CHOICES = [0, 2500, 5000, 10000, 20000];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
export type FetchMetadata = (url: string) => Promise<unknown>;

export const defaultFetchMetadata: FetchMetadata = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!r.ok) throw new Error(`status ${r.status}`);
  const text = await r.text();                    // fetch decodes gzip, deflate and brotli itself
  if (text.length > 64 * 1024) throw new Error("too large");
  return JSON.parse(text);
};

function okRedirect(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)); }
  catch { return false; }
}

export interface OAuthDeps { db: Db; mailer: Mailer; publicUrl: string; secureCookies: boolean; fetchMetadata: FetchMetadata; now: () => Date; lang: (c: Context<any>) => Lang; me: (c: Context<any>) => { id: string; display_name: string; token_hash: string; gate: "setup" | "verify" | null } | null;
  /** The club's texts, when it sends them: then the sign-in can be by a texted code too. */
  texter?: Texter | null; memberUrl?: string }

/** The pending consent screens: one per authorize request, for 10 minutes. */
const pending = new Map<string, { at: number; params: AuthorizeParams; clientName: string }>();
interface AuthorizeParams { client_id: string; redirect_uri: string; code_challenge: string; state?: string; scope: string; resource: string }

async function resolveClient(deps: OAuthDeps, clientId: string): Promise<{ client_id: string; name: string; redirect_uris: string[] }> {
  if (clientId.startsWith("https://")) {   // a published identity: the client id is its metadata document's URL
    const doc = await deps.fetchMetadata(clientId).catch(() => null) as any;
    if (!doc || doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) throw new KumiError("error.oauth_client", {}, 400);
    await deps.db.insertInto("oauth_client").values({ client_id: clientId, kind: "published", name: String(doc.client_name ?? new URL(clientId).host), redirect_uris: doc.redirect_uris, metadata: JSON.stringify(doc) })
      .onConflict((oc) => oc.column("client_id").doUpdateSet({ name: String(doc.client_name ?? new URL(clientId).host), redirect_uris: doc.redirect_uris, metadata: JSON.stringify(doc) })).execute();
    return { client_id: clientId, name: String(doc.client_name ?? new URL(clientId).host), redirect_uris: doc.redirect_uris };
  }
  const c = await deps.db.selectFrom("oauth_client").selectAll().where("client_id", "=", clientId).executeTakeFirst();
  if (!c) throw new KumiError("error.oauth_client", {}, 400);
  return { client_id: c.client_id, name: c.name ?? "An app", redirect_uris: c.redirect_uris };
}

function page(lang: Lang, title: string, body: unknown) {
  return html`<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;max-width:440px;margin:40px auto;padding:0 16px;background:#f6f6f2;color:#1d2a26}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #0B5A55}button.primary{background:#0B5A55;color:#fff}input{font:inherit;padding:8px;width:100%;box-sizing:border-box;margin:6px 0 12px}</style>
<body><h1 style="font-size:22px">${title}</h1>${body}</body></html>`;
}

export function oauthRoutes(deps: OAuthDeps) {
  const app = new Hono();
  const issuer = deps.publicUrl, resource = `${deps.publicUrl}/mcp`;
  const club = async () => (await deps.db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;

  const prm = async (c: Context) => c.json({ resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: await club() });
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-authorization-server", (c) => c.json({
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"], scopes_supported: [SCOPE], client_id_metadata_document_supported: true,
  }));

  app.post("/oauth/register", async (c) => {
    const b = await c.req.json().catch(() => ({})) as any;
    const uris: string[] = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || !uris.every(okRedirect)) return c.json({ error: "invalid_redirect_uri" }, 400);
    const method = ["none", "client_secret_basic", "client_secret_post"].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : "client_secret_basic";
    const clientId = `kc_${b64url(randomBytes(12))}`, secret = method === "none" ? null : b64url(randomBytes(24));
    await deps.db.insertInto("oauth_client").values({ client_id: clientId, kind: "registered", name: typeof b.client_name === "string" ? b.client_name.slice(0, 80) : null, redirect_uris: uris, auth_method: method, secret_hash: secret ? sha(secret) : null, metadata: JSON.stringify(b) }).execute();
    return c.json({ client_id: clientId, client_id_issued_at: Math.floor(deps.now().getTime() / 1000), redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: b.client_name, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) }, 201);
  });

  // The consent page. Not signed in: sign in by an emailed code first, on the same page, or a texted one when
  // the club texts. Only a number already confirmed on an account is ever texted here (no joining), so the page
  // needs no bot check for it; the club's limits on texts per number and per hour apply as everywhere.
  const phoneOn = () => phoneSignInOn(deps.texter ?? null);
  app.get("/oauth/authorize", async (c) => {
    const lang = deps.lang(c), q = c.req.query();
    if (q.response_type !== "code" || !q.client_id || !q.redirect_uri || !q.code_challenge || q.code_challenge_method !== "S256") throw new KumiError("error.oauth_request", {}, 400);
    if (q.resource && q.resource !== resource) throw new KumiError("error.oauth_request", {}, 400);
    const client = await resolveClient(deps, q.client_id);
    if (!client.redirect_uris.includes(q.redirect_uri)) throw new KumiError("error.oauth_client", {}, 400);
    const clubName = await club(), me = deps.me(c);
    if (!me) {
      const back = c.req.url, sent = Boolean(c.req.query("sent")), byPhone = c.req.query("by") === "phone" && phoneOn();
      const other = new URL(back); other.searchParams.delete("sent"); other.searchParams.delete("email"); other.searchParams.delete("phone");
      if (byPhone) other.searchParams.delete("by"); else other.searchParams.set("by", "phone");
      const code = html`<label>${t(lang, byPhone ? "consent.text_code_label" : "consent.code_label")}<input name="code" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code"></label><button class="primary">${t(lang, "consent.verify")}</button>`;
      return c.html(page(lang, t(lang, "consent.sign_in_first", { club: clubName }), html`
<form method="post" action="/oauth/sign-in"><input type="hidden" name="back" value="${back}">
${byPhone ? html`<label>${t(lang, "consent.phone_label")}<input name="phone" type="tel" required autocomplete="tel" value="${c.req.query("phone") ?? ""}"></label>`
  : html`<label>${t(lang, "consent.email_label")}<input name="email" type="email" required autocomplete="email" value="${c.req.query("email") ?? ""}"></label>`}
${sent ? code : html`<button class="primary">${t(lang, byPhone ? "consent.send_text" : "consent.send_code")}</button>`}</form>
${phoneOn() ? html`<p><a href="${other.pathname}${other.search}">${t(lang, byPhone ? "consent.use_email" : "consent.use_phone")}</a></p>` : ""}`));
    }
    // Signed in by emailed code, but this person signs in with two steps: the authenticator's code here, or
    // (with only a passkey, or nothing set up yet) the club's app first.
    if (me.gate) {
      if (me.gate === "verify" && await activeFactor(deps.db, me.id)) return c.html(page(lang, t(lang, "consent.two_step_title"), html`
<form method="post" action="/oauth/two-step"><input type="hidden" name="back" value="${c.req.url}">
<label>${t(lang, "consent.two_step_label")}<input name="code" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code"></label><button class="primary">${t(lang, "consent.verify")}</button></form>`));
      return c.html(page(lang, t(lang, "consent.two_step_title"), html`<p>${t(lang, "consent.two_step_in_app", { club: clubName })}</p>`));
    }
    const id = b64url(randomBytes(16));
    pending.set(id, { at: Date.now(), clientName: client.name, params: { client_id: client.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state, scope: SCOPE, resource } });
    const host = new URL(q.redirect_uri).host;
    return c.html(page(lang, t(lang, "consent.title", { client: client.name, club: clubName }), html`
<p>${t(lang, "consent.body", { client: client.name, host, club: clubName })}</p><p>${t(lang, "consent.signed_in_as", { name: me.display_name })}</p>
<form method="post" action="/oauth/decide"><input type="hidden" name="req" value="${id}">
<label>${t(lang, "consent.cap_label")}<select name="cap" style="font:inherit;padding:8px;width:100%;margin:6px 0 4px">${CAP_CHOICES.map((c) => html`<option value="${c}">${c ? money(c, lang) : t(lang, "consent.cap_none")}</option>`)}</select></label>
<p style="font-size:14px;color:#55605c">${t(lang, "consent.cap_note")}</p>
<button class="primary" name="decision" value="allow">${t(lang, "consent.allow")}</button> <button name="decision" value="deny">${t(lang, "consent.deny")}</button></form>`));
  });

  app.post("/oauth/sign-in", async (c) => {
    const f = await c.req.parseBody(), lang = deps.lang(c);
    const email = String(f.email ?? "");
    const u = new URL(String(f.back ?? ""), issuer);   // only ever back to this club's own consent page
    if (u.origin !== new URL(issuer).origin || u.pathname !== "/oauth/authorize") throw new KumiError("error.oauth_request", {}, 400);
    if (f.phone !== undefined) {
      if (!phoneOn()) throw new KumiError("error.phone_sign_in_off", {}, 409);
      const phone = usPhone(String(f.phone));
      if (!phone) throw new KumiError("error.phone_bad", {}, 400);
      if (!f.code) {
        // The same answer whether or not the number has an account; only an account's own number gets a text.
        await startPhoneSignIn(deps.db, deps.texter!, phone, lang, deps.now(), { signUp: false, memberUrl: deps.memberUrl });
        u.searchParams.set("sent", "1"); u.searchParams.set("phone", String(f.phone)); u.searchParams.set("by", "phone");
        return c.redirect(`${u.pathname}${u.search}`, 303);
      }
      const r = await verifyPhoneCode(deps.db, phone, String(f.code), c.req.header("user-agent") ?? null, deps.now(), { signUp: false });
      if (!("token" in r)) throw new KumiError("error.no_account", {}, 404);
      setCookie(c, "kumi_session", r.token, { httpOnly: true, secure: deps.secureCookies, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
      for (const k of ["sent", "phone", "by"]) u.searchParams.delete(k);
      return c.redirect(`${u.pathname}${u.search}`, 303);
    }
    if (!f.code) {
      // Connecting an agent needs an account already: joining the club happens in the app.
      await startEmailSignIn(deps.db, deps.mailer, email, lang, deps.now(), { signUp: false });
      u.searchParams.set("sent", "1"); u.searchParams.set("email", email);
      return c.redirect(`${u.pathname}${u.search}`, 303);
    }
    const r = await verifyEmailCode(deps.db, email, String(f.code), c.req.header("user-agent") ?? null, deps.now(), { signUp: false });
    if (!("token" in r)) throw new KumiError("error.no_account", {}, 404);
    setCookie(c, "kumi_session", r.token, { httpOnly: true, secure: deps.secureCookies, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    u.searchParams.delete("sent"); u.searchParams.delete("email");
    return c.redirect(`${u.pathname}${u.search}`, 303);
  });

  app.post("/oauth/two-step", async (c) => {
    const f = await c.req.parseBody(), me = deps.me(c);
    const u = new URL(String(f.back ?? ""), issuer);
    if (u.origin !== new URL(issuer).origin || u.pathname !== "/oauth/authorize") throw new KumiError("error.oauth_request", {}, 400);
    if (!me) throw new KumiError("error.signed_out", {}, 401);
    if (!(await useAuthenticatorCode(deps.db, me.id, String(f.code ?? ""), deps.now()))) throw new KumiError("error.bad_factor_code", {}, 401);
    await deps.db.updateTable("web_session").set({ second_factor: "totp" }).where("token_hash", "=", me.token_hash).execute();
    return c.redirect(`${u.pathname}${u.search}`, 303);
  });

  app.post("/oauth/decide", async (c) => {
    const f = await c.req.parseBody(), me = deps.me(c);
    const p = pending.get(String(f.req ?? ""));
    pending.delete(String(f.req ?? ""));
    if (!p || Date.now() - p.at > 600_000) throw new KumiError("error.oauth_expired", {}, 400);
    if (!me) throw new KumiError("error.signed_out", {}, 401);
    const u = new URL(p.params.redirect_uri);
    if (p.params.state) u.searchParams.set("state", p.params.state);
    u.searchParams.set("iss", issuer);
    if (f.decision !== "allow") { u.searchParams.set("error", "access_denied"); return c.redirect(u.toString(), 302); }
    const grantId = uuidv7(), code = b64url(randomBytes(24));
    const cap = Number(f.cap ?? 0);
    await deps.db.insertInto("oauth_grant").values({ id: grantId, person_id: me.id, client_id: p.params.client_id, scopes: [p.params.scope], revoked_at: null,
      weekly_cap_cents: CAP_CHOICES.includes(cap) ? cap : 0 }).execute();
    await deps.db.insertInto("oauth_code").values({ code_hash: sha(code), grant_id: grantId, redirect_uri: p.params.redirect_uri, code_challenge: p.params.code_challenge, resource: p.params.resource, expires_at: new Date(deps.now().getTime() + CODE_SECONDS * 1000), consumed_at: null }).execute();
    u.searchParams.set("code", code);
    return c.redirect(u.toString(), 302);
  });

  app.post("/oauth/token", async (c) => {
    const f = await c.req.parseBody();
    const err = (e: string, d?: string) => c.json({ error: e, ...(d ? { error_description: d } : {}) }, 400, { "cache-control": "no-store" });
    let clientId = String(f.client_id ?? ""), secret = f.client_secret ? String(f.client_secret) : null;
    const basic = c.req.header("authorization");
    if (basic?.startsWith("Basic ")) { const [id, s] = Buffer.from(basic.slice(6), "base64").toString().split(":"); clientId = decodeURIComponent(id ?? ""); secret = decodeURIComponent(s ?? ""); }
    const client = await deps.db.selectFrom("oauth_client").selectAll().where("client_id", "=", clientId).executeTakeFirst();
    if (!client) return err("invalid_client");
    if (client.secret_hash && (!secret || sha(secret) !== client.secret_hash)) return err("invalid_client");
    const now = deps.now();
    const issue = async (grantId: string, family: string) => {
      const access = b64url(randomBytes(32)), refresh = b64url(randomBytes(32));
      await deps.db.insertInto("oauth_token").values([
        { token_hash: sha(access), kind: "access", grant_id: grantId, family, resource, expires_at: new Date(now.getTime() + ACCESS_SECONDS * 1000), used_at: null, revoked_at: null },
        { token_hash: sha(refresh), kind: "refresh", grant_id: grantId, family, resource, expires_at: new Date(now.getTime() + REFRESH_DAYS * 864e5), used_at: null, revoked_at: null },
      ]).execute();
      return c.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE }, 200, { "cache-control": "no-store" });
    };
    if (f.grant_type === "authorization_code") {
      const row = await deps.db.selectFrom("oauth_code").innerJoin("oauth_grant", "oauth_grant.id", "oauth_code.grant_id").selectAll("oauth_code").select(["oauth_grant.client_id", "oauth_grant.revoked_at"])
        .where("oauth_code.code_hash", "=", sha(String(f.code ?? ""))).executeTakeFirst();
      if (!row || row.consumed_at || row.expires_at < now || row.revoked_at) return err("invalid_grant");
      if (row.client_id !== client.client_id) return err("invalid_grant", "code was issued to another client");
      if (f.redirect_uri && f.redirect_uri !== row.redirect_uri) return err("invalid_grant", "redirect_uri mismatch");
      if (f.resource && f.resource !== row.resource) return err("invalid_target");
      if (b64url(createHash("sha256").update(String(f.code_verifier ?? "")).digest()) !== row.code_challenge) return err("invalid_grant", "PKCE check failed");
      await deps.db.updateTable("oauth_code").set({ consumed_at: now }).where("code_hash", "=", row.code_hash).execute();
      return issue(row.grant_id, uuidv7());
    }
    if (f.grant_type === "refresh_token") {
      const row = await deps.db.selectFrom("oauth_token").innerJoin("oauth_grant", "oauth_grant.id", "oauth_token.grant_id").selectAll("oauth_token").select(["oauth_grant.client_id", "oauth_grant.revoked_at as grant_revoked"])
        .where("oauth_token.token_hash", "=", sha(String(f.refresh_token ?? ""))).where("oauth_token.kind", "=", "refresh").executeTakeFirst();
      if (!row || row.revoked_at || row.grant_revoked || row.expires_at < now || row.client_id !== client.client_id) return err("invalid_grant");
      if (row.used_at) {   // a stolen or replayed refresh token: end the whole chain
        await deps.db.updateTable("oauth_token").set({ revoked_at: now }).where("family", "=", row.family).execute();
        return err("invalid_grant", "refresh token reused");
      }
      await deps.db.updateTable("oauth_token").set({ used_at: now }).where("token_hash", "=", row.token_hash).execute();
      return issue(row.grant_id, row.family);
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return app;
}

/** The person behind a bearer token for this club's MCP address, or null. */
export async function bearerPerson(db: Db, header: string | undefined, resource: string, now: Date) {
  if (!header?.startsWith("Bearer ")) return null;
  const r = await db.selectFrom("oauth_token").innerJoin("oauth_grant", "oauth_grant.id", "oauth_token.grant_id").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id")
    .innerJoin("person", "person.id", "oauth_grant.person_id")
    .select(["person.id", "person.display_name", "person.locale", "oauth_client.name as client_name", "oauth_token.resource", "oauth_grant.id as grant_id"])
    .where("oauth_token.token_hash", "=", sha(header.slice(7))).where("oauth_token.kind", "=", "access").where("oauth_token.revoked_at", "is", null)
    .where("oauth_grant.revoked_at", "is", null).where("oauth_token.expires_at", ">", now).where("person.status", "!=", "archived").executeTakeFirst();
  return r && r.resource === resource ? r : null;
}
