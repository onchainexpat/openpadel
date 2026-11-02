// Email goes through a Mailer. In development it is kept in memory and logged. With a Resend key it
// goes from the club's own domain, and outside production only to the test addresses listed, so a
// practice run never reaches a real member.
import type { Mail, Mailer } from "@kumi/core";
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
