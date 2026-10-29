// A software passkey for tests: a real P-256 key, "none" attestation in CBOR, signed assertions.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64 = (b: Buffer) => b.toString("base64url");
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported value");
}

export class SoftPasskey {
  readonly credId = randomBytes(16);
  counter = 0;
  private readonly priv: KeyObject;
  private readonly pub: KeyObject;
  private readonly origin: string;
  private userHandle = "";
  constructor(origin: string) { this.origin = origin; const k = generateKeyPairSync("ec", { namedCurve: "P-256" }); this.priv = k.privateKey; this.pub = k.publicKey; }

  create(options: any) {
    this.userHandle = options.user.id;
    const jwk = this.pub.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([sha(options.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const attestation = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: b64(this.credId), rawId: b64(this.credId), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestation), transports: ["internal"] } };
  }

  get(options: any) {
    this.counter++;
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(options.rpId), Buffer.from([0x05]), count]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha(clientData)]), this.priv);
    return { id: b64(this.credId), rawId: b64(this.credId), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: this.userHandle } };
  }
}
