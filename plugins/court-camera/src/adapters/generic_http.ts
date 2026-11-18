// The generic HTTP adapter: JSON in, JSON out, signed like openPadel's own webhooks. A camera system that can post a
// webhook and (optionally) take a booking's times needs no code of its own: it speaks this. The shapes are in README.md,
// "The generic HTTP adapter".
//
// In (the vendor POSTs to https://<club>/plugins/court-camera/hook):
//   { "type": "highlight.ready", "id": "clip_81", "camera_id": "cam-01", "session_id": "ses_…" (optional),
//     "started_at": "<ISO>", "ended_at": "<ISO>", "url": "https://…", "duration_seconds": 45 }
//   { "type": "game_stats.ready", "id": "stats_9", "camera_id": "cam-01", "session_id": "…", "started_at": "<ISO>",
//     "ended_at": "<ISO>", "url": "https://… (the game's page, optional)", "stats": [{ "key": "rallies", "value": 54 }] }
//   with `camera-signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" under CAMERA_WEBHOOK_SECRET>`.
//   A body may also be { "notices": [ …up to 50 of those… ] }. Any other `type` (a ping) is answered and ignored.
// Out (with tell_cameras on), under `Authorization: Bearer <CAMERA_API_KEY>`:
//   PUT    <vendor_url>/sessions/<session_id>   { "session_id", "camera_id", "starts_at", "ends_at" }
//   DELETE <vendor_url>/sessions/<session_id>   (404 counts as done)
import { createHmac, timingSafeEqual } from "node:crypto";
import { VendorError, type CameraAdapter, type Notice, type Stat, type Words } from "./types.ts";

export const SIGNATURE_HEADER = "camera-signature";
export const MAX_SKEW_SECONDS = 300;
const MAX_NOTICES = 50, MAX_STATS = 12;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : null);
const time = (v: unknown): number | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const httpsUrl = (v: unknown): string | null => {
  const s = str(v, 500);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null; } catch { return null; }
};
const words = (v: unknown, max: number): Words | null => {
  if (!v || typeof v !== "object") return null;
  const en = str((v as Words).en, max), es = str((v as Words).es, max);
  return en && es ? { en, es } : null;
};

function stat(v: unknown): Stat | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>, key = str(o.key, 60);
  if (!key || !/^[a-z0-9_]+$/.test(key)) return null;
  const value = typeof o.value === "number" && Number.isFinite(o.value) ? o.value : words(o.value, 60);
  if (value === null) return null;
  const label = o.label === undefined ? undefined : words(o.label, 40);
  if (label === null) return null;
  return label ? { key, value, label } : { key, value };
}

function notice(v: unknown): Notice | null {
  if (!v || typeof v !== "object") throw new VendorError(400, "a notice isn't an object");
  const o = v as Record<string, unknown>;
  const kind = o.type === "highlight.ready" ? "highlight" : o.type === "game_stats.ready" ? "stats" : null;
  if (!kind) return null;   // a ping, or something this plugin doesn't show
  const id = str(o.id, 200), camera = str(o.camera_id, 100), start = time(o.started_at);
  if (!id || !camera || start === null) throw new VendorError(400, `a ${String(o.type)} needs id, camera_id and started_at`);
  const end = o.ended_at === undefined ? null : time(o.ended_at);
  const url = o.url === undefined || o.url === null ? null : httpsUrl(o.url);
  if (o.url && !url) throw new VendorError(400, "url must be an https address");
  if (kind === "highlight" && !url) throw new VendorError(400, "a highlight needs its url");
  const secs = typeof o.duration_seconds === "number" && o.duration_seconds >= 0 && o.duration_seconds < 86_400 ? Math.round(o.duration_seconds) : end !== null && end > start ? Math.round((end - start) / 1000) : null;
  const stats = kind === "stats" && Array.isArray(o.stats) ? o.stats.slice(0, MAX_STATS).map(stat).filter((x): x is Stat => x !== null) : [];
  return { kind, id, camera, session: str(o.session_id, 100), start, end: end !== null && end >= start ? end : null, url, seconds: kind === "highlight" ? secs : null, stats };
}

export const genericHttp: CameraAdapter = {
  name: "generic-http",
  verify(headers, rawBody, secret, nowSeconds) {
    const header = headers[SIGNATURE_HEADER];
    if (!header || !secret) return false;
    const p = Object.fromEntries(header.split(",").map((x) => x.trim().split("=", 2)));
    const t = Number(p.t), v1 = p.v1 ?? "";
    if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > MAX_SKEW_SECONDS || !/^[0-9a-f]{64}$/.test(v1)) return false;
    const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
    return timingSafeEqual(Buffer.from(v1, "hex"), expected);
  },
  parse(rawBody) {
    let b: unknown;
    try { b = JSON.parse(rawBody); } catch { throw new VendorError(400, "the body isn't JSON"); }
    const list = b && typeof b === "object" && Array.isArray((b as { notices?: unknown }).notices) ? (b as { notices: unknown[] }).notices : [b];
    if (list.length > MAX_NOTICES) throw new VendorError(400, `at most ${MAX_NOTICES} notices a message`);
    return list.map(notice).filter((x): x is Notice => x !== null);
  },
  async tell(o, op, s) {
    const url = `${o.baseUrl}/sessions/${encodeURIComponent(s.id)}`;
    let r: Response;
    try {
      r = await o.fetch(url, { method: op === "upsert" ? "PUT" : "DELETE", signal: AbortSignal.timeout(o.timeoutMs), redirect: "error",
        headers: { "content-type": "application/json", "user-agent": "openPadel-CourtCamera/0.1", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: op === "upsert" ? JSON.stringify({ session_id: s.id, camera_id: s.camera, starts_at: s.starts_at, ends_at: s.ends_at }) : undefined });
    } catch (e) { throw new VendorError(0, `the camera system didn't answer: ${(e as Error).message}`); }
    await r.arrayBuffer().catch(() => null);
    if (op === "cancel" && r.status === 404) return;
    if (r.status < 200 || r.status > 299) throw new VendorError(r.status, `the camera system answered HTTP ${r.status} to ${op === "upsert" ? "PUT" : "DELETE"} a session`);
  },
};

/** Signs a body as a vendor would for this adapter: for a vendor's own tests, and this plugin's. */
export function signAsVendor(secret: string, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSeconds},v1=${createHmac("sha256", secret).update(`${nowSeconds}.${rawBody}`, "utf8").digest("hex")}`;
}
