// The club's own Twilio account, for texts (texts.ts). Its keys come from the environment, never the database
// or the code: KUMI_TWILIO_ACCOUNT_SID and KUMI_TWILIO_AUTH_TOKEN. Who texts are from: a Messaging Service
// (KUMI_TWILIO_MESSAGING_SERVICE_SID, Twilio's advice) or one number (KUMI_TWILIO_FROM); without either, the
// Messaging Service `kumi texting` registered, once Twilio approves it (texting.ts). No sender, no texts.
// Everything Twilio posts back (texts to the club's number, delivery reports) is signed with the auth token,
// and anything unsigned or signed wrong is refused.
import { createHmac, timingSafeEqual } from "node:crypto";
import { TextError, type Texter, type TextOut } from "@kumi/core";

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface TwilioConfig { accountSid: string; authToken: string; messagingServiceSid?: string; from?: string }

/** The settings, or null when texts aren't set up; an error when they're set up wrong. Who texts are from may
 *  be missing: the registration (texting.ts) gives it once approved. */
export function twilioFromEnv(env: Env): TwilioConfig | null {
  const accountSid = env.KUMI_TWILIO_ACCOUNT_SID?.trim(), authToken = env.KUMI_TWILIO_AUTH_TOKEN?.trim();
  const messagingServiceSid = env.KUMI_TWILIO_MESSAGING_SERVICE_SID?.trim() || undefined, from = env.KUMI_TWILIO_FROM?.trim() || undefined;
  if (!accountSid && !authToken) return null;
  if (!accountSid || !authToken) throw new Error("KUMI_TWILIO_ACCOUNT_SID and KUMI_TWILIO_AUTH_TOKEN go together");
  if (!/^AC[0-9a-f]{32}$/.test(accountSid)) throw new Error("KUMI_TWILIO_ACCOUNT_SID should look like AC followed by 32 letters and digits");
  if (!/^[0-9a-f]{32}$/.test(authToken)) throw new Error("KUMI_TWILIO_AUTH_TOKEN should be 32 letters and digits");
  if (messagingServiceSid && !/^MG[0-9a-f]{32}$/.test(messagingServiceSid)) throw new Error("KUMI_TWILIO_MESSAGING_SERVICE_SID should look like MG followed by 32 letters and digits");
  if (from && !/^\+\d{8,15}$/.test(from)) throw new Error("KUMI_TWILIO_FROM should be a number like +15035550123");
  return { accountSid, authToken, ...(messagingServiceSid ? { messagingServiceSid } : {}), ...(from ? { from } : {}) };
}

// Twilio's error codes that no retry will change: the number isn't one, can't take texts, replied STOP, or the
// account can't text it. Anything else (a 5xx, the network, a rate limit) may pass.
const FINAL = new Set(["21211", "21214", "21217", "21219", "21265", "21408", "21410", "21606", "21608", "21610", "21612", "21614", "21659", "21660", "21661", "21703", "30004", "30005", "30006", "30007"]);

/** Whether the settings say who texts are from. */
export const hasSender = (cfg: TwilioConfig) => Boolean(cfg.messagingServiceSid || cfg.from);

/** Sends through Twilio's Messages API, from the Messaging Service or the one number. */
export class TwilioTexter implements Texter {
  private readonly cfg: TwilioConfig;
  private readonly fetch: Fetch;
  constructor(cfg: TwilioConfig, fetchFn: Fetch = fetch) {
    if (!hasSender(cfg)) throw new Error("texts need who they're from: a Messaging Service or a number");
    this.cfg = cfg; this.fetch = fetchFn;
  }
  async send(text: TextOut): Promise<{ ref: string | null }> {
    const form = new URLSearchParams({ To: text.to, Body: text.body });
    if (this.cfg.messagingServiceSid) form.set("MessagingServiceSid", this.cfg.messagingServiceSid); else form.set("From", this.cfg.from!);
    if (text.statusCallback) form.set("StatusCallback", text.statusCallback);
    let r: Response;
    try {
      r = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
        method: "POST", body: form, signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" } });
    } catch (e) { throw new TextError("network", (e as Error).message, false); }
    const body = await r.json().catch(() => ({})) as { sid?: string; code?: number; message?: string };
    if (r.ok && body.sid) return { ref: body.sid };
    const code = String(body.code ?? r.status);
    throw new TextError(code, body.message ?? `HTTP ${r.status}`, FINAL.has(code) || r.status === 401 || r.status === 403);
  }
}

/** Practice: only the club's test numbers get texts; the rest are held and logged, never sent (whole, so a
 *  sign-in code held in practice can be read from the log, as an emailed one can). */
export class PracticeTexter implements Texter {
  held: TextOut[] = [];
  private readonly inner: Texter;
  private readonly allowed: Set<string>;
  constructor(inner: Texter, testNumbers: string[]) { this.inner = inner; this.allowed = new Set(testNumbers.map((n) => n.trim()).filter(Boolean)); }
  async send(text: TextOut) {
    if (this.allowed.has(text.to)) return this.inner.send(text);
    this.held.push(text);
    console.log(`[text held, practice] to ${text.to.slice(0, -4)}****: ${text.body.slice(0, 200)}`);
    return { ref: null };
  }
}

/** Without Twilio (development): texts only reach the server's log. */
export class LogTexter implements Texter {
  sent: TextOut[] = [];
  async send(text: TextOut) { this.sent.push(text); console.log(`[text, not sent] to ${text.to}: ${text.body}`); return { ref: null }; }
}

/** Twilio's signature: HMAC-SHA1 with the auth token over the full address it posted to, then each form field's
 *  name and value, sorted by name. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}
export function validSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params)), got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** For `kumi doctor`: whether Twilio accepts the account and token. Test credentials can't read the account
 *  (Twilio's 20008), which is how they're told apart. Reads only. */
export async function checkTwilio(cfg: TwilioConfig, fetchFn: Fetch = fetch): Promise<"ok" | "test" | { error: string }> {
  try {
    const r = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}.json`, {
      method: "GET", signal: AbortSignal.timeout(8000), headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}` } });
    if (r.ok) return "ok";
    const body = await r.json().catch(() => ({})) as { code?: number; message?: string };
    if (body.code === 20008) return "test";
    return { error: `${body.code ?? r.status}${body.message ? `: ${body.message}` : ""}` };
  } catch (e) { return { error: (e as Error).message }; }
}
