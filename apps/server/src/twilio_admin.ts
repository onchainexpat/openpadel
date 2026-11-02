// The parts of Twilio's API that registering texting needs (texting.ts): numbers (find, search for a
// toll-free one, buy), Messaging Services, and toll-free verifications. The club's own account and token, from
// the settings file; nothing here is kept but what texting.ts records. Twilio's errors come back as TwilioApiError
// with Twilio's own code (20008: test credentials can't use this; 21422: that number isn't available).
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const API = "https://api.twilio.com/2010-04-01", MESSAGING = "https://messaging.twilio.com/v1";

export class TwilioApiError extends Error {
  readonly status: number; readonly code: number | null;
  constructor(status: number, code: number | null, message: string) { super(message); this.status = status; this.code = code; }
}
export interface TwilioNumber { sid: string; phone_number: string; sms: boolean }
export interface TwilioService { sid: string; friendly_name: string; inbound_request_url: string | null; status_callback: string | null }
export interface TollfreeVerification {
  sid: string; status: string; tollfree_phone_number_sid: string; rejection_reason: string | null;
  rejection_reasons: { reason?: string; code?: number | null; error_code?: number | null }[] | null; error_code: number | null;
  edit_allowed: boolean | null; edit_expiration: string | null; date_created?: string | null; external_reference_id?: string | null;
}
/** One request's fields, in Twilio's own names; a list goes as the same name repeated. */
export type Form = Record<string, string | string[] | boolean | undefined>;

export class TwilioApi {
  private readonly auth: string;
  private readonly accountSid: string;
  private readonly fetchFn: Fetch;
  constructor(accountSid: string, authToken: string, fetchFn: Fetch = fetch) {
    this.accountSid = accountSid; this.fetchFn = fetchFn;
    this.auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  }
  private async call<T>(method: "GET" | "POST" | "DELETE", url: string, form?: Form): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form ?? {})) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) body.append(k, String(one));
    }
    const r = await this.fetchFn(url, { method, signal: AbortSignal.timeout(20_000),
      headers: { authorization: this.auth, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body } : {}) });
    if (r.status === 204) return undefined as T;
    const json = await r.json().catch(() => ({})) as T & { code?: number; message?: string };
    if (!r.ok) throw new TwilioApiError(r.status, json.code ?? null, json.message ?? `HTTP ${r.status}`);
    return json;
  }
  private num = (n: { sid: string; phone_number: string; capabilities?: { sms?: boolean; SMS?: boolean } }): TwilioNumber =>
    ({ sid: n.sid, phone_number: n.phone_number, sms: Boolean(n.capabilities?.sms ?? n.capabilities?.SMS) });

  /** A number already in the account, by the number itself. */
  async findNumber(phone: string): Promise<TwilioNumber | null> {
    const r = await this.call<{ incoming_phone_numbers: { sid: string; phone_number: string; capabilities?: { sms?: boolean } }[] }>("GET",
      `${API}/Accounts/${this.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`);
    const n = r.incoming_phone_numbers.find((x) => x.phone_number === phone);
    return n ? this.num(n) : null;
  }
  /** Toll-free numbers Twilio has free that can text. */
  async searchTollFree(limit = 3): Promise<string[]> {
    const r = await this.call<{ available_phone_numbers: { phone_number: string }[] }>("GET",
      `${API}/Accounts/${this.accountSid}/AvailablePhoneNumbers/US/TollFree.json?SmsEnabled=true&PageSize=${limit}`);
    return r.available_phone_numbers.map((x) => x.phone_number);
  }
  /** Buy one: it's the club's from now on, on its own bill. */
  async buyNumber(phone: string, friendlyName: string): Promise<TwilioNumber> {
    return this.num(await this.call("POST", `${API}/Accounts/${this.accountSid}/IncomingPhoneNumbers.json`, { PhoneNumber: phone, FriendlyName: friendlyName }));
  }

  async getService(sid: string): Promise<TwilioService | null> {
    try { return await this.call<TwilioService>("GET", `${MESSAGING}/Services/${sid}`); }
    catch (e) { if (e instanceof TwilioApiError && e.status === 404) return null; throw e; }
  }
  /** Texts members send to the club's number, and delivery reports, both to this server (texts.ts). */
  async createService(friendlyName: string, inbound: string, statusCallback: string): Promise<TwilioService> {
    return this.call("POST", `${MESSAGING}/Services`, { FriendlyName: friendlyName, InboundRequestUrl: inbound, InboundMethod: "POST", StatusCallback: statusCallback,
      UseInboundWebhookOnNumber: false });
  }
  async updateService(sid: string, inbound: string, statusCallback: string): Promise<TwilioService> {
    return this.call("POST", `${MESSAGING}/Services/${sid}`, { InboundRequestUrl: inbound, InboundMethod: "POST", StatusCallback: statusCallback });
  }
  async serviceNumbers(sid: string): Promise<string[]> {
    const r = await this.call<{ phone_numbers: { sid: string }[] }>("GET", `${MESSAGING}/Services/${sid}/PhoneNumbers?PageSize=50`);
    return r.phone_numbers.map((x) => x.sid);
  }
  async addNumberToService(sid: string, phoneNumberSid: string): Promise<void> {
    await this.call("POST", `${MESSAGING}/Services/${sid}/PhoneNumbers`, { PhoneNumberSid: phoneNumberSid });
  }

  /** The verifications sent for a number (one, normally). */
  async verificationsFor(phoneNumberSid: string): Promise<TollfreeVerification[]> {
    const r = await this.call<{ verifications: TollfreeVerification[] }>("GET", `${MESSAGING}/Tollfree/Verifications?TollfreePhoneNumberSid=${phoneNumberSid}&PageSize=20`);
    return r.verifications;
  }
  async getVerification(sid: string): Promise<TollfreeVerification> { return this.call("GET", `${MESSAGING}/Tollfree/Verifications/${sid}`); }
  async createVerification(form: Form): Promise<TollfreeVerification> { return this.call("POST", `${MESSAGING}/Tollfree/Verifications`, form); }
  /** A rejected one, corrected and sent again: only while Twilio says it can be edited. */
  async updateVerification(sid: string, form: Form): Promise<TollfreeVerification> { return this.call("POST", `${MESSAGING}/Tollfree/Verifications/${sid}`, form); }
  async deleteVerification(sid: string): Promise<void> { await this.call("DELETE", `${MESSAGING}/Tollfree/Verifications/${sid}`); }
}
