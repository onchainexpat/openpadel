// One club's export: once a day, after the club's send time, each club day that's over and not yet sent goes to the
// accounting system as one journal, oldest first; then the last week's days are read again, and a day whose books have
// changed since it was sent gets an adjusting journal of the difference, saying which day it corrects.
//
// Never twice: before a journal is sent, the accounting system is asked for it by its reference (Xero's narration,
// QuickBooks' document number). What's there is what was sent, whatever this plugin remembers; each POST also carries
// an idempotency key. A refresh token from the provider changes on every use: the new one is kept in the club's vault
// through the door (plugin_secret_keep) before anything else is done with it, and held here until the door takes it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { addDays, atClub, byKey, checkBalanced, diffLines, localNow, mapLines, parseSettings, refs, addLines, Unbalanced, type Books as DoorBooks, type Journal, type Settings } from "./books.ts";
import { door as openDoor, DoorError, type Door, type Fetch } from "./door.ts";
import type { Log } from "./log.ts";
import { providerFor, ProviderError, type Creds, type Ctx, type Http, type Provider } from "./providers.ts";
import type { Books, ClubRecord, ProviderKind, Store } from "./store.ts";
import { connectorsCard, moneyCard, type Card, type Problem, type State } from "./words.ts";

export const PLUGIN_NAME = "accounting-export";
export const SEEN_KEPT = 500;
/** A connect link's state is good for a day, and a fresh one is made after 12 hours (so the card doesn't change often). */
export const CONNECT_VALID_MS = 24 * 3600_000, CONNECT_RENEW_MS = 12 * 3600_000;
/** Days read again for changes after they were sent. */
export const ADJUST_DAYS = 7;
/** At most this many days in one read of the club's books. */
export const WINDOW_DAYS = 31;
const CARDS_RECHECK_MS = 3600_000, CARD_RETRY_MS = 5 * 60_000;
export const backoff = (n: number) => Math.min(5_000 * 2 ** Math.max(0, n - 1), 300_000);
const FAILING: Problem[] = ["reconnect", "down", "rate", "rejected", "door", "unbalanced", "no_accounts", "stripe_long"];

class NotReady extends Error { problem: Problem; constructor(p: Problem, m: string) { super(m); this.problem = p; } }
/** How long the card provider (Stripe) may not answer for a day's fees and payouts before the cards and health say so.
 *  The day still isn't sent without them, nor any day after it. */
export const STRIPE_WAIT_SAID_MS = 3 * 86400_000;
/** Whether the club couldn't read a day's fees or payouts from the card provider (as opposed to having none). */
const providerMissing = (d: { fees?: string; payouts?: string }) => d.fees === "error" || d.payouts === "error";

export interface ClubHealth { provider: ProviderKind; connected: boolean; last_sent_day: string | null; next_send_at: string | null; failing: string | null }

export class ClubRunner {
  rec: ClubRecord;
  private door: Door;
  private fetchImpl: Fetch;
  private http: Http;
  private store: Store;
  private log: Log;
  private keysAdded: Record<string, boolean> | null = null;
  private secrets = new Map<string, string>();
  private access: { provider: ProviderKind; token: string; until: number } | null = null;
  private problem: Problem = null;
  private detail: string | null = null;
  private attempts = 0;
  private nextTryAt = 0;
  private suspense = 0;
  private shown = new Map<string, string>();
  private cards: { state: "unknown" | "yes" | "no"; checkedAt: number; retryAt: number } = { state: "unknown", checkedAt: 0, retryAt: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  private said = new Set<string>();

  constructor(rec: ClubRecord, o: { fetch: Fetch; http: Http; store: Store; log: Log }) {
    this.rec = rec; this.fetchImpl = o.fetch; this.http = o.http; this.store = o.store; this.log = o.log;
    this.door = openDoor(rec.door.mcp, rec.door.token, o.fetch);
  }

  /** A new registration for the same club: a new token and secrets; what it sent and is connected to stay. */
  replace(rec: ClubRecord): void {
    this.rec = { ...this.rec, club: rec.club, door: rec.door, webhookSecret: rec.webhookSecret, hookSecret: rec.hookSecret, settings: rec.settings };
    this.door = openDoor(rec.door.mcp, rec.door.token, this.fetchImpl);
    this.secrets.clear(); this.access = null;
    this.save();
  }

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
  private settings(): Settings { return parseSettings(this.rec.settings); }
  private provider(): Provider { return providerFor(this.settings().provider, this.http); }
  private booksOf(kind: ProviderKind): Books { return (this.rec.books[kind] ??= { sent: {}, lastSentDay: null, lastRunDate: null }); }
  private clubHash(): string { return createHash("sha256").update(this.rec.club.url).digest("hex").slice(0, 12); }
  redirect(): string { return `${this.rec.club.url}/plugins/${PLUGIN_NAME}/callback`; }

  /** An event the club sent (its signature already checked). Gives whether to read the club again. */
  event(body: { id?: unknown; type?: unknown; data?: any }): "duplicate" | "read" | "ignored" {
    const id = typeof body.id === "string" ? body.id : null;
    if (id && this.rec.seen.includes(id)) return "duplicate";
    if (id) { this.rec.seen.push(id); if (this.rec.seen.length > SEEN_KEPT) this.rec.seen.splice(0, this.rec.seen.length - SEEN_KEPT); }
    const type = typeof body.type === "string" ? body.type : "";
    if (type === "plugin.configured" && body.data && typeof body.data.settings === "object" && body.data.settings) {
      this.rec.settings = body.data.settings as Record<string, unknown>;
      this.access = null;
      this.said.delete("settings");
    }
    this.save();
    return type === "plugin.configured" ? "read" : "ignored";
  }

  /** Reads its settings, which keys the club has, and the club's time zone through the door; then does what's due. */
  async reconcile(now: number): Promise<void> {
    try {
      const mine = await this.door.call<{ settings?: Record<string, unknown>; keys?: { name: string; added: boolean }[] }>("plugin_settings");
      if (mine && typeof mine.settings === "object" && mine.settings) this.rec.settings = mine.settings;
      if (Array.isArray(mine?.keys)) this.keysAdded = Object.fromEntries(mine.keys.map((k) => [k.name, Boolean(k.added)]));
      const s = this.settings();
      if (s.problems.length) this.once("settings", "warn", "some of the plugin's settings don't read", { problems: s.problems });
      // The club's own time zone, from its books (a local plugin isn't told it otherwise).
      const day = localNow(now, this.rec.club.time_zone || "UTC").date;
      const b = await this.door.call<DoorBooks>("money_books", { from: day, to: day });
      if (b?.time_zone) this.rec.club.time_zone = b.time_zone;
      this.said.delete("door");
      if (this.problem === "door") this.problem = null;
    } catch (e) {
      this.once("door", "warn", "couldn't read the plugin's settings from the club", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
    }
    this.save();
    await this.tick(now);
  }

  /** Each minute: keys still to keep, the day's send when it's due, the cards. */
  async tick(now: number): Promise<void> {
    await this.keepHeld();
    await this.job(now);
    await this.showCards(now);
  }

  // ---- Keys: the provider's, through the door ----
  private async secret(name: string): Promise<string | null> {
    const held = this.rec.held.find((h) => h.name === name);
    if (held) return held.value;
    if (this.secrets.has(name)) return this.secrets.get(name)!;
    try {
      const k = await this.door.call<{ value?: string }>("plugin_secret", { name });
      const v = typeof k?.value === "string" && k.value ? k.value : null;
      if (v) this.secrets.set(name, v);
      return v;
    } catch (e) {
      if (e instanceof DoorError && e.code === "error.plugin_secret_missing") return null;
      throw e;
    }
  }
  private async creds(p: Provider): Promise<Creds> {
    const id = await this.secret(p.keys.id), secret = await this.secret(p.keys.secret);
    if (!id || !secret) throw new NotReady("no_keys", "the app's client id or secret isn't in the vault");
    return { id, secret };
  }
  /** Held first (kept on disk where it can be), then kept in the club's vault; held until the door takes it. */
  private hold(name: string, value: string): void {
    this.rec.held = [...this.rec.held.filter((h) => h.name !== name), { name, value }];
    this.secrets.set(name, value);
    if (this.keysAdded) this.keysAdded[name] = true;
    this.save();
  }
  private async keepHeld(): Promise<void> {
    for (const h of [...this.rec.held]) {
      try {
        await this.change("plugin_secret_keep", { name: h.name, value: h.value });
        this.rec.held = this.rec.held.filter((x) => !(x.name === h.name && x.value === h.value));
        this.said.delete(`keep:${h.name}`);
        this.save();
      } catch (e) {
        this.once(`keep:${h.name}`, "warn", "couldn't keep a key in the club's vault yet; holding it and trying again", { key: h.name, code: e instanceof DoorError ? e.code : "error" });
        return;
      }
    }
  }

  private connected(kind: ProviderKind): boolean {
    const p = providerFor(kind, this.http);
    if (this.rec.held.some((h) => h.name === p.keys.refresh)) return true;
    if (this.keysAdded) return Boolean(this.keysAdded[p.keys.refresh]);
    return this.rec.link?.provider === kind;
  }

  /** An access token: the one in memory, or a refresh (whose new refresh token is kept first). */
  private async ctx(now: number): Promise<Ctx> {
    const p = this.provider();
    let link = this.rec.link?.provider === p.kind ? this.rec.link : null;
    if (!this.access || this.access.provider !== p.kind || this.access.until <= now) {
      const c = await this.creds(p);
      const token = await this.secret(p.keys.refresh);
      if (!token) throw new NotReady("reconnect", "not connected");
      let t;
      try { t = await p.refresh(token, c); }
      catch (e) {
        if (e instanceof ProviderError && e.code === "invalid_grant") { this.rec.reconnect = true; this.secrets.delete(p.keys.refresh); this.save(); throw new NotReady("reconnect", "the refresh token was refused"); }
        throw e;
      }
      this.hold(p.keys.refresh, t.refresh);
      await this.keepHeld();
      this.access = { provider: p.kind, token: t.access, until: now + (t.expiresIn - 60) * 1000 };
    }
    const realm = p.keys.realm ? link?.realm ?? await this.secret(p.keys.realm) : null;
    const ctx: Ctx = { access: this.access.token, tenant: link?.tenant ?? null, realm };
    if (p.kind === "xero" && !ctx.tenant) {
      const o = await p.org(ctx);
      if (!o.tenant) throw new ProviderError("rejected", 200, "no organisation is connected");
      this.rec.link = link = { provider: p.kind, org: o.name, tenant: o.tenant, realm: null };
      ctx.tenant = o.tenant; this.save();
    }
    if (p.kind === "quickbooks" && !ctx.realm) throw new NotReady("reconnect", "no QuickBooks company");
    if (!link) { this.rec.link = { provider: p.kind, org: (await p.org(ctx).catch(() => ({ name: null }))).name, tenant: null, realm }; this.save(); }
    return ctx;
  }
  /** One call to the provider; an access token it refuses is refreshed once. */
  private async withProvider<T>(now: number, f: (p: Provider, ctx: Ctx) => Promise<T>): Promise<T> {
    const p = this.provider();
    try { return await f(p, await this.ctx(now)); }
    catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "auth") throw e;
      this.access = null;
      try { return await f(p, await this.ctx(now)); }
      catch (e2) {
        if (e2 instanceof ProviderError && e2.code === "auth") { this.rec.reconnect = true; this.save(); throw new NotReady("reconnect", "the provider refused the connection"); }
        throw e2;
      }
    }
  }

  // ---- Connecting: the owner's browser and the club's callback ----
  /** The link on the Connectors card: the provider's sign-in, with a state and a PKCE challenge kept here. */
  private async connectUrl(now: number): Promise<string | null> {
    const p = this.provider();
    const clientId = await this.secret(p.keys.id).catch(() => null);
    if (!clientId) return null;
    let c = this.rec.connect;
    if (!c || c.provider !== p.kind || now - c.createdAt > CONNECT_RENEW_MS) {
      c = this.rec.connect = { provider: p.kind, state: randomBytes(16).toString("base64url"), verifier: randomBytes(32).toString("base64url"), createdAt: now };
      this.save();
    }
    const challenge = createHash("sha256").update(c.verifier).digest("base64url");
    const url = p.authorizeUrl(clientId, this.redirect(), c.state, challenge);
    return url.length <= 500 && url.startsWith("https://") ? url : null;
  }

  /** The browser came back (the club passed its query on, signed). */
  async callback(query: Record<string, unknown>, now: number): Promise<{ ok: boolean; error?: "state" | "denied" | "exchange" }> {
    const p = this.provider(), pending = this.rec.connect;
    const state = typeof query.state === "string" ? query.state : "";
    const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (!pending || pending.provider !== p.kind || now - pending.createdAt > CONNECT_VALID_MS || !same(state, pending.state)) {
      this.log("warn", "a connect came back with a state this plugin didn't give; nothing kept", { club: this.rec.club.url });
      return { ok: false, error: "state" };
    }
    this.rec.connect = null;   // single use
    this.save();
    if (typeof query.error === "string" || typeof query.code !== "string" || !query.code) {
      this.log("info", "the owner didn't connect", { club: this.rec.club.url, provider: p.kind });
      return { ok: false, error: "denied" };
    }
    const realm = typeof query.realmId === "string" && /^\d{1,30}$/.test(query.realmId) ? query.realmId : null;
    if (p.kind === "quickbooks" && !realm) return { ok: false, error: "exchange" };
    try {
      const c = await this.creds(p);
      const t = await p.exchange(query.code, pending.verifier, this.redirect(), c);
      this.hold(p.keys.refresh, t.refresh);
      if (p.keys.realm && realm) this.hold(p.keys.realm, realm);
      await this.keepHeld();
      this.access = { provider: p.kind, token: t.access, until: now + (t.expiresIn - 60) * 1000 };
      const o = await p.org({ access: t.access, tenant: null, realm }).catch(() => ({ name: null, tenant: null }));
      this.rec.link = { provider: p.kind, org: o.name, tenant: o.tenant, realm };
      this.rec.reconnect = false;
      if (this.problem === "reconnect" || this.problem === "no_keys") this.problem = null;
      this.nextTryAt = 0; this.attempts = 0;
      this.save();
      this.log("info", "connected", { club: this.rec.club.url, provider: p.kind });
    } catch (e) {
      this.log("warn", "the provider didn't take the connect", { club: this.rec.club.url, provider: p.kind, code: e instanceof ProviderError ? e.code : "error", error: (e as Error).message });
      return { ok: false, error: "exchange" };
    }
    await this.showCards(now, true);
    return { ok: true };
  }

  // ---- The day's send ----
  private async job(now: number): Promise<void> {
    const s = this.settings(), kind = s.provider, b = this.booksOf(kind);
    if (!this.connected(kind)) { this.problem = this.missingKeys().length ? "no_keys" : this.rec.reconnect ? "reconnect" : null; return; }
    if (!s.startDate) { this.problem = "no_start"; return; }
    const local = localNow(now, this.rec.club.time_zone || "UTC");
    if (local.time < s.sendAt || b.lastRunDate === local.date) return;
    if (now < this.nextTryAt) return;
    try {
      await this.run(now, s, b, local.date);
      b.lastRunDate = local.date;
      if (this.problem) this.log("info", "sending works again", { club: this.rec.club.url });
      this.problem = null; this.detail = null; this.attempts = 0; this.nextTryAt = 0;
      this.said.delete("job");
    } catch (e) {
      this.attempts++;
      const pe = e instanceof ProviderError ? e : null;
      this.problem = e instanceof NotReady ? e.problem : e instanceof Unbalanced ? "unbalanced" : e instanceof DoorError ? "door"
        : pe?.code === "rate" ? "rate" : pe?.code === "rejected" ? "rejected" : pe?.code === "invalid_grant" ? "reconnect" : "down";
      this.detail = pe?.code === "rejected" ? pe.message : null;
      this.nextTryAt = now + Math.max(backoff(this.attempts), pe?.retryAfterMs ?? 0);
      this.log("warn", "couldn't send the club's books; trying again later", { club: this.rec.club.url, provider: kind, problem: this.problem, attempts: this.attempts, error: (e as Error).message });
    }
    this.save();
  }

  private async books(from: string, to: string): Promise<DoorBooks> {
    const b = await this.door.call<DoorBooks>("money_books", { from, to });
    if (!b || !Array.isArray(b.days)) throw new DoorError("door_error", "the club's books came back without days");
    if (b.time_zone) this.rec.club.time_zone = b.time_zone;
    return b;
  }

  private async run(now: number, s: Settings, b: Books, today: string): Promise<void> {
    const yesterday = addDays(today, -1);
    let from = b.lastSentDay ? addDays(b.lastSentDay, 1) : s.startDate!;
    if (from < s.startDate!) from = s.startDate!;
    while (from <= yesterday) {
      const to = addDays(from, WINDOW_DAYS - 1) < yesterday ? addDays(from, WINDOW_DAYS - 1) : yesterday;
      const books = await this.books(from, to);
      for (const d of [...books.days].sort((x, y) => (x.date < y.date ? -1 : 1))) {
        if (d.date < from || d.date > to) continue;
        if (!d.complete) return;
        // Never a day without its card fees and payouts: it waits (and every day after it, in order) until the club
        // can read them from Stripe again.
        if (providerMissing(d)) {
          if (b.waiting?.day !== d.date) b.waiting = { day: d.date, since: now };
          this.save();
          throw new NotReady(now - b.waiting.since >= STRIPE_WAIT_SAID_MS ? "stripe_long" : "stripe", `Stripe's fees or payouts for ${d.date} couldn't be read`);
        }
        if (b.waiting?.day === d.date) b.waiting = null;
        await this.sendDay(now, s, b, d.date, byKey(d.lines));
      }
      from = addDays(to, 1);
    }
    // The last week again: a day whose books changed since it was sent gets an adjusting journal.
    let since = addDays(today, -ADJUST_DAYS);
    if (since < s.startDate!) since = s.startDate!;
    const until = b.lastSentDay && b.lastSentDay < yesterday ? b.lastSentDay : yesterday;
    if (since > until) return;
    const books = await this.books(since, until);
    for (const d of [...books.days].sort((x, y) => (x.date < y.date ? -1 : 1))) {
      // A day whose fees or payouts can't be read now isn't compared: they'd look like a change.
      if (!d.complete || !b.sent[d.date] || providerMissing(d)) continue;
      await this.adjustDay(now, s, b, d.date, byKey(d.lines), today);
    }
  }

  private journal(s: Settings, day: string, date: string, n: number, lines: Record<string, number>): Journal {
    const kind = s.provider, r = refs(kind, day, this.clubHash(), this.rec.club.name);
    const m = mapLines(lines, s);
    if (m.missing.length) throw new NotReady("no_accounts", `no account for ${m.missing.join(", ")}`);
    checkBalanced(m.lines);
    this.suspense = m.suspense;
    return { day, date, adjusts: n ? day : null, ref: n ? r.adjustment(n) : r.original, narration: kind === "xero" ? r.narration(n) : r.note(n), idempotencyKey: r.key(n), lines: m.lines };
  }

  private async sendDay(now: number, s: Settings, b: Books, day: string, lines: Record<string, number>): Promise<void> {
    if (b.sent[day]) return;
    const kind = s.provider, r = refs(kind, day, this.clubHash(), this.rec.club.name);
    const found = await this.withProvider(now, (p, ctx) => p.find(ctx, day, r));
    const mark = (sent: Books["sent"][string]) => {
      b.sent[day] = sent;
      if (!b.lastSentDay || day > b.lastSentDay) b.lastSentDay = day;
      if (this.rec.sending?.day === day) this.rec.sending = null;
      // What's older than the days read again isn't needed: the provider has it.
      for (const k of Object.keys(b.sent)) if (k < addDays(day, -40)) delete b.sent[k];
      this.save();
    };
    if (found.some((f) => f.n === 0)) {
      mark({ lines: found.reduce((acc, f) => addLines(acc, f.lines), {} as Record<string, number>), adjustments: Math.max(0, ...found.map((f) => f.n)) });
      this.log("info", "a day was already in the accounting system; not sent again", { club: this.rec.club.url, provider: kind, day });
      return;
    }
    if (!Object.keys(lines).length) { mark({ lines: {}, adjustments: 0, empty: true }); return; }
    const j = this.journal(s, day, day, 0, lines);
    this.rec.sending = { provider: kind, day, ref: j.ref, at: now };
    this.save();
    await this.withProvider(now, (p, ctx) => p.post(ctx, j));
    mark({ lines, adjustments: 0 });
    this.log("info", "sent a day's journal", { club: this.rec.club.url, provider: kind, day, lines: j.lines.length });
  }

  private async adjustDay(now: number, s: Settings, b: Books, day: string, lines: Record<string, number>, today: string): Promise<void> {
    const had = b.sent[day]!;
    if (!Object.keys(diffLines(lines, had.lines)).length) return;
    const kind = s.provider, r = refs(kind, day, this.clubHash(), this.rec.club.name);
    // What the provider has is what was sent (the original and every adjustment), whatever is remembered here.
    const found = await this.withProvider(now, (p, ctx) => p.find(ctx, day, r));
    if (found.length) { had.lines = found.reduce((acc, f) => addLines(acc, f.lines), {} as Record<string, number>); had.adjustments = Math.max(0, ...found.map((f) => f.n)); }
    const d = diffLines(lines, had.lines);
    if (!Object.keys(d).length) { this.save(); return; }
    const n = had.adjustments + 1;
    if (kind === "quickbooks" && n > 9) throw new ProviderError("rejected", 0, `more than 9 adjustments to ${day}`);
    const j = this.journal(s, day, today, n, d);
    this.rec.sending = { provider: kind, day, ref: j.ref, at: now };
    this.save();
    await this.withProvider(now, (p, ctx) => p.post(ctx, j));
    had.lines = lines; had.adjustments = n; this.rec.sending = null;
    this.save();
    this.log("info", "sent an adjusting journal", { club: this.rec.club.url, provider: kind, day, adjustment: n, lines: j.lines.length });
  }

  // ---- What it shows ----
  private missingKeys(): string[] {
    const p = this.provider();
    if (!this.keysAdded) return [];
    return [p.keys.id, p.keys.secret].filter((k) => !this.keysAdded![k] && !this.rec.held.some((h) => h.name === k));
  }
  private next(now: number): { date: string; time: string } | null {
    const s = this.settings();
    if (!s.startDate || !this.connected(s.provider)) return null;
    const local = localNow(now, this.rec.club.time_zone || "UTC"), b = this.booksOf(s.provider);
    // Done today: tomorrow. Not yet (or still trying): today.
    return { date: b.lastRunDate === local.date ? addDays(local.date, 1) : local.date, time: s.sendAt };
  }
  private async state(now: number, withLink: boolean): Promise<State> {
    const s = this.settings(), connected = this.connected(s.provider);
    const missing = this.missingKeys();
    const problem: Problem = this.problem ?? (!connected && missing.length ? "no_keys" : connected && !s.startDate ? "no_start" : null);
    const needLink = withLink && (!connected || this.rec.reconnect) && !missing.length;
    return { provider: s.provider, connected, org: this.rec.link?.provider === s.provider ? this.rec.link.org : null, missingKeys: missing, redirect: this.redirect(),
      connectUrl: needLink ? await this.connectUrl(now) : null, lastSentDay: this.booksOf(s.provider).lastSentDay, next: this.next(now), problem: this.rec.reconnect ? "reconnect" : problem,
      detail: this.detail, suspense: this.suspense, waitingDay: this.booksOf(s.provider).waiting?.day ?? null };
  }
  cardsNow(now: number) { return this.state(now, true).then((st) => ({ connectors: connectorsCard(st), money: moneyCard(st) })); }

  /** Both cards, put again only when what they say changes. A club whose door doesn't offer cards is asked hourly. */
  private async showCards(now: number, force = false): Promise<void> {
    if (!force && this.cards.state === "no" && now - this.cards.checkedAt < CARDS_RECHECK_MS) return;
    if (!force && now < this.cards.retryAt) return;
    try {
      const c = await this.cardsNow(now);
      for (const [slot, card] of Object.entries(c) as [string, Card][]) {
        const key = JSON.stringify(card);
        if (this.shown.get(slot) === key) continue;
        await this.change("plugin_card_put", { slot, tone: card.tone, rows: card.rows, ...(card.link ? { link: card.link } : {}) });
        this.shown.set(slot, key);
      }
      this.cards.state = "yes";
    } catch (e) {
      if (e instanceof DoorError && e.code === "no_tool") {
        if (this.cards.state !== "no") this.log("info", "the club doesn't show plugin cards yet; the export works without them", { club: this.rec.club.url });
        this.cards = { state: "no", checkedAt: now, retryAt: 0 };
        return;
      }
      this.cards.retryAt = now + CARD_RETRY_MS;
      this.once("cards", "warn", "couldn't show a card", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
    }
  }
  private async change(base: string, args: Record<string, unknown>): Promise<void> {
    const p = await this.door.call<{ run_id?: string; status?: string }>(`${base}_preview`, args);
    if (!p?.run_id) throw new DoorError("door_error", `${base}_preview gave no run_id`);
    if (p.status === "awaiting_approval") throw new DoorError("door_error", `${base} waits for a person's yes`);
    await this.door.call(`${base}_confirm`, { run_id: p.run_id });
  }

  health(now: number): ClubHealth {
    const s = this.settings(), n = this.next(now);
    const failing = this.rec.reconnect ? "reconnect" : this.problem && FAILING.includes(this.problem) ? this.problem : null;
    return { provider: s.provider, connected: this.connected(s.provider) && !this.rec.reconnect, last_sent_day: this.booksOf(s.provider).lastSentDay,
      next_send_at: n ? new Date(atClub(n.date, n.time, this.rec.club.time_zone || "UTC")).toISOString() : null, failing };
  }
}
