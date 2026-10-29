import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryMailer, PracticeMailer, ResendMailer } from "../src/mailer.ts";

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
