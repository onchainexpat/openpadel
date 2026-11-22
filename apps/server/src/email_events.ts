// The email service's reports (Resend's webhook, signed the way Svix signs: docs.svix.com): a hard bounce, a spam
// complaint, or an address the service won't send to any more. Each is recorded as an action (email_suppression.ts),
// so the club stops emailing an address that can't take it. Only a signed, recent post is read, and only about email
// from the club's own domain: a shared email account (a host's) sends for other clubs too.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { emailDomain, readEmailReport, runAsSystem, type Db } from "@kumi/core";

/** How far a post's signed time may be from the server's clock, either way (seconds): an older one is a replay. */
export const SIGNED_TOLERANCE_S = 300;
/** The largest post read: Resend's are a few kilobytes. */
const MAX_BODY = 256_000;

/** Whether the post is the email service's own: an HMAC-SHA256 of "<id>.<timestamp>.<body>" with the endpoint's
 *  secret (whsec_ and base64), among the space-separated "v1,<base64>" signatures, signed within the tolerance. */
export function verifyEmailSignature(raw: string, h: { id?: string | null; timestamp?: string | null; signature?: string | null }, secret: string, nowMs = Date.now()): boolean {
  if (!h.id || !h.timestamp || !h.signature || !/^\d{1,12}$/.test(h.timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(h.timestamp)) > SIGNED_TOLERANCE_S) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  if (key.length < 16) return false;
  const want = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${raw}`).digest();
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/** POST /webhooks/resend. Without OPENPADEL_RESEND_WEBHOOK_SECRET it isn't there (404): nothing unsigned is ever read. */
export function emailEventRoutes(db: Db, o: { secret: string | null; from: string | null; now: () => Date }) {
  const app = new Hono();
  const mine = o.from ? emailDomain(o.from) : null;
  app.post("/webhooks/resend", async (c) => {
    if (!o.secret) return c.json({ error: "not_configured" }, 404);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: "too_large" }, 413);
    const h = (name: string) => c.req.header(`svix-${name}`) ?? c.req.header(`webhook-${name}`) ?? null;
    const now = o.now();
    if (!verifyEmailSignature(raw, { id: h("id"), timestamp: h("timestamp"), signature: h("signature") }, o.secret, now.getTime())) return c.json({ error: "bad_signature" }, 400);
    let body: any;
    try { body = JSON.parse(raw); } catch { return c.json({ error: "bad_body" }, 400); }
    const report = readEmailReport(body);
    if ("ignored" in report) return c.body(null, 204);
    // About email from another domain on the same account: another club's, not this one's to act on.
    const theirs = typeof body?.data?.from === "string" ? emailDomain(body.data.from) : null;
    if (mine && theirs && theirs !== mine) { console.log(`[email report] about email from another domain (${theirs}): left alone`); return c.body(null, 204); }
    for (const address of report.addresses)
      await runAsSystem(db, "email.report", { reason: report.reason, address, email_id: report.email_id, detail: report.detail, at: report.at }, "webhook:resend", { now });
    console.log(`[email report] ${report.reason} for ${report.addresses.length} address${report.addresses.length === 1 ? "" : "es"}: held back from now on`);
    return c.body(null, 204);
  });
  return app;
}
