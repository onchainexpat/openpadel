// Klaviyo's API (https://developers.klaviyo.com/en/reference/api_overview), the few calls this plugin makes, with the
// club's private key (`Authorization: Klaviyo-API-Key pk_...`) and a pinned revision:
//   - GET  /api/lists/{id}                               the list exists and the key reads it (health, the card's name);
//   - GET  /api/lists/{id}/profiles?fields[profile]=email who's on it now, 100 a page (the daily check), with their
//                                                        email marketing subscription;
//   - POST /api/profile-import                           a member's profile, made or brought up to date by email (it
//                                                        never sets consent: this plugin subscribes nobody);
//   - POST /api/lists/{id}/relationships/profiles        onto the list, up to 1000 profiles a call;
//   - DELETE /api/lists/{id}/relationships/profiles      off the list;
//   - POST /api/data-privacy-deletion-jobs               a deleted member's profile deleted in Klaviyo too.
// A 429 waits for its Retry-After (at most a minute) and tries again; a 5xx or no answer tries twice more. Anything else
// is a KlaviyoError with its status, and the caller decides.
import type { Fetch } from "./door.ts";

export const KLAVIYO_URL = "https://a.klaviyo.com";
export const REVISION = "2024-10-15";
export const TIMEOUT_MS = 20_000, PAGE = 100, ADD_MAX = 1000, TRIES = 3;

export class KlaviyoError extends Error {
  /** HTTP status, or 0 when Klaviyo didn't answer. */
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Whether Klaviyo says the profile left email marketing: unsubscribed there, or suppressed (a bounce, a complaint, an
 *  unsubscribe link). Such a profile is never put back on the list, and the club hears of it. */
export function optedOut(attributes: any): boolean {
  const m = attributes?.subscriptions?.email?.marketing;
  return m?.consent === "UNSUBSCRIBED" || (Array.isArray(m?.suppression) && m.suppression.length > 0);
}
const SUBS = "additional-fields[profile]=subscriptions";

/** What's sent for a member: nothing else. */
export interface Member { email: string; first_name: string; language: string }

export interface KlaviyoOpts { base?: string; key: string; fetch: Fetch; sleep: (ms: number) => Promise<void> }

export function klaviyo(o: KlaviyoOpts) {
  const base = (o.base ?? KLAVIYO_URL).replace(/\/+$/, "");
  async function call(method: string, url: string, body?: unknown): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      let r: Response;
      try {
        r = await o.fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
          headers: { authorization: `Klaviyo-API-Key ${o.key}`, revision: REVISION, accept: "application/vnd.api+json", "user-agent": "openPadel-Klaviyo/0.1",
            ...(body === undefined ? {} : { "content-type": "application/vnd.api+json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (e) {
        if (attempt < TRIES) { await o.sleep(1000 * attempt); continue; }
        throw new KlaviyoError(0, `Klaviyo didn't answer: ${(e as Error).message}`);
      }
      if (r.status === 429 && attempt < TRIES) {
        const wait = Math.min(Math.max(Number(r.headers.get("retry-after")) || 1, 1), 60);
        await r.body?.cancel();
        await o.sleep(wait * 1000); continue;
      }
      if (r.status >= 500 && attempt < TRIES) { await r.body?.cancel(); await o.sleep(1000 * attempt); continue; }
      const text = await r.text();
      if (!r.ok) {
        // Klaviyo's error detail, never the request (which has an email in it).
        let detail = "";
        try { detail = String((JSON.parse(text) as { errors?: { detail?: string }[] }).errors?.[0]?.detail ?? "").slice(0, 200); } catch { /* not JSON */ }
        throw new KlaviyoError(r.status, `Klaviyo answered HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
      }
      return text ? JSON.parse(text) : null;
    }
  }
  const listPath = (id: string) => `${base}/api/lists/${encodeURIComponent(id)}`;
  const refs = (ids: string[]) => ({ data: ids.map((id) => ({ type: "profile", id })) });

  return {
    /** The list's name; a KlaviyoError 404 when there's no such list. */
    async list(id: string): Promise<{ name: string }> {
      const b = await call("GET", `${listPath(id)}?fields[list]=name`);
      return { name: String(b?.data?.attributes?.name ?? "") };
    },
    /** Everyone on the list now: their email (lowercase) to their profile's id, and whether they left email marketing. */
    async onList(id: string): Promise<Map<string, { id: string; out: boolean }>> {
      const out = new Map<string, { id: string; out: boolean }>();
      let url: string | null = `${listPath(id)}/profiles?fields[profile]=email,subscriptions&${SUBS}&page[size]=${PAGE}`;
      for (let pages = 0; url && pages < 10_000; pages++) {
        const b = await call("GET", url);
        for (const p of b?.data ?? []) {
          const email = typeof p?.attributes?.email === "string" ? p.attributes.email.trim().toLowerCase() : "";
          if (typeof p?.id === "string") out.set(email || `#${p.id}`, { id: p.id, out: optedOut(p.attributes) });
        }
        const next: unknown = b?.links?.next;
        // Only ever Klaviyo's own next page.
        url = typeof next === "string" && next.startsWith(`${base}/`) ? next : null;
      }
      return out;
    },
    /** The member's profile, made or brought up to date by their email: its id, and whether it left email marketing. */
    async upsert(m: Member): Promise<{ id: string; out: boolean }> {
      const b = await call("POST", `${base}/api/profile-import?${SUBS}`, { data: { type: "profile", attributes: { email: m.email, first_name: m.first_name || null, properties: { language: m.language } } } });
      const id = b?.data?.id;
      if (typeof id !== "string" || !id) throw new KlaviyoError(502, "Klaviyo answered without a profile id");
      return { id, out: optedOut(b?.data?.attributes) };
    },
    async add(listId: string, ids: string[]): Promise<void> {
      for (let i = 0; i < ids.length; i += ADD_MAX) await call("POST", `${listPath(listId)}/relationships/profiles`, refs(ids.slice(i, i + ADD_MAX)));
    },
    async remove(listId: string, ids: string[]): Promise<void> {
      for (let i = 0; i < ids.length; i += ADD_MAX) await call("DELETE", `${listPath(listId)}/relationships/profiles`, refs(ids.slice(i, i + ADD_MAX)));
    },
    /** Asks Klaviyo to delete the profile and everything it holds about it (it does so within a few days). */
    async forget(profileId: string): Promise<void> {
      await call("POST", `${base}/api/data-privacy-deletion-jobs`, { data: { type: "data-privacy-deletion-job", attributes: { profile: { data: { type: "profile", id: profileId } } } } });
    },
  };
}
export type Klaviyo = ReturnType<typeof klaviyo>;
