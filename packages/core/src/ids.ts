import { randomBytes } from "node:crypto";

/** A UUIDv7: time-ordered, so rows sort by creation without a separate column (ground rule 2). */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i--) { b[i] = Number(ms & 0xffn); ms >>= 8n; }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
