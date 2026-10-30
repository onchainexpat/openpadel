import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { encryptPush, generateVapidKeys, isPushEndpoint, sendPush, vapidAuthorization } from "../src/webpush.ts";

const u = (s: string) => Buffer.from(s, "base64url");

test("encryption matches the worked example in RFC 8291 (Appendix A), byte for byte", () => {
  const out = encryptPush(Buffer.from("When I grow up, I want to be a watermelon"),
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
    { salt: u("DGv6ra1nlYgDCS1FRnbzlw"), senderPrivate: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") });
  assert.equal(out.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("a device can read what was encrypted for it (a fresh key and salt each time)", () => {
  const device = createECDH("prime256v1"); device.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  const msg = Buffer.from(JSON.stringify({ title: "Pagado", body: "Ya estás dentro: 6:00 p.m." }));
  const a = encryptPush(msg, device.getPublicKey().toString("base64url"), auth.toString("base64url"));
  const b = encryptPush(msg, device.getPublicKey().toString("base64url"), auth.toString("base64url"));
  assert.notEqual(a.toString("hex"), b.toString("hex"));
  // What the browser does (RFC 8291 section 3.4, from the receiving side).
  const salt = a.subarray(0, 16), idlen = a[20]!, sender = a.subarray(21, 21 + idlen), body = a.subarray(21 + idlen);
  const ikm = Buffer.from(hkdfSync("sha256", device.computeSecret(sender), auth, Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), sender]), 32));
  const d = createDecipheriv("aes-128-gcm", Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)));
  d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), { title: "Pagado", body: "Ya estás dentro: 6:00 p.m." });
});

test("the VAPID token is signed with the club's key, for that push service, and expires", () => {
  const keys = generateVapidKeys(), now = new Date("2026-11-30T16:00:00Z");
  const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:owner@club.test", now);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(k, keys.publicKey);
  const [h, c, s] = jwt!.split(".");
  const claims = JSON.parse(u(c!).toString());
  assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: now.getTime() / 1000 + 12 * 3600, sub: "mailto:owner@club.test" });
  const pub = u(keys.publicKey);
  const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, u(s!)));
});

test("only browser push services are push endpoints", () => {
  assert.ok(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x"));
  for (const bad of ["http://fcm.googleapis.com/x", "https://evil.test/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.test/x", "not a url"]) assert.ok(!isPushEndpoint(bad), bad);
});

test("sending: the headers a push service needs, and a dead subscription comes back as gone", async () => {
  const keys = generateVapidKeys(), device = createECDH("prime256v1"); device.generateKeys();
  const sub = { endpoint: "https://push.example.test/sub/1", p256dh: device.getPublicKey().toString("base64url"), auth: "AAAAAAAAAAAAAAAAAAAAAA" };
  let seen: RequestInit | null = null;
  assert.deepEqual(await sendPush(sub, { title: "x" }, keys, "mailto:a@b.test", { fetch: async (_u, init) => { seen = init; return new Response(null, { status: 201 }); } }), { ok: true });
  const h = seen!.headers as Record<string, string>;
  assert.deepEqual([h["content-encoding"], h.ttl, h.urgency], ["aes128gcm", "86400", "normal"]);
  assert.deepEqual(await sendPush(sub, { title: "x" }, keys, "mailto:a@b.test", { fetch: async () => new Response(null, { status: 410 }) }), { ok: false, gone: true, status: 410 });
});
