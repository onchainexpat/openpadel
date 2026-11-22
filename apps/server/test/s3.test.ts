import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, S3Error, s3FromEnv, signV4 } from "../src/s3.ts";
import { offsiteLatest, offsitePush, offsiteRetention, openBackup, sealBackup } from "../src/backups.ts";
import { fakeS3, type FakeS3 } from "./fake_s3.ts";

const E = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sig = (x: Parameters<typeof signV4>[0]) => signV4(x).authorization.split("Signature=")[1];
const aws = { region: "us-east-1", service: "s3", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", amzDate: "20130524T000000Z" };

test("SigV4 matches AWS's published examples", () => {
  // The Signature Version 4 test suite's get-vanilla.
  assert.equal(sig({ method: "GET", host: "example.amazonaws.com", path: "/", headers: { "x-amz-date": "20150830T123600Z" }, payloadHash: E, amzDate: "20150830T123600Z",
    region: "us-east-1", service: "service", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }), "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  // The S3 guide's examples: GET an object (with a range), PUT one (an encoded name), and two bucket queries.
  assert.equal(sig({ ...aws, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9", "x-amz-content-sha256": E, "x-amz-date": aws.amzDate }, payloadHash: E }),
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  const P = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
  assert.equal(sig({ ...aws, method: "PUT", host: "examplebucket.s3.amazonaws.com", path: "/test$file.text", payloadHash: P,
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY", "x-amz-content-sha256": P, "x-amz-date": aws.amzDate } }), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  assert.equal(sig({ ...aws, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/", query: { lifecycle: "" }, headers: { "x-amz-content-sha256": E, "x-amz-date": aws.amzDate }, payloadHash: E }),
    "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  assert.equal(sig({ ...aws, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/", query: { "max-keys": "2", prefix: "J" }, headers: { "x-amz-content-sha256": E, "x-amz-date": aws.amzDate }, payloadHash: E }),
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

let s3: FakeS3;
const creds = { bucket: "club-backups", accessKeyId: "AKTEST", secretAccessKey: "secret/for+tests", region: "auto" };
before(async () => { s3 = await fakeS3(creds); });
after(async () => s3.close());
const client = (secret = creds.secretAccessKey) => new S3Client({ endpoint: s3.url, bucket: creds.bucket, accessKeyId: creds.accessKeyId, secretAccessKey: secret, region: creds.region, pathStyle: true });

test("the client puts, lists (page by page), gets and deletes, every request signed", async () => {
  const c = client();
  for (const k of ["kumi/a.txt", "kumi/b c.txt", "kumi/d&e.txt", "other/x"]) await c.put(k, Buffer.from(`body of ${k}`));
  assert.deepEqual((await c.list("kumi/")).map((x) => x.key), ["kumi/a.txt", "kumi/b c.txt", "kumi/d&e.txt"]);
  assert.equal((await c.get("kumi/b c.txt")).toString(), "body of kumi/b c.txt");
  await c.delete("kumi/a.txt");
  assert.deepEqual((await c.list("kumi/")).map((x) => x.key), ["kumi/b c.txt", "kumi/d&e.txt"]);
  await assert.rejects(client("wrong").put("kumi/z", Buffer.from("z")), (e: unknown) => e instanceof S3Error && e.status === 403 && /SignatureDoesNotMatch/.test(e.message));
  await assert.rejects(c.get("kumi/nothing"), (e: unknown) => e instanceof S3Error && e.status === 404);
});

test("offsite copies are sealed with the backup key; a wrong key or a damaged file won't open", () => {
  const key = Buffer.alloc(32, 3), dump = Buffer.from("PGDMP fake dump body");
  const sealed = sealBackup(dump, key);
  assert.ok(!sealed.includes(dump));
  assert.deepEqual(openBackup(sealed, key), dump);
  assert.throws(() => openBackup(sealed, Buffer.alloc(32, 4)), /doesn't open with OPENPADEL_BACKUP_KEY/);
  sealed[sealed.length - 1]! ^= 1;
  assert.throws(() => openBackup(sealed, key), /doesn't open/);
});

test("each night's copy goes in daily/, the month's first in monthly/; 30 days and 12 months are kept", async () => {
  const c = client(), key = Buffer.alloc(32, 5), dir = mkdtempSync(join(tmpdir(), "kumi-s3-"));
  for (const k of [...s3.objects.keys()]) s3.objects.delete(k);
  // Forty days and fifteen months already there.
  for (let d = 0; d < 40; d++) {
    const day = new Date(Date.UTC(2026, 9, 1) + d * 86400_000).toISOString().slice(0, 10);
    s3.objects.set(`kumi/daily/kumi-${day}.dump.enc`, Buffer.from("x")); s3.objects.set(`kumi/daily/kumi-${day}.json.enc`, Buffer.from("x"));
  }
  for (let m = 0; m < 15; m++) s3.objects.set(`kumi/monthly/kumi-${new Date(Date.UTC(2025, 8 + m, 1)).toISOString().slice(0, 7)}.dump.enc`, Buffer.from("x"));
  const file = join(dir, "kumi-2026-11-10.dump"), manifest = join(dir, "kumi-2026-11-10.json");
  writeFileSync(file, "PGDMP tonight"); writeFileSync(manifest, JSON.stringify({ kind: "kumi-backup", tables: { club: 1 } }));
  const r = await offsitePush(c, { file, manifestFile: manifest, key, prefix: "kumi/", now: new Date("2026-11-10T11:17:00Z") });
  assert.equal(r.key, "kumi/daily/kumi-2026-11-10.dump.enc");
  assert.equal(r.monthly, null);   // 2026-11 already has its monthly copy
  assert.deepEqual(openBackup(s3.objects.get(r.key)!, key).toString(), "PGDMP tonight");
  const daily = [...s3.objects.keys()].filter((k) => k.startsWith("kumi/daily/") && k.endsWith(".dump.enc")).sort();
  assert.equal(daily.length, 30);
  assert.equal(daily.at(-1), "kumi/daily/kumi-2026-11-10.dump.enc");
  assert.equal([...s3.objects.keys()].filter((k) => k.startsWith("kumi/monthly/")).length, 12);
  assert.deepEqual(await offsiteLatest(c, "kumi/"), { dump: "kumi/daily/kumi-2026-11-10.dump.enc", manifest: "kumi/daily/kumi-2026-11-10.json.enc" });
  // A new month: its first night makes the monthly copy.
  writeFileSync(join(dir, "kumi-2026-12-01.dump"), "PGDMP december");
  const dec = await offsitePush(c, { file: join(dir, "kumi-2026-12-01.dump"), manifestFile: null, key, prefix: "kumi/", now: new Date("2026-12-01T11:17:00Z") });
  assert.equal(dec.monthly, "kumi/monthly/kumi-2026-12.dump.enc");
  assert.equal([...s3.objects.keys()].filter((k) => k.startsWith("kumi/monthly/")).length, 12);
  assert.deepEqual(await offsiteRetention(c, "kumi/"), []);
});

test("the offsite settings come from the environment, all four needed", () => {
  assert.equal(s3FromEnv({ KUMI_OFFSITE_ENDPOINT: "https://acct.r2.cloudflarestorage.com" }), null);
  assert.deepEqual(s3FromEnv({ KUMI_OFFSITE_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", KUMI_OFFSITE_BUCKET: "b", KUMI_OFFSITE_ACCESS_KEY_ID: "a", KUMI_OFFSITE_SECRET_ACCESS_KEY: "s" }),
    { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "a", secretAccessKey: "s", region: "auto", pathStyle: true });
});
