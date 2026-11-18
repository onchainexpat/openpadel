// A fake club (its signing key, a door answering what the plugin uses, signed registration, events and callbacks), a
// fake Xero and a fake QuickBooks Online, all on 127.0.0.1, for the plugin's tests.
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export const TZ = "America/Los_Angeles";
/** An instant at the club (PST, UTC-8, in November). */
export const at = (ymd: string, hh: number, mm = 0) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return Date.UTC(y, m - 1, d, hh + 8, mm); };

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
}
function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => r(b)); });
}
export const KEPT = ["XERO_REFRESH_TOKEN", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_COMPANY_ID"];
const DECLARED = ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", ...KEPT];

export async function fakeClub(name = "Kestrel Padel") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const state = {
    settings: {} as Record<string, unknown>,
    vault: new Map<string, string>(),
    /** Each day's book lines, by date. A day not here has none. */
    days: new Map<string, { key: string; cents: number }[]>(),
    today: "2026-11-17",
    cards: true, down: false, keepDown: false,
    /** Days whose Stripe fees and payouts the club couldn't read (money_books says "error"). */
    stripeDown: new Set<string>(),
    token: "opa_" + randomBytes(24).toString("base64url"),
    webhookSecret: "whsec_" + randomBytes(24).toString("base64url"),
    hookSecret: "opps_" + randomBytes(24).toString("base64url"),
    calls: [] as { tool: string; args: any }[],
    kept: [] as { name: string; value: string }[],
    shown: new Map<string, any>(),
  };
  const ok = (id: unknown, v: unknown) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(v) }] } });
  const err = (id: unknown, code: string, text: string) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }], _meta: { "kumi/error": code } } });
  let runs = 0;
  const pending = new Map<string, { tool: string; args: any }>();
  const server = createServer(async (req, res) => {
    const body = await readAll(req);
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.url === "/.well-known/openpadel-plugin-key") return json(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "openpadel-plugin-1" }] });
    if (req.url !== "/mcp" || req.method !== "POST") return json(404, {});
    if (state.down) return json(502, { error: "down" });
    if (req.headers.authorization !== `Bearer ${state.token}`) return json(401, { error: "signed_out" });
    const rpc = JSON.parse(body), tool: string = rpc.params?.name, args = rpc.params?.arguments ?? {};
    state.calls.push({ tool, args: tool.startsWith("plugin_secret_keep") ? { name: args.name } : args });
    switch (tool) {
      case "plugin_settings": return json(200, ok(rpc.id, { name: "accounting-export", status: "on", settings: state.settings,
        keys: DECLARED.map((n) => ({ name: n, added: state.vault.has(n), last4: state.vault.get(n)?.slice(-4) ?? null, kept_by_plugin: KEPT.includes(n) })) }));
      case "plugin_secret": return json(200, state.vault.has(args.name) ? ok(rpc.id, { name: args.name, value: state.vault.get(args.name), last4: state.vault.get(args.name)!.slice(-4) })
        : err(rpc.id, "error.plugin_secret_missing", "Not added yet"));
      case "money_books": {
        const out = [];
        for (let d = args.from; d <= args.to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) {
          const stripe = state.stripeDown.has(d) ? "error" : "known";
          out.push({ date: d, complete: d < state.today, fees: stripe, payouts: stripe, lines: (state.days.get(d) ?? []).filter((l) => l.cents !== 0) });
          if (out.length > 31) return json(200, err(rpc.id, "error.invalid_input", "at most 31 days"));
        }
        return json(200, ok(rpc.id, { currency: "USD", time_zone: TZ, today: state.today, days: out }));
      }
      case "plugin_secret_keep_preview": {
        if (state.keepDown) return json(502, { error: "down" });
        if (!KEPT.includes(args.name)) return json(200, err(rpc.id, "error.plugin_secret_not_kept", "Not a key this plugin keeps"));
        const id = `run-${++runs}`; pending.set(id, { tool, args });
        return json(200, ok(rpc.id, { run_id: id, status: "planned", summary: `Keep ${args.name}` }));
      }
      case "plugin_card_put_preview": case "plugin_card_clear_preview": {
        if (!state.cards) break;
        const id = `run-${++runs}`; pending.set(id, { tool, args });
        return json(200, ok(rpc.id, { run_id: id, status: "planned", summary: "Show a card" }));
      }
      case "plugin_secret_keep_confirm": case "plugin_card_put_confirm": case "plugin_card_clear_confirm": {
        const p = pending.get(args.run_id);
        if (!p) return json(200, err(rpc.id, "error.not_found", "No such run"));
        pending.delete(args.run_id);
        if (p.tool === "plugin_secret_keep_preview") { state.vault.set(p.args.name, p.args.value); state.kept.push({ name: p.args.name, value: p.args.value }); }
        else if (p.tool === "plugin_card_put_preview") state.shown.set(p.args.slot, p.args); else state.shown.delete(p.args.slot);
        return json(200, ok(rpc.id, { done: true }));
      }
    }
    return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `MCP error -32602: Tool ${tool} not found` } });
  });
  const url = await listen(server);
  const hmac = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return {
    url, state, name, close: () => { server.closeAllConnections(); server.close(); },
    registration(nowMs: number) {
      const body = JSON.stringify({ type: "plugin.registered", id: "p1", sent_at: new Date(nowMs).toISOString(),
        club: { name, url, language: "en", time_zone: TZ, key_url: `${url}/.well-known/openpadel-plugin-key` },
        plugin: { name: "accounting-export", version: "0.1.0" }, door: { mcp: `${url}/mcp`, token: state.token },
        webhooks: { secret: state.webhookSecret, signature_header: "openpadel-signature" },
        hooks: { url: `${url}/plugins/accounting-export/hook`, secret: state.hookSecret, signature_header: "openpadel-signature" }, settings: state.settings });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},ed25519=${sign(null, Buffer.from(`${t}.${body}`), privateKey).toString("base64url")}` };
    },
    event(nowMs: number, type: string, data: Record<string, unknown> = {}) {
      const body = JSON.stringify({ id: `evt_${randomBytes(6).toString("hex")}`, type, created_at: new Date(nowMs).toISOString(), data });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},v1=${hmac(state.webhookSecret, t, body)}` };
    },
    /** A browser's return, as the club passes it on (signed with the hook secret, or a forger's). */
    callback(nowMs: number, query: Record<string, string>, o: { secret?: string } = {}) {
      const body = JSON.stringify({ query });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},v1=${hmac(o.secret ?? state.hookSecret, t, body)}` };
    },
  };
}

export interface Issued { token: string; used: boolean }
/** The token endpoint both providers share in shape: codes for a verifier, refresh tokens that work once. */
function oauth(prefix: string) {
  const s = { clientId: `${prefix}-client-id`, clientSecret: `${prefix}-client-secret-0001`, codes: new Map<string, { challenge: string }>(), refresh: [] as Issued[], access: new Set<string>(),
    refusedReuse: 0, lastRedirect: "" };
  const issue = () => {
    const r = { token: `${prefix}rt_${randomBytes(12).toString("hex")}`, used: false };
    s.refresh.push(r);
    const a = `${prefix}at_${randomBytes(12).toString("hex")}`;
    s.access.add(a);
    return { access_token: a, refresh_token: r.token, expires_in: 1800, token_type: "Bearer" };
  };
  /** The owner says yes at the provider: a code for this challenge. */
  const approve = (challenge: string) => { const code = `${prefix}code_${randomBytes(8).toString("hex")}`; s.codes.set(code, { challenge }); return code; };
  async function token(req: IncomingMessage, body: string): Promise<[number, unknown]> {
    if (req.headers.authorization !== `Basic ${Buffer.from(`${s.clientId}:${s.clientSecret}`).toString("base64")}`) return [401, { error: "invalid_client" }];
    const f = new URLSearchParams(body);
    if (f.get("grant_type") === "authorization_code") {
      const c = s.codes.get(f.get("code") ?? "");
      s.codes.delete(f.get("code") ?? "");
      const { createHash } = await import("node:crypto");
      if (!c || createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return [400, { error: "invalid_grant" }];
      s.lastRedirect = f.get("redirect_uri") ?? "";
      return [200, issue()];
    }
    if (f.get("grant_type") === "refresh_token") {
      const r = s.refresh.find((x) => x.token === f.get("refresh_token"));
      if (!r || r.used) { s.refusedReuse++; return [400, { error: "invalid_grant" }]; }
      r.used = true;
      return [200, issue()];
    }
    return [400, { error: "unsupported_grant_type" }];
  }
  return { s, issue, approve, token, latest: () => s.refresh.at(-1)?.token ?? null };
}

export interface XeroJournal { ManualJournalID: string; Narration: string; Date: string; Status: string; LineAmountTypes: string; JournalLines: { LineAmount: number; AccountCode: string; Description: string }[] }

export async function fakeXero() {
  const o = oauth("x");
  const state = { mode: "ok" as "ok" | "down" | "rate", rateOnce: false, dropNextPost: false, journals: [] as XeroJournal[], posts: 0, keys: new Map<string, string>(), tenant: "tenant-1", org: "Kestrel Padel LLC" };
  const server = createServer(async (req, res) => {
    const body = await readAll(req);
    const json = (status: number, v: unknown, h: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...h }); res.end(JSON.stringify(v)); };
    if (state.mode === "down") return json(503, { error: "down" });
    if (state.mode === "rate" || state.rateOnce) { state.rateOnce = false; return json(429, { error: "rate" }, { "retry-after": "2" }); }
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/connect/token" && req.method === "POST") { const [st, v] = await o.token(req, body); return json(st, v); }
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!o.s.access.has(bearer)) return json(401, { Title: "Unauthorized" });
    if (u.pathname === "/connections") return json(200, [{ id: "c1", tenantId: state.tenant, tenantType: "ORGANISATION", tenantName: state.org }]);
    if (u.pathname === "/api.xro/2.0/ManualJournals") {
      if (req.headers["xero-tenant-id"] !== state.tenant) return json(403, { Title: "Forbidden" });
      if (req.method === "GET") {
        const starts = [...(u.searchParams.get("where") ?? "").matchAll(/Narration\.StartsWith\("([^"]*)"\)/g)].map((m) => m[1]!);
        return json(200, { ManualJournals: state.journals.filter((j) => starts.some((s) => j.Narration.startsWith(s))) });
      }
      if (req.method === "POST") {
        const key = String(req.headers["idempotency-key"] ?? "");
        const had = key && state.keys.get(key);
        let j: XeroJournal;
        if (had) j = state.journals.find((x) => x.ManualJournalID === had)!;
        else {
          state.posts++;
          const sent = JSON.parse(body).ManualJournals[0];
          const total = sent.JournalLines.reduce((n: number, l: any) => n + Math.round(l.LineAmount * 100), 0);
          if (total !== 0) return json(400, { Message: "Journal lines must balance" });
          j = { ...sent, ManualJournalID: `mj-${state.journals.length + 1}` };
          state.journals.push(j);
          if (key) state.keys.set(key, j.ManualJournalID);
        }
        if (state.dropNextPost) { state.dropNextPost = false; req.socket.destroy(); return; }
        return json(200, { ManualJournals: [j] });
      }
    }
    return json(404, {});
  });
  const url = await listen(server);
  return { url, state, oauth: o, close: () => { server.closeAllConnections(); server.close(); } };
}

export interface QboEntry { Id: string; DocNumber: string; TxnDate: string; PrivateNote: string; Line: { Amount: number; Description: string; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } } }[] }

export async function fakeQuickBooks() {
  const o = oauth("q");
  const state = { realm: "9130350000000001", company: "Kestrel Padel Inc", entries: [] as QboEntry[], posts: 0, requests: new Map<string, string>(),
    accounts: [{ Id: "11", Name: "Court income", AcctNum: "4000" }, { Id: "12", Name: "Stripe clearing", AcctNum: "1050" }, { Id: "13", Name: "Sales tax payable", AcctNum: "2200" },
      { Id: "14", Name: "Suspense", AcctNum: "9999" }, { Id: "15", Name: "Card fees" }] };
  const server = createServer(async (req, res) => {
    const body = await readAll(req);
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/oauth2/v1/tokens/bearer" && req.method === "POST") { const [st, v] = await o.token(req, body); return json(st, v); }
    if (!o.s.access.has(String(req.headers.authorization ?? "").replace(/^Bearer /, ""))) return json(401, { Fault: { Error: [{ Message: "AuthenticationFailed" }] } });
    const m = /^\/v3\/company\/([^/]+)\/(query|journalentry|companyinfo\/[^/]+)$/.exec(u.pathname);
    if (!m || m[1] !== state.realm) return json(404, {});
    if (m[2]!.startsWith("companyinfo")) return json(200, { CompanyInfo: { CompanyName: state.company } });
    if (m[2] === "query") {
      const q = u.searchParams.get("query") ?? "";
      if (/from Account/i.test(q)) return json(200, { QueryResponse: { Account: state.accounts } });
      const docs = [...q.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
      const found = state.entries.filter((e) => docs.includes(e.DocNumber));
      return json(200, { QueryResponse: found.length ? { JournalEntry: found } : {} });
    }
    if (m[2] === "journalentry" && req.method === "POST") {
      const rid = u.searchParams.get("requestid") ?? "";
      const had = rid && state.requests.get(rid);
      if (had) return json(200, { JournalEntry: state.entries.find((e) => e.Id === had) });
      const e = JSON.parse(body);
      let dr = 0, cr = 0;
      for (const l of e.Line) { const c = Math.round(l.Amount * 100); if (l.JournalEntryLineDetail.PostingType === "Debit") dr += c; else cr += c; }
      if (dr !== cr) return json(400, { Fault: { Error: [{ Detail: "Debits and credits must be equal" }] } });
      state.posts++;
      const saved = { ...e, Id: String(100 + state.entries.length) };
      state.entries.push(saved);
      if (rid) state.requests.set(rid, saved.Id);
      return json(200, { JournalEntry: saved });
    }
    return json(404, {});
  });
  const url = await listen(server);
  return { url, state, oauth: o, close: () => { server.closeAllConnections(); server.close(); } };
}
