// Web Push, with nothing but node:crypto: the club's key pair (VAPID, RFC 8292) proves the push comes from
// this server, and each message is encrypted for the one device it goes to (RFC 8291, aes128gcm), so the
// browser's push service (Google's, Apple's, Mozilla's) carries it without being able to read it.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export interface VapidKeys { publicKey: string; privateKey: string }   // base64url: the 65-byte point, the 32-byte scalar

/** A new key pair for the club's pushes. */
export function generateVapidKeys(): VapidKeys {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

/** The Authorization header for one push service: a short-lived ES256 token naming the service and who sends. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = new Date()): string {
  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Encrypt a message for one subscription (its p256dh key and auth secret), as one aes128gcm record. The salt
 *  and the sender's one-time key are fresh each time; tests can pass fixed ones to check against the RFC. */
export function encryptPush(plaintext: Buffer, p256dh: string, auth: string, fixed: { salt?: Buffer; senderPrivate?: Buffer } = {}): Buffer {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const as = createECDH("prime256v1");
  if (fixed.senderPrivate) as.setPrivateKey(fixed.senderPrivate); else as.generateKeys();
  const asPublic = as.getPublicKey(), shared = as.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync("sha256", shared, secret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPublic]), 32));
  const salt = fixed.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);   // 2: the last (only) record
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** The push services browsers use (Chrome and Android, Firefox, Safari and iPhone, Edge). The server only ever
 *  sends to these: a subscription naming anywhere else could make it call addresses it shouldn't. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function isPushEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint); return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((h) => h.test(u.hostname)); } catch { return false; }
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Send one encrypted message to one device. Gone (404, 410): the subscription is dead and should be dropped. */
export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, message: unknown, keys: VapidKeys, subject: string,
  o: { ttlSeconds?: number; urgency?: "low" | "normal" | "high"; fetch?: Fetch; now?: Date } = {}): Promise<PushResult> {
  const body = encryptPush(Buffer.from(JSON.stringify(message)), sub.p256dh, sub.auth);
  const r = await (o.fetch ?? globalThis.fetch)(sub.endpoint, { method: "POST", body: new Uint8Array(body), headers: {
    authorization: vapidAuthorization(sub.endpoint, keys, subject, o.now), "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
    ttl: String(o.ttlSeconds ?? 24 * 3600), urgency: o.urgency ?? "normal" } });
  if (r.ok) return { ok: true };
  return { ok: false, gone: r.status === 404 || r.status === 410, status: r.status };
}
