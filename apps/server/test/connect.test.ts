import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { fakeStripe } from "../../../packages/core/test/fake-stripe.ts";
import { clubStripeAccount, runAsSystem, setPaymentProvider, uuidv7, StripeProvider, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const fake = fakeStripe(), WHSEC = "whsec_connect_test";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => { const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
const sign = (payload: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex")}`; };

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new StripeProvider({ secretKey: "sk_test_platform", fetch: fake.fetch, connect: clubStripeAccount(db) }));
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://kestrel.example", stripe: { publishableKey: "pk_test_platform", webhookSecret: WHSEC } });
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: "Ana", email: "ana@example.test", created_via: "desk" }).execute();
  const role = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: role.id, location_id: null }).execute();
});
after(async () => drop());

test("the owner connects the club's Stripe account from the Payments page; members can't", async () => {
  const owner = await signIn("robin@example.test"), ana = await signIn("ana@example.test");
  assert.deepEqual((await call("/staff/payments", owner)).json, { mode: "connect", live: false, account: null });
  assert.equal((await call("/staff/payments", ana)).status, 403);
  assert.equal((await call("/staff/payments/connect", ana, {})).status, 403);
  assert.equal(fake.accounts.size, 0);
  // Members see that card payments aren't on yet.
  assert.deepEqual((await call("/payments/config", ana)).json, { provider: "stripe", publishable_key: "pk_test_platform", stripe_account: null, ready: false });

  const r = await call("/staff/payments/connect", owner, {});
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\/connect\.stripe\.com\//);
  const link = fake.calls.findLast((c) => c.path === "/v1/account_links")!;
  assert.equal(link.body.get("return_url"), "https://kestrel.example/payments?stripe=return");
  assert.equal(link.body.get("refresh_url"), "https://kestrel.example/payments?stripe=refresh");
  const acct = [...fake.accounts.keys()][0]!;
  assert.equal(fake.calls.find((c) => c.path === "/v1/accounts")!.body.get("email"), "robin@example.test", "Stripe's setup starts with the owner's email");
  assert.deepEqual((await call("/staff/payments", owner)).json.account, { tail: acct.slice(-4), charges_enabled: false, details_submitted: false });
});

test("Stripe's webhook says the account is ready: members can pay, on the club's account", async () => {
  const owner = await signIn("robin@example.test"), ana = await signIn("ana@example.test");
  const acct = [...fake.accounts.keys()][0]!;
  fake.accounts.get(acct)!.charges_enabled = true; fake.accounts.get(acct)!.details_submitted = true;
  const ev = JSON.stringify({ id: "evt_a", type: "account.updated", account: acct, data: { object: { id: acct, object: "account" } } });
  assert.equal((await app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sign(ev) }, body: ev })).status, 200);
  assert.equal((await call("/staff/payments", owner)).json.account.charges_enabled, true);
  assert.deepEqual((await call("/payments/config", ana)).json, { provider: "stripe", publishable_key: "pk_test_platform", stripe_account: acct, ready: true });
});
