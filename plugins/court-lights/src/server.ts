// The plugin's own address: what the club POSTs (its registration, its events, hooks) and the health it checks. Paths
// are matched by their last part, so it answers under any prefix (`run.url` https://lights.example.com/v1 gets
// /v1/register, /v1/events, /v1/health). One plugin can serve several clubs, each with its own registration.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ClubRunner } from "./club.ts";
import type { Fetch } from "./door.ts";
import type { Log } from "./log.ts";
import { verifyRegistration, verifyWebhook, type FetchKey } from "./signatures.ts";
import type { ClubRecord, Store } from "./store.ts";

export const MAX_BODY = 1_000_000;
export const TICK_MS = 30_000, RECONCILE_MS = 5 * 60_000, AFTER_EVENT_MS = 1_000;

export interface PluginOpts {
  store: Store; log: Log; fetch?: Fetch; fetchKey?: FetchKey;
  /** A club on http (this machine, in development). Production clubs are https. */
  allowHttp?: boolean;
  /** Only these clubs may register (their addresses), when given. */
  clubs?: string[] | null;
  /** A local plugin is given its club in its environment: it takes no registrations. */
  registrations?: boolean;
  now?: () => number;
  /** Off in tests: an event's read happens at once (await the runner's idle()), with no timer to wait for. */
  timers?: boolean;
}

export function plugin(o: PluginOpts) {
  const fetchImpl = o.fetch ?? fetch, now = o.now ?? Date.now, runners = new Map<string, ClubRunner>();
  const fetchKey: FetchKey = o.fetchKey ?? (async (url) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ keys: Record<string, string>[] }>;
  });
  const soon = new Map<string, ReturnType<typeof setTimeout>>();

  function add(rec: ClubRecord): ClubRunner {
    const had = runners.get(rec.club.url);
    if (had) { had.replace(rec); return had; }
    const r = new ClubRunner(rec, { fetch: fetchImpl, store: o.store, log: o.log });
    runners.set(rec.club.url, r);
    o.store.save(rec);
    return r;
  }
  for (const rec of o.store.load()) add(rec);

  /** Reads the club again shortly (events come in bursts: one read for them all). */
  function readSoon(r: ClubRunner) {
    if (o.timers === false) { void r.serial(() => r.reconcile(now())); return; }
    const key = r.rec.club.url;
    if (soon.has(key)) return;
    soon.set(key, setTimeout(() => { soon.delete(key); void r.serial(() => r.reconcile(now())); }, AFTER_EVENT_MS));
  }

  async function register(header: string | undefined, body: string): Promise<number> {
    if (o.registrations === false) return 404;
    if (!(await verifyRegistration(header, body, fetchKey, { allowHttp: o.allowHttp, nowSeconds: Math.floor(now() / 1000) }))) { o.log("warn", "a registration's signature didn't check; refused"); return 401; }
    const b = JSON.parse(body) as any;
    const url = String(b.club.url).replace(/\/+$/, "");
    if (o.clubs?.length && !o.clubs.includes(url)) { o.log("warn", "a registration from a club this plugin doesn't serve; refused", { club: url }); return 403; }
    if (typeof b.door?.mcp !== "string" || !b.door.mcp.startsWith(`${url}/`) || typeof b.door.token !== "string" || typeof b.webhooks?.secret !== "string") return 400;
    const rec: ClubRecord = {
      club: { name: String(b.club.name ?? ""), url, time_zone: String(b.club.time_zone ?? "UTC"), language: String(b.club.language ?? "en") },
      door: { mcp: b.door.mcp, token: b.door.token }, webhookSecret: b.webhooks.secret, hookSecret: String(b.hooks?.secret ?? ""),
      settings: b.settings && typeof b.settings === "object" ? b.settings : {}, commanded: {}, seen: [],
    };
    const r = add(rec);
    o.log("info", "registered at a club", { club: url, plugin_version: b.plugin?.version });
    void r.serial(() => r.reconcile(now()));
    return 200;
  }

  /** An event: from whichever club's secret signs it. */
  function event(header: string | undefined, body: string): { status: number; runner?: ClubRunner } {
    const t = Math.floor(now() / 1000);
    const r = [...runners.values()].find((x) => verifyWebhook(x.rec.webhookSecret, header, body, t));
    if (!r) return { status: 401 };
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return { status: 400 }; }
    const what = r.event(parsed, now());
    if (what === "read") readSoon(r);
    return { status: 200, runner: r };
  }

  function health() {
    const t = now(), list = [...runners.values()];
    const ok = list.every((r) => r.healthy(t));
    const hs = list.map((r) => r.health());
    const latest = (f: (h: (typeof hs)[number]) => string | null, pick: "max" | "min") => {
      const v = hs.map(f).filter((x): x is string => Boolean(x)).sort();
      return (pick === "max" ? v.at(-1) : v[0]) ?? null;
    };
    // Nothing that names a club: anyone can ask a plugin's health.
    const body = list.length === 1 ? { ok, ...hs[0]! }
      : { ok, clubs: list.length, last_event_at: latest((h) => h.last_event_at, "max"), last_reconcile_at: latest((h) => h.last_reconcile_at, "min"),
        home_assistant: { reachable: hs.every((h) => h.home_assistant.reachable !== false) }, on: hs.reduce((n, h) => n + h.on, 0) };
    return { status: ok ? 200 : 503, body };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "");
    const last = path.slice(path.lastIndexOf("/") + 1);
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && last === "health") { const h = health(); return send(h.status, h.body); }
    if (req.method !== "POST" || !["register", "events", "hook"].includes(last)) return send(404, { error: "not_found" });
    let body: string;
    try { body = await readBody(req); } catch { return send(413, { error: "too_big" }); }
    const h = (n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; };
    if (last === "register") { const s = await register(h("openpadel-signature-ed25519"), body).catch(() => 400); return send(s, s === 200 ? { ok: true } : { error: "refused" }); }
    if (last === "events") { const e = event(h("openpadel-signature"), body); return send(e.status, e.status === 200 ? { ok: true } : { error: "refused" }); }
    // Its manifest takes no hooks: nothing outside the club posts to it.
    return send(404, { error: "no_hooks" });
  }

  let ticker: ReturnType<typeof setInterval> | null = null, reader: ReturnType<typeof setInterval> | null = null;
  return {
    runners, add, handle, health,
    /** Reads every club now, and keeps at it: a tick every 30 seconds, a read every 5 minutes. */
    start() {
      for (const r of runners.values()) void r.serial(() => r.reconcile(now()));
      ticker = setInterval(() => { for (const r of runners.values()) void r.serial(() => r.tick(now())); }, TICK_MS);
      reader = setInterval(() => { for (const r of runners.values()) void r.serial(() => r.reconcile(now())); }, RECONCILE_MS);
    },
    stop() { if (ticker) clearInterval(ticker); if (reader) clearInterval(reader); for (const t of soon.values()) clearTimeout(t); soon.clear(); },
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
