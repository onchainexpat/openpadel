// One club's cameras: which court each camera films (the settings and the club's courts, read through the door), a
// vendor's notice matched to the booking on that court at that time (the `day` read), and that game's card put for its
// players (plugin.card_put, slot `game`). With `tell_cameras` on, it also tells the vendor each booking's start and end
// on a court with a camera, and that it's off when it's cancelled or moved away.
//
// Safe by default:
//   - a notice for a court nobody had booked then is answered and dropped: no card, nothing kept;
//   - a notice that came while the club's door didn't answer waits, and is matched on the next read that works;
//   - the vendor not answering never loses a booking's times: what it wasn't told is tried again, the wait doubling from
//     5 seconds to 5 minutes, and a cancellation is only sent on a schedule read in the last 15 minutes.
import { door as openDoor, DoorError, type Door, type Fetch } from "./door.ts";
import type { CameraAdapter, Notice, Session } from "./adapters/types.ts";
import { VendorError } from "./adapters/types.ts";
import type { Log } from "./log.ts";
import { cameraFor, EARLY_MS, LATE_MS, matchBooking, momentOf, parseSettings, sessionId, type Held } from "./match.ts";
import type { ClubRecord, Game, Store } from "./store.ts";
import { cardFor } from "./words.ts";

/** A schedule older than this doesn't cancel anything at the vendor. */
export const FRESH_MS = 15 * 60_000;
/** A notice about a game further back than this is answered and dropped (`too_old`); so is one more than a few minutes
 *  in the future (`future`: a camera whose clock is off). */
export const MAX_AGE_MS = 14 * 86_400_000, FUTURE_MS = 10 * 60_000;
/** Notices waiting for the door: at most this many, for at most this long. */
export const WAITING_KEPT = 200, WAITING_MS = 2 * 86_400_000;
export const GAMES_KEPT = 300, SEEN_KEPT = 500, CLIPS_PER_GAME = 30;
export const VENDOR_TIMEOUT_MS = 8_000;
const CARDS_RECHECK_MS = 3600_000;
const backoff = (n: number) => Math.min(5_000 * 2 ** Math.max(0, n - 1), 300_000);

export type Outcome = "shown" | "matched" | "empty" | "unknown_camera" | "too_old" | "future" | "waiting";
export type VendorProblem = null | "unreachable" | "refused" | "no_key" | "no_address" | "no_adapter";
interface Cam { court: string; name: string; location: string }
interface Day { date?: string; today?: string; time_zone?: string; courts?: { id: string; items?: Held[] }[] }

export interface ClubHealth { last_event_at: string | null; last_hook_at: string | null; last_reconcile_at: string | null; reconcile_error: string | null;
  cameras: number; games_shown: number; waiting: number; vendor: { told: boolean; reachable: boolean | null; problem: VendorProblem; last_ok_at: string | null } }

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const nextDate = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
const dateIn = (ms: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

export class ClubRunner {
  rec: ClubRecord;
  private door: Door;
  private fetchImpl: Fetch;
  private store: Store;
  private log: Log;
  private adapter: CameraAdapter;
  /** By camera id: its court, read on each reconcile. */
  private cams: Map<string, Cam> | null = null;
  private zones = new Map<string, string>();
  /** The sessions the vendor should have, from the last read that worked. */
  private desired: Map<string, Session> | null = null;
  private readAt: number | null = null;
  private vendorSecret: string | null = null;
  private apiKey: string | null = null;
  private vendor: { problem: VendorProblem; lastOkAt: number | null; attempts: number; retryAt: number } = { problem: null, lastOkAt: null, attempts: 0, retryAt: 0 };
  private lastEventAt: number | null = null;
  private lastHookAt: number | null = null;
  private lastReconcileAt: number | null = null;
  private reconcileError: string | null = null;
  private cards: { state: "unknown" | "yes" | "no"; checkedAt: number } = { state: "unknown", checkedAt: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  private said = new Set<string>();

  constructor(rec: ClubRecord, o: { fetch: Fetch; store: Store; log: Log; adapter: CameraAdapter }) {
    this.rec = rec; this.fetchImpl = o.fetch; this.store = o.store; this.log = o.log; this.adapter = o.adapter;
    this.door = openDoor(rec.door.mcp, rec.door.token, o.fetch);
  }

  /** A new registration for the same club (a new token after the club's address changed, or a reinstall). */
  replace(rec: ClubRecord): void {
    this.rec = { ...rec, games: this.rec.games, told: this.rec.told, waiting: this.rec.waiting, seen: this.rec.seen };
    this.door = openDoor(rec.door.mcp, rec.door.token, this.fetchImpl);
    this.vendorSecret = null; this.apiKey = null;
    this.save();
  }

  /** Work is done one thing at a time: a hook's match never races the timer's read. */
  serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => {});
    return next;
  }
  idle(): Promise<unknown> { return this.chain; }

  private save(): void { try { this.store.save(this.rec); } catch (e) { this.once("save", "warn", "couldn't keep the plugin's state on disk", { error: (e as Error).message }); } }
  private once(key: string, level: "info" | "warn" | "error", msg: string, f: Record<string, unknown> = {}) {
    if (this.said.has(key)) return;
    this.said.add(key); this.log(level, msg, { club: this.rec.club.url, ...f });
  }

  /** An event the club sent (its signature already checked). Gives whether to read the club again. */
  event(body: { id?: unknown; type?: unknown; data?: any }, now: number): "duplicate" | "read" | "ignored" {
    const id = typeof body.id === "string" ? body.id : null;
    if (id && this.rec.seen.includes(id)) return "duplicate";
    if (id) { this.rec.seen.push(id); if (this.rec.seen.length > SEEN_KEPT) this.rec.seen.splice(0, this.rec.seen.length - SEEN_KEPT); }
    this.lastEventAt = now;
    const type = typeof body.type === "string" ? body.type : "";
    if (type === "plugin.configured" && body.data && typeof body.data.settings === "object" && body.data.settings) {
      this.rec.settings = body.data.settings as Record<string, unknown>;
      this.apiKey = null; this.said.delete("settings");
    }
    this.save();
    return type.startsWith("booking.") || type === "plugin.configured" ? "read" : "ignored";
  }

  // ---- Reading the club ----

  /** Reads the club through the door: its settings, which camera films which court, and (with tell_cameras on) the
   *  bookings on those courts today and tomorrow. Then matches what's waiting, shows what isn't shown yet, and tells the
   *  vendor what changed. */
  async reconcile(now: number): Promise<void> {
    try {
      await this.readCourts();
      const s = parseSettings(this.rec.settings);
      if (s.tell) {
        const want = new Map<string, Session>();
        for (const loc of [...new Set([...this.cams!.values()].map((c) => c.location))]) {
          const today = await this.door.call<Day>("day", { location_id: loc });
          const day = today.today ?? today.date;
          if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new DoorError("door_error", "the day's read has no date");
          if (today.time_zone) this.zones.set(loc, today.time_zone);
          const tomorrow = await this.door.call<Day>("day", { location_id: loc, date: nextDate(day) });
          for (const [camera, c] of this.cams!) {
            if (c.location !== loc) continue;
            for (const h of [...(today.courts?.find((x) => x.id === c.court)?.items ?? []), ...(tomorrow.courts?.find((x) => x.id === c.court)?.items ?? [])]) {
              if (h.kind !== "booking" || h.status === "cancelled" || !h.booking_id || Date.parse(h.end) <= now) continue;
              want.set(h.booking_id, { id: sessionId(this.key(), h.booking_id), camera, starts_at: new Date(h.start).toISOString(), ends_at: new Date(h.end).toISOString() });
            }
          }
        }
        this.desired = want;
      } else this.desired = new Map();
      this.readAt = now; this.reconcileError = null; this.said.delete("door");
    } catch (e) {
      this.reconcileError = e instanceof DoorError ? e.code : "error";
      this.once("door", "warn", "couldn't read the club; trying again on the next read", { code: this.reconcileError, error: (e as Error).message });
    }
    this.lastReconcileAt = now;
    if (this.reconcileError === null) {
      await this.retryWaiting(now);
      await this.showAll(now);
    }
    this.save();
    await this.tick(now);
  }

  /** The key a booking's session id is made with: the plugin's own hook secret, which only it and the club hold. */
  private key(): string { return this.rec.hookSecret || this.rec.door.token; }

  /** The settings (from the club) and the cameras on the courts they name. */
  private async readCourts(): Promise<void> {
    const mine = await this.door.call<{ settings?: Record<string, unknown> }>("plugin_settings");
    if (mine && typeof mine.settings === "object" && mine.settings) this.rec.settings = mine.settings;
    const s = parseSettings(this.rec.settings);
    if (s.problems.length) this.once("settings", "warn", "some of the plugin's settings don't read", { problems: s.problems });
    const all = await this.door.call<{ id: string; name: string; location_id: string }[]>("courts");
    const cams = new Map<string, Cam>();
    for (const c of (Array.isArray(all) ? all : []).filter((x) => s.courts.includes(x.id))) {
      const cam = cameraFor(c, s);
      if (!cam) continue;
      if (cams.has(cam)) { this.once(`twice:${cam}`, "warn", "two courts name the same camera; the first keeps it", { camera: cam }); continue; }
      cams.set(cam, { court: c.id, name: c.name, location: c.location_id });
    }
    this.cams = cams;
  }

  // ---- What the vendor posts ----

  /** What the vendor posted to the club's /plugins/<name>/hook (the club's signature already checked): the vendor's
   *  own signature, then each notice matched and shown. The answer goes back to the vendor. */
  async hook(headers: Record<string, string>, raw: string, now: number): Promise<{ status: number; body: unknown }> {
    this.lastHookAt = now;
    let secret = await this.secret("CAMERA_WEBHOOK_SECRET").catch((e) => e as DoorError);
    if (secret instanceof DoorError) return { status: 503, body: { ok: false, error: "club_unreachable" } };
    if (!secret) { this.once("no_secret", "warn", "a camera posted, but the club's vault has no CAMERA_WEBHOOK_SECRET yet"); return { status: 503, body: { ok: false, error: "not_set_up" } }; }
    const t = Math.floor(now / 1000);
    if (!this.adapter.verify(headers, raw, secret, t)) {
      // The owner may have put a new secret in the vault: read it again once.
      this.vendorSecret = null;
      secret = await this.secret("CAMERA_WEBHOOK_SECRET").catch(() => null);
      if (!secret || !this.adapter.verify(headers, raw, secret, t)) { this.log("warn", "a camera notice's signature didn't check; refused", { club: this.rec.club.url }); return { status: 401, body: { ok: false, error: "bad_signature" } }; }
    }
    this.said.delete("no_secret");
    let notices: Notice[];
    try { notices = this.adapter.parse(raw); } catch (e) { return { status: 400, body: { ok: false, error: "bad_body", detail: (e as Error).message } }; }
    const results: { id: string; result: Outcome }[] = [];
    for (const n of notices) results.push({ id: n.id, result: await this.take(n, now) });
    this.save();
    return { status: 200, body: { ok: true, results } };
  }

  /** One notice: its court from its camera, its booking from the court's day, then the game's card. */
  async take(n: Notice, now: number, waited: { got: number; tries: number } | null = null): Promise<Outcome> {
    const at = momentOf(n.start, n.end);
    if (at < now - MAX_AGE_MS || at > now + FUTURE_MS) { this.log("info", "a camera notice too far from now; dropped", { club: this.rec.club.url, notice: n.id }); return at < now ? "too_old" : "future"; }
    const wait = (): Outcome => {
      const w = waited ?? { got: now, tries: 0 };
      this.rec.waiting = [...this.rec.waiting.filter((x) => x.notice.id !== n.id), { notice: n, got: w.got, tries: w.tries + 1 }].slice(-WAITING_KEPT);
      return "waiting";
    };
    try {
      if (!this.cams) await this.readCourts();
      let cam = this.cams!.get(n.camera);
      if (!cam && !waited) { await this.readCourts(); cam = this.cams!.get(n.camera); }   // a court just set up
      if (!cam) { this.once(`camera:${n.camera}`, "warn", "a notice from a camera the settings don't give a court; dropped", { camera: n.camera }); return "unknown_camera"; }
      const tz = await this.zoneOf(cam.location);
      const dates = [...new Set([dateIn(at - LATE_MS, tz), dateIn(at, tz), dateIn(at + EARLY_MS, tz)])];
      const items: Held[] = [];
      for (const date of dates) {
        const d = await this.door.call<Day>("day", { location_id: cam.location, date });
        items.push(...(d.courts?.find((x) => x.id === cam!.court)?.items ?? []));
      }
      const booking = matchBooking(items, at, { session: n.session, key: this.key() });
      this.rec.waiting = this.rec.waiting.filter((x) => x.notice.id !== n.id);
      if (!booking) { this.log("info", "a camera notice for a time nobody had the court; dropped", { club: this.rec.club.url, camera: n.camera, notice: n.id, at: iso(at) }); return "empty"; }
      this.keep(booking, n, now);
      const shown = await this.show(booking, now);
      this.log("info", n.kind === "highlight" ? "a highlight matched to a game" : "a game's stats matched", { club: this.rec.club.url, booking, notice: n.id, shown });
      return shown ? "shown" : "matched";
    } catch (e) {
      if (!(e instanceof DoorError)) throw e;
      this.once("door", "warn", "couldn't read the club to match a camera notice; it waits for the next read", { code: e.code, error: e.message });
      return wait();
    }
  }

  private async zoneOf(location: string): Promise<string> {
    const z = this.zones.get(location);
    if (z) return z;
    const d = await this.door.call<Day>("day", { location_id: location });
    const tz = d.time_zone || this.rec.club.time_zone || "UTC";
    this.zones.set(location, tz);
    return tz;
  }

  private keep(booking: string, n: Notice, now: number) {
    const g: Game = this.rec.games[booking] ?? { clips: [], stats: null, at: now, shown: false };
    if (n.kind === "highlight" && n.url) g.clips = [...g.clips.filter((c) => c.id !== n.id), { id: n.id, url: n.url, seconds: n.seconds, start: n.start }].slice(-CLIPS_PER_GAME);
    if (n.kind === "stats") g.stats = { id: n.id, url: n.url, stats: n.stats };
    g.at = now; g.shown = false;
    this.rec.games[booking] = g;
    const ids = Object.keys(this.rec.games);
    if (ids.length > GAMES_KEPT) for (const id of ids.sort((a, b) => this.rec.games[a]!.at - this.rec.games[b]!.at).slice(0, ids.length - GAMES_KEPT)) delete this.rec.games[id];
  }

  private async retryWaiting(now: number) {
    const list = this.rec.waiting.filter((w) => now - w.got <= WAITING_MS);
    if (list.length < this.rec.waiting.length) this.log("warn", "camera notices waited too long for the club's door; dropped", { club: this.rec.club.url, dropped: this.rec.waiting.length - list.length });
    this.rec.waiting = list;
    for (const w of list) {
      let out: Outcome;
      try { out = await this.take(w.notice, now, w); }
      catch (e) { this.rec.waiting = this.rec.waiting.filter((x) => x !== w); this.log("warn", "a waiting camera notice couldn't be read; dropped", { club: this.rec.club.url, notice: w.notice.id, error: (e as Error).message }); continue; }
      if (out === "waiting") break;   // the door went again: wait for the next read
    }
  }

  // ---- The game's card ----

  /** Puts a game's card. False when the club didn't take it (it shows no plugin cards, or the door failed): it's tried
   *  again on the next read. */
  private async show(booking: string, now: number): Promise<boolean> {
    const g = this.rec.games[booking];
    if (!g) return false;
    if (this.cards.state === "no" && now - this.cards.checkedAt < CARDS_RECHECK_MS) return false;
    const card = cardFor(g.clips, g.stats);
    try {
      await this.change("plugin_card_put", { slot: "game", subject: booking, tone: card.tone, rows: card.rows, ...(card.link ? { link: card.link } : {}) });
      g.shown = true; this.cards.state = "yes"; this.said.delete("cards");
      return true;
    } catch (e) {
      if (e instanceof DoorError && e.code === "no_tool") {
        if (this.cards.state !== "no") this.log("info", "the club doesn't show plugin cards yet; clips are kept for when it does", { club: this.rec.club.url });
        this.cards = { state: "no", checkedAt: now };
        return false;
      }
      if (e instanceof DoorError && e.code === "error.plugin_card_subject") { delete this.rec.games[booking]; return false; }   // the booking is gone
      this.once("cards", "warn", "couldn't put a game's card; trying again on the next read", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
      return false;
    }
  }
  private async showAll(now: number) {
    for (const [id, g] of Object.entries(this.rec.games)) if (!g.shown && !(await this.show(id, now)) && this.cards.state === "no") break;
  }

  /** A change through the door: its preview, then its confirm. */
  private async change(base: string, args: Record<string, unknown>): Promise<void> {
    const p = await this.door.call<{ run_id?: string; status?: string }>(`${base}_preview`, args);
    if (!p?.run_id) throw new DoorError("door_error", `${base}_preview gave no run_id`);
    if (p.status === "awaiting_approval") throw new DoorError("door_error", `${base} waits for a person's yes`);
    await this.door.call(`${base}_confirm`, { run_id: p.run_id });
  }

  /** One of the plugin's keys from the club's vault, through the door (kept in memory, never logged). Null when the
   *  owner hasn't added it; a DoorError when the door doesn't answer. */
  private async secret(name: "CAMERA_WEBHOOK_SECRET" | "CAMERA_API_KEY"): Promise<string | null> {
    if (name === "CAMERA_WEBHOOK_SECRET" && this.vendorSecret) return this.vendorSecret;
    if (name === "CAMERA_API_KEY" && this.apiKey) return this.apiKey;
    let v: string | null = null;
    try {
      const k = await this.door.call<{ value?: string }>("plugin_secret", { name });
      v = typeof k?.value === "string" && k.value ? k.value : null;
    } catch (e) {
      if (e instanceof DoorError && e.code === "error.plugin_secret_missing") return null;
      throw e;
    }
    if (name === "CAMERA_WEBHOOK_SECRET") this.vendorSecret = v; else this.apiKey = v;
    return v;
  }

  // ---- Telling the cameras ----

  /** What the vendor should know against what it was told: new and moved bookings sent, cancelled ones taken back
   *  (only on a fresh read), finished ones forgotten. Waits after a failure, longer each time. */
  async tick(now: number): Promise<void> {
    const s = parseSettings(this.rec.settings);
    const told = this.rec.told;
    for (const [id, t] of Object.entries(told)) if (Date.parse(t.ends_at) <= now && !this.desired?.has(id)) delete told[id];
    if (!this.desired) return;
    const fresh = this.readAt !== null && now - this.readAt <= FRESH_MS;
    const ups = [...this.desired].filter(([id, x]) => { const t = told[id]; return !t || t.session !== x.id || t.camera !== x.camera || t.starts_at !== x.starts_at || t.ends_at !== x.ends_at; });
    const offs = fresh ? Object.entries(told).filter(([id]) => !this.desired!.has(id)) : [];
    if (!ups.length && !offs.length) { if (!s.tell) this.vendor.problem = null; return; }
    if (now < this.vendor.retryAt) return;
    if (!this.adapter.tell) { this.vendor.problem = "no_adapter"; this.once("no_adapter", "warn", `the ${this.adapter.name} adapter can't tell cameras about bookings`); return; }
    if (!s.vendorUrl) { this.vendor.problem = "no_address"; return; }
    let key: string | null;
    try { key = await this.secret("CAMERA_API_KEY"); } catch { return; }   // the door: on the next read
    if (!key) { this.vendor.problem = "no_key"; this.once("no_key", "warn", "tell_cameras is on, but the club's vault has no CAMERA_API_KEY yet"); return; }
    this.said.delete("no_key");
    const o = { baseUrl: s.vendorUrl, apiKey: key, fetch: this.fetchImpl, timeoutMs: VENDOR_TIMEOUT_MS };
    try {
      for (const [id, x] of ups) {
        // Moved to a court whose camera is another: the old camera's session is taken back first.
        const t = told[id];
        if (t && t.camera !== x.camera) await this.adapter.tell(o, "cancel", { id: t.session, camera: t.camera, starts_at: t.starts_at, ends_at: t.ends_at });
        await this.adapter.tell(o, "upsert", x);
        told[id] = { session: x.id, camera: x.camera, starts_at: x.starts_at, ends_at: x.ends_at };
      }
      for (const [id, t] of offs) {
        if (Date.parse(t.ends_at) > now) await this.adapter.tell(o, "cancel", { id: t.session, camera: t.camera, starts_at: t.starts_at, ends_at: t.ends_at });
        delete told[id];
      }
      if (this.vendor.problem) this.log("info", "the camera system answers again", { club: this.rec.club.url });
      this.vendor = { problem: null, lastOkAt: now, attempts: 0, retryAt: 0 };
      this.said.delete("vendor");
    } catch (e) {
      const refused = e instanceof VendorError && (e.status === 401 || e.status === 403);
      if (refused) this.apiKey = null;   // read again: the owner may have added a new one
      const attempts = this.vendor.attempts + 1;
      this.vendor = { ...this.vendor, problem: refused ? "refused" : "unreachable", attempts, retryAt: now + backoff(attempts) };
      this.once("vendor", "warn", refused ? "the camera system refused the API key" : "the camera system isn't answering; trying again", { error: (e as Error).message, retry_in_s: backoff(attempts) / 1000 });
    }
    this.save();
  }

  health(): ClubHealth {
    const s = parseSettings(this.rec.settings);
    return { last_event_at: iso(this.lastEventAt), last_hook_at: iso(this.lastHookAt), last_reconcile_at: iso(this.lastReconcileAt), reconcile_error: this.reconcileError,
      cameras: this.cams?.size ?? 0, games_shown: Object.values(this.rec.games).filter((g) => g.shown).length, waiting: this.rec.waiting.length,
      vendor: { told: s.tell, reachable: !s.tell ? null : this.vendor.problem === "unreachable" || this.vendor.problem === "refused" ? false : this.vendor.lastOkAt !== null ? true : null,
        problem: s.tell ? this.vendor.problem : null, last_ok_at: iso(this.vendor.lastOkAt) } };
  }
  /** Working: the club read recently, and (when it tells the cameras) the vendor answering. */
  healthy(now: number): boolean {
    if (this.readAt === null || now - this.readAt > FRESH_MS) return this.lastReconcileAt === null;
    return this.health().vendor.reachable !== false;
  }
}
