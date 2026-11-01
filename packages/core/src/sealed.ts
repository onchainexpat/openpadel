// Secrets kept in the database are sealed with the server's own key (KUMI_SECRET_KEY, 32 random bytes made at
// install): AES-256-GCM, a fresh nonce each time, and the key's short id in front so a value sealed under the
// key before (KUMI_SECRET_KEY_PREVIOUS) still opens while `kumi rotate-key` moves everything to the new one.
// Without a key (development only: production refuses to start), values are kept as they are, and say so.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Db, Trx } from "./db.ts";

const TEXT_PREFIX = "enc:v1:";
const BYTES_SEALED = Buffer.from("KS1"), BYTES_PLAIN = Buffer.from("KP1");

interface Key { id: string; bytes: Buffer }
let current: Key | null = null, previous: Key | null = null;

/** A key from the environment: 32 bytes as base64, base64url or hex. */
export function parseSecretKey(text: string): Buffer {
  const t = text.trim();
  const b = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (b.length !== 32) throw new Error("a secret key must be 32 random bytes (make one with: openssl rand -base64 32)");
  return b;
}
const idOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);
const keyFrom = (text: string | undefined): Key | null => { if (!text?.trim()) return null; const bytes = parseSecretKey(text); return { id: idOf(bytes), bytes }; };

/** Set the server's keys (from KUMI_SECRET_KEY and KUMI_SECRET_KEY_PREVIOUS). Tests set and clear them too. */
export function setSecretKeys(k: { current?: string; previous?: string }) {
  current = keyFrom(k.current);
  previous = keyFrom(k.previous);
  if (previous && current && previous.id === current.id) previous = null;
}
export function secretKeyStatus(): { current: string | null; previous: string | null } {
  return { current: current?.id ?? null, previous: previous?.id ?? null };
}
const keyById = (id: string) => (current?.id === id ? current : previous?.id === id ? previous : null);

function seal(key: Key, plain: Buffer): Buffer {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key.bytes, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(key: Key, box: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key.bytes, box.subarray(0, 12));
  d.setAuthTag(box.subarray(12, 28));
  return Buffer.concat([d.update(box.subarray(28)), d.final()]);
}

export class SealedError extends Error {}

/** A text secret to store: "enc:v1:<key id>:<sealed>", or the text itself while there's no key. */
export function sealText(plain: string): string {
  if (!current) return plain;
  return `${TEXT_PREFIX}${current.id}:${seal(current, Buffer.from(plain, "utf8")).toString("base64url")}`;
}
export function isSealedText(v: string): boolean { return v.startsWith(TEXT_PREFIX); }
/** A stored text secret, opened. Text that was never sealed (from before the key) comes back as it is. */
export function openText(stored: string): string {
  if (!isSealedText(stored)) return stored;
  const [id, box] = stored.slice(TEXT_PREFIX.length).split(":");
  const key = keyById(id ?? "");
  if (!key || !box) throw new SealedError(`sealed under key ${id}, which this server doesn't have`);
  return open(key, Buffer.from(box, "base64url")).toString("utf8");
}

/** A file or other bytes to store: "KS1" + the key's id + the sealed bytes, or "KP1" + the bytes while there's no key. */
export function sealBytes(plain: Buffer): Buffer {
  if (!current) return Buffer.concat([BYTES_PLAIN, plain]);
  return Buffer.concat([BYTES_SEALED, Buffer.from(current.id, "hex"), seal(current, plain)]);
}
export function openBytes(stored: Buffer): Buffer {
  const head = stored.subarray(0, 3);
  if (head.equals(BYTES_PLAIN)) return stored.subarray(3);
  if (!head.equals(BYTES_SEALED)) throw new SealedError("not a sealed value");
  const id = stored.subarray(3, 7).toString("hex"), key = keyById(id);
  if (!key) throw new SealedError(`sealed under key ${id}, which this server doesn't have`);
  return open(key, stored.subarray(7));
}
const bytesKeyId = (stored: Buffer) => (stored.subarray(0, 3).equals(BYTES_SEALED) ? stored.subarray(3, 7).toString("hex") : null);
const textKeyId = (stored: string) => (isSealedText(stored) ? stored.slice(TEXT_PREFIX.length).split(":")[0] ?? null : null);

/** Every column that holds a secret. Text columns hold sealText values; bytes columns hold sealBytes values. */
export const SEALED_COLUMNS: { table: string; key: string; column: string; kind: "text" | "bytes"; where?: string }[] = [
  { table: "staff_factor", key: "person_id", column: "secret", kind: "text" },
  { table: "auth_challenge", key: "id", column: "code_hash", kind: "text", where: "kind = 'totp_setup'" },
  { table: "push_key", key: "singleton", column: "private_key", kind: "text" },
  { table: "vault_blob", key: "id", column: "bytes", kind: "bytes" },
];

export interface ResealReport { sealed: number; resealed: number; current: number; plain: number; unreadable: number }
/** Seal what isn't sealed yet, and move whatever was sealed under the previous key to the current one. Without
 *  a key it only counts. Run at every start (cheap: a club has a handful of these) and by `kumi rotate-key`. */
export async function resealAll(db: Db | Trx): Promise<ResealReport> {
  const r: ResealReport = { sealed: 0, resealed: 0, current: 0, plain: 0, unreadable: 0 };
  for (const c of SEALED_COLUMNS) {
    const rows = (await sql<{ k: unknown; v: string | Buffer }>`SELECT ${sql.ref(c.key)} AS k, ${sql.ref(c.column)} AS v FROM ${sql.table(c.table)} ${c.where ? sql.raw(`WHERE ${c.where}`) : sql``}`.execute(db)).rows;
    for (const row of rows) {
      const id = c.kind === "text" ? textKeyId(row.v as string) : bytesKeyId(row.v as Buffer);
      if (id && id === current?.id) { r.current++; continue; }
      if (!current) { if (id) r.current++; else r.plain++; continue; }
      if (id && !keyById(id)) { r.unreadable++; continue; }
      const next = c.kind === "text" ? sealText(openText(row.v as string)) : sealBytes(openBytes(row.v as Buffer));
      await sql`UPDATE ${sql.table(c.table)} SET ${sql.ref(c.column)} = ${next} WHERE ${sql.ref(c.key)} = ${row.k}`.execute(db);
      if (id) r.resealed++; else r.sealed++;
    }
  }
  return r;
}
