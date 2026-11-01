// Bot protection with no third party, on sign-up, sign-in codes and checkout: a field people never see
// (filled in, it's a script), and a small proof of work. The server hands out a signed, short-lived
// challenge; the browser finds a number that makes SHA-256 of "challenge:number" start with enough zero
// bits. A phone does the default in a fraction of a second; an address that keeps failing gets harder ones.
// Kept in memory, like the rate limits: one server process per club, and a restart only means a new challenge.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CHALLENGE_SECONDS = 600, BASE_BITS = 15, MAX_BITS = 20, FAIL_WINDOW_MS = 3600_000;
export type BotVerdict = "ok" | "honeypot" | "missing" | "forged" | "expired" | "replayed" | "too_easy" | "wrong";
export interface Pow { challenge?: unknown; counter?: unknown }

const b64 = (b: Buffer) => b.toString("base64url");
/** How many zero bits a SHA-256 digest starts with. */
export function zeroBits(digest: Buffer): number {
  let n = 0;
  for (const byte of digest) { if (byte === 0) { n += 8; continue; } n += Math.clz32(byte) - 24; break; }
  return n;
}

export class BotCheck {
  private readonly key = randomBytes(32);
  private readonly used = new Map<string, number>();     // nonce -> when its challenge expires
  private readonly fails = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** How hard a challenge for this address is: the default, one bit more for each failure in the last hour. */
  bits(ip: string | null): number {
    const t = this.now(), recent = (this.fails.get(ip ?? "") ?? []).filter((x) => t - x < FAIL_WINDOW_MS);
    return Math.min(MAX_BITS, BASE_BITS + recent.length);
  }
  issue(ip: string | null): { challenge: string; bits: number } {
    const bits = this.bits(ip), payload = `${b64(randomBytes(16))}.${Math.floor(this.now() / 1000) + CHALLENGE_SECONDS}.${bits}`;
    return { challenge: `${payload}.${b64(createHmac("sha256", this.key).update(payload).digest())}`, bits };
  }
  /** The verdict on what a form sent; anything but "ok" counts against the address. */
  check(ip: string | null, pow: Pow | undefined, honeypot: unknown): BotVerdict {
    const v = this.verdict(ip, pow, honeypot);
    if (v !== "ok") this.fail(ip);
    return v;
  }
  fail(ip: string | null): void {
    const t = this.now(), list = (this.fails.get(ip ?? "") ?? []).filter((x) => t - x < FAIL_WINDOW_MS);
    list.push(t); this.fails.set(ip ?? "", list);
    if (this.fails.size > 10_000) for (const [k, v] of this.fails) if (!v.some((x) => t - x < FAIL_WINDOW_MS)) this.fails.delete(k);
  }
  private verdict(ip: string | null, pow: Pow | undefined, honeypot: unknown): BotVerdict {
    if (typeof honeypot === "string" && honeypot.trim() !== "") return "honeypot";
    if (!pow || typeof pow.challenge !== "string" || (typeof pow.counter !== "number" && typeof pow.counter !== "string")) return "missing";
    const parts = pow.challenge.split(".");
    if (parts.length !== 4) return "forged";
    const [nonce, exp, bits, sig] = parts as [string, string, string, string];
    const want = createHmac("sha256", this.key).update(`${nonce}.${exp}.${bits}`).digest(), got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return "forged";
    const t = this.now();
    if (Number(exp) * 1000 < t) return "expired";
    for (const [n, e] of this.used) if (e * 1000 < t) this.used.delete(n);
    if (this.used.has(nonce)) return "replayed";
    if (Number(bits) < this.bits(ip)) return "too_easy";   // asked for before this address started failing
    const counter = String(pow.counter);
    if (!/^\d{1,12}$/.test(counter)) return "wrong";
    if (zeroBits(createHash("sha256").update(`${pow.challenge}:${counter}`).digest()) < Number(bits)) return "wrong";
    this.used.set(nonce, Number(exp));
    return "ok";
  }
}

/** Solving one, as the browser does (for tests and scripts). */
export function solve(challenge: string, bits: number): number {
  for (let i = 0; ; i++) if (zeroBits(createHash("sha256").update(`${challenge}:${i}`).digest()) >= bits) return i;
}
