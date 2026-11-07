// OAuth 2.1 for the MCP door (spikes/mcp_signin.md): Claude's published identity (a client
// metadata document) and dynamic registration, PKCE S256, tokens bound to this club's MCP
// address, refresh tokens that rotate, and a reused refresh token revokes its whole family.
import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { setSession } from "./session_cookie.ts";
import { money, t, type Lang } from "@kumi/i18n";
import { activeFactor, KumiError, supportOnly, textablePhone, useAuthenticatorCode, uuidv7, type Db, type Texter, type Trx } from "@kumi/core";
import { phoneSignInOn, startEmailSignIn, startPhoneSignIn, verifyEmailCode, verifyPhoneCode } from "./auth.ts";
import type { Mailer } from "./mailer.ts";
import { RateLimiter } from "./limits.ts";

export const ACCESS_SECONDS = 3600, REFRESH_DAYS = 30, CODE_SECONDS = 300, SCOPE = "kumi", REGISTER_BYTES = 16_384, UNUSED_CLIENT_DAYS = 7;
/** A sign-in from a device with no browser of its own (RFC 8628): how long its code waits, and how often it may ask. */
export const DEVICE_SECONDS = 600, DEVICE_INTERVAL = 5, DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";   // no vowels, so a code never spells a word; no look-alike digits
export const userCodeOf = (raw: string) => raw.toUpperCase().replace(/[^A-Z]/g, "");
/** What a person can let an assistant spend for them a week, chosen as they connect it ($0 unless they pick more;
 *  any amount up to $500 later, in the app). */
export const CAP_CHOICES = [0, 2500, 5000, 10000, 20000];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
export type FetchMetadata = (url: string) => Promise<unknown>;

// A client's metadata document is fetched from an address anyone can name before signing in, so the fetch must
// never reach this server's own network (loopback, private ranges, link-local and the cloud metadata address),
// read only so much, and take only so long.
const NOT_PUBLIC_V4 = new BlockList(), NOT_PUBLIC_V6 = new BlockList();
for (const [a, n] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NOT_PUBLIC_V4.addSubnet(a, n, "ipv4");
for (const [a, n] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) NOT_PUBLIC_V6.addSubnet(a, n, "ipv6");
/** An IPv4 address written as IPv6 (::ffff:10.0.0.1, or ::ffff:a00:1 as URLs print it) is judged as the IPv4 one. */
function mappedV4(a: string): string | null {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(a);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16), lo = parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}
export function publicAddress(address: string): boolean {
  const f = isIP(address);
  if (f === 4) return !NOT_PUBLIC_V4.check(address, "ipv4");
  if (f !== 6) return false;
  const v4 = mappedV4(address);
  return v4 ? !NOT_PUBLIC_V4.check(v4, "ipv4") : !NOT_PUBLIC_V6.check(address, "ipv6");
}
type Resolve = (host: string, cb: (err: Error | null, addrs: LookupAddress[]) => void) => void;
const resolveAll: Resolve = (host, cb) => dnsLookup(host, { all: true }, cb);
/** A lookup for the connection itself that refuses any name with a non-public address among its answers: the
 *  address checked is the one connected to, so a name can't answer one thing to the check and another to the
 *  connection (DNS rebinding). */
export function publicOnlyLookup(resolve: Resolve = resolveAll) {
  return (host: string, opts: { all?: boolean }, cb: (...a: any[]) => void) => resolve(host, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || !addrs.every((a) => publicAddress(a.address))) return cb(Object.assign(new Error(`${host} isn't a public address`), { code: "ENOTPUBLIC" }));
    return opts.all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}
/** Read a response body, stopping (and failing) as soon as it's longer than `max` bytes. */
export function readCapped(body: Readable, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let n = 0;
    body.on("data", (d: Buffer) => { n += d.length; if (n > max) { body.destroy(); reject(new Error("too large")); } else parts.push(d); });
    body.on("end", () => resolve(Buffer.concat(parts)));
    body.on("error", reject);
  });
}
export const METADATA_MAX_BYTES = 64 * 1024;
export const defaultFetchMetadata: FetchMetadata = (url) => new Promise((resolve, reject) => {
  let u: URL;
  try { u = new URL(url); } catch { return reject(new Error("not a URL")); }
  if (u.protocol !== "https:") return reject(new Error("https only"));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host)) return reject(new Error(`${host} isn't a public address`));   // no lookup for a bare address
  const req = httpsRequest(u, { method: "GET", headers: { accept: "application/json", "accept-encoding": "identity" }, lookup: publicOnlyLookup() as any }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }   // redirects aren't followed
    if (Number(res.headers["content-length"] ?? 0) > METADATA_MAX_BYTES) { res.destroy(); return reject(new Error("too large")); }
    readCapped(res, METADATA_MAX_BYTES).then((b) => { clearTimeout(timer); resolve(JSON.parse(b.toString("utf8"))); }).catch(reject);
  });
  const timer = setTimeout(() => req.destroy(new Error("took too long")), 5000);
  req.on("error", (e) => { clearTimeout(timer); reject(e); });
  req.end();
});

function okRedirect(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)); }
  catch { return false; }
}

export interface OAuthDeps { db: Db; mailer: Mailer; publicUrl: string; secureCookies: boolean; fetchMetadata: FetchMetadata; now: () => Date; lang: (c: Context<any>) => Lang; me: (c: Context<any>) => { id: string; display_name: string; token_hash: string; gate: "setup" | "verify" | null } | null;
  /** The club's texts, when it sends them: then the sign-in can be by a texted code too. */
  texter?: Texter | null; memberUrl?: string;
  /** Wrong second-step codes per person: the same count as the apps' sign-in (two_factor.ts). */
  secondStepTries?: RateLimiter }

/** The club's own /mcp addresses: the staff app's (where the sign-in server lives) and the members' app's.
 *  Both are this one server, so a token for either works at both; each address names itself as the resource
 *  (RFC 9728), since an assistant checks that the resource it's told matches the address it was given. */
export function mcpResources(publicUrl: string, memberUrl?: string): string[] {
  return [...new Set([publicUrl, memberUrl ?? publicUrl])].map((u) => `${u}/mcp`);
}
/** The /mcp address a request came in on: the members' app's on its host, the staff app's otherwise. */
export function mcpResourceOf(resources: string[], requestUrl: string): string {
  const host = new URL(requestUrl).host;
  return resources.find((r) => new URL(r).host === host) ?? resources[0]!;
}

/** The pending consent screens: one per authorize request, for 10 minutes. */
const pending = new Map<string, { at: number; params: AuthorizeParams; clientName: string; published?: Client }>();
type Client = { client_id: string; name: string; redirect_uris: string[]; metadata?: unknown };
/** Published identities fetched lately (per server), so the consent page's own reloads don't fetch again. Kept in
 *  memory, a few hundred at most: a client is saved in the database only once someone allows it. */
type Fetched = Map<string, { at: number; client: Client }>;
interface AuthorizeParams { client_id: string; redirect_uri: string; code_challenge: string; state?: string; scope: string; resource: string }

async function resolveClient(deps: OAuthDeps, fetched: Fetched, clientId: string): Promise<Client & { published: boolean }> {
  if (clientId.startsWith("https://")) {   // a published identity: the client id is its metadata document's URL
    const known = fetched.get(clientId);
    if (known && Date.now() - known.at < 600_000) return { ...known.client, published: true };
    const doc = await deps.fetchMetadata(clientId).catch(() => null) as any;
    if (!doc || doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((u: unknown) => typeof u === "string")) throw new KumiError("error.oauth_client", {}, 400);
    const client: Client = { client_id: clientId, name: String(doc.client_name ?? new URL(clientId).host).slice(0, 80), redirect_uris: doc.redirect_uris, metadata: doc };
    fetched.set(clientId, { at: Date.now(), client });
    if (fetched.size > 300) fetched.delete(fetched.keys().next().value!);
    return { ...client, published: true };
  }
  const c = await deps.db.selectFrom("oauth_client").selectAll().where("client_id", "=", clientId).executeTakeFirst();
  if (!c) throw new KumiError("error.oauth_client", {}, 400);
  return { client_id: c.client_id, name: c.name ?? "An app", redirect_uris: c.redirect_uris, published: false };
}
/** A published client is saved when someone allows it (its grant refers to it), not when anyone names it. */
async function saveClient(db: Db, c: Client) {
  const v = { name: c.name, redirect_uris: c.redirect_uris, metadata: JSON.stringify(c.metadata ?? {}) };
  await db.insertInto("oauth_client").values({ client_id: c.client_id, kind: "published", ...v }).onConflict((oc) => oc.column("client_id").doUpdateSet(v)).execute();
}

function page(lang: Lang, title: string, body: unknown) {
  return html`<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;max-width:440px;margin:40px auto;padding:0 16px;background:#f6f6f2;color:#1d2a26}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #0B5A55}button.primary{background:#0B5A55;color:#fff}input{font:inherit;padding:8px;width:100%;box-sizing:border-box;margin:6px 0 12px}</style>
<body><h1 style="font-size:22px">${title}</h1>${body}</body></html>`;
}

export function oauthRoutes(deps: OAuthDeps) {
  const app = new Hono();
  const issuer = deps.publicUrl, resources = mcpResources(deps.publicUrl, deps.memberUrl);
  const secondStep = deps.secondStepTries ?? new RateLimiter(5, 15 * 60_000);
  const fetched: Fetched = new Map();
  const club = async () => (await deps.db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;

  const prm = async (c: Context) => c.json({ resource: mcpResourceOf(resources, c.req.url), authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: await club() });
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-authorization-server", (c) => c.json({
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`,
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"], scopes_supported: [SCOPE], client_id_metadata_document_supported: true,
  }));

  // Anyone may register (RFC 7591), so it's kept small: a few kilobytes asked, and only what's used is kept.
  app.post("/oauth/register", async (c) => {
    const raw = await c.req.text().catch(() => "");
    if (raw.length > REGISTER_BYTES) return c.json({ error: "invalid_client_metadata", error_description: "too large" }, 413);
    let b: any = {};
    try { b = JSON.parse(raw || "{}"); } catch { b = {}; }
    const uris: string[] = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000 && okRedirect(u))) return c.json({ error: "invalid_redirect_uri" }, 400);
    const method = ["none", "client_secret_basic", "client_secret_post"].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : "client_secret_basic";
    const clientId = `kc_${b64url(randomBytes(12))}`, secret = method === "none" ? null : b64url(randomBytes(24));
    const name = typeof b.client_name === "string" ? b.client_name.slice(0, 80) : null;
    const kept = { client_name: name, ...(typeof b.client_uri === "string" ? { client_uri: b.client_uri.slice(0, 500) } : {}), ...(typeof b.software_id === "string" ? { software_id: b.software_id.slice(0, 100) } : {}) };
    await deps.db.insertInto("oauth_client").values({ client_id: clientId, kind: "registered", name, redirect_uris: uris, auth_method: method, secret_hash: secret ? sha(secret) : null, metadata: JSON.stringify(kept) }).execute();
    return c.json({ client_id: clientId, client_id_issued_at: Math.floor(deps.now().getTime() / 1000), redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: name ?? undefined, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) }, 201);
  });

  // The consent page. Not signed in: sign in by an emailed code first, on the same page, or a texted one when
  // the club texts. Only a number already confirmed on an account is ever texted here (no joining), so the page
  // needs no bot check for it; the club's limits on texts per number and per hour apply as everywhere.
  const phoneOn = () => phoneSignInOn(deps.texter ?? null);
  /** What comes before a consent screen (the assistant's or a device's): signing in, by an emailed code or (when the
   *  club texts) a texted one; then the second step for someone who signs in with two; and no consent at all for an
   *  account made only for support access. Null once the person may see the consent screen. */
  async function beforeConsent(c: Context, lang: Lang, clubName: string, me: ReturnType<OAuthDeps["me"]>): Promise<Response | null> {
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
    // An account made only for support access has nothing of its own for an assistant, and support access is never
    // through one (support.ts): no consent screen for it.
    if (await supportOnly(deps.db, me.id)) return c.html(page(lang, t(lang, "consent.support_title"), html`<p>${t(lang, "consent.support_only", { club: clubName })}</p>`), 403);
    return null;
  }
  /** The sign-in and second-step forms go back only to this club's own consent screens. */
  const backTo = (raw: unknown) => {
    const u = new URL(String(raw ?? ""), issuer);
    if (u.origin !== new URL(issuer).origin || (u.pathname !== "/oauth/authorize" && u.pathname !== "/oauth/device")) throw new KumiError("error.oauth_request", {}, 400);
    return u;
  };
  app.get("/oauth/authorize", async (c) => {
    const lang = deps.lang(c), q = c.req.query();
    if (q.response_type !== "code" || !q.client_id || !q.redirect_uri || !q.code_challenge || q.code_challenge_method !== "S256") throw new KumiError("error.oauth_request", {}, 400);
    if (q.resource && !resources.includes(q.resource)) throw new KumiError("error.oauth_request", {}, 400);
    const client = await resolveClient(deps, fetched, q.client_id);
    if (!client.redirect_uris.includes(q.redirect_uri)) throw new KumiError("error.oauth_client", {}, 400);
    const clubName = await club(), me = deps.me(c);
    const first = await beforeConsent(c, lang, clubName, me);
    if (first || !me) return first!;
    const id = b64url(randomBytes(16));
    pending.set(id, { at: Date.now(), clientName: client.name, published: client.published ? client : undefined, params: { client_id: client.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state, scope: SCOPE, resource: q.resource || resources[0]! } });
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
    const u = backTo(f.back);   // only ever back to this club's own consent page
    if (f.phone !== undefined) {
      if (!phoneOn()) throw new KumiError("error.phone_sign_in_off", {}, 409);
      const phone = textablePhone(String(f.phone));
      if (!phone) throw new KumiError("error.phone_bad", {}, 400);
      if (!f.code) {
        // The same answer whether or not the number has an account; only an account's own number gets a text.
        await startPhoneSignIn(deps.db, deps.texter!, phone, lang, deps.now(), { signUp: false, memberUrl: deps.memberUrl });
        u.searchParams.set("sent", "1"); u.searchParams.set("phone", String(f.phone)); u.searchParams.set("by", "phone");
        return c.redirect(`${u.pathname}${u.search}`, 303);
      }
      const r = await verifyPhoneCode(deps.db, phone, String(f.code), c.req.header("user-agent") ?? null, deps.now(), { signUp: false });
      if (!("token" in r)) throw new KumiError("error.no_account", {}, 404);
      setSession(c, r.token, { secure: deps.secureCookies, legacy: false });
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
    setSession(c, r.token, { secure: deps.secureCookies, legacy: false });
    u.searchParams.delete("sent"); u.searchParams.delete("email");
    return c.redirect(`${u.pathname}${u.search}`, 303);
  });

  app.post("/oauth/two-step", async (c) => {
    const f = await c.req.parseBody(), me = deps.me(c);
    const u = backTo(f.back);
    if (!me) throw new KumiError("error.signed_out", {}, 401);
    if (!secondStep.take(me.id, deps.now().getTime())) throw new KumiError("error.too_many_attempts", {}, 429);
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
    if (await supportOnly(deps.db, me.id)) throw new KumiError("error.support_no_assistant", {}, 403);
    const u = new URL(p.params.redirect_uri);
    if (p.params.state) u.searchParams.set("state", p.params.state);
    u.searchParams.set("iss", issuer);
    if (f.decision !== "allow") { u.searchParams.set("error", "access_denied"); return c.redirect(u.toString(), 302); }
    const grantId = uuidv7(), code = b64url(randomBytes(24));
    const cap = Number(f.cap ?? 0);
    if (p.published) await saveClient(deps.db, p.published);
    await deps.db.insertInto("oauth_grant").values({ id: grantId, person_id: me.id, client_id: p.params.client_id, scopes: [p.params.scope], revoked_at: null,
      weekly_cap_cents: CAP_CHOICES.includes(cap) ? cap : 0 }).execute();
    await deps.db.insertInto("oauth_code").values({ code_hash: sha(code), grant_id: grantId, redirect_uri: p.params.redirect_uri, code_challenge: p.params.code_challenge, resource: p.params.resource, expires_at: new Date(deps.now().getTime() + CODE_SECONDS * 1000), consumed_at: null }).execute();
    u.searchParams.set("code", code);
    return c.redirect(u.toString(), 302);
  });

  // ---- A device with no browser of its own (RFC 8628): the command line on a server, or an agent's machine ----
  // The device asks for a code and shows it with this address; the person opens it on their phone or computer, signs
  // in as on the consent page, checks the code matches and allows it, with the same weekly limit; the device, asking
  // every few seconds, then gets its tokens. Kept in memory, ten minutes each, as the consent screens are.
  type Device = { at: number; clientId: string; clientName: string; userCode: string; resource: string; status: "waiting" | "allowed" | "denied"; grantId?: string; polled: number; interval: number;
    /** The consent screen shown, and to whom: its answer must carry this, as the assistant's consent does (req). */
    consent?: { id: string; personId: string } };
  const devices = new Map<string, Device>(), byUserCode = new Map<string, string>();
  const tidyDevices = () => {
    for (const [k, d] of devices) if (Date.now() - d.at > DEVICE_SECONDS * 1000) { devices.delete(k); byUserCode.delete(d.userCode); }
  };
  const deviceOf = (raw: string | undefined) => {
    tidyDevices();
    const k = byUserCode.get(userCodeOf(raw ?? ""));
    return k ? { key: k, d: devices.get(k)! } : null;
  };
  const shownCode = (u: string) => `${u.slice(0, 4)}-${u.slice(4)}`;

  app.post("/oauth/device_authorization", async (c) => {
    const f = await c.req.parseBody();
    const client = await deps.db.selectFrom("oauth_client").select(["client_id", "name"]).where("client_id", "=", String(f.client_id ?? "")).executeTakeFirst();
    if (!client) return c.json({ error: "invalid_client" }, 400);
    const resource = f.resource ? String(f.resource) : resources[0]!;
    if (!resources.includes(resource)) return c.json({ error: "invalid_target" }, 400);
    tidyDevices();
    if (devices.size >= 500) return c.json({ error: "slow_down" }, 429);
    const deviceCode = b64url(randomBytes(32));
    let userCode = "";
    do userCode = Array.from(randomBytes(8), (b) => USER_CODE_LETTERS[b % USER_CODE_LETTERS.length]).join(""); while (byUserCode.has(userCode));
    devices.set(sha(deviceCode), { at: Date.now(), clientId: client.client_id, clientName: client.name ?? "An app", userCode, resource, status: "waiting", polled: 0, interval: DEVICE_INTERVAL });
    byUserCode.set(userCode, sha(deviceCode));
    return c.json({ device_code: deviceCode, user_code: shownCode(userCode), verification_uri: `${issuer}/oauth/device`, verification_uri_complete: `${issuer}/oauth/device?code=${shownCode(userCode)}`,
      expires_in: DEVICE_SECONDS, interval: DEVICE_INTERVAL }, 200, { "cache-control": "no-store" });
  });

  app.get("/oauth/device", async (c) => {
    const lang = deps.lang(c), clubName = await club(), raw = c.req.query("code");
    const enter = (note?: string) => c.html(page(lang, t(lang, "consent.device_enter_title", { club: clubName }), html`${note ? html`<p>${note}</p>` : ""}
<form method="get" action="/oauth/device"><label>${t(lang, "consent.device_enter_label")}<input name="code" required autocomplete="off" autocapitalize="characters"></label><button class="primary">${t(lang, "consent.device_continue")}</button></form>`));
    if (!raw) return enter();
    const found = deviceOf(raw);
    if (!found || found.d.status !== "waiting") return enter(t(lang, "consent.device_unknown"));
    const me = deps.me(c);
    const first = await beforeConsent(c, lang, clubName, me);
    if (first || !me) return first!;
    found.d.consent = { id: b64url(randomBytes(16)), personId: me.id };
    return c.html(page(lang, t(lang, "consent.title", { client: found.d.clientName, club: clubName }), html`
<p>${t(lang, "consent.device_body", { client: found.d.clientName, club: clubName })}</p>
<p style="font-size:28px;letter-spacing:4px;font-weight:600">${shownCode(found.d.userCode)}</p>
<p>${t(lang, "consent.signed_in_as", { name: me.display_name })}</p>
<form method="post" action="/oauth/device/decide"><input type="hidden" name="code" value="${found.d.userCode}"><input type="hidden" name="req" value="${found.d.consent.id}">
<label>${t(lang, "consent.cap_label")}<select name="cap" style="font:inherit;padding:8px;width:100%;margin:6px 0 4px">${CAP_CHOICES.map((x) => html`<option value="${x}">${x ? money(x, lang) : t(lang, "consent.cap_none")}</option>`)}</select></label>
<p style="font-size:14px;color:#55605c">${t(lang, "consent.cap_note")}</p>
<button class="primary" name="decision" value="allow">${t(lang, "consent.allow")}</button> <button name="decision" value="deny">${t(lang, "consent.deny")}</button></form>`));
  });

  app.post("/oauth/device/decide", async (c) => {
    const f = await c.req.parseBody(), me = deps.me(c), lang = deps.lang(c);
    const found = deviceOf(String(f.code ?? ""));
    if (!found || found.d.status !== "waiting") throw new KumiError("error.oauth_expired", {}, 400);
    if (!me || me.gate) throw new KumiError("error.signed_out", {}, 401);
    // Only the answer to the consent screen this person was shown: never a form posted from anywhere else.
    if (!found.d.consent || found.d.consent.id !== String(f.req ?? "") || found.d.consent.personId !== me.id) throw new KumiError("error.oauth_expired", {}, 400);
    if (await supportOnly(deps.db, me.id)) throw new KumiError("error.support_no_assistant", {}, 403);
    if (f.decision !== "allow") {
      found.d.status = "denied";
      return c.html(page(lang, t(lang, "consent.device_denied_title"), html`<p>${t(lang, "consent.device_denied", { client: found.d.clientName })}</p>`));
    }
    const grantId = uuidv7(), cap = Number(f.cap ?? 0);
    await deps.db.insertInto("oauth_grant").values({ id: grantId, person_id: me.id, client_id: found.d.clientId, scopes: [SCOPE], revoked_at: null,
      weekly_cap_cents: CAP_CHOICES.includes(cap) ? cap : 0 }).execute();
    found.d.status = "allowed"; found.d.grantId = grantId;
    return c.html(page(lang, t(lang, "consent.device_done_title"), html`<p>${t(lang, "consent.device_done", { client: found.d.clientName })}</p>`));
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
    const issue = async (grantId: string, family: string, resource: string, q: Db | Trx = deps.db) => {
      const access = b64url(randomBytes(32)), refresh = b64url(randomBytes(32));
      await q.insertInto("oauth_token").values([
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
      // Used up in one step: of two redemptions at once, only one gets tokens.
      const used = await deps.db.updateTable("oauth_code").set({ consumed_at: now }).where("code_hash", "=", row.code_hash).where("consumed_at", "is", null).returning("code_hash").executeTakeFirst();
      if (!used) return err("invalid_grant");
      return issue(row.grant_id, uuidv7(), row.resource);
    }
    if (f.grant_type === "refresh_token") {
      const row = await deps.db.selectFrom("oauth_token").innerJoin("oauth_grant", "oauth_grant.id", "oauth_token.grant_id").selectAll("oauth_token").select(["oauth_grant.client_id", "oauth_grant.revoked_at as grant_revoked"])
        .where("oauth_token.token_hash", "=", sha(String(f.refresh_token ?? ""))).where("oauth_token.kind", "=", "refresh").executeTakeFirst();
      if (!row || row.revoked_at || row.grant_revoked || row.expires_at < now || row.client_id !== client.client_id) return err("invalid_grant");
      // One refresh of a token at a time (its row locked): a stolen or replayed one, or a second made at the same
      // moment, finds it used and ends the whole chain, the tokens the first one just got included.
      return deps.db.transaction().execute(async (trx) => {
        const t = await trx.selectFrom("oauth_token").select(["used_at", "revoked_at"]).where("token_hash", "=", row.token_hash).forUpdate().executeTakeFirst();
        if (!t || t.revoked_at) return err("invalid_grant");
        if (t.used_at) {
          await trx.updateTable("oauth_token").set({ revoked_at: now }).where("family", "=", row.family).execute();
          return err("invalid_grant", "refresh token reused");
        }
        await trx.updateTable("oauth_token").set({ used_at: now }).where("token_hash", "=", row.token_hash).execute();
        return issue(row.grant_id, row.family, row.resource, trx);
      });
    }
    if (f.grant_type === DEVICE_GRANT) {
      // RFC 8628 3.5: waiting, asked too often, said no, or gone; or the tokens, once.
      const key = sha(String(f.device_code ?? "")), d = devices.get(key);
      if (!d || Date.now() - d.at > DEVICE_SECONDS * 1000) { if (d) { devices.delete(key); byUserCode.delete(d.userCode); } return err("expired_token"); }
      if (d.clientId !== client.client_id) return err("invalid_grant");
      if (d.status === "denied") { devices.delete(key); byUserCode.delete(d.userCode); return err("access_denied"); }
      if (d.status === "waiting") {
        const early = Date.now() - d.polled < d.interval * 1000;
        d.polled = Date.now();
        if (early) { d.interval += 5; return err("slow_down"); }
        return err("authorization_pending");
      }
      devices.delete(key); byUserCode.delete(d.userCode);
      return issue(d.grantId!, uuidv7(), d.resource);
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return app;
}

/** The person behind a bearer token for one of this club's MCP addresses, or null. */
export async function bearerPerson(db: Db, header: string | undefined, resources: string[], now: Date) {
  if (!header?.startsWith("Bearer ")) return null;
  const r = await db.selectFrom("oauth_token").innerJoin("oauth_grant", "oauth_grant.id", "oauth_token.grant_id").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id")
    .innerJoin("person", "person.id", "oauth_grant.person_id")
    .select(["person.id", "person.display_name", "person.locale", "person.created_via", "oauth_client.name as client_name", "oauth_token.resource", "oauth_grant.id as grant_id"])
    .where("oauth_token.token_hash", "=", sha(header.slice(7))).where("oauth_token.kind", "=", "access").where("oauth_token.revoked_at", "is", null)
    .where("oauth_grant.revoked_at", "is", null).where("oauth_token.expires_at", ">", now).where("person.status", "!=", "archived").executeTakeFirst();
  if (!r || !resources.includes(r.resource)) return null;
  // One connected before support-only accounts were refused at the consent screen is refused here.
  if (r.created_via === "support" && await supportOnly(db, r.id)) return null;
  return r;
}

/** What sign-in leaves behind, tidied: codes and passkey challenges a day past their end, and assistants that
 *  registered (or were looked up) a week ago and were never connected. Rows still counted by the hourly limits
 *  are hours old at most, so nothing a limit needs goes. */
export async function tidySignIns(db: Db, now = new Date()): Promise<{ challenges: number; clients: number }> {
  const challenges = await db.deleteFrom("auth_challenge").where("expires_at", "<", new Date(now.getTime() - 864e5)).executeTakeFirst();
  const clients = await db.deleteFrom("oauth_client").where("created_at", "<", new Date(now.getTime() - UNUSED_CLIENT_DAYS * 864e5))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("oauth_grant").select("oauth_grant.id").whereRef("oauth_grant.client_id", "=", "oauth_client.client_id")))).executeTakeFirst();
  return { challenges: Number(challenges.numDeletedRows), clients: Number(clients.numDeletedRows) };
}
