// The plugin's own address: what the club POSTs (its registration, its events with the messages to send, what Meta
// posted to the club's /plugins/whatsapp/hook, and Meta's check of that address as /verify) and the health it checks.
// Paths are matched by their last part, so it answers under any prefix (`run.url` https://whatsapp.example.com/v1 gets
// /v1/register, /v1/events, /v1/hook, /v1/verify, /v1/health). One plugin can serve several clubs, each with its own
// registration: what the club passes on is signed with that club's own secret.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ClubRunner, type Http } from "./club.ts";
import type { Fetch } from "./door.ts";
import type { Log } from "./log.ts";
import { GRAPH } from "./meta.ts";
import { verifyRegistration, verifyWebhook, type FetchKey } from "./signatures.ts";
import { blankRecord, type ClubRecord, type Store } from "./store.ts";

export const MAX_BODY = 1_000_000, MAX_QUERY = 2_000;
export const TICK_MS = 5_000, RECONCILE_MS = 15 * 60_000;

export interface PluginOpts {
  store: Store; log: Log; fetch?: Fetch; fetchKey?: FetchKey;
  /** A club on http (this machine, in development). Production clubs are https. */
  allowHttp?: boolean;
  /** Only these clubs may register (their addresses), when given. */
  clubs?: string[] | null;
  /** A local plugin is given its club in its environment: it takes no registrations. */
  registrations?: boolean;
  now?: () => number;
  /** Off in tests: work happens at once (await the runner's idle()), with no timer to wait for. */
  timers?: boolean;
  /** Meta's Graph API address (tests point it at a fake). */
  graph?: string;
  /** How the pace between messages is waited (tests don't wait). */
  sleep?: (ms: number) => Promise<void>;
}

export function plugin(o: PluginOpts) {
  const fetchImpl = o.fetch ?? fetch, now = o.now ?? Date.now, runners = new Map<string, ClubRunner>();
  const http: Http = { fetch: fetchImpl, graph: o.graph ?? GRAPH, sleep: o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))) };
  const fetchKey: FetchKey = o.fetchKey ?? (async (url) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ keys: Record<string, string>[] }>;
  });

  function add(rec: ClubRecord): ClubRunner {
    const had = runners.get(rec.club.url);
    if (had) { had.replace(rec); return had; }
    const r = new ClubRunner({ ...blankRecord(rec), ...rec }, { http, store: o.store, log: o.log });
    runners.set(rec.club.url, r);
    o.store.save(r.rec);
    return r;
  }
  for (const rec of o.store.load()) add(rec);

  /** Work for a club now (tests), or on the next tick. */
  const soon = (r: ClubRunner) => { if (o.timers === false) void r.serial(() => r.tick(now())); else setTimeout(() => void r.serial(() => r.tick(now())), 50).unref?.(); };

  async function register(header: string | undefined, body: string): Promise<number> {
    if (o.registrations === false) return 404;
    if (!(await verifyRegistration(header, body, fetchKey, { allowHttp: o.allowHttp, nowSeconds: Math.floor(now() / 1000) }))) { o.log("warn", "a registration's signature didn't check; refused"); return 401; }
    const b = JSON.parse(body) as any;
    const url = String(b.club.url).replace(/\/+$/, "");
    if (o.clubs?.length && !o.clubs.includes(url)) { o.log("warn", "a registration from a club this plugin doesn't serve; refused", { club: url }); return 403; }
    if (typeof b.door?.mcp !== "string" || !b.door.mcp.startsWith(`${url}/`) || typeof b.door.token !== "string" || typeof b.webhooks?.secret !== "string" || typeof b.hooks?.secret !== "string") return 400;
    const r = add(blankRecord({
      club: { name: String(b.club.name ?? ""), url, time_zone: String(b.club.time_zone ?? "UTC"), language: String(b.club.language ?? "en") },
      door: { mcp: b.door.mcp, token: b.door.token }, webhookSecret: b.webhooks.secret, hookSecret: b.hooks.secret,
      settings: b.settings && typeof b.settings === "object" ? b.settings : {},
    }));
    o.log("info", "registered at a club", { club: url, plugin_version: b.plugin?.version });
    void r.serial(() => r.reconcile(now()));
    return 200;
  }

  /** Whichever club's secret signs it (the webhook's for events, the hook's for what Meta posted and its check). */
  const signedBy = (header: string | undefined, body: string, which: "webhookSecret" | "hookSecret") => {
    const t = Math.floor(now() / 1000);
    return [...runners.values()].find((x) => Boolean(x.rec[which]) && verifyWebhook(x.rec[which], header, body, t));
  };

  function event(header: string | undefined, body: string): number {
    const r = signedBy(header, body, "webhookSecret");
    if (!r) return 401;
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return 400; }
    const what = r.event(parsed, now());
    if (what === "send" || what === "read") soon(r);
    return 200;
  }

  /** What Meta posted to the club's /plugins/whatsapp/hook: the club's signature, then Meta's own (in the runner). */
  async function hook(header: string | undefined, metaSignature: string | undefined, body: string): Promise<number> {
    const r = signedBy(header, body, "hookSecret");
    if (!r) { o.log("warn", "a hook's club signature didn't check; refused"); return 401; }
    const s = await r.serial(() => r.hook(body, metaSignature, now()));
    if (s === 200) soon(r);
    return s;
  }

  /** Meta's GET check of the hook address, as the club passes it on: its query, signed with the hook secret. */
  async function verify(header: string | undefined, body: string): Promise<{ status: number; body: unknown }> {
    const r = signedBy(header, body, "hookSecret");
    if (!r) return { status: 401, body: { error: "refused" } };
    let q: unknown;
    try { q = (JSON.parse(body) as { query?: unknown }).query; } catch { return { status: 400, body: { error: "query" } }; }
    if (!q || typeof q !== "object" || Array.isArray(q) || JSON.stringify(q).length > MAX_QUERY || Object.values(q).some((v) => typeof v !== "string")) return { status: 400, body: { error: "query" } };
    const answer = await r.serial(() => r.verify(q as Record<string, string>, now()));
    return answer ? { status: 200, body: { answer } } : { status: 403, body: { error: "refused" } };
  }

  function health() {
    const t = now(), hs = [...runners.values()].map((r) => r.health(t));
    const ok = hs.every((h) => !h.failing);
    // Nothing that names a club or a member: anyone can ask a plugin's health.
    const body = hs.length === 1 ? { ok, ...hs[0]! } : { ok, clubs: hs.length, failing: hs.filter((h) => h.failing).length, waiting: hs.reduce((n, h) => n + h.waiting, 0) };
    return { status: ok ? 200 : 503, body };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "");
    const last = path.slice(path.lastIndexOf("/") + 1);
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && last === "health") { const h = health(); return send(h.status, h.body); }
    if (req.method !== "POST" || !["register", "events", "hook", "verify"].includes(last)) return send(404, { error: "not_found" });
    let body: string;
    try { body = await readBody(req); } catch { return send(413, { error: "too_big" }); }
    const h = (n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; };
    if (last === "register") { const s = await register(h("openpadel-signature-ed25519"), body).catch(() => 400); return send(s, s === 200 ? { ok: true } : { error: "refused" }); }
    if (last === "events") { const s = event(h("openpadel-signature"), body); return send(s, s === 200 ? { ok: true } : { error: "refused" }); }
    if (last === "verify") { const v = await verify(h("openpadel-signature"), body); return send(v.status, v.body); }
    const s = await hook(h("openpadel-signature"), h("x-hub-signature-256"), body);
    return send(s, s === 200 ? { ok: true } : { error: "refused" });
  }

  let ticker: ReturnType<typeof setInterval> | null = null, reader: ReturnType<typeof setInterval> | null = null;
  return {
    runners, add, handle, health,
    /** Reads every club now, and keeps at it: a tick every 5 seconds (messages and reports), a read every 15 minutes. */
    start() {
      for (const r of runners.values()) void r.serial(() => r.reconcile(now()));
      ticker = setInterval(() => { for (const r of runners.values()) void r.serial(() => r.tick(now())); }, TICK_MS);
      reader = setInterval(() => { for (const r of runners.values()) void r.serial(() => r.reconcile(now())); }, RECONCILE_MS);
    },
    stop() { if (ticker) clearInterval(ticker); if (reader) clearInterval(reader); },
    listen(port: number, host: string): Promise<Server> {
      const s = createServer((req, res) => { handle(req, res).catch((e) => { o.log("error", "a request failed", { error: (e as Error).message }); if (!res.headersSent) { res.writeHead(500); } res.end(); }); });
      return new Promise((resolve) => s.listen(port, host, () => resolve(s)));
    },
  };
}
export type Plugin = ReturnType<typeof plugin>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
