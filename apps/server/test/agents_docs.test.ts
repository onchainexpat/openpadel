// What docs/agents/ promises about webhooks: the signature sample a receiver copies checks the server's own signing,
// and production's rules keep webhooks to public https addresses (webhooks.ts). No database needed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkWebhookUrl, signatureHeader, verifyWebhookSignature } from "@kumi/core";
import { publicHost, useWebhookRules, webhookPost } from "../src/webhooks.ts";

const DOCS = join(import.meta.dirname, "../../../docs/agents");
const dir = mkdtempSync(join(tmpdir(), "kumi-webhook-doc-"));
after(() => { rmSync(dir, { recursive: true, force: true }); useWebhookRules(false); });

test("the Node signature check in webhooks.md accepts the server's signature, and refuses a changed body, another secret or an old time", async () => {
  const md = readFileSync(join(DOCS, "webhooks.md"), "utf8");
  const sample = /<!-- signature-sample[^>]*-->\s*```js\n([\s\S]*?)```/.exec(md)?.[1];
  assert.ok(sample, "the marked sample is there");
  const file = join(dir, "verify.mjs");
  writeFileSync(file, sample);
  const { verifyOpenPadelSignature } = await import(pathToFileURL(file).href) as { verifyOpenPadelSignature: (s: string, h: string, b: string, now?: number) => boolean };
  const secret = "whsec_" + "k".repeat(43), body = JSON.stringify({ id: "evt_1", type: "booking.cancelled", created_at: "2026-11-16T18:20:00.000Z", data: { booking_id: "b1" } });
  const t = Math.floor(Date.now() / 1000), header = signatureHeader(secret, t, body);
  assert.equal(verifyOpenPadelSignature(secret, header, body), true);
  assert.equal(verifyWebhookSignature(secret, header, body), true, "and the server's own check agrees");
  assert.equal(verifyOpenPadelSignature(secret, header, body.replace("b1", "b2")), false);
  assert.equal(verifyOpenPadelSignature("whsec_other", header, body), false);
  assert.equal(verifyOpenPadelSignature(secret, signatureHeader(secret, t - 600, body), body), false, "a delivery replayed later");
  assert.equal(verifyOpenPadelSignature(secret, "t=abc,v1=zz", body), false);
});

test("every recipe the README lists is there", () => {
  const readme = readFileSync(join(DOCS, "README.md"), "utf8");
  for (const [, file] of readme.matchAll(/\]\(([a-z-]+\.md)\)/g)) assert.ok(readFileSync(join(DOCS, file!), "utf8").length > 200, file);
});

test("in production, webhooks go only to public https addresses; in development, anywhere", async () => {
  useWebhookRules(true);
  for (const bad of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://localhost/x",
    "https://db.internal/x", "https://intranet/x", "https://user:pw@hooks.example.com/x", "ftp://hooks.example.com/x", "not a url"])
    assert.throws(() => checkWebhookUrl(bad), (e: any) => e.code?.startsWith("error.webhook_"), bad);
  assert.equal(checkWebhookUrl("https://hooks.example.com/in#frag"), "https://hooks.example.com/in");
  assert.equal(publicHost("8.8.8.8"), true);
  assert.equal(publicHost("192.168.1.10"), false);
  // And when it's sent: the address is checked again, before anything is connected to.
  await assert.rejects(webhookPost(true)("https://127.0.0.1:9/x", "{}", {}), /isn't a public address/);
  await assert.rejects(webhookPost(true)("http://hooks.example.com/x", "{}", {}), /https only/);
  useWebhookRules(false);
  assert.equal(checkWebhookUrl("http://127.0.0.1:5678/webhook/abc"), "http://127.0.0.1:5678/webhook/abc");
});
