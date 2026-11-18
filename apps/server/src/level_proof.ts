// A level claim's screenshot (core/level_claims.ts) going back to the player or staff: as the picture type its own
// first bytes said it was, never cached, sniffed or able to run anything.
import type { Context } from "hono";
/** A claim's screenshot, as a picture of the type its own bytes said it was, never cached or sniffed. */
export function proofResponse(c: Context<any>, p: { content_type: string; bytes: Buffer }) {
  c.header("content-type", p.content_type);
  c.header("x-content-type-options", "nosniff");
  c.header("cache-control", "private, no-store");
  c.header("content-security-policy", "default-src 'none'");
  return c.body(new Uint8Array(p.bytes));
}
