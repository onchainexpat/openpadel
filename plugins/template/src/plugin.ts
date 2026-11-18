// The whole plugin: the address the club calls, and what it does for each club. Copy this file and change `refresh`
// (what your plugin does) and `cardFor` (what its card says); the rest is what every plugin needs, and is the same in
// openPadel's own (plugins/court-lights, plugins/klaviyo).
//
// The club calls four paths, matched by their last part so any prefix works (`run.url` https://you.example/v1):
//   POST <url>/register  once, on install: the club's signed registration (its door, your token, your secrets);
//   POST <url>/events    the events your manifest names, signed with the webhook secret;
//   POST <url>/hook      what an outside service posted to the club for you (this template takes none: 404);
//   GET  <url>/health    2xx while you're working, for `openpadel doctor` and the Connectors page.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { door as openDoor, DoorError, type Door, type Fetch } from "./door.ts";
import { verifyRegistration, verifyWebhook, type FetchKey } from "./signatures.ts";

/** What it keeps per club: the registration (its token and secret: secrets, so 0600 on disk and never logged). */
export interface Club { url: string; timeZone: string; mcp: string; token: string; webhookSecret: string; settings: Record<string, unknown> }
export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
export interface Text { en: string; es: string }
export interface Card { tone: "ok" | "warn" | "off"; rows: { label: Text; text: Text }[] }

export const REFRESH_MS = 10 * 60_000;
const SEEN_KEPT = 500;

// ---- What this plugin does: change these two ----

/** Reads what it needs through the door: here, today's bookings at each location (`locations`, then `day`). */
async function refresh(d: Door): Promise<{ name: string; bookings: number }[]> {
  const locations = await d.call<{ id: string; name: string }[]>("locations");
  const out: { name: string; bookings: number }[] = [];
  for (const l of locations) {
    const day = await d.call<{ courts?: { items?: { kind: string; status?: string }[] }[] }>("day", { location_id: l.id });
    const n = (day.courts ?? []).flatMap((c) => c.items ?? []).filter((i) => i.kind === "booking" && i.status !== "cancelled").length;
    out.push({ name: l.name, bookings: n });
  }
  return out;
}

/** What its card says, in English and Spanish (US and Latin American, with "tú"): one line a row, no dashes. */
export function cardFor(counts: { name: string; bookings: number }[], label: string | null): Card {
  const word = (n: number): Text => label ? { en: label, es: label } : { en: n === 1 ? "booking" : "bookings", es: n === 1 ? "reserva" : "reservas" };
  if (!counts.length) return { tone: "off", rows: [{ label: { en: "Today", es: "Hoy" }, text: { en: "No locations yet", es: "Todavía no hay sedes" } }] };
  return { tone: "ok", rows: counts.slice(0, 6).map((c) => ({ label: { en: c.name, es: c.name },
    text: { en: `${c.bookings} ${word(c.bookings).en} today`, es: `${c.bookings} ${word(c.bookings).es} hoy` } })) };
}

// ---- What every plugin needs ----

class Runner {
  club: Club;
  door: Door;
  seen: string[] = [];
  lastEventAt: number | null = null;
  lastReadAt: number | null = null;
  error: string | null = null;
  private shown = "";
  private chain: Promise<unknown> = Promise.resolve();
  private o: { fetch: Fetch; log: Log };
  constructor(club: Club, o: { fetch: Fetch; log: Log }) { this.club = club; this.o = o; this.door = openDoor(club.mcp, club.token, o.fetch); }

  /** One thing at a time per club: an event's read never races the timer's. */
  serial<T>(f: () => Promise<T>): Promise<T> { const next = this.chain.then(f, f); this.chain = next.catch(() => {}); return next; }
  idle() { return this.chain; }

  /** Reads the club and shows the card. The club is the truth: events only say when to read it again. */
  async read(now: number): Promise<void> {
    try {
      const mine = await this.door.call<{ settings?: Record<string, unknown> }>("plugin_settings");
      this.club.settings = mine?.settings ?? this.club.settings;
      const counts = await refresh(this.door);
      const label = typeof this.club.settings.label === "string" && this.club.settings.label.trim() ? this.club.settings.label.trim() : null;
      await this.showCard(cardFor(counts, label));
      this.lastReadAt = now; this.error = null;
    } catch (e) {
      this.error = e instanceof DoorError ? e.code : "error";
      this.o.log("warn", "couldn't read the club", { club: this.club.url, code: this.error, error: (e as Error).message });
    }
  }

  /** A card is a change like any other: a preview, then its confirm with the run id. Put again only when it changes. */
  private async showCard(card: Card): Promise<void> {
    const key = JSON.stringify(card);
    if (key === this.shown) return;
    try {
      const p = await this.door.call<{ run_id?: string }>("plugin_card_put_preview", { slot: "connectors", tone: card.tone, rows: card.rows });
      if (!p?.run_id) throw new DoorError("door_error", "no run_id");
      await this.door.call("plugin_card_put_confirm", { run_id: p.run_id });
      this.shown = key;
    } catch (e) {
      // A club whose openPadel doesn't show plugin cards yet: carry on without one.
      if (!(e instanceof DoorError && e.code === "no_tool")) throw e;
    }
  }

  /** An event (its signature already checked): handled once by its id. Gives whether to read the club again. */
  event(b: { id?: unknown; type?: unknown; data?: any }, now: number): boolean {
    if (typeof b.id === "string") { if (this.seen.includes(b.id)) return false; this.seen.push(b.id); this.seen.splice(0, Math.max(0, this.seen.length - SEEN_KEPT)); }
    this.lastEventAt = now;
    if (b.type === "plugin.configured" && b.data?.settings && typeof b.data.settings === "object") this.club.settings = b.data.settings;
    return true;
  }
}

export interface PluginOpts {
  log: Log; fetch?: Fetch; fetchKey?: FetchKey; now?: () => number;
  /** Where registrations are kept (0600); without one, in memory only. */
  stateDir?: string | null;
  /** A club on http (your own machine, in development). Production clubs are https. */
  allowHttp?: boolean;
  /** A local plugin is given its club in its environment and takes no registrations. */
  local?: Club | null;
}

export function plugin(o: PluginOpts) {
  const fetchImpl = o.fetch ?? fetch, now = o.now ?? Date.now, runners = new Map<string, Runner>();
  const fetchKey: FetchKey = o.fetchKey ?? (async (url) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ keys: Record<string, string>[] }>;
  });
  const file = o.stateDir ? join(o.stateDir, "clubs.json") : null;
  const save = () => {
    if (!file || !o.stateDir) return;
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify([...runners.values()].map((r) => r.club)), { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600); renameSync(`${file}.tmp`, file);
  };
  const add = (c: Club) => { const r = new Runner(c, { fetch: fetchImpl, log: o.log }); runners.set(c.url, r); return r; };
  if (o.local) add(o.local);
  else if (file) { try { for (const c of JSON.parse(readFileSync(file, "utf8")) as Club[]) add(c); } catch { /* nothing kept yet */ } }

  async function register(header: string | undefined, body: string): Promise<number> {
    if (o.local) return 404;
    // Check the club's Ed25519 signature against the key at its own address before keeping anything.
    if (!(await verifyRegistration(header, body, fetchKey, { allowHttp: o.allowHttp, nowSeconds: Math.floor(now() / 1000) }))) return 401;
    const b = JSON.parse(body);
    const url = String(b.club.url).replace(/\/+$/, "");
    if (typeof b.door?.mcp !== "string" || !b.door.mcp.startsWith(`${url}/`) || typeof b.door.token !== "string" || typeof b.webhooks?.secret !== "string") return 400;
    const r = add({ url, timeZone: String(b.club.time_zone ?? "UTC"), mcp: b.door.mcp, token: b.door.token, webhookSecret: b.webhooks.secret, settings: b.settings ?? {} });
    save();
    o.log("info", "registered at a club", { club: url });
    void r.serial(() => r.read(now()));
    return 200;
  }

  function events(header: string | undefined, body: string): { status: number; runner?: Runner } {
    const t = Math.floor(now() / 1000);
    const r = [...runners.values()].find((x) => verifyWebhook(x.club.webhookSecret, header, body, t));
    if (!r) return { status: 401 };
    let b: unknown;
    try { b = JSON.parse(body); } catch { return { status: 400 }; }
    if (r.event(b as any, now())) void r.serial(() => r.read(now()));
    return { status: 200, runner: r };
  }

  function health() {
    const t = now(), list = [...runners.values()];
    // Down when a club hasn't been read for two refreshes. It names no club: anyone can ask.
    const ok = list.every((r) => r.lastReadAt !== null ? t - r.lastReadAt < 2 * REFRESH_MS : r.error === null);
    return { status: ok ? 200 : 503, body: { ok, clubs: list.length, last_event_at: Math.max(0, ...list.map((r) => r.lastEventAt ?? 0)) || null } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const last = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "").split("/").pop();
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && last === "health") { const h = health(); return send(h.status, h.body); }
    if (req.method !== "POST" || (last !== "register" && last !== "events")) return send(404, { error: "not_found" });
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) return send(413, { error: "too_big" }); chunks.push(c as Buffer); }
    const body = Buffer.concat(chunks).toString("utf8"), h = (k: string) => [req.headers[k]].flat()[0];
    if (last === "register") { const s = await register(h("openpadel-signature-ed25519"), body).catch(() => 400); return send(s, s === 200 ? { ok: true } : { error: "refused" }); }
    const e = events(h("openpadel-signature"), body);
    return send(e.status, e.status === 200 ? { ok: true } : { error: "refused" });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    runners, handle, health,
    /** Reads each club now, then every REFRESH_MS: a missed event is caught by the next read. */
    start() {
      for (const r of runners.values()) void r.serial(() => r.read(now()));
      timer = setInterval(() => { for (const r of runners.values()) void r.serial(() => r.read(now())); }, REFRESH_MS);
    },
    stop() { if (timer) clearInterval(timer); },
    listen(port: number, host: string): Promise<Server> {
      const s = createServer((req, res) => { handle(req, res).catch((e) => { o.log("error", "a request failed", { error: (e as Error).message }); if (!res.headersSent) res.writeHead(500); res.end(); }); });
      return new Promise((ok) => s.listen(port, host, () => ok(s)));
    },
  };
}
export type Plugin = ReturnType<typeof plugin>;
