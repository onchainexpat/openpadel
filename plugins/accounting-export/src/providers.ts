// Xero and QuickBooks Online: their OAuth 2.0 (authorization code with PKCE and state, refresh tokens that change on
// every use) and the one thing this plugin does there, a manual journal per club day, found again by its reference
// before anything is sent. Only their documented endpoints:
//   Xero: login.xero.com/identity/connect/authorize, identity.xero.com/connect/token, api.xero.com/connections,
//         api.xero.com/api.xro/2.0/ManualJournals (Xero-tenant-id; Idempotency-Key on the POST).
//   QuickBooks: appcenter.intuit.com/connect/oauth2, oauth.platform.intuit.com/oauth2/v1/tokens/bearer,
//         quickbooks.api.intuit.com/v3/company/<realm>/journalentry, /query and /companyinfo (requestid on the POST).
import { amount, keyOfDescription, toCents, type Journal } from "./books.ts";
import type { Fetch } from "./door.ts";
import type { ProviderKind } from "./store.ts";

export const PROVIDER_TIMEOUT_MS = 20_000;
/** Xero's scopes for a "Web app": a journal needs accounting.transactions. Xero apps made after March 2026 may be given
 *  granular scopes instead; XERO_SCOPES in the environment overrides this (README.md). */
export const XERO_SCOPES = "offline_access accounting.transactions accounting.settings.read";
export const QUICKBOOKS_SCOPES = "com.intuit.quickbooks.accounting";
export const QUICKBOOKS_MINOR = "75";
const RATE_RETRIES = 2, RATE_WAIT_MAX_S = 60;

export interface Endpoints { xeroLogin: string; xeroIdentity: string; xeroApi: string; qboAppcenter: string; qboOauth: string; qboApi: string }
export const ENDPOINTS: Endpoints = {
  xeroLogin: "https://login.xero.com", xeroIdentity: "https://identity.xero.com", xeroApi: "https://api.xero.com",
  qboAppcenter: "https://appcenter.intuit.com", qboOauth: "https://oauth.platform.intuit.com", qboApi: "https://quickbooks.api.intuit.com",
};

/** Why a call failed: rate (429 past its retries), down (5xx), network, auth (401/403: the access token or the
 *  connection), invalid_grant (the refresh token or code refused: connect again), rejected (anything else 4xx). */
export type ProviderErrorCode = "rate" | "down" | "network" | "auth" | "invalid_grant" | "rejected";
export class ProviderError extends Error {
  code: ProviderErrorCode; status: number; retryAfterMs: number | null;
  constructor(code: ProviderErrorCode, status: number, message: string, retryAfterMs: number | null = null) { super(message); this.code = code; this.status = status; this.retryAfterMs = retryAfterMs; }
}

export interface Http { fetch: Fetch; sleep: (ms: number) => Promise<void>; endpoints: Endpoints; scopes?: string | null }
export interface Tokens { access: string; refresh: string; expiresIn: number }
export interface Creds { id: string; secret: string }
export interface Ctx { access: string; tenant: string | null; realm: string | null }
/** A journal already at the provider for a day: n = 0 the day's own, n >= 1 its adjustments. */
export interface Found { n: number; lines: Record<string, number> }

export interface Provider {
  kind: ProviderKind;
  name: string;
  keys: { id: string; secret: string; refresh: string; realm?: string };
  authorizeUrl(clientId: string, redirect: string, state: string, challenge: string): string;
  exchange(code: string, verifier: string, redirect: string, c: Creds): Promise<Tokens>;
  refresh(token: string, c: Creds): Promise<Tokens>;
  /** The organisation's name, and Xero's tenant id. */
  org(ctx: Ctx): Promise<{ name: string | null; tenant: string | null }>;
  find(ctx: Ctx, day: string, refs: { original: string; adjustment: (n: number) => string }): Promise<Found[]>;
  post(ctx: Ctx, j: Journal): Promise<void>;
}

/** A short, safe piece of what a provider said, for the log and the card (never a token: their errors don't carry one). */
const said = (s: string) => s.replace(/[\u0000-\u001f]/g, " ").slice(0, 200);

async function call(h: Http, url: string, init: RequestInit & { form?: Record<string, string>; json?: unknown }, tokenEndpoint = false): Promise<any> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "openPadel-AccountingExport/0.1", ...(init.headers as Record<string, string> ?? {}) };
  let body: string | undefined;
  if (init.form) { body = new URLSearchParams(init.form).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
  else if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] = "application/json"; }
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try { r = await h.fetch(url, { method: init.method ?? "GET", headers, body, redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }); }
    catch (e) { throw new ProviderError("network", 0, `didn't answer: ${said((e as Error).message)}`); }
    const text = await r.text();
    if (r.status === 429) {
      const wait = Math.min(Math.max(Number(r.headers.get("retry-after") ?? 1) || 1, 1), RATE_WAIT_MAX_S) * 1000;
      if (attempt < RATE_RETRIES) { await h.sleep(wait); continue; }
      throw new ProviderError("rate", 429, "too many requests", wait);
    }
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (r.status >= 500) throw new ProviderError("down", r.status, `HTTP ${r.status}`);
    if (tokenEndpoint && r.status === 400 && /invalid_grant/.test(String(parsed?.error ?? text))) throw new ProviderError("invalid_grant", 400, "the grant was refused");
    if (r.status === 401 || r.status === 403) throw new ProviderError(tokenEndpoint ? "invalid_grant" : "auth", r.status, `HTTP ${r.status}`);
    if (r.status >= 400) {
      const why = parsed?.Message ?? parsed?.Elements?.[0]?.ValidationErrors?.[0]?.Message ?? parsed?.Fault?.Error?.[0]?.Detail ?? parsed?.Fault?.Error?.[0]?.Message ?? parsed?.error ?? `HTTP ${r.status}`;
      throw new ProviderError("rejected", r.status, said(String(why)));
    }
    if (parsed === null && text) throw new ProviderError("rejected", r.status, "answered with something other than JSON");
    return parsed;
  }
}
const basic = (c: Creds) => `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`;
function tokens(b: any): Tokens {
  if (typeof b?.access_token !== "string" || typeof b?.refresh_token !== "string") throw new ProviderError("rejected", 200, "no tokens in the answer");
  return { access: b.access_token, refresh: b.refresh_token, expiresIn: Number(b.expires_in) > 0 ? Number(b.expires_in) : 1800 };
}
const authorize = (base: string, q: Record<string, string>) => `${base}?${new URLSearchParams(q).toString()}`;

export function xero(h: Http): Provider {
  const e = h.endpoints;
  const api = (ctx: Ctx) => ({ authorization: `Bearer ${ctx.access}`, "xero-tenant-id": ctx.tenant ?? "" });
  return {
    kind: "xero", name: "Xero",
    keys: { id: "XERO_CLIENT_ID", secret: "XERO_CLIENT_SECRET", refresh: "XERO_REFRESH_TOKEN" },
    authorizeUrl: (clientId, redirect, state, challenge) => authorize(`${e.xeroLogin}/identity/connect/authorize`,
      { response_type: "code", client_id: clientId, redirect_uri: redirect, scope: h.scopes || XERO_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" }),
    async exchange(code, verifier, redirect, c) {
      return tokens(await call(h, `${e.xeroIdentity}/connect/token`, { method: "POST", headers: { authorization: basic(c) }, form: { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier } }, true));
    },
    async refresh(token, c) {
      return tokens(await call(h, `${e.xeroIdentity}/connect/token`, { method: "POST", headers: { authorization: basic(c) }, form: { grant_type: "refresh_token", refresh_token: token } }, true));
    },
    async org(ctx) {
      const list = await call(h, `${e.xeroApi}/connections`, { headers: { authorization: `Bearer ${ctx.access}` } });
      const t = (Array.isArray(list) ? list : []).find((x: any) => x?.tenantType === "ORGANISATION") ?? null;
      return { name: t?.tenantName ? String(t.tenantName) : null, tenant: t?.tenantId ? String(t.tenantId) : null };
    },
    async find(ctx, day, r) {
      const where = `Narration.StartsWith("${r.original}") OR Narration.StartsWith("${r.adjustment(0).replace(/#0$/, "#")}")`;
      const b = await call(h, `${e.xeroApi}/api.xro/2.0/ManualJournals?${new URLSearchParams({ where }).toString()}`, { headers: api(ctx) });
      const out: Found[] = [];
      for (const j of b?.ManualJournals ?? []) {
        if (["VOIDED", "DELETED"].includes(String(j?.Status ?? ""))) continue;
        const narration = String(j?.Narration ?? "");
        const adj = new RegExp(`^openPadel adjustment to ${day} #(\\d+)`).exec(narration);
        if (!adj && !narration.startsWith(`${r.original}`)) continue;
        let lines = j?.JournalLines;
        if (!Array.isArray(lines) && j?.ManualJournalID) lines = (await call(h, `${e.xeroApi}/api.xro/2.0/ManualJournals/${encodeURIComponent(j.ManualJournalID)}`, { headers: api(ctx) }))?.ManualJournals?.[0]?.JournalLines;
        const sums: Record<string, number> = {};
        for (const l of Array.isArray(lines) ? lines : []) { const k = keyOfDescription(l?.Description); if (k) sums[k] = (sums[k] ?? 0) + toCents(l?.LineAmount); }
        out.push({ n: adj ? Number(adj[1]) : 0, lines: sums });
      }
      return out;
    },
    async post(ctx, j) {
      await call(h, `${e.xeroApi}/api.xro/2.0/ManualJournals`, { method: "POST", headers: { ...api(ctx), "idempotency-key": j.idempotencyKey },
        json: { ManualJournals: [{ Narration: j.narration, Date: j.date, Status: "POSTED", LineAmountTypes: "NoTax",
          JournalLines: j.lines.map((l) => ({ LineAmount: amount(l.cents), AccountCode: l.account, Description: l.description })) }] } });
    },
  };
}

export function quickbooks(h: Http): Provider {
  const e = h.endpoints;
  const company = (ctx: Ctx) => `${e.qboApi}/v3/company/${encodeURIComponent(ctx.realm ?? "")}`;
  const auth = (ctx: Ctx) => ({ authorization: `Bearer ${ctx.access}` });
  const query = (ctx: Ctx, q: string) => call(h, `${company(ctx)}/query?${new URLSearchParams({ query: q, minorversion: QUICKBOOKS_MINOR }).toString()}`, { headers: auth(ctx) });
  const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return {
    kind: "quickbooks", name: "QuickBooks",
    keys: { id: "QUICKBOOKS_CLIENT_ID", secret: "QUICKBOOKS_CLIENT_SECRET", refresh: "QUICKBOOKS_REFRESH_TOKEN", realm: "QUICKBOOKS_COMPANY_ID" },
    authorizeUrl: (clientId, redirect, state, challenge) => authorize(`${e.qboAppcenter}/connect/oauth2`,
      { client_id: clientId, response_type: "code", scope: QUICKBOOKS_SCOPES, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256" }),
    async exchange(code, verifier, redirect, c) {
      return tokens(await call(h, `${e.qboOauth}/oauth2/v1/tokens/bearer`, { method: "POST", headers: { authorization: basic(c) }, form: { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier } }, true));
    },
    async refresh(token, c) {
      return tokens(await call(h, `${e.qboOauth}/oauth2/v1/tokens/bearer`, { method: "POST", headers: { authorization: basic(c) }, form: { grant_type: "refresh_token", refresh_token: token } }, true));
    },
    async org(ctx) {
      const b = await call(h, `${company(ctx)}/companyinfo/${encodeURIComponent(ctx.realm ?? "")}?minorversion=${QUICKBOOKS_MINOR}`, { headers: auth(ctx) });
      return { name: b?.CompanyInfo?.CompanyName ? String(b.CompanyInfo.CompanyName) : null, tenant: null };
    },
    async find(ctx, _day, r) {
      const docs = [r.original, ...Array.from({ length: 9 }, (_, i) => r.adjustment(i + 1))];
      const b = await query(ctx, `select * from JournalEntry where DocNumber in (${docs.map(quote).join(", ")})`);
      const out: Found[] = [];
      for (const j of b?.QueryResponse?.JournalEntry ?? []) {
        const n = docs.indexOf(String(j?.DocNumber ?? ""));
        if (n < 0) continue;
        const sums: Record<string, number> = {};
        for (const l of Array.isArray(j?.Line) ? j.Line : []) {
          const k = keyOfDescription(l?.Description);
          if (!k) continue;
          const c = toCents(l?.Amount);
          sums[k] = (sums[k] ?? 0) + (l?.JournalEntryLineDetail?.PostingType === "Credit" ? -c : c);
        }
        out.push({ n, lines: sums });
      }
      return out;
    },
    async post(ctx, j) {
      // Each setting is matched to an account by its number, then its name, then its id.
      const b = await query(ctx, "select Id, Name, AcctNum, Active from Account maxresults 1000");
      const accounts: { Id: string; Name?: string; AcctNum?: string }[] = b?.QueryResponse?.Account ?? [];
      const ref = (code: string) => {
        const lc = code.toLowerCase();
        const a = accounts.find((x) => x.AcctNum && x.AcctNum === code) ?? accounts.find((x) => (x.Name ?? "").toLowerCase() === lc) ?? accounts.find((x) => String(x.Id) === code);
        if (!a) throw new ProviderError("rejected", 400, `no account ${code} in QuickBooks`);
        return { value: String(a.Id), name: a.Name };
      };
      const lines = j.lines.map((l) => ({ Amount: amount(Math.abs(l.cents)), DetailType: "JournalEntryLineDetail", Description: l.description,
        JournalEntryLineDetail: { PostingType: l.cents > 0 ? "Debit" : "Credit", AccountRef: ref(l.account) } }));
      await call(h, `${company(ctx)}/journalentry?${new URLSearchParams({ minorversion: QUICKBOOKS_MINOR, requestid: j.idempotencyKey }).toString()}`, { method: "POST", headers: auth(ctx),
        json: { DocNumber: j.ref, TxnDate: j.date, PrivateNote: j.narration, Line: lines } });
    },
  };
}

export function providerFor(kind: ProviderKind, h: Http): Provider { return kind === "quickbooks" ? quickbooks(h) : xero(h); }
