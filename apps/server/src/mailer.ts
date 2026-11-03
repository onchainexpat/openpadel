// Email goes through a Mailer. In development it is kept in memory and logged. With a Resend key it
// goes from the club's own domain, and outside production only to the test addresses listed, so a
// practice run never reaches a real member.
import { countEmail, type Db, type Mail, type Mailer } from "@kumi/core";
export type { Mail, Mailer };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Email kept in memory (the newest 500) and, when `log` is on, written to the log, codes and all. The server only
 *  uses it in practice or development: live, it won't start without real email. */
export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  private log: boolean;
  constructor(log = false) { this.log = log; }
  async send(mail: Mail) {
    this.sent.push(mail);
    if (this.sent.length > 500) this.sent.splice(0, this.sent.length - 500);
    if (this.log) console.log(`[mail] to ${mail.to}: ${mail.subject}`);
  }
  last(to: string): Mail | undefined { return [...this.sent].reverse().find((m) => m.to === to); }
}

/** Resend's REST API: one call per email. A failure throws, so the sender tries again later. */
export class ResendMailer implements Mailer {
  private readonly o: { apiKey: string; from: string; replyTo?: string; fetch: Fetch; baseUrl: string };
  constructor(o: { apiKey: string; from: string; replyTo?: string; fetch?: Fetch; baseUrl?: string }) {
    if (!o.apiKey.startsWith("re_")) throw new Error("that isn't a Resend API key");
    if (!/<[^@\s]+@[^>\s]+>$|^[^@\s]+@[^@\s]+$/.test(o.from)) throw new Error("the from address should look like 'Club Name <hello@club.example>'");
    this.o = { fetch: globalThis.fetch.bind(globalThis), baseUrl: "https://api.resend.com", ...o };
  }
  async send(mail: Mail) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" };
    if (mail.id) headers["idempotency-key"] = `kumi:${mail.id}`;
    const r = await this.o.fetch(`${this.o.baseUrl}/emails`, { method: "POST", headers,
      body: JSON.stringify({ from: this.o.from, to: [mail.to], subject: mail.subject, text: mail.text, ...(this.o.replyTo ? { reply_to: this.o.replyTo } : {}), ...(mail.headers ? { headers: mail.headers } : {}) }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({})) as { message?: string; name?: string };
      throw new Error(`resend ${r.status}: ${d.message ?? d.name ?? "no detail"}`);
    }
    // Resend's id for it: its reports of a bounce or a complaint name the email by it (email_events.ts).
    const d = await r.json().catch(() => ({})) as { id?: unknown };
    return { ref: typeof d.id === "string" ? d.id : null };
  }
}

/** Outside production: only the listed test addresses get real email; everyone else's is held and logged. */
export class PracticeMailer implements Mailer {
  held: Mail[] = [];
  private readonly inner: Mailer;
  private readonly allowed: Set<string>;
  constructor(inner: Mailer, testAddresses: string[]) { this.inner = inner; this.allowed = new Set(testAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean)); }
  async send(mail: Mail) {
    if (this.allowed.has(mail.to.toLowerCase())) return this.inner.send(mail);
    this.held.push(mail);
    console.log(`[mail held, practice] to ${mail.to}: ${mail.subject}`);
  }
}

/** Each email the provider took counts on the club's monthly meter (usage.ts). Wraps the real sender only, so
 *  email held in practice isn't counted. A meter that can't be written never stops the email. */
export class MeteredMailer implements Mailer {
  private readonly inner: Mailer;
  private readonly db: Db;
  private readonly now: () => Date;
  constructor(inner: Mailer, db: Db, now: () => Date = () => new Date()) { this.inner = inner; this.db = db; this.now = now; }
  async send(mail: Mail) {
    const took = await this.inner.send(mail);
    await countEmail(this.db, this.now()).catch((e) => console.error(`usage: an email wasn't counted: ${(e as Error).message}`));
    return took;
  }
}

/** Whether the club's sending domain is verified (for `kumi doctor`). A full-access key asks Resend; a sending-only
 *  key, as the setup guide makes, can't, so the domain's DKIM record in DNS is checked instead. */
export async function checkSendingDomain(apiKey: string, domain: string, o: { fetch?: Fetch; resolveTxt?: (name: string) => Promise<string[][]> } = {}):
  Promise<{ state: "verified" } | { state: "status"; status: string } | { state: "missing" } | { state: "dkim"; found: boolean } | { state: "unknown"; error: string }> {
  const fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const r = await fetchFn("https://api.resend.com/domains", { method: "GET", signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${apiKey}` } });
    const d = await r.json().catch(() => ({})) as { data?: Array<{ name?: string; status?: string }>; name?: string; message?: string };
    if (r.ok) {
      const mine = (d.data ?? []).find((x) => x.name?.toLowerCase() === domain);
      return !mine ? { state: "missing" } : mine.status === "verified" ? { state: "verified" } : { state: "status", status: mine.status ?? "unknown" };
    }
    if (r.status !== 401 && r.status !== 403) return { state: "unknown", error: `resend ${r.status}: ${d.message ?? d.name ?? "no detail"}` };
  } catch (e) { return { state: "unknown", error: (e as Error).message }; }
  // A sending-only key: Resend's DKIM record is a TXT at resend._domainkey.<domain> with the key ("p=...").
  const resolve = o.resolveTxt ?? (async (name: string) => (await import("node:dns/promises")).resolveTxt(name));
  const txt = await resolve(`resend._domainkey.${domain}`).catch(() => [] as string[][]);
  return { state: "dkim", found: txt.some((parts) => parts.join("").includes("p=")) };
}
