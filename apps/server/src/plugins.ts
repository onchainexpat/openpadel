// Plugins on the server (packages/core/src/plugins.ts holds the actions): talking to them under the webhooks' address
// rules, the club's public signing key, /plugins/<name>/hook passed on to a plugin so the club opens no new ports, their
// health for `openpadel doctor` and the staff list, and the staff reads (installed plugins, the catalog, the processors
// list). A plugin is a separate program: nothing here runs its code or lets it near the database.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Hono, type Context } from "hono";
import { both, type Lang } from "@kumi/i18n";
import { clubPlugins, problemText, rawError, HOOK_MAX_BYTES, HOOK_PER_MINUTE, hookTarget, KumiError, parseManifest, pluginCard, pluginCatalog, pluginKey, processors, searchCatalog, setPluginIo,
  type Db, type Manifest } from "@kumi/core";
import { publicOnlyLookup, readCapped } from "./oauth.ts";
import { publicHost } from "./webhooks.ts";
import { RateLimiter } from "./limits.ts";

export const PLUGIN_TIMEOUT_MS = 10_000, HEALTH_TIMEOUT_MS = 4_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface PluginHttp { method: "GET" | "POST"; body?: string | Buffer; headers?: Record<string, string>; max: number; timeoutMs: number;
  /** https and public addresses only (production), unless `loopbackOk`: a local plugin on this server's loopback. */
  publicOnly: boolean; loopbackOk?: boolean }
/** One request to a plugin or a catalog: no redirects, an answer read up to `max` bytes, and in production only https
 *  public addresses, checked on the address connected to (oauth.ts, publicOnlyLookup). A local plugin is reached on
 *  the loopback only (`loopbackOk`). */
export function pluginRequest(url: string, o: PluginHttp): Promise<{ status: number; body: Buffer; type: string | null }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error("not an address")); }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const local = Boolean(o.loopbackOk) && LOOPBACK.has(host) && u.protocol === "http:";
    if (o.publicOnly && !local) {
      if (u.protocol !== "https:") return reject(new Error("https only"));
      if (!publicHost(host)) return reject(new Error(`${host} isn't a public address`));
    }
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const body = o.body === undefined ? undefined : typeof o.body === "string" ? Buffer.from(o.body) : o.body;
    const req = send(u, { method: o.method, headers: { ...(o.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}), "accept-encoding": "identity" },
      ...(o.publicOnly && !local ? { lookup: publicOnlyLookup() as any } : {}) }, (res) => {
      readCapped(res, o.max).then((b) => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body: b, type: (res.headers["content-type"] as string | undefined) ?? null }); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error(`took longer than ${Math.round(o.timeoutMs / 1000)} seconds`)), o.timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

/** The server's way of talking to plugins and catalogs (core's PluginIo): the webhooks' rules in production. */
export function usePluginIo(o: { production: boolean; publicUrl: string; catalogUrl?: string | null }): void {
  setPluginIo({
    publicUrl: o.publicUrl, catalogUrl: o.catalogUrl ?? null,
    async fetchText(url, max) {
      const r = await pluginRequest(url, { method: "GET", headers: { accept: "application/json", "user-agent": "openPadel-Plugins/1" }, max, timeoutMs: PLUGIN_TIMEOUT_MS, publicOnly: o.production });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.body.toString("utf8");
    },
    async post(url, body, headers) {
      const r = await pluginRequest(url, { method: "POST", body, headers, max: 64_000, timeoutMs: PLUGIN_TIMEOUT_MS, publicOnly: o.production });
      return { status: r.status, body: r.body.toString("utf8").slice(0, 2000) };
    },
  });
}

export type Health = { state: "ok" | "down" | "paused" | "waiting"; status?: number; error?: string; ms?: number;
  /** What went wrong in plain words, in the reader's language (the staff list); `error` is the raw detail. */ problem?: string };
/** A plugin's health: its manifest's health path on its own address, within the timeout and the webhooks' rules (a
 *  local plugin on the loopback). Paused or not yet registered says so without asking it. */
export async function pluginHealth(p: { status: string; base_url: string | null; mode: string; manifest: unknown }, production: boolean): Promise<Health> {
  if (p.status === "paused") return { state: "paused" };
  if (!p.base_url) return { state: "waiting" };
  const started = Date.now();
  try {
    const r = await pluginRequest(`${p.base_url}${(p.manifest as Manifest).health}`, { method: "GET", headers: { "user-agent": "openPadel-Health/1" }, max: 16_000, timeoutMs: HEALTH_TIMEOUT_MS,
      publicOnly: production, loopbackOk: p.mode === "local" });
    return r.status >= 200 && r.status < 300 ? { state: "ok", status: r.status, ms: Date.now() - started } : { state: "down", status: r.status, error: `HTTP ${r.status}` };
  } catch (e) { return { state: "down", error: rawError(e) }; }
}
/** Live plugins with their health, all asked at once. */
export async function pluginsHealth(db: Db, production: boolean) {
  const rows = await db.selectFrom("plugin").select(["name", "status", "base_url", "mode", "manifest", "registration_error", "registered_at"]).where("status", "!=", "removed").orderBy("name").execute();
  return Promise.all(rows.map(async (r) => ({ name: r.name, status: r.status, base_url: r.base_url, registration_error: r.registration_error, registered: Boolean(r.registered_at), health: await pluginHealth(r, production) })));
}

/** Headers never passed on to a plugin: the club's own cookies and the connection's. */
const NOT_PASSED = new Set(["cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "accept-encoding"]);

export function pluginRoutes(db: Db, o: { production: boolean; now: () => Date }) {
  const app = new Hono();
  const limit = new RateLimiter(HOOK_PER_MINUTE, 60_000);
  // The club's public key for what it sends plugins: a plugin checks a registration's openpadel-signature-ed25519 with it.
  app.get("/.well-known/openpadel-plugin-key", async (c) => {
    const k = await pluginKey(db);
    c.header("cache-control", "public, max-age=3600");
    return c.json({ keys: [{ ...k.jwk, kid: "openpadel-plugin-1" }] });
  });
  // What an outside service posts for a plugin (a camera's "highlight ready"), passed on to it, signed with its own
  // secret, so the club opens no new ports. At most HOOK_MAX_BYTES, HOOK_PER_MINUTE a minute per plugin.
  app.post("/plugins/:name/hook", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name)) throw new KumiError("error.not_found", { thing: both("thing.plugin") }, 404);
    const target = await hookTarget(db, name);
    if (!target) throw new KumiError("error.not_found", { thing: both("thing.plugin") }, 404);
    if (Number(c.req.header("content-length") ?? 0) > HOOK_MAX_BYTES) throw new KumiError("error.too_big", {}, 413);
    if (!limit.take(name)) return c.json({ error: "too_many" }, 429, { "retry-after": "60" });
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.length > HOOK_MAX_BYTES) throw new KumiError("error.too_big", {}, 413);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { if (!NOT_PASSED.has(k.toLowerCase()) && !k.toLowerCase().startsWith("openpadel-")) headers[k] = v; });
    const t = Math.floor(o.now().getTime() / 1000);
    Object.assign(headers, { "user-agent": "openPadel-Hooks/1", "openpadel-event": "plugin.hook", "openpadel-signature": target.sign(body, t) });
    try {
      const r = await pluginRequest(target.url, { method: "POST", body, headers, max: 256_000, timeoutMs: PLUGIN_TIMEOUT_MS, publicOnly: o.production, loopbackOk: target.local });
      // The answer goes back to the sender as JSON or plain text only: never a page the club's address would show.
      const type = /^application\/json\b/i.test(r.type ?? "") ? "application/json" : "text/plain; charset=utf-8";
      return new Response(new Uint8Array(r.body), { status: r.status >= 200 && r.status < 600 ? r.status : 502,
        headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": "default-src 'none'; sandbox" } });
    } catch { return c.json({ error: "plugin_unreachable" }, 502); }
  });
  return app;
}

/** The staff reads (reads.ts mounts these behind its checks: the settings area, the owner and managers, and the door
 *  for their assistants): installed plugins with health, the catalog and one plugin in it, and the processors list. */
export function pluginReadRoutes(db: Db, me: (c: Context<any>) => { id: string } | null, lang: (c: Context<any>) => Lang, o: { production: boolean }) {
  const app = new Hono();
  // What's installed, and the catalog (which says what's installed), are the owner's and managers' (and their agents'),
  // like Settings, Agents: the front desk and coaches aren't told. The processors list below stays every staff read.
  app.use("/staff/plugins", ownerOrManager);
  app.use("/staff/plugins/*", ownerOrManager);
  async function ownerOrManager(c: Context<any>, next: () => Promise<void>) {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const boss = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", m.id)
      .where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "in", ["owner", "manager"]).executeTakeFirst();
    if (!boss) throw new KumiError("error.staff_only", {}, 403);
    await next();
  }
  app.get("/staff/plugins", async (c) => {
    const l = lang(c), list = await clubPlugins(db, l);
    const health = new Map((await pluginsHealth(db, o.production)).map((h) => [h.name, h.health]));
    // What staff read is plain words (problemText); the raw detail stays in `error` for agents and the logs.
    const host = (p: { address: string | null }) => (p.address ?? "").replace(/^https?:\/\//, "");
    return c.json(list.map((p) => {
      const h = p.status === "removed" ? null : health.get(p.name) ?? null;
      return { ...p, health: h && h.state === "down" ? { ...h, problem: problemText(h.error, host(p))[l] } : h };
    }));
  });
  app.get("/staff/plugins/catalog", async (c) => {
    const l = lang(c), q = c.req.query("q") ?? "";
    const installed = new Set((await db.selectFrom("plugin").select("name").where("status", "!=", "removed").execute()).map((r) => r.name));
    const { source, skipped } = await pluginCatalog();
    const found = await searchCatalog(q);
    return c.json({ source, skipped, plugins: found.map((e) => ({ name: e.manifest.name, publisher: e.manifest.publisher, version: e.manifest.version, description: e.manifest.description[l],
      mode: e.manifest.run.mode, charges: e.manifest.cost.charges, installed: installed.has(e.manifest.name), install: `openpadel plugin install ${e.manifest.name}` })) });
  });
  app.get("/staff/plugins/catalog/:name", async (c) => {
    const l = lang(c), name = c.req.param("name");
    const e = (await pluginCatalog()).entries.find((x) => x.manifest.name === name);
    if (!e) throw new KumiError("error.plugin_not_in_catalog", { name }, 404);
    const installed = await db.selectFrom("plugin").select(["release", "status"]).where("name", "=", name).where("status", "!=", "removed").executeTakeFirst();
    return c.json({ ...pluginCard(e.manifest, l), installed: installed ? { version: installed.release, status: installed.status } : null, install: `openpadel plugin install ${name}` });
  });
  app.get("/staff/processors", async (c) => c.json(await processors(db, lang(c))));
  return app;
}

/** A manifest checked on its own, for `openpadel plugin check <file>` and tests: the words a preview would show. */
export function describeManifest(text: string, lang: Lang) {
  return pluginCard(parseManifest(text), lang);
}
