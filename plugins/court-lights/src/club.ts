// One club's lights: read its schedule through the door, work out when each court's lights should be on, tell Home
// Assistant at each change, and show each court's state on its tile (plugin.card_put).
//
// Events only say "something changed": the schedule is always read again through the door (on start, every few
// minutes, and soon after each event), so a missed event is caught by the next read. Two rules keep the lights safe:
//   - an error never turns lights off during a booking: a failed read keeps the last schedule, and lights are turned off
//     on a schedule read in the last FRESH_MS, or, while the door doesn't answer, CUTOFF_MINUTES after the last booking
//     it knows about on that court ended (so a court isn't lit all night because the club's server is down);
//   - a command Home Assistant didn't take is tried again, the wait doubling from 5 seconds to 5 minutes.
import { door as openDoor, DoorError, type Door, type Fetch } from "./door.ts";
import { HomeAssistantError, ping, setLights } from "./home_assistant.ts";
import type { Log } from "./log.ts";
import { at, entitiesFor, parseSettings, windows, type Held, type Window } from "./schedule.ts";
import type { ClubRecord, Store } from "./store.ts";
import { cardFor, type HaProblem } from "./words.ts";

/** A schedule older than this doesn't turn lights off. */
export const FRESH_MS = 15 * 60_000;
/** On start, a court whose lights it can't remember turning on is turned off if a booking ended this recently. */
export const CATCH_UP_MS = 3 * 3600_000;
/** While the club's door doesn't answer, lights still go off this long after the last booking it knows about ended. */
export const CUTOFF_MINUTES = 120, CUTOFF_MS = CUTOFF_MINUTES * 60_000;
export const SEEN_KEPT = 500;
const CARDS_RECHECK_MS = 3600_000, CARD_RETRY_MS = 5 * 60_000;
const backoff = (n: number) => Math.min(5_000 * 2 ** Math.max(0, n - 1), 300_000);

interface Court { name: string; timeZone: string; entities: string[]; windows: Window[] }
interface Day { date?: string; today?: string; time_zone?: string; courts?: { id: string; items?: Held[] }[] }

export interface ClubHealth { last_event_at: string | null; last_reconcile_at: string | null; reconcile_error: string | null; home_assistant: { reachable: boolean | null; problem: HaProblem; last_ok_at: string | null }; courts: number; on: number }

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const nextDate = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };

export class ClubRunner {
  rec: ClubRecord;
  private door: Door;
  private fetchImpl: Fetch;
  private store: Store;
  private log: Log;
  private schedule: Map<string, Court> | null = null;
  private readAt: number | null = null;
  private haToken: string | null = null;
  private ha: { problem: HaProblem; lastOkAt: number | null } = { problem: null, lastOkAt: null };
  private lastEventAt: number | null = null;
  private lastReconcileAt: number | null = null;
  private reconcileError: string | null = null;
  private pending = new Map<string, { want: "on" | "off"; attempts: number; nextAt: number }>();
  private shown = new Map<string, string>();
  private cards: { state: "unknown" | "yes" | "no"; checkedAt: number; retryAt: number } = { state: "unknown", checkedAt: 0, retryAt: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  private said = new Set<string>();

  constructor(rec: ClubRecord, o: { fetch: Fetch; store: Store; log: Log }) {
    this.rec = rec; this.fetchImpl = o.fetch; this.store = o.store; this.log = o.log;
    this.door = openDoor(rec.door.mcp, rec.door.token, o.fetch);
  }

  /** A new registration for the same club (a new token after the club's address changed, or a reinstall). */
  replace(rec: ClubRecord): void {
    this.rec = { ...rec, commanded: this.rec.commanded, seen: this.rec.seen };
    this.door = openDoor(rec.door.mcp, rec.door.token, this.fetchImpl);
    this.haToken = null;
    this.save();
  }

  /** Work is done one thing at a time: an event's read never races the timer's. */
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
      this.haToken = null;   // a new address may come with a new key; read it again
      this.said.delete("settings");
    }
    this.save();
    return type.startsWith("booking.") || type.startsWith("court.") || type === "plugin.configured" ? "read" : "ignored";
  }

  /** Reads the club's schedule and settings through the door, then acts on them. */
  async reconcile(now: number): Promise<void> {
    try {
      const mine = await this.door.call<{ settings?: Record<string, unknown>; status?: string }>("plugin_settings");
      if (mine && typeof mine.settings === "object" && mine.settings) this.rec.settings = mine.settings;
      const s = parseSettings(this.rec.settings);
      if (s.problems.length) this.once("settings", "warn", "some of the plugin's settings don't read", { problems: s.problems });
      const all = await this.door.call<{ id: string; name: string; location_id: string }[]>("courts");
      const lit = (Array.isArray(all) ? all : []).filter((c) => s.courts.includes(c.id));
      const missing = s.courts.filter((id) => !lit.some((c) => c.id === id));
      if (missing.length) this.once(`missing:${missing.join()}`, "warn", "some courts in the settings aren't at the club any more", { courts: missing });
      const sched = new Map<string, Court>();
      for (const loc of [...new Set(lit.map((c) => c.location_id))]) {
        const today = await this.door.call<Day>("day", { location_id: loc });
        const day = today.today ?? today.date;
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new DoorError("door_error", "the day's read has no date");
        const tomorrow = await this.door.call<Day>("day", { location_id: loc, date: nextDate(day) });
        const tz = today.time_zone || this.rec.club.time_zone || "UTC";
        for (const c of lit.filter((x) => x.location_id === loc)) {
          const items = [...(today.courts?.find((x) => x.id === c.id)?.items ?? []), ...(tomorrow.courts?.find((x) => x.id === c.id)?.items ?? [])];
          const uniq = [...new Map(items.map((h) => [`${h.kind}|${h.start}|${h.end}`, h])).values()];
          sched.set(c.id, { name: c.name, timeZone: tz, entities: entitiesFor(c, s), windows: windows(uniq, s.before, s.after) });
        }
      }
      this.schedule = sched; this.readAt = now; this.reconcileError = null;
      this.said.delete("door");
      this.cards.retryAt = 0;   // the door answers again: the tiles can catch up now
      await this.checkHomeAssistant(s.homeAssistantUrl, now);
    } catch (e) {
      this.reconcileError = e instanceof DoorError ? e.code : "error";
      // Said once until the door answers again; the lights keep the last schedule meanwhile.
      this.once("door", "warn", "couldn't read the club's schedule; keeping the last one", { code: this.reconcileError, error: (e as Error).message });
    }
    this.lastReconcileAt = now;
    this.save();
    await this.tick(now);
  }

  /** The Home Assistant key through the door (never logged), and whether Home Assistant answers with it. */
  private async checkHomeAssistant(url: string | null, now: number): Promise<void> {
    if (!url) { this.ha.problem = "no_address"; return; }
    if (!this.haToken) {
      try {
        const k = await this.door.call<{ value?: string }>("plugin_secret", { name: "HA_TOKEN" });
        this.haToken = typeof k?.value === "string" && k.value ? k.value : null;
      } catch (e) {
        if (e instanceof DoorError && e.code === "error.plugin_secret_missing") { this.ha.problem = "no_token"; return; }
        throw e;
      }
      if (!this.haToken) { this.ha.problem = "no_token"; return; }
    }
    try { await ping(url, this.haToken, this.fetchImpl); this.haOk(now); }
    catch (e) { this.haFailed(e); }
  }
  private haOk(now: number) {
    if (this.ha.problem) this.log("info", "Home Assistant answers again", { club: this.rec.club.url });
    this.ha = { problem: null, lastOkAt: now }; this.said.delete("ha");
  }
  private haFailed(e: unknown) {
    const refused = e instanceof HomeAssistantError && (e.status === 401 || e.status === 403);
    if (refused) this.haToken = null;   // read again: the owner may have added a new one
    this.ha.problem = refused ? "refused" : "unreachable";
    this.once("ha", "warn", refused ? "Home Assistant refused the access token" : "Home Assistant isn't answering", { error: (e as Error).message });
  }

  /** What should be on now, against what it last told Home Assistant; then the tiles. */
  async tick(now: number): Promise<void> {
    if (!this.schedule) return;   // never read: nothing to go on, and nothing is turned off
    const fresh = this.readAt !== null && now - this.readAt <= FRESH_MS;
    for (const [id, c] of this.schedule) {
      const st = at(c.windows, now), prev = this.rec.commanded[id];
      let want: "on" | "off" | null = null;
      if (st.on && prev?.state !== "on") want = "on";
      else if (st.on && prev?.state === "on" && c.entities.some((e) => !prev.entities.includes(e))) want = "on";   // a light added to the court
      else if (!st.on && prev?.state === "on") {
        // Off on a fresh read; on an old one only once the last known booking is CUTOFF_MINUTES behind (or, with none
        // known, CUTOFF_MINUTES after it turned them on).
        const since = st.lastEnded ?? Date.parse(prev.at);
        const cutoff = !fresh && Number.isFinite(since) && now - since >= CUTOFF_MS;
        want = fresh || cutoff ? "off" : null;
        if (cutoff) this.once(`cutoff:${id}`, "warn", "the club's door hasn't answered; turning a court's lights off after the cutoff", { court: id, cutoff_minutes: CUTOFF_MINUTES });
      }
      else if (!st.on && !prev && fresh && st.lastEnded !== null && now - st.lastEnded < CATCH_UP_MS) want = "off";
      if (want) await this.command(id, want, want === "off" && prev ? [...new Set([...prev.entities, ...c.entities])] : c.entities, now);
      else this.pending.delete(id);
    }
    // A court taken out of the settings whose lights it turned on: off, once the club has been read since.
    if (fresh) for (const [id, prev] of Object.entries(this.rec.commanded)) {
      if (this.schedule.has(id)) continue;
      if (prev.state === "on") await this.command(id, "off", prev.entities, now);
      if (this.rec.commanded[id]?.state !== "on") delete this.rec.commanded[id];
    }
    this.save();
    await this.showCards(now);
  }

  private async command(id: string, want: "on" | "off", entities: string[], now: number): Promise<void> {
    const p = this.pending.get(id);
    if (p && p.want === want && p.nextAt > now) return;
    const attempts = p && p.want === want ? p.attempts + 1 : 1;
    const url = parseSettings(this.rec.settings).homeAssistantUrl;
    const retry = () => { this.pending.set(id, { want, attempts, nextAt: now + backoff(attempts) }); };
    if (!entities.length) return;
    if (!url) { this.ha.problem = "no_address"; return retry(); }
    if (!this.haToken) {
      try { await this.checkHomeAssistant(url, now); } catch { /* the door: tried again on the next read */ }
      if (!this.haToken) { this.ha.problem ??= "no_token"; return retry(); }
    }
    try {
      await setLights(url, this.haToken, want === "on" ? "turn_on" : "turn_off", entities, this.fetchImpl);
      this.rec.commanded[id] = { state: want, at: new Date(now).toISOString(), entities };
      this.pending.delete(id);
      this.haOk(now);
      this.log("info", want === "on" ? "lights on" : "lights off", { club: this.rec.club.url, court: id, entities });
    } catch (e) { this.haFailed(e); retry(); }
  }

  /** Each court's tile, put again only when what it says changes. A club whose door doesn't offer cards yet is asked
   *  again hourly; the lights work the same without them. */
  private async showCards(now: number): Promise<void> {
    if (!this.schedule) return;
    if (this.cards.state === "no" && now - this.cards.checkedAt < CARDS_RECHECK_MS) return;
    if (now < this.cards.retryAt) return;
    try {
      for (const [id, c] of this.schedule) {
        const st = at(c.windows, now), prev = this.rec.commanded[id];
        const on = prev?.state === "on";
        const card = cardFor({ on, until: on && st.on ? st.until : null, next: st.next, now, timeZone: c.timeZone, entities: c.entities, problem: this.ha.problem });
        const key = JSON.stringify(card);
        if (this.shown.get(id) === key) continue;
        await this.change("plugin_card_put", { slot: "court_tile", subject: id, tone: card.tone, rows: card.rows });
        this.shown.set(id, key);
      }
      for (const id of [...this.shown.keys()]) {
        if (this.schedule.has(id)) continue;
        await this.change("plugin_card_clear", { slot: "court_tile", subject: id });
        this.shown.delete(id);
      }
      this.cards.state = "yes";
    } catch (e) {
      if (e instanceof DoorError && e.code === "no_tool") {
        if (this.cards.state !== "no") this.log("info", "the club doesn't show plugin cards yet; the lights work without them", { club: this.rec.club.url });
        this.cards = { state: "no", checkedAt: now, retryAt: 0 };
        return;
      }
      this.cards.retryAt = now + CARD_RETRY_MS;
      this.once("cards", "warn", "couldn't show a court's tile", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
    }
  }
  /** A change through the door: its preview, then its confirm. */
  private async change(base: string, args: Record<string, unknown>): Promise<void> {
    const p = await this.door.call<{ run_id?: string; status?: string }>(`${base}_preview`, args);
    if (!p?.run_id) throw new DoorError("door_error", `${base}_preview gave no run_id`);
    if (p.status === "awaiting_approval") throw new DoorError("door_error", `${base} waits for a person's yes`);
    await this.door.call(`${base}_confirm`, { run_id: p.run_id });
  }

  health(): ClubHealth {
    let on = 0;
    for (const c of Object.values(this.rec.commanded)) if (c.state === "on") on++;
    return { last_event_at: iso(this.lastEventAt), last_reconcile_at: iso(this.lastReconcileAt), reconcile_error: this.reconcileError,
      home_assistant: { reachable: this.ha.problem === "unreachable" || this.ha.problem === "refused" ? false : this.ha.lastOkAt !== null ? true : null, problem: this.ha.problem, last_ok_at: iso(this.ha.lastOkAt) },
      courts: this.schedule?.size ?? 0, on };
  }
  /** Working: the door read recently and Home Assistant answering (or not set up yet, which doctor says itself). */
  healthy(now: number): boolean {
    const h = this.health();
    if (this.readAt === null || now - this.readAt > FRESH_MS) return this.lastReconcileAt === null;
    return h.home_assistant.reachable !== false;
  }
}
