// Meta's WhatsApp Cloud API: sending a template or a plain message from the club's number, checking that a webhook
// really came from Meta (X-Hub-Signature-256, an HMAC of the exact body under the app secret), and reading what its
// webhooks say (members' messages, and how each message went).
// https://developers.facebook.com/docs/whatsapp/cloud-api
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Fetch } from "./door.ts";

export const GRAPH = "https://graph.facebook.com/v21.0";
export const META_TIMEOUT_MS = 15_000;

/** Why a send didn't go. `retry`: it may go later (Meta down or busy, the club's number sending too fast); `window`: a
 *  plain message outside the 24-hour window (send the template instead); `stopped`: the member opted out of the club's
 *  messages at WhatsApp; `keys`: the club's token or number id refused; otherwise it won't go (`permanent`). */
export class MetaError extends Error {
  kind: "retry" | "window" | "stopped" | "keys" | "permanent"; code: number | null; retryAfterMs: number | null;
  constructor(kind: MetaError["kind"], code: number | null, message: string, retryAfterMs: number | null = null) { super(message); this.kind = kind; this.code = code; this.retryAfterMs = retryAfterMs; }
}

/** Meta's error codes, by what to do about them. */
const RETRY = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
/** The club's token or number id refused: 190 an expired or revoked token, 0 and 10 and 200 its permissions, 33 a phone
 *  number id that isn't the club's. */
const KEYS = new Set([0, 10, 33, 190, 200]);
const kindOf = (code: number | null, status: number): MetaError["kind"] => {
  if (code === 131047) return "window";
  if (code === 131050) return "stopped";
  if (code !== null && RETRY.has(code)) return "retry";
  if (status === 401 || (code !== null && KEYS.has(code))) return "keys";
  if (status === 429 || status >= 500) return "retry";
  return "permanent";
};

export interface Keys { token: string; phoneNumberId: string }
export type Payload = { kind: "template"; name: string; language: string; parameters: string[] } | { kind: "text"; body: string };

/** Sends one message; gives Meta's id for it (wamid...). */
export async function send(fetchImpl: Fetch, base: string, keys: Keys, to: string, p: Payload): Promise<string> {
  const body = p.kind === "template"
    ? { messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/^\+/, ""), type: "template",
        template: { name: p.name, language: { code: p.language }, components: [{ type: "body", parameters: p.parameters.map((text) => ({ type: "text", text })) }] } }
    : { messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/^\+/, ""), type: "text", text: { preview_url: false, body: p.body } };
  let r: Response;
  try {
    r = await fetchImpl(`${base}/${encodeURIComponent(keys.phoneNumberId)}/messages`, { method: "POST", signal: AbortSignal.timeout(META_TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Bearer ${keys.token}`, "content-type": "application/json", "user-agent": "openPadel-WhatsApp/0.1" }, body: JSON.stringify(body) });
  } catch (e) { throw new MetaError("retry", null, `Meta didn't answer: ${(e as Error).message}`); }
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.ok && typeof j?.messages?.[0]?.id === "string") return j.messages[0].id;
  const code = typeof j?.error?.code === "number" ? j.error.code : null;
  const ra = Number(r.headers.get("retry-after"));
  const msg = `${code ?? `HTTP ${r.status}`}: ${String(j?.error?.message ?? text).slice(0, 200)}`;
  throw new MetaError(r.ok ? "permanent" : kindOf(code, r.status), code, msg, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : null);
}

/** Whether a webhook came from Meta: X-Hub-Signature-256 is "sha256=" and the HMAC of the exact body under the app secret. */
export function verifyMeta(appSecret: string, header: string | undefined, rawBody: string): boolean {
  if (!appSecret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  return timingSafeEqual(Buffer.from(header.slice(7), "hex"), expected);
}

export interface Inbound { id: string; from: string; at: number; text: string; button: boolean }
export interface Status { id: string; status: "sent" | "delivered" | "read" | "failed"; to: string; error: string | null; code: number | null }
/** What a webhook from Meta says, for this club's number only: messages that came in, and statuses. */
export function readWebhook(body: unknown, phoneNumberId: string): { inbound: Inbound[]; statuses: Status[]; other: number } {
  const out = { inbound: [] as Inbound[], statuses: [] as Status[], other: 0 };
  const b = body as any;
  if (b?.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  for (const e of b.entry) for (const ch of Array.isArray(e?.changes) ? e.changes : []) {
    const v = ch?.value;
    if (ch?.field !== "messages" || !v || String(v.metadata?.phone_number_id ?? "") !== phoneNumberId) { out.other++; continue; }
    for (const m of Array.isArray(v.messages) ? v.messages : []) {
      if (typeof m?.id !== "string" || typeof m?.from !== "string" || !/^\d{8,15}$/.test(m.from)) continue;
      const text = m.type === "text" ? m.text?.body : m.type === "button" ? (m.button?.text ?? m.button?.payload)
        : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
      out.inbound.push({ id: m.id, from: `+${m.from}`, at: Number(m.timestamp) * 1000 || 0, text: typeof text === "string" ? text : "", button: m.type === "button" || m.type === "interactive" });
    }
    for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
      if (typeof s?.id !== "string" || !["sent", "delivered", "read", "failed"].includes(s.status)) continue;
      const err = Array.isArray(s.errors) ? s.errors[0] : null;
      out.statuses.push({ id: s.id, status: s.status, to: `+${String(s.recipient_id ?? "")}`, code: typeof err?.code === "number" ? err.code : null,
        error: err ? `${err.code ?? ""} ${String(err.title ?? err.message ?? "").slice(0, 150)}`.trim() : null });
    }
  }
  return out;
}

// STOP and its kin, in English and Spanish: the whole message, courtesy words aside (the club's server checks again).
const COURTESY = new Set(["please", "pls", "thanks", "thank", "you", "por", "favor", "gracias"]);
const STOP_WORDS = new Set(["stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "stop messages", "stop whatsapp",
  "baja", "darme de baja", "dar de baja", "parar", "para", "alto", "cancelar", "detener", "no mas mensajes", "no mas"]);
/** Whether a message (or a button's words) asks to stop. */
export function isStop(text: string): boolean {
  const words = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  return STOP_WORDS.has(words.filter((w) => !COURTESY.has(w)).join(" "));
}
