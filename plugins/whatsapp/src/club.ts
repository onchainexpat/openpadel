// One club's WhatsApp. The club decides who gets what (each member's yes, quiet hours, STOP) and hands this plugin each
// message to send (message.send on its webhook): the number, the approved template's name and its words, the language,
// and the same words as a plain message. This sends it from the club's own number through Meta's Cloud API, as the
// plain message when the member wrote to the club in the last 24 hours (WhatsApp's window) and as the template
// otherwise, paced, and tried again when Meta is down or busy. It never chooses a recipient and never reads members.
//
// What comes back from Meta (through the club's /plugins/whatsapp/hook, signed by the club and by Meta) goes to the club
// through the door, in order, as this plugin's own changes: how each message went (plugin_message_status), STOP or
// BAJA or Meta's opt-out (plugin_channel_stop), and anything else a member wrote (plugin_channel_reply: the club links a
// number from its code, or passes the message to the front desk). The club says what to answer, and this sends it.
import { door as openDoor, DoorError, type Door, type Fetch } from "./door.ts";
import { tail, type Log } from "./log.ts";
import { isStop, MetaError, readWebhook, send, verifyMeta, type Keys, type Payload } from "./meta.ts";
import type { ClubRecord, Outgoing, Report, Store } from "./store.ts";
import { connectorsCard, type Card, type Problem } from "./words.ts";

export const PLUGIN_NAME = "whatsapp";
export const KEY_NAMES = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"] as const;
export const SEEN_KEPT = 2000;
/** WhatsApp's window for a plain message after the member's own, less a margin. */
export const WINDOW_MS = 24 * 3600_000 - 10 * 60_000;
/** A message is tried this many times when Meta is down or busy, the wait doubling from 30 seconds. */
export const MAX_ATTEMPTS = 6;
export const backoff = (n: number) => Math.min(30_000 * 2 ** Math.max(0, n - 1), 30 * 60_000);
/** A report the door won't take is tried again, the wait doubling from 5 seconds to 5 minutes, for a day. */
const reportBackoff = (n: number) => Math.min(5_000 * 2 ** Math.max(0, n - 1), 300_000);
const REPORT_GIVE_UP = 300;
/** Automatic answers: to a number the club doesn't know, once a day; "passed to the front desk", once an hour. */
const ANSWER_EVERY: Record<string, number> = { unknown: 86400_000, too_many: 86400_000, desk: 3600_000 };
const SENT_KEPT_MS = 7 * 86400_000;
const CARDS_RECHECK_MS = 3600_000, CARD_RETRY_MS = 5 * 60_000;
/** Meta's codes for a template it doesn't have, or whose words don't fit. */
const TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);

export interface Http { fetch: Fetch; graph: string; sleep: (ms: number) => Promise<void> }
export interface ClubHealth { keys_missing: string[]; waiting: number; reports_waiting: number; last_event_at: string | null; last_sent_at: string | null; failing: string | null }

export class ClubRunner {
  rec: ClubRecord;
  private door: Door;
  private http: Http;
  private store: Store;
  private log: Log;
  private keys: Partial<Record<(typeof KEY_NAMES)[number], string>> = {};
  private missing: string[] = [];
  private keysAt = 0;
  private problem: Problem = null;
  private detail: string | null = null;
  private shown: string | null = null;
  private cards: { state: "unknown" | "yes" | "no"; checkedAt: number; retryAt: number } = { state: "unknown", checkedAt: 0, retryAt: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  private said = new Set<string>();

  constructor(rec: ClubRecord, o: { http: Http; store: Store; log: Log }) {
    this.rec = rec; this.http = o.http; this.store = o.store; this.log = o.log;
    this.door = openDoor(rec.door.mcp, rec.door.token, o.http.fetch);
  }

  /** A new registration for the same club: a new token and secrets; what waits to go stays. */
  replace(rec: ClubRecord): void {
    this.rec = { ...this.rec, club: rec.club, door: rec.door, webhookSecret: rec.webhookSecret, hookSecret: rec.hookSecret, settings: rec.settings };
    this.door = openDoor(rec.door.mcp, rec.door.token, this.http.fetch);
    this.keys = {}; this.keysAt = 0;
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
  private seen(id: string): boolean {
    if (this.rec.seen.includes(id)) return true;
    this.rec.seen.push(id);
    if (this.rec.seen.length > SEEN_KEPT) this.rec.seen.splice(0, this.rec.seen.length - SEEN_KEPT);
    return false;
  }
  private setting(key: string, fallback: string): string { const v = this.rec.settings[key]; return typeof v === "string" && v.trim() ? v.trim() : fallback; }
  private perSecond(): number { const v = Number(this.rec.settings.per_second); return Number.isInteger(v) && v >= 1 && v <= 80 ? v : 20; }
  private today(now: number): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.rec.club.time_zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  }
  private count(now: number, k: "sent" | "delivered" | "failed" | "replies"): void {
    const day = this.today(now);
    if (this.rec.counts.day !== day) this.rec.counts = { day, sent: 0, delivered: 0, failed: 0, replies: 0 };
    this.rec.counts[k]++;
  }

  // ---- What the club sends ----
  /** An event the club sent (its signature already checked): a message to send, or new settings. */
  event(body: { id?: unknown; type?: unknown; created_at?: unknown; data?: any }, now: number): "duplicate" | "send" | "read" | "ignored" {
    const id = typeof body.id === "string" ? body.id : null;
    if (id && this.seen(id)) return "duplicate";
    this.rec.lastEventAt = now;
    const type = typeof body.type === "string" ? body.type : "", d = body.data;
    if (type === "plugin.configured" && d && typeof d.settings === "object" && d.settings) {
      this.rec.settings = d.settings as Record<string, unknown>;
      this.keysAt = 0;
      this.save();
      return "read";
    }
    if (type === "message.send" && d && typeof d.message_id === "string" && typeof d.to === "string" && /^\+[1-9]\d{7,14}$/.test(d.to)
      && d.template && typeof d.template.name === "string" && Array.isArray(d.template.parameters) && typeof d.text === "string") {
      // The club hands a message only to a member who said yes: one handed after a STOP means they said yes again since;
      // one handed before it (on its way as they wrote STOP) doesn't go.
      const handedAt = typeof body.created_at === "string" ? Date.parse(body.created_at) || now : now;
      if (this.rec.stopped[d.to] !== undefined) {
        if (handedAt > this.rec.stopped[d.to]!) delete this.rec.stopped[d.to];
        else { this.report("plugin_message_status", { message_id: d.message_id, status: "failed", error: "stopped: the member sent STOP" }, now); this.save(); return "send"; }
      }
      if (!this.rec.queue.some((q) => q.message_id === d.message_id)) this.rec.queue.push({ message_id: d.message_id, to: d.to, language: d.language === "es" ? "es" : "en",
        template: { name: d.template.name, parameters: d.template.parameters.map((p: unknown) => String(p)) }, text: d.text, essential: Boolean(d.essential),
        send_before: typeof d.send_before === "string" ? d.send_before : null, attempts: 0, next_at: now, received_at: now });
      this.save();
      return "send";
    }
    this.save();
    return "ignored";
  }

  /** Meta's check of the hook address, passed on by the club: the challenge back when the verify token is the club's. */
  async verify(q: Record<string, string>, now: number): Promise<string | null> {
    await this.loadKeys(now);
    const token = this.keys.WHATSAPP_VERIFY_TOKEN;
    if (q["hub.mode"] !== "subscribe" || !token || q["hub.verify_token"] !== token || !/^[A-Za-z0-9._-]{1,200}$/.test(q["hub.challenge"] ?? "")) {
      this.log("warn", "Meta's check of the hook address didn't have the club's verify token; refused", { club: this.rec.club.url });
      return null;
    }
    this.log("info", "Meta checked the hook address", { club: this.rec.club.url });
    return q["hub.challenge"]!;
  }

  /** What Meta posted (the club's signature already checked): refused unless Meta's own signature checks with the club's
   *  app secret. Messages and statuses become reports for the club, in order. Gives the HTTP status to answer. */
  async hook(raw: string, metaSignature: string | undefined, now: number): Promise<number> {
    await this.loadKeys(now);
    const secret = this.keys.WHATSAPP_APP_SECRET, number = this.keys.WHATSAPP_PHONE_NUMBER_ID;
    if (!secret || !number) { this.once("hook-keys", "warn", "a message from Meta came before the club's app secret and number id were added; Meta will try again"); return 503; }
    if (!verifyMeta(secret, metaSignature, raw)) { this.log("warn", "a message at the hook wasn't signed by Meta with the club's app secret; refused", { club: this.rec.club.url }); return 401; }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return 400; }
    const w = readWebhook(body, number);
    for (const m of w.inbound) {
      if (this.seen(`in:${m.id}`)) continue;
      this.rec.lastIn[m.from] = Math.max(this.rec.lastIn[m.from] ?? 0, now);
      this.count(now, "replies");
      if (isStop(m.text)) {
        this.stopLocally(m.from, now);
        this.rec.reports.push({ tool: "plugin_channel_stop", args: { phone: m.from, said: m.text.slice(0, 200) || "STOP", ref: m.id }, attempts: 0, next_at: now, answer_to: m.from });
      } else {
        const body = m.text.trim() || (this.rec.club.language === "es" ? "(Un mensaje de WhatsApp que no es texto)" : "(A WhatsApp message that isn't text)");
        this.rec.reports.push({ tool: "plugin_channel_reply", args: { phone: m.from, body: body.slice(0, 4000), ref: m.id }, attempts: 0, next_at: now, answer_to: m.from });
      }
    }
    for (const s of w.statuses) {
      const mine = this.rec.sent[s.id];
      if (!mine || this.seen(`st:${s.id}:${s.status}`)) continue;
      if (s.status === "delivered") this.count(now, "delivered");
      if (s.status === "failed") this.count(now, "failed");
      this.rec.reports.push({ tool: "plugin_message_status", args: { message_id: mine.message_id, status: s.status, ref: s.id, ...(s.error ? { error: s.error.slice(0, 300) } : {}) }, attempts: 0, next_at: now });
      // The member opted out at WhatsApp: the club turns WhatsApp off for them.
      if (s.status === "failed" && s.code === 131050) {
        this.stopLocally(s.to, now);
        this.rec.reports.push({ tool: "plugin_channel_stop", args: { phone: s.to, said: "WhatsApp opt-out (131050)" }, attempts: 0, next_at: now });
      }
    }
    this.rec.lastEventAt = now;
    this.save();
    return 200;
  }

  /** STOP from a number: nothing waiting for it goes, from now. */
  private stopLocally(phone: string, now: number): void {
    this.rec.stopped[phone] = now;
    for (const q of this.rec.queue.filter((x) => x.to === phone)) this.rec.reports.push({ tool: "plugin_message_status", args: { message_id: q.message_id, status: "failed", error: "stopped: the member sent STOP" }, attempts: 0, next_at: now });
    this.rec.queue = this.rec.queue.filter((x) => x.to !== phone);
  }

  // ---- The club's keys ----
  /** Its keys from the club's vault, through the door, held in memory only; read again every 15 minutes and after new settings. */
  async loadKeys(now: number, force = false): Promise<void> {
    if (!force && this.keysAt && now - this.keysAt < 15 * 60_000) return;
    try {
      const mine = await this.door.call<{ settings?: Record<string, unknown>; keys?: { name: string; added: boolean }[] }>("plugin_settings");
      if (mine && typeof mine.settings === "object" && mine.settings) this.rec.settings = mine.settings;
      const added = new Set((mine?.keys ?? []).filter((k) => k.added).map((k) => k.name));
      this.missing = KEY_NAMES.filter((k) => !added.has(k));
      for (const k of KEY_NAMES) {
        if (!added.has(k)) { delete this.keys[k]; continue; }
        const v = await this.door.call<{ value?: string }>("plugin_secret", { name: k });
        if (typeof v?.value === "string" && v.value) this.keys[k] = v.value.trim();
      }
      this.keysAt = now;
      if (this.problem === "door") this.problem = null;
      this.said.delete("door");
    } catch (e) {
      if (this.problem === null) this.problem = "door";
      this.once("door", "warn", "couldn't read the plugin's keys from the club", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
    }
  }
  private metaKeys(): Keys | null {
    const token = this.keys.WHATSAPP_ACCESS_TOKEN, id = this.keys.WHATSAPP_PHONE_NUMBER_ID;
    return token && id ? { token, phoneNumberId: id } : null;
  }

  // ---- Work ----
  /** Reads its settings and keys, then does what's due. */
  async reconcile(now: number): Promise<void> {
    await this.loadKeys(now, true);
    await this.tick(now);
  }

  /** Reports to the club first (in order), then the messages that are due, then the card. */
  async tick(now: number): Promise<void> {
    await this.flushReports(now);
    await this.sendDue(now);
    await this.flushReports(now);
    for (const [id, s] of Object.entries(this.rec.sent)) if (now - s.at > SENT_KEPT_MS) delete this.rec.sent[id];
    for (const [p, at] of Object.entries(this.rec.lastIn)) if (now - at > 2 * 86400_000) delete this.rec.lastIn[p];
    for (const [p, at] of Object.entries(this.rec.answered)) if (now - at > 2 * 86400_000) delete this.rec.answered[p];
    this.save();
    await this.showCard(now);
  }

  private async sendDue(now: number): Promise<void> {
    if (!this.rec.queue.length) return;
    await this.loadKeys(now);
    const keys = this.metaKeys();
    if (!keys) { this.once("keys-missing", "warn", "messages wait: the club's WhatsApp keys aren't in its vault yet", { missing: this.missing }); return; }
    this.said.delete("keys-missing");
    const gap = Math.ceil(1000 / this.perSecond());
    let first = true;
    for (const m of [...this.rec.queue]) {
      if (m.next_at > now) continue;
      if (!first) await this.http.sleep(gap);
      first = false;
      const done = await this.sendOne(keys, m, now);
      if (done) this.rec.queue = this.rec.queue.filter((q) => q.message_id !== m.message_id);
      this.save();
      if (this.problem === "keys" || this.problem === "down") break;
    }
  }

  /** One message: true when it's done with (sent, or given up on and reported). */
  private async sendOne(keys: Keys, m: Outgoing, now: number): Promise<boolean> {
    const fail = (error: string) => { this.count(now, "failed"); this.report("plugin_message_status", { message_id: m.message_id, status: "failed", error: error.slice(0, 300) }, now); return true; };
    if (m.send_before && now > Date.parse(m.send_before)) return fail("not sent: past its time (quiet hours, or no longer news)");
    if (this.rec.stopped[m.to] !== undefined) return fail("stopped: the member sent STOP");
    const open = now - (this.rec.lastIn[m.to] ?? 0) < WINDOW_MS;
    const template: Payload = { kind: "template", name: m.template.name, language: this.setting(m.language === "es" ? "template_language_es" : "template_language_en", m.language === "es" ? "es_MX" : "en_US"),
      parameters: m.template.parameters };
    try {
      let id: string;
      try { id = await send(this.http.fetch, this.http.graph, keys, m.to, open ? { kind: "text", body: m.text } : template); }
      catch (e) {
        // The window closed sooner than this plugin knew (its state was lost, say): the template instead.
        if (open && e instanceof MetaError && e.kind === "window") id = await send(this.http.fetch, this.http.graph, keys, m.to, template);
        else throw e;
      }
      this.rec.sent[id] = { message_id: m.message_id, at: now };
      this.rec.lastSentAt = now;
      this.count(now, "sent");
      this.report("plugin_message_status", { message_id: m.message_id, status: "sent", ref: id }, now);
      if (this.problem === "down" || this.problem === "keys" || this.problem === "template") { this.problem = null; this.detail = null; }
      this.log("info", "sent a message", { club: this.rec.club.url, to: tail(m.to), as: open ? "text" : m.template.name });
      return true;
    } catch (e) {
      const err = e instanceof MetaError ? e : new MetaError("retry", null, (e as Error).message);
      this.log("warn", "Meta didn't take a message", { club: this.rec.club.url, to: tail(m.to), kind: err.kind, error: err.message, attempt: m.attempts + 1 });
      if (err.kind === "stopped") {
        this.stopLocally(m.to, now);
        this.report("plugin_channel_stop", { phone: m.to, said: "WhatsApp opt-out (131050)" }, now);
        return fail(`stopped at WhatsApp: ${err.message}`);
      }
      if (err.kind === "retry" || err.kind === "keys") {
        m.attempts++;
        if (err.kind === "keys") { this.problem = "keys"; this.keysAt = 0; } else this.problem = "down";
        if (m.attempts >= MAX_ATTEMPTS) return fail(`${err.kind === "keys" ? "Meta refused the club's keys" : "Meta didn't take it"} after ${m.attempts} tries: ${err.message}`);
        m.next_at = now + Math.max(backoff(m.attempts), err.retryAfterMs ?? 0);
        return false;
      }
      if (err.code !== null && TEMPLATE_CODES.has(err.code)) { this.problem = "template"; this.detail = `${template.kind === "template" ? `${template.name} (${template.language})` : ""}`; }
      return fail(err.message);
    }
  }

  private report(tool: Report["tool"], args: Record<string, unknown>, now: number): void {
    this.rec.reports.push({ tool, args, attempts: 0, next_at: now });
  }

  /** The reports the door hasn't taken yet, in order: it stops at the first the door won't take, and tries again later. */
  private async flushReports(now: number): Promise<void> {
    while (this.rec.reports.length) {
      const r = this.rec.reports[0]!;
      if (r.next_at > now) return;
      let result: any = null;
      try { result = await this.change(r.tool, r.args); }
      catch (e) {
        const code = e instanceof DoorError ? e.code : "error";
        // Already done (the same message again, a status already known): nothing more to do.
        if (code === "error.nothing_changed") { this.rec.reports.shift(); continue; }
        // The club refuses it for good (a message it doesn't know): dropped, said once.
        if (/^error\./.test(code) && code !== "error.too_many") { this.log("warn", "the club refused a report", { club: this.rec.club.url, tool: r.tool, code }); this.rec.reports.shift(); continue; }
        r.attempts++;
        if (r.attempts >= REPORT_GIVE_UP) { this.log("error", "gave up on a report the club's door wouldn't take", { club: this.rec.club.url, tool: r.tool }); this.rec.reports.shift(); continue; }
        r.next_at = now + reportBackoff(r.attempts);
        if (this.problem === null) this.problem = "door";
        this.once("report", "warn", "the club's door didn't take a report; it waits and is tried again", { code, error: (e as Error).message });
        this.save();
        return;
      }
      this.rec.reports.shift();
      if (this.problem === "door") this.problem = null;
      this.said.delete("report");
      this.save();
      if (r.answer_to && typeof result?.result?.reply === "string") await this.answer(r.answer_to, String(result.result.outcome ?? (r.tool === "plugin_channel_stop" ? "stop" : "")), result.result.reply, now);
    }
  }

  /** The club's answer to what a member wrote, as a plain message (WhatsApp's window is open: they just wrote). */
  private async answer(to: string, outcome: string, words: string, now: number): Promise<void> {
    const every = ANSWER_EVERY[outcome];
    if (every && now - (this.rec.answered[`${outcome}:${to}`] ?? 0) < every) return;
    const keys = this.metaKeys();
    if (!keys || outcome === "duplicate") return;
    try {
      await send(this.http.fetch, this.http.graph, keys, to, { kind: "text", body: words });
      this.rec.answered[`${outcome}:${to}`] = now;
    } catch (e) { this.log("warn", "couldn't answer a member's message", { club: this.rec.club.url, to: tail(to), error: (e as Error).message }); }
  }

  private async change(base: string, args: Record<string, unknown>): Promise<any> {
    const p = await this.door.call<{ run_id?: string; status?: string }>(`${base}_preview`, args);
    if (!p?.run_id) throw new DoorError("door_error", `${base}_preview gave no run_id`);
    if (p.status === "awaiting_approval") throw new DoorError("door_error", `${base} waits for a person's yes`);
    return this.door.call(`${base}_confirm`, { run_id: p.run_id });
  }

  // ---- What it shows ----
  cardNow(now: number): Card {
    const c = this.rec.counts.day === this.today(now) ? this.rec.counts : { sent: 0, delivered: 0, failed: 0, replies: 0 };
    const n = this.rec.settings.club_number;
    return connectorsCard({ missingKeys: this.keysAt ? this.missing : [], counts: c, waiting: this.rec.queue.length, problem: this.problem, detail: this.detail,
      number: typeof n === "string" && n.trim() ? n.trim().slice(0, 30) : null });
  }
  private async showCard(now: number): Promise<void> {
    if (this.cards.state === "no" && now - this.cards.checkedAt < CARDS_RECHECK_MS) return;
    if (now < this.cards.retryAt) return;
    const card = this.cardNow(now), key = JSON.stringify(card);
    if (this.shown === key) return;
    try {
      await this.change("plugin_card_put", { slot: "connectors", tone: card.tone, rows: card.rows, ...(card.link ? { link: card.link } : {}) });
      this.shown = key;
      this.cards.state = "yes";
    } catch (e) {
      if (e instanceof DoorError && e.code === "no_tool") { this.cards = { state: "no", checkedAt: now, retryAt: 0 }; return; }
      this.cards.retryAt = now + CARD_RETRY_MS;
      this.once("cards", "warn", "couldn't show its card", { code: e instanceof DoorError ? e.code : "error", error: (e as Error).message });
    }
  }

  health(_now: number): ClubHealth {
    const failing = this.keysAt && this.missing.length ? "keys_missing" : this.problem === "keys" || this.problem === "down" || this.problem === "door" ? this.problem : null;
    return { keys_missing: this.keysAt ? this.missing : [], waiting: this.rec.queue.length, reports_waiting: this.rec.reports.length,
      last_event_at: this.rec.lastEventAt ? new Date(this.rec.lastEventAt).toISOString() : null, last_sent_at: this.rec.lastSentAt ? new Date(this.rec.lastSentAt).toISOString() : null, failing };
  }
}
