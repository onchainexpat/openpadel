// Authenticator app codes (TOTP, RFC 6238, on HOTP, RFC 4226) and recovery codes, with nothing but
// node:crypto. The secret is shown once as base32, the form authenticator apps take.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export type Algo = "sha1" | "sha256" | "sha512";
export const STEP_SECONDS = 30, DIGITS = 6;

/** HOTP: the code for one counter value. */
export function hotp(key: Buffer, counter: number, digits = DIGITS, algo: Algo = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, key).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (at: Date) => Math.floor(at.getTime() / 1000 / STEP_SECONDS);
/** TOTP: the code at a moment. */
export const totp = (key: Buffer, at: Date, digits = DIGITS, algo: Algo = "sha1") => hotp(key, stepAt(at), digits, algo);

/** Which time step a code belongs to (this one, or one either side for a clock a little off), or null. A
 *  step at or before `lastStep` was already used, so it doesn't count again. */
export function matchStep(secret: string, code: string, at: Date, lastStep = 0): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret), now = stepAt(at);
  for (const s of [now, now - 1, now + 1]) {
    if (s <= lastStep) continue;
    const want = Buffer.from(hotp(key, s)), got = Buffer.from(c);
    if (timingSafeEqual(want, got)) return s;
  }
  return null;
}

export const newSecret = () => base32Encode(randomBytes(20));

/** The link an authenticator app reads (as a QR code, or typed in from the key). */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- Recovery codes: ten of them, like "k7rq-2mxd", kept as hashes ----
const RC = "abcdefghjkmnpqrstuvwxyz23456789";
export const RECOVERY_CODES = 10;
export const newRecoveryCode = () => Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + RC[randomInt(RC.length)]).join("");
export const recoveryHash = (code: string) => createHash("sha256").update(`kumi-recovery:${code.trim().toLowerCase().replace(/[^a-z0-9]/g, "")}`).digest("hex");
