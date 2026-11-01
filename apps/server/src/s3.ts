// A small S3 client for offsite backups: Cloudflare R2, Backblaze B2, AWS S3, DigitalOcean Spaces, MinIO. Only
// what backups need (put, get, list, delete), signed with AWS Signature Version 4 on node:crypto: no SDK. Each
// object is one PUT, so it holds the whole file in memory: fine for a club's database, and capped (S3_PUT_MAX).
import { createHash, createHmac } from "node:crypto";

/** The largest object sent in one PUT. Bigger needs multipart upload, which isn't built: a club's database is
 *  far smaller (tens of MB after years), and the server holds the file in memory while it sends it. */
export const S3_PUT_MAX = 512 * 1024 * 1024;

export interface S3Config { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; pathStyle: boolean }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const sha256hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters; "/" kept in paths. */
export function uriEncode(s: string, keepSlash: boolean): string {
  return Array.from(Buffer.from(s, "utf8")).map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export interface SignInput {
  method: string; host: string; path: string; query?: Record<string, string>;
  headers?: Record<string, string>; payloadHash: string; amzDate: string; region: string; service: string;
  accessKeyId: string; secretAccessKey: string;
  /** The path is already encoded as it should be signed (the AWS test vectors give it that way). */
  encodedPath?: boolean;
}
/** The Authorization header (and the headers it signed) for one request, per AWS Signature Version 4. */
export function signV4(r: SignInput): { authorization: string; signedHeaders: string; canonicalRequest: string; stringToSign: string } {
  const date = r.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: r.host, ...Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = Object.entries(r.query ?? {}).map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const path = r.encodedPath ? r.path : uriEncode(r.path, true);
  const canonicalRequest = [r.method, path, query, canonicalHeaders, signedHeaders, r.payloadHash].join("\n");
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", r.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${r.secretAccessKey}`, date), kRegion = hmac(kDate, r.region), kService = hmac(kRegion, r.service), kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signedHeaders, canonicalRequest, stringToSign };
}

export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export class S3Error extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export interface S3Object { key: string; size: number; lastModified: string }

export class S3Client {
  private c: S3Config;
  private o: { fetch?: Fetch; now?: () => Date };
  constructor(c: S3Config, o: { fetch?: Fetch; now?: () => Date } = {}) { this.c = c; this.o = o; }

  private where(key: string) {
    const base = new URL(this.c.endpoint);
    const host = this.c.pathStyle ? base.host : `${this.c.bucket}.${base.host}`;
    const path = this.c.pathStyle ? `/${this.c.bucket}${key ? `/${key}` : ""}` : `/${key}`;
    return { origin: `${base.protocol}//${host}`, host, path };
  }
  private async send(method: string, key: string, o: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {}) {
    const w = this.where(key), body = o.body ?? Buffer.alloc(0), payloadHash = sha256hex(body), date = amzDate((this.o.now ?? (() => new Date()))());
    const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": date, ...(o.headers ?? {}) };
    const s = signV4({ method, host: w.host, path: w.path, query: o.query, headers, payloadHash, amzDate: date, region: this.c.region, service: "s3", accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey });
    const qs = Object.entries(o.query ?? {}).map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).join("&");
    const res = await (this.o.fetch ?? fetch)(`${w.origin}${uriEncode(w.path, true)}${qs ? `?${qs}` : ""}`, {
      method, headers: { ...headers, authorization: s.authorization }, ...(method === "PUT" ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(10 * 60_000) });
    return res;
  }
  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1], msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    throw new S3Error(`${what}: HTTP ${res.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`, res.status);
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream") {
    if (body.length > S3_PUT_MAX) throw new S3Error(`${key} is ${Math.round(body.length / 1048576)} MB, over the ${S3_PUT_MAX / 1048576} MB one upload can send`, 413);
    const res = await this.send("PUT", key, { body, headers: { "content-type": contentType, "content-length": String(body.length) } });
    if (!res.ok) await this.fail(res, `upload ${key}`);
  }
  async get(key: string): Promise<Buffer> {
    const res = await this.send("GET", key);
    if (!res.ok) await this.fail(res, `download ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key: string) {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) await this.fail(res, `delete ${key}`);
  }
  /** Every object under a prefix (ListObjectsV2, page by page). */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const res = await this.send("GET", "", { query });
      if (!res.ok) await this.fail(res, `list ${prefix}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const part = m[1]!;
        const key = /<Key>([^<]*)<\/Key>/.exec(part)?.[1];
        if (key) out.push({ key: unxml(key), size: Number(/<Size>(\d+)<\/Size>/.exec(part)?.[1] ?? 0), lastModified: /<LastModified>([^<]*)<\/LastModified>/.exec(part)?.[1] ?? "" });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || undefined : undefined;
    } while (token);
    return out;
  }
}
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The offsite settings from the environment, or null when offsite backups aren't set up. */
export function s3FromEnv(env: Record<string, string | undefined>): S3Config | null {
  const endpoint = env.KUMI_OFFSITE_ENDPOINT, bucket = env.KUMI_OFFSITE_BUCKET, accessKeyId = env.KUMI_OFFSITE_ACCESS_KEY_ID, secretAccessKey = env.KUMI_OFFSITE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: endpoint.replace(/\/$/, ""), bucket, accessKeyId, secretAccessKey, region: env.KUMI_OFFSITE_REGION || "auto", pathStyle: env.KUMI_OFFSITE_PATH_STYLE !== "0" };
}
