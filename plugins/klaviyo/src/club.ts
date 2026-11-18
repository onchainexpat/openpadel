// One club's Klaviyo list: the members who said yes to club news by email, read through the door (club_news_list, which
// the club filters on its own server: nobody who said no, never answered, was deleted or is a junior is in it), kept as a
// Klaviyo list with each one's email, first name and language and nothing else.
//
//   - Removals come first. `club_news.left` (they said no, stopped from an email's link or by texting STOP, or their
//     account was deleted) takes them off the list at once; a deleted member's profile is deleted in Klaviyo too. A
//     removal Klaviyo didn't take is kept and tried again every minute, before anything is added.
//   - Then the club's list: read whole through the door (on start, soon after any event, and hourly), and anyone new or
//     changed is put on the list, anyone no longer on the club's list taken off.
//   - Nobody Klaviyo says unsubscribed or suppressed is put back: this plugin never subscribes anyone (it doesn't touch
//     consent in Klaviyo), and a profile Klaviyo shows as out of email marketing isn't added to the list again, comes
//     off it, and is passed back to the club (club_news_unsubscribed_elsewhere) so the member's answer is no there too.
//   - Once a day the whole Klaviyo list is read and checked against the club's: whoever is on it and shouldn't be (a
//     missed event, a lost state file, someone added by hand) is taken off, and whoever is missing put back.
// Events only say "something changed": a missed one is caught by the next read.
import { createHash } from "node:crypto";
import { door as openDoor, DoorError, type Door, type Fetch } from "./door.ts";
import { klaviyo, KlaviyoError, type Klaviyo, type Member } from "./klaviyo.ts";
import type { Log } from "./log.ts";
import type { ClubRecord, Store } from "./store.ts";
import { cardFor, type Problem } from "./words.ts";

/** The club's list read again at least this often. */
export const SYNC_MS = 60 * 60_000;
/** The whole Klaviyo list checked against the club's this often. */
export const FULL_MS = 24 * 3600_000;
export const SEEN_KEPT = 500, MAX_PAGES = 400, BATCH = 100;
const CARDS_RECHECK_MS = 3600_000, CARD_RETRY_MS = 5 * 60_000;

export interface Row extends Member { id: string }
export interface ClubHealth { last_event_at: string | null; last_sync_at: string | null; last_full_check_at: string | null; door_error: string | null;
  klaviyo: { reachable: boolean | null; problem: Problem; last_ok_at: string | null }; members: number; waiting_removals: number }

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const LIST_ID = /^[A-Za-z0-9]{1,40}$/;
/** A fingerprint of what was sent for a member, to tell when it changed (the member's details aren't kept). */
export const fingerprint = (m: Member) => createHash("sha256").update(JSON.stringify([m.email, m.first_name, m.language])).digest("hex").slice(0, 32);

export class ClubRunner {
  rec: ClubRecord;
  private door: Door;
  private o: { fetch: Fetch; store: Store; log: Log; sleep: (ms: number) => Promise<void>; klaviyoUrl?: string };
  private key: string | null = null;
  private problem: Problem = null;
  private privacyRefused = false;
  private listName: string | null = null;
  private lastEventAt: number | null = null;
  private lastTryAt: number | null = null;
  private lastSyncAt: number | null = null;
  private lastOkAt: number | null = null;
  private doorError: string | null = null;
  private shown: string | null = null;
  private cards: { state: "unknown" | "yes" | "no"; checkedAt: number; retryAt: number } = { state: "unknown", checkedAt: 0, retryAt: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  private said = new Set<string>();

  constructor(rec: ClubRecord, o: ClubRunner["o"]) {
    this.rec = rec; this.o = o;
    this.door = openDoor(rec.door.mcp, rec.door.token, o.fetch);
  }

  /** A new registration for the same club (a new token after the club's address changed, or a reinstall). */
  replace(rec: ClubRecord): void {
    this.rec = { ...rec, seen: this.rec.seen, synced: this.rec.synced, listId: this.rec.listId, removals: this.rec.removals, lastFullAt: this.rec.lastFullAt, toReport: this.rec.toReport };
    this.door = openDoor(rec.door.mcp, rec.door.token, this.o.fetch);
    this.key = null;
    this.save();
  }

  /** Work is done one thing at a time: an event's read never races the timer's. */
  serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => {});
    return next;
  }
  idle(): Promise<unknown> { return this.chain; }

  private save(): void { try { this.o.store.save(this.rec); } catch (e) { this.once("save", "warn", "couldn't keep the plugin's state on disk", { error: (e as Error).message }); } }
  private once(key: string, level: "info" | "warn" | "error", msg: string, f: Record<string, unknown> = {}) {
    if (this.said.has(key)) return;
    this.said.add(key); this.o.log(level, msg, { club: this.rec.club.url, ...f });
  }

  /** An event the club sent (its signature already checked). Gives whether to read the club again. */
  event(body: { id?: unknown; type?: unknown; data?: any }, now: number): "duplicate" | "read" | "ignored" {
    const id = typeof body.id === "string" ? body.id : null;
    if (id && this.rec.seen.includes(id)) return "duplicate";
    if (id) { this.rec.seen.push(id); if (this.rec.seen.length > SEEN_KEPT) this.rec.seen.splice(0, this.rec.seen.length - SEEN_KEPT); }
    this.lastEventAt = now;
    const type = typeof body.type === "string" ? body.type : "";
    let out: "read" | "ignored" = "ignored";
    if (type === "club_news.left" && typeof body.data?.person_id === "string") {
      const person = body.data.person_id as string, deleted = body.data.why === "deleted";
      const had = this.rec.removals.find((r) => r.person === person);
      if (had) had.deleted ||= deleted; else this.rec.removals.push({ person, deleted, at: now });
      out = "read";
    } else if (type === "club_news.joined") out = "read";
    else if (type === "plugin.configured" && body.data && typeof body.data.settings === "object" && body.data.settings) {
      this.rec.settings = body.data.settings as Record<string, unknown>;
      this.key = null;
      out = "read";
    }
    this.save();
    return out;
  }

  /** Whether the timer should read now: a removal waiting, or the last read an hour ago. */
  due(now: number): boolean {
    return this.rec.removals.length > 0 || this.lastTryAt === null || now - this.lastTryAt >= SYNC_MS || (this.rec.lastFullAt !== null && now - this.rec.lastFullAt >= FULL_MS);
  }

  /** Takes off whoever is waiting, then reads the club's list and brings the Klaviyo list up to date (whole, once a day). */
  async sync(now: number, o: { full?: boolean } = {}): Promise<void> {
    this.lastTryAt = now;
    try {
      const mine = await this.door.call<{ settings?: Record<string, unknown> }>("plugin_settings");
      if (mine && typeof mine.settings === "object" && mine.settings) this.rec.settings = mine.settings;
      this.doorError = null; this.said.delete("door");
      const listId = typeof this.rec.settings.list_id === "string" ? this.rec.settings.list_id.trim() : "";
      if (!LIST_ID.test(listId)) { this.problem = "no_list"; return; }
      if (!this.key) {
        try {
          const k = await this.door.call<{ value?: string }>("plugin_secret", { name: "KLAVIYO_API_KEY" });
          this.key = typeof k?.value === "string" && k.value ? k.value : null;
        } catch (e) { if (!(e instanceof DoorError && e.code === "error.plugin_secret_missing")) throw e; }
        if (!this.key) { this.problem = "no_key"; return; }
      }
      const k = klaviyo({ key: this.key, fetch: this.o.fetch, sleep: this.o.sleep, base: this.o.klaviyoUrl });
      if (this.rec.listId !== listId) {
        // Another list: everyone is put on it from the start (the old one is left as it is, the club's own).
        if (this.rec.listId) this.o.log("info", "the list changed; putting everyone on the new one", { club: this.rec.club.url });
        this.rec.synced = {}; this.rec.listId = listId; this.rec.lastFullAt = null; this.listName = null;
      }
      this.listName = (await k.list(listId)).name || null;
      await this.takeOff(k, listId);
      await this.report();
      const club = await this.clubList();
      if (o.full || this.rec.lastFullAt === null || now - this.rec.lastFullAt >= FULL_MS) await this.fullCheck(k, listId, club, now);
      else await this.bringUp(k, listId, club);
      this.problem = null; this.lastSyncAt = now; this.lastOkAt = now;
      this.said.delete("klaviyo");
    } catch (e) {
      if (e instanceof DoorError) {
        this.doorError = e.code;
        this.once("door", "warn", "couldn't read the club; trying again", { code: e.code, error: e.message });
      } else if (e instanceof KlaviyoError) {
        this.problem = e.status === 401 || e.status === 403 ? "refused" : e.status === 404 ? "list_missing" : "unreachable";
        if (this.problem === "refused") this.key = null;   // read again: the owner may have added a new one
        this.once("klaviyo", "warn", this.problem === "refused" ? "Klaviyo refused the key" : this.problem === "list_missing" ? "Klaviyo has no list with that id" : "Klaviyo isn't answering",
          { status: e.status, error: e.message });
      } else {
        this.doorError = "error";
        this.once("error", "error", "the sync failed", { error: (e as Error).message });
      }
    } finally {
      this.save();
      await this.showCard(now);
    }
  }

  /** Whoever said no or was deleted, off the list (and a deleted member's profile deleted in Klaviyo), one at a time so
   *  each one done is kept even if the next fails. */
  private async takeOff(k: Klaviyo, listId: string): Promise<void> {
    while (this.rec.removals.length) {
      const r = this.rec.removals[0]!, s = this.rec.synced[r.person];
      if (s) {
        await k.remove(listId, [s.p]);
        if (r.deleted) {
          try { await k.forget(s.p); }
          catch (e) {
            if (!(e instanceof KlaviyoError) || (e.status !== 401 && e.status !== 403)) throw e;
            // The key may not have Data Privacy access: off the list all the same, and the card says so.
            this.privacyRefused = true;
            this.once("privacy", "warn", "Klaviyo refused to delete a deleted member's profile: the key needs Data Privacy access", { status: e.status });
          }
        }
        delete this.rec.synced[r.person];
        this.o.log("info", r.deleted ? "a deleted member taken off the list" : "a member who said no taken off the list", { club: this.rec.club.url, person: r.person });
      } else {
        // Not one it remembers putting there (a lost state file, or someone it never had): the whole list is checked
        // now rather than tomorrow, so they come off by their email if they're on it.
        this.rec.lastFullAt = null;
      }
      this.rec.removals.shift();
      this.save();
    }
  }

  /** The club's list through the door, every page: only members who said yes, each one's email, first name and language. */
  private async clubList(): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    let after: string | null = null;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const b: { members?: unknown[]; next?: unknown } = await this.door.call("club_news_list", after ? { after } : {});
      for (const m of Array.isArray(b?.members) ? b.members as any[] : []) {
        if (typeof m?.id !== "string" || typeof m.email !== "string" || !m.email.includes("@")) continue;
        out.set(m.id, { id: m.id, email: m.email.trim().toLowerCase(), first_name: typeof m.first_name === "string" ? m.first_name.slice(0, 100) : "", language: m.language === "es" ? "es" : "en" });
      }
      if (typeof b?.next !== "string" || !b.next) return out;
      after = b.next;
    }
    throw new DoorError("door_error", "the club's list didn't end");
  }

  /** Off the Klaviyo list whoever left the club's; on it whoever is new or changed. */
  private async bringUp(k: Klaviyo, listId: string, club: Map<string, Row>): Promise<void> {
    const gone = Object.keys(this.rec.synced).filter((id) => !club.has(id));
    if (gone.length) {
      await k.remove(listId, gone.map((id) => this.rec.synced[id]!.p));
      for (const id of gone) delete this.rec.synced[id];
      this.save();
      this.o.log("info", "members no longer on the club's list taken off", { club: this.rec.club.url, count: gone.length });
    }
    const todo = [...club.values()].filter((m) => this.rec.synced[m.id]?.h !== fingerprint(m) && !this.rec.toReport.includes(m.id));
    let added = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const done: { m: Row; p: string; old: string | null }[] = [], left: string[] = [];
      for (const m of todo.slice(i, i + BATCH)) {
        const u = await k.upsert(m), old = this.rec.synced[m.id]?.p ?? null;
        // Out of email marketing in Klaviyo: never put back; off the list if it was there, and the club told.
        if (u.out) { left.push(...new Set([u.id, ...(old ? [old] : [])])); delete this.rec.synced[m.id]; this.rec.toReport.push(m.id); continue; }
        done.push({ m, p: u.id, old });
      }
      if (left.length) await k.remove(listId, left);
      if (done.length) await k.add(listId, done.map((d) => d.p));
      // A new email is a new profile in Klaviyo: the old one comes off.
      const stale = done.filter((d) => d.old && d.old !== d.p).map((d) => d.old!);
      if (stale.length) await k.remove(listId, stale);
      for (const d of done) this.rec.synced[d.m.id] = { p: d.p, h: fingerprint(d.m) };
      added += done.length;
      this.save();
    }
    await this.report();
    if (added) this.o.log("info", "members put on the list or brought up to date", { club: this.rec.club.url, count: added });
  }

  /** The whole Klaviyo list against the club's: anyone on it who isn't on the club's comes off; anyone missing goes on. */
  private async fullCheck(k: Klaviyo, listId: string, club: Map<string, Row>, now: number): Promise<void> {
    const on = await k.onList(listId), emails = new Set([...club.values()].map((m) => m.email));
    // Whoever left email marketing in Klaviyo comes off the list too, and the club hears of the members among them.
    const strangers = [...on].filter(([email, p]) => !emails.has(email) || p.out).map(([, p]) => p.id);
    for (const m of club.values()) if (on.get(m.email)?.out && !this.rec.toReport.includes(m.id)) this.rec.toReport.push(m.id);
    if (strangers.length) {
      await k.remove(listId, strangers);
      this.o.log("info", "the daily check took off people who aren't on the club's list", { club: this.rec.club.url, count: strangers.length });
    }
    const synced: ClubRecord["synced"] = {};
    for (const m of club.values()) {
      const o = on.get(m.email), had = this.rec.synced[m.id];
      // On the list already: kept as it is when it's the profile it put there, else sent again to bring it up to date.
      if (o && !o.out) synced[m.id] = { p: o.id, h: had?.p === o.id ? had.h : "" };
    }
    this.rec.synced = synced;
    this.save();
    await this.bringUp(k, listId, club);
    this.rec.lastFullAt = now;
  }

  /** Tells the club each member Klaviyo says unsubscribed or is suppressed, so their answer to club news is no there too.
   *  One already no (nothing_changed) is done; one the door didn't take is tried again on the next read. */
  private async report(): Promise<void> {
    while (this.rec.toReport.length) {
      const person = this.rec.toReport[0]!;
      try {
        const p = await this.door.call<{ run_id?: string; status?: string }>("club_news_unsubscribed_elsewhere_preview", { person_id: person, service: "Klaviyo" });
        if (!p?.run_id || p.status === "awaiting_approval") throw new DoorError("door_error", "club_news_unsubscribed_elsewhere wasn't planned");
        await this.door.call("club_news_unsubscribed_elsewhere_confirm", { run_id: p.run_id });
        this.o.log("info", "a member who unsubscribed in Klaviyo passed back to the club", { club: this.rec.club.url, person });
      } catch (e) {
        if (!(e instanceof DoorError) || !["error.nothing_changed", "no_tool"].includes(e.code)) throw e;
        if (e.code === "no_tool") this.once("report", "warn", "the club can't hear of unsubscribes from Klaviyo yet; they stay off the list", { club: this.rec.club.url });
      }
      this.rec.toReport.shift();
      this.save();
    }
  }

  /** The Connectors card, put again only when what it says changes. A club whose door doesn't offer cards yet is asked
   *  again hourly; the list is kept the same without it. */
  private async showCard(now: number): Promise<void> {
    if (this.cards.state === "no" && now - this.cards.checkedAt < CARDS_RECHECK_MS) return;
    if (now < this.cards.retryAt) return;
    const card = cardFor({ members: Object.keys(this.rec.synced).length, listName: this.listName, checkedAt: this.rec.lastFullAt, timeZone: this.rec.club.time_zone || "UTC",
      problem: this.problem, waiting: this.rec.removals.length, privacyRefused: this.privacyRefused });
    const key = JSON.stringify(card);
    if (key === this.shown) return;
    try {
      const p = await this.door.call<{ run_id?: string; status?: string }>("plugin_card_put_preview", { slot: "connectors", tone: card.tone, rows: card.rows });
      if (!p?.run_id) throw new DoorError("door_error", "plugin_card_put_preview gave no run_id");
      if (p.status === "awaiting_approval") throw new DoorError("door_error", "plugin_card_put waits for a person's yes");
      await this.door.call("plugin_card_put_confirm", { run_id: p.run_id });
      this.shown = key; this.cards.state = "yes";
    } catch (e) {
      if (e instanceof DoorError && e.code === "no_tool") {
        if (this.cards.state !== "no") this.o.log("info", "the club doesn't show plugin cards yet; the list is kept without one", { club: this.rec.club.url });
        this.cards = { state: "no", checkedAt: now, retryAt: 0 };
        return;
      }
      this.cards.retryAt = now + CARD_RETRY_MS;
      this.once("cards", "warn", "couldn't show the plugin's card", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
    }
  }

  health(): ClubHealth {
    const down = this.problem === "unreachable" || this.problem === "refused";
    return { last_event_at: iso(this.lastEventAt), last_sync_at: iso(this.lastSyncAt), last_full_check_at: iso(this.rec.lastFullAt), door_error: this.doorError,
      klaviyo: { reachable: down ? false : this.lastOkAt !== null ? true : null, problem: this.problem, last_ok_at: iso(this.lastOkAt) },
      members: Object.keys(this.rec.synced).length, waiting_removals: this.rec.removals.length };
  }
  /** Working: Klaviyo answering with its key and the list there, and the club read in the last two hours (or not tried
   *  yet). Waiting for its key or its list's id isn't "down": doctor names the missing key itself. */
  healthy(now: number): boolean {
    if (this.problem === "unreachable" || this.problem === "refused" || this.problem === "list_missing") return false;
    return !(this.doorError && (this.lastSyncAt === null || now - this.lastSyncAt > 2 * SYNC_MS));
  }
}
