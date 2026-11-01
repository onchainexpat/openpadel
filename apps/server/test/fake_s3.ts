// A small S3 stand-in for the tests: put, get, delete and list (ListObjectsV2, two keys a page so the paging is
// used), every request's SigV4 signature checked against the secret it was given. Path-style addressing.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { signV4 } from "../src/s3.ts";

export interface FakeS3 { url: string; objects: Map<string, Buffer>; requests: string[]; close: () => Promise<void> }

export async function fakeS3(o: { bucket: string; accessKeyId: string; secretAccessKey: string; region: string }): Promise<FakeS3> {
  const objects = new Map<string, Buffer>(), requests: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks), url = new URL(req.url!, "http://x");
    const fail = (status: number, code: string) => { res.writeHead(status, { "content-type": "application/xml" }); res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`); };
    // The signature: recomputed from what arrived, with the secret this bucket knows.
    const auth = String(req.headers.authorization ?? ""), m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(auth);
    if (!m || m[1] !== o.accessKeyId || m[3] !== o.region) return fail(403, "InvalidAccessKeyId");
    const hash = String(req.headers["x-amz-content-sha256"]);
    if (hash !== createHash("sha256").update(body).digest("hex")) return fail(400, "XAmzContentSHA256Mismatch");
    const signed = m[4]!.split(";").filter((h) => h !== "host"), headers = Object.fromEntries(signed.map((h) => [h, String(req.headers[h])]));
    const query = Object.fromEntries(url.searchParams.entries());
    const want = signV4({ method: req.method!, host: String(req.headers.host), path: decodeURIComponent(url.pathname), query, headers, payloadHash: hash,
      amzDate: String(req.headers["x-amz-date"]), region: o.region, service: "s3", accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey });
    if (!want.authorization.endsWith(`Signature=${m[5]}`)) return fail(403, "SignatureDoesNotMatch");
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/"), key = rest.join("/");
    if (bucket !== o.bucket) return fail(404, "NoSuchBucket");
    requests.push(`${req.method} ${key || `?${url.searchParams}`}`);
    if (req.method === "PUT") { objects.set(key, body); res.writeHead(200); return res.end(); }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); return res.end(); }
    if (req.method === "GET" && key) { const b = objects.get(key); if (!b) return fail(404, "NoSuchKey"); res.writeHead(200); return res.end(b); }
    if (req.method === "GET" && query["list-type"] === "2") {
      const all = [...objects.keys()].filter((k) => k.startsWith(query.prefix ?? "")).sort();
      const from = query["continuation-token"] ? all.indexOf(query["continuation-token"]) : 0, page = all.slice(from, from + 2), next = all[from + 2];
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${
        page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>2026-11-30T00:00:00.000Z</LastModified><Size>${objects.get(k)!.length}</Size></Contents>`).join("")}</ListBucketResult>`);
    }
    fail(400, "NotImplemented");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, requests, close: () => new Promise((r) => server.close(() => r())) };
}
