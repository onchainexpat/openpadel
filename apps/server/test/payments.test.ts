import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setPaymentProvider, uuidv7, StripeProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

// Stripe, played by a map: intents are created, read back, and marked paid by the test.
const intents = new Map<string, { status: string; secret: string; amount: number; key: string }>();
const fakeStripe = async (url: string, init?: RequestInit) => {
  const u = new URL(url), body = new URLSearchParams(String(init?.body ?? "")), key = (init?.headers as Record<string, string>)["idempotency-key"] ?? "";
  if (init?.method === "POST" && u.pathname === "/v1/payment_intents") {
    const known = [...intents].find(([, v]) => v.key === key);
    const id = known?.[0] ?? `pi_${intents.size + 1}`;
    if (!known) intents.set(id, { status: "requires_payment_method", secret: `${id}_secret`, amount: Number(body.get("amount")), key });
    return Response.json({ id, client_secret: intents.get(id)!.secret, status: intents.get(id)!.status });
  }
  const m = u.pathname.match(/^\/v1\/payment_intents\/(.+)$/);
  if (m && intents.has(m[1]!)) { const it = intents.get(m[1]!)!; return Response.json({ id: m[1], client_secret: it.secret, status: it.status }); }
  return Response.json({ error: { message: "no such thing" } }, { status: 404 });
};
const WHSEC = "whsec_test_kumi";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, program: string, ana: string, ben: string;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => { const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
const webhook = (payload: string, sig: string) => app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: payload });
const sign = (payload: string, secret = WHSEC) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`; };
async function member(name: string) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}@example.test`, created_via: "desk" }).execute();
  const role = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: role.id, location_id: null }).execute();
  return id;
}
async function joinUnpaid(cookie: string, personId: string) {
  const p = await call("/actions/enrolment.join/plan", cookie, { program_id: program, person_id: personId });
  return (await call(`/runs/${p.json.run_id}/apply`, cookie, {})).json.result.payment_id as string;
}
const status = async (id: string) => (await db.selectFrom("payment").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new StripeProvider({ secretKey: "sk_test_kumi", fetch: fakeStripe }));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, stripe: { publishableKey: "pk_test_kumi", webhookSecret: WHSEC } });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  program = ((await run(db, "program.create", { location_id: loc, kind: "social", format: "americano", name: "Friday Americano", capacity: 8, price_cents: 2500 }, owner)).result as any).program_id;
  await run(db, "session.add", { program_id: program, starts_at: new Date(Date.now() + 2 * 864e5).toISOString(), ends_at: new Date(Date.now() + 2 * 864e5 + 7200_000).toISOString(), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: program }, owner);
  ana = await member("Ana"); ben = await member("Ben");
});
after(async () => drop());

test("the members' app is told which card form to show, with the publishable key", async () => {
  const cookie = await signIn("ana@example.test");
  assert.deepEqual((await call("/payments/config", cookie)).json, { provider: "stripe", publishable_key: "pk_test_kumi", stripe_account: null, ready: true });   // direct: the key is the club's own
});

test("pay: the card form opens once, and the app's check records the payment when Stripe has it", async () => {
  const cookie = await signIn("ana@example.test"), other = await signIn("ben@example.test");
  const pay = await joinUnpaid(cookie, ana);
  assert.equal(intents.size, 0, "joining asks Stripe for nothing");
  const a = await call(`/my/payments/${pay}/intent`, cookie, {});
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { provider: "stripe", client_secret: "pi_1_secret", publishable_key: "pk_test_kumi", stripe_account: null });
  assert.equal((await call(`/my/payments/${pay}/intent`, cookie, {})).json.client_secret, "pi_1_secret");
  assert.equal(intents.size, 1);
  assert.equal(intents.get("pi_1")!.amount, 2500);
  assert.equal((await call(`/my/payments/${pay}/intent`, other, {})).status, 404, "someone else's payment");
  assert.equal((await call(`/my/payments/${pay}/check`, cookie, {})).json.status, "pending");
  intents.get("pi_1")!.status = "succeeded";   // the card went through in Stripe's form
  assert.equal((await call(`/my/payments/${pay}/check`, cookie, {})).json.status, "succeeded");
  assert.equal(await status(pay), "succeeded");
  assert.equal((await call(`/my/payments/${pay}/intent`, cookie, {})).status, 409, "nothing left to pay");
});

test("Stripe's webhook settles a payment, but only when Stripe signed it", async () => {
  const cookie = await signIn("ben@example.test");
  const pay = await joinUnpaid(cookie, ben);
  await call(`/my/payments/${pay}/intent`, cookie, {});
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", pay).executeTakeFirstOrThrow()).provider_ref!;
  intents.get(ref)!.status = "succeeded";   // paid, and Ben closed the app before it checked
  const event = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: ref, object: "payment_intent", status: "succeeded" } } });
  assert.equal((await webhook(event, sign(event, "whsec_someone_else"))).status, 400);
  assert.equal(await status(pay), "pending", "an unsigned message changes nothing");
  assert.equal((await webhook(event, sign(event))).status, 200);
  assert.equal(await status(pay), "succeeded");
  assert.equal((await webhook(event, sign(event))).status, 200, "Stripe sends it again: still fine");
  const other = JSON.stringify({ id: "evt_2", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
  assert.equal((await webhook(other, sign(other))).status, 200, "events Kumi doesn't use are acknowledged");
});

test("checking a payment from the app is limited per person: each check can be a question to Stripe", async () => {
  const cara = await member("Cara"), cookie = await signIn("cara@example.test");
  const pay = await joinUnpaid(cookie, cara);
  const answers: number[] = [];
  for (let k = 0; k < 31; k++) answers.push((await call(`/my/payments/${pay}/check`, cookie, {})).status);
  assert.deepEqual([answers.filter((s) => s === 200).length, answers.at(-1)], [30, 429]);
});
