import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, usageView } from "@kumi/core";
import { MemoryMailer, MeteredMailer, PracticeMailer, ResendMailer } from "../src/mailer.ts";

function fakeResend(status = 200, reply: unknown = { id: "e_1" }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

test("an email goes to Resend from the club's address, once however often it's retried", async () => {
  const f = fakeResend();
  const m = new ResendMailer({ apiKey: "re_test_123", from: "Kestrel Padel <hello@kestrel.example>", replyTo: "desk@kestrel.example", fetch: f.fetch });
  await m.send({ to: "sam@example.test", subject: "Paid: Friday social", text: "We have your $30.00.", id: "0192-msg" });
  assert.equal(f.calls[0]!.url, "https://api.resend.com/emails");
  assert.equal(f.calls[0]!.headers.authorization, "Bearer re_test_123");
  assert.equal(f.calls[0]!.headers["idempotency-key"], "kumi:0192-msg");
  assert.deepEqual(f.calls[0]!.body, { from: "Kestrel Padel <hello@kestrel.example>", to: ["sam@example.test"], subject: "Paid: Friday social", text: "We have your $30.00.", reply_to: "desk@kestrel.example" });
});

test("Resend saying no is a failure the sender retries", async () => {
  const m = new ResendMailer({ apiKey: "re_x", from: "hello@kestrel.example", fetch: fakeResend(403, { name: "validation_error", message: "The kestrel.example domain is not verified." }).fetch });
  await assert.rejects(m.send({ to: "a@example.test", subject: "s", text: "t" }), /resend 403: The kestrel.example domain is not verified\./);
  assert.throws(() => new ResendMailer({ apiKey: "sk_live_nope", from: "hello@kestrel.example" }), /isn't a Resend API key/);
});

test("outside production, only the test addresses get real email", async () => {
  const inner = new MemoryMailer();
  const m = new PracticeMailer(inner, ["Robin@example.test", " staff@example.test "]);
  await m.send({ to: "robin@example.test", subject: "a", text: "a" });
  await m.send({ to: "real.member@example.test", subject: "b", text: "b" });
  assert.deepEqual(inner.sent.map((x) => x.to), ["robin@example.test"]);
  assert.deepEqual(m.held.map((x) => x.to), ["real.member@example.test"]);
});

test("live with no email, the server won't start: sign-in codes would only reach its log", () => {
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  const env = { PATH: process.env.PATH!, NODE_ENV: "production", KUMI_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"), DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" };
  const r = spawnSync(process.execPath, [main], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /email isn't set up .*OPENPADEL_PRACTICE=1/);
});

test("the memory mailer keeps only the newest 500", async () => {
  const m = new MemoryMailer();
  for (let i = 0; i < 520; i++) await m.send({ to: `p${i}@example.test`, subject: "x", text: "x" } as any);
  assert.equal(m.sent.length, 500);
  assert.equal(m.sent[0]!.to, "p20@example.test");
});

test("each email the provider takes counts on the club's meter; one it refuses doesn't, and practice email held back doesn't either", async () => {
  const { db, drop } = await freshDb();
  try {
    await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
    const ok = new MeteredMailer(new ResendMailer({ apiKey: "re_x", from: "hello@kestrel.example", fetch: fakeResend().fetch }), db);
    await ok.send({ to: "a@example.test", subject: "s", text: "t" });
    const no = new MeteredMailer(new ResendMailer({ apiKey: "re_x", from: "hello@kestrel.example", fetch: fakeResend(500).fetch }), db);
    await assert.rejects(no.send({ to: "a@example.test", subject: "s", text: "t" }));
    await new PracticeMailer(ok, ["desk@kestrel.example"]).send({ to: "a@example.test", subject: "s", text: "t" });
    assert.equal((await usageView(db))!.kinds.email.count, 1);
  } finally { await drop(); }
});
