// The export's passphrase stretching (export.ts): new files use scrypt at 2^17; a file says what it was made with,
// so older ones (2^15) still open; a header asking for more than Kumi ever uses is refused before any work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { EXPORT_MAGIC, exportHeader, openExport, packExport, sealExport } from "../src/export.ts";

const manifest = Buffer.from(JSON.stringify({ kind: "kumi-export", format: 1 }));
const payload = () => packExport([{ name: "manifest.json", data: manifest }, { name: "database.dump", data: Buffer.from("dump") }]);
const PASS = "a passphrase the owner chose";

/** A file sealed the way an earlier Kumi did, with the stretching given here. */
function sealWith(kdf: { N: number; r: number; p: number }, passphrase: string, header?: object): Buffer {
  const salt = randomBytes(16), iv = randomBytes(12);
  const h = Buffer.from(JSON.stringify(header ?? { format: 1, kdf: { name: "scrypt", ...kdf, salt: salt.toString("base64") }, cipher: "aes-256-gcm",
    iv: iv.toString("base64"), passphrase: "chosen", created_at: new Date().toISOString(), kumi: "0.1.0" }));
  const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  const front = Buffer.concat([EXPORT_MAGIC, len, h]);
  const key = scryptSync(passphrase.normalize("NFC").trim(), salt, 32, { ...kdf, maxmem: 64 * 1024 * 1024 });
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(front);
  return Buffer.concat([front, c.update(payload()), c.final(), c.getAuthTag()]);
}

test("a new file is stretched with scrypt at 2^17", () => {
  const file = sealExport(payload(), PASS, false, new Date());
  assert.equal(exportHeader(file).kdf.N, 131072);
  assert.equal(openExport(file, PASS).manifest.kind, "kumi-export");
});

test("a file made with 2^15 still opens", () => {
  const file = sealWith({ N: 32768, r: 8, p: 1 }, PASS);
  assert.equal(openExport(file, PASS).manifest.kind, "kumi-export");
});

test("a header asking for far more work than Kumi uses is refused before any is done", () => {
  const salt = randomBytes(16).toString("base64"), iv = randomBytes(12).toString("base64");
  for (const kdf of [{ N: 1 << 24, r: 8, p: 1 }, { N: 100000, r: 8, p: 1 }, { N: 131072, r: 64, p: 1 }, { N: 1024, r: 8, p: 1 }]) {
    const file = sealWith({ N: 32768, r: 8, p: 1 }, PASS, { format: 1, kdf: { name: "scrypt", ...kdf, salt }, cipher: "aes-256-gcm", iv, passphrase: "chosen", created_at: "x", kumi: "x" });
    assert.throws(() => openExport(file, PASS), /stretching/);
  }
});
