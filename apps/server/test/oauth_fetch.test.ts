// Fetching a client's published identity (OAuth client metadata document): anyone can name its address before
// signing in, so the fetch never reaches the server's own network, reads at most 64 KB, and gives up after 5 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { defaultFetchMetadata, publicAddress, publicOnlyLookup, readCapped, METADATA_MAX_BYTES } from "../src/oauth.ts";

test("only public addresses: loopback, private ranges, link-local and the cloud metadata address are refused", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"])
    assert.equal(publicAddress(a), false, a);
  for (const a of ["8.8.8.8", "160.79.104.10", "2606:4700::1111"]) assert.equal(publicAddress(a), true, a);
});

test("the connection's own lookup refuses a name with any non-public answer (no DNS rebinding gap)", async () => {
  const look = (answers: { address: string; family: number }[], all: boolean) => new Promise<any>((resolve) =>
    publicOnlyLookup((_h, cb) => cb(null, answers))("x.example", { all }, (err: Error | null, a: unknown, f?: number) => resolve(err ?? (all ? a : { a, f }))));
  assert.match(String(await look([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], true)), /isn't a public address/);
  assert.match(String(await look([{ address: "10.0.0.5", family: 4 }], false)), /isn't a public address/);
  assert.deepEqual(await look([{ address: "93.184.216.34", family: 4 }], false), { a: "93.184.216.34", f: 4 });
  assert.deepEqual(await look([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800::1", family: 6 }], true), [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800::1", family: 6 }]);
});

test("a body is read only up to the limit: a huge document fails without being held in memory", async () => {
  const chunk = Buffer.alloc(16 * 1024, 32);
  await assert.rejects(readCapped(Readable.from(Array.from({ length: 1000 }, () => chunk)), METADATA_MAX_BYTES), /too large/);
  assert.equal((await readCapped(Readable.from([Buffer.from('{"a":1}')]), METADATA_MAX_BYTES)).toString(), '{"a":1}');
});

test("the fetch refuses plain http and the server's own addresses before connecting", async () => {
  await assert.rejects(defaultFetchMetadata("http://example.com/client.json"), /https only/);
  await assert.rejects(defaultFetchMetadata("https://127.0.0.1:9/client.json"), /isn't a public address/);
  await assert.rejects(defaultFetchMetadata("https://[::1]:9/client.json"), /isn't a public address/);
  await assert.rejects(defaultFetchMetadata("https://localhost:9/client.json"), /isn't a public address/);
});
