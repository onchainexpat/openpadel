// Checking what the club sends: its registration, signed with the club's Ed25519 key (docs/plugins/README.md), and its
// events, signed with the webhook's secret (docs/agents/webhooks.md). Both are copies of the docs' samples, which the
// club's own tests check against its signing, kept here so the plugin needs nothing of openPadel's to run.
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

export const MAX_SKEW_SECONDS = 300;
const parts = (header: string) => Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));

export type FetchKey = (url: string) => Promise<{ keys: Record<string, string>[] }>;

/** Whether a registration really came from the club it names: its signature checks with the key the club publishes at
 *  its own address (https, unless `allowHttp` for a club on this machine in development). */
export async function verifyRegistration(header: string | undefined, body: string, fetchKey: FetchKey, o: { nowSeconds?: number; allowHttp?: boolean } = {}): Promise<boolean> {
  if (!header) return false;
  const p = parts(header), t = Number(p.t), now = o.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(t) || Math.abs(now - t) > MAX_SKEW_SECONDS || !p.ed25519) return false;
  let club: { url?: unknown; key_url?: unknown } | undefined;
  try { club = (JSON.parse(body) as { club?: typeof club }).club; } catch { return false; }
  if (typeof club?.url !== "string" || typeof club.key_url !== "string" || !club.key_url.startsWith(`${club.url}/`)) return false;
  if (!club.url.startsWith("https://") && !(o.allowHttp && club.url.startsWith("http://"))) return false;
  try {
    const { keys } = await fetchKey(club.key_url);
    const key = createPublicKey({ key: keys[0] as any, format: "jwk" });
    return verify(null, Buffer.from(`${t}.${body}`), key, Buffer.from(p.ed25519, "base64url"));
  } catch { return false; }
}

/** Whether an event came from the club: openpadel-signature's HMAC of the time and the exact body, under the secret. */
export function verifyWebhook(secret: string, header: string | undefined, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  const p = parts(header), t = Number(p.t), v1 = p.v1 ?? "";
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > MAX_SKEW_SECONDS || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  return timingSafeEqual(Buffer.from(v1, "hex"), expected);
}
