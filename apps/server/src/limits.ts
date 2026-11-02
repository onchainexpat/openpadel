// How fast one address can try things. Kept in memory: a club runs one server process, and a restart
// forgetting the counts is fine. Per-email limits (codes per hour, tries per code) live with sign-in.
import type { Context } from "hono";

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) { this.limit = limit; this.windowMs = windowMs; }
  /** Count a try; false when this key has used up its tries in the window. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(now); this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

/** The address a request came from. Behind Caddy, Caddy's X-Forwarded-For says who it was (Caddy replaces
 *  any the client sent, and the last entry is the one it adds). It's trusted from Caddy on the same machine,
 *  and from any peer when KUMI_TRUST_PROXY=1: Docker's Caddy is another container, and the server's port is
 *  reachable only from the compose network. From anywhere else the header isn't trusted. */
export function clientIp(c: Context<any>, env: Record<string, string | undefined> = process.env): string | null {
  const remote: string | undefined = c.env?.incoming?.socket?.remoteAddress;
  if (!remote) return null;   // in-process requests (tests) have no address
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const trusted = local || env.KUMI_TRUST_PROXY === "1";
  const forwarded = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return trusted && forwarded ? forwarded : remote;
}
