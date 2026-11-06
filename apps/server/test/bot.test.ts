import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { BotCheck, BASE_BITS, solve, zeroBits } from "../src/bot.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court: string, pass: string;
const provider = new TestProvider();
const mailer = new MemoryMailer(), people: Record<string, string> = {};
let ip = "198.51.100.1";
const post = async (path: string, body: unknown, cookie = "") => {
  const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
};
/** What the browser does: ask for a challenge and solve it. */
async function proof() {
  const c = await (await app.request("/auth/challenge")).json() as { challenge: string; bits: number };
  return { challenge: c.challenge, counter: solve(c.challenge, c.bits) };
}

test("the check itself: solved is fine; reused, late, wrong, forged, too easy or a filled-in hidden field isn't", () => {
  let now = 1_800_000_000_000;
  const bot = new BotCheck(() => now);
  const a = bot.issue("1.1.1.1");
  assert.equal(a.bits, BASE_BITS);
  const good = { challenge: a.challenge, counter: solve(a.challenge, a.bits) };
  assert.equal(bot.check("1.1.1.1", good, ""), "ok");
  assert.equal(bot.check("1.1.1.1", good, ""), "replayed");
  const b = bot.issue("2.2.2.2");
  assert.equal(bot.check("2.2.2.2", { challenge: b.challenge, counter: solve(b.challenge, b.bits) }, "https://spam.example"), "honeypot");
  assert.equal(bot.check("3.3.3.3", undefined, ""), "missing");
  const c = bot.issue("3.3.3.3");
  // One character of the signature changed: its first, since the last one's low bits are base64 padding, which
  // decoding ignores (an "A" made a "B" there was sometimes the same signature, and the test failed now and then).
  const [nonce, exp, bits, sig] = c.challenge.split(".") as [string, string, string, string];
  assert.equal(bot.check("3.3.3.3", { challenge: `${nonce}.${exp}.${bits}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`, counter: 1 }, ""), "forged");
  // A counter that doesn't make enough zero bits (from another address: the forgery made this one's harder).
  const w = bot.issue("6.6.6.6");
  let wrong = 0;
  while (zeroBits(createHash("sha256").update(`${w.challenge}:${wrong}`).digest()) >= w.bits) wrong++;
  assert.equal(bot.check("6.6.6.6", { challenge: w.challenge, counter: wrong }, ""), "wrong");
  // Every failure makes this address's next challenges harder; one asked for before is now too easy.
  const d = bot.issue("4.4.4.4");
  bot.fail("4.4.4.4"); bot.fail("4.4.4.4");
  assert.equal(bot.bits("4.4.4.4"), BASE_BITS + 2);
  assert.equal(bot.check("4.4.4.4", { challenge: d.challenge, counter: solve(d.challenge, d.bits) }, ""), "too_easy");
  const e = bot.issue("5.5.5.5");
  now += 11 * 60_000;
  assert.equal(bot.check("5.5.5.5", { challenge: e.challenge, counter: solve(e.challenge, e.bits) }, ""), "expired");
});

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(provider);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true, sign_up_open: true }, owner);
  people.Sam = ((await run(db, "person.create", { display_name: "Sam", email: "sam@example.test" }, owner)).result as any).person_id;
  people.Ana = ((await run(db, "person.create", { display_name: "Ana", email: "ana@example.test" }, owner)).result as any).person_id;
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor);
  pass = ((await run(db, "pass_product.set", { name: "5 courts", covers: "courts", price_cents: 17500, uses: 5 }, owner)).result as any).product_id;
  app = makeApp({ db, mailer, secureCookies: false, clientIp: () => ip, botCheck: true });
});
after(async () => drop());

test("asking for a sign-in code needs the challenge solved; a filled-in hidden field gets the usual answer and no email", async () => {
  assert.equal((await post("/auth/email/start", { email: "sam@example.test" })).json.error, "error.bot_check");
  ip = "198.51.100.2";
  const before = mailer.sent.length;
  const trap = await post("/auth/email/start", { email: "sam@example.test", pow: await proof(), website: "http://spam.example" });
  assert.deepEqual([trap.status, trap.json], [200, { sent: true }]);
  assert.equal(mailer.sent.length, before);
  ip = "198.51.100.3";
  assert.equal((await post("/auth/email/start", { email: "sam@example.test", pow: await proof(), website: "" })).status, 200);
  assert.match(mailer.last("sam@example.test")!.subject, /sign-in code/);
});

test("joining needs it too", async () => {
  ip = "198.51.100.4";
  await post("/auth/email/start", { email: "new@example.test", pow: await proof() });
  const code = mailer.last("new@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const { ticket } = (await post("/auth/email/verify", { email: "new@example.test", code })).json;
  assert.equal((await post("/auth/sign-up", { ticket, display_name: "Nova", locale: "en", club_news: false })).json.error, "error.bot_check");
  assert.equal((await post("/auth/sign-up", { ticket, display_name: "Nova", locale: "en", club_news: false, pow: await proof() })).json.signed_in, true);
});

test("a card form for a member's payment needs it; staff at the desk don't", async () => {
  const signIn = async (email: string) => {
    ip = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;
    await post("/auth/email/start", { email, pow: await proof() });
    return (await post("/auth/email/verify", { email, code: mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]! })).cookie;
  };
  const book = async (who: string, cookie: string, hour: number) => {
    const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const p = await post("/actions/booking.request/plan", { court_id: court, starts_at: `${day}T${String(hour).padStart(2, "0")}:00:00-08:00`, minutes: 60, pay: "whole", person_id: people[who] }, cookie);
    return (await post(`/runs/${p.json.run_id}/apply`, {}, cookie)).json.result.payment_id as string;
  };
  const sam = await signIn("sam@example.test"), paySam = await book("Sam", sam, 9);
  assert.equal((await post(`/my/payments/${paySam}/intent`, {}, sam)).json.error, "error.bot_check");
  assert.equal((await post(`/my/payments/${paySam}/intent`, { pow: await proof() }, sam)).status, 200);
  const robin = await signIn("robin@example.test"), payRobin = await book("Robin", robin, 11);
  assert.equal((await post(`/my/payments/${payRobin}/intent`, {}, robin)).status, 200);
});

test("a gift card and a pass bought by card in the app: the card form passes the check, is a payment, and they're theirs once paid", async () => {
  // Phone check 5: the card-only sheet opened as a save-a-card sheet, with no proof, and the server refused it.
  ip = "198.51.100.230";
  await post("/auth/email/start", { email: "ana@example.test", pow: await proof() });
  const ana = (await post("/auth/email/verify", { email: "ana@example.test", code: mailer.last("ana@example.test")!.text.match(/\b(\d{6})\b/)![1]! })).cookie;
  const buy = async (action: string, input: object) => {
    const p = await post(`/actions/${action}/plan`, { person_id: people.Ana, ...input }, ana);
    return (await post(`/runs/${p.json.run_id}/apply`, {}, ana)).json.result.payment_id as string;
  };
  const get = async (path: string) => (await app.request(path, { headers: { cookie: ana } })).json() as Promise<any>;
  const refOf = async (id: string) => (await db.selectFrom("payment").select("provider_ref").where("id", "=", id).executeTakeFirstOrThrow()).provider_ref!;

  const card = await buy("gift_card.buy", { cents: 5000, for_name: "Ben" });
  assert.equal((await post(`/my/payments/${card}/intent`, {}, ana)).json.error, "error.bot_check");
  const opened = await post(`/my/payments/${card}/intent`, { pow: await proof() }, ana);
  assert.equal(opened.status, 200);
  assert.match(opened.json.client_secret, /^pi_test_/, "a payment's card form, not a card setup's");
  provider.settle(await refOf(card), "succeeded");
  // A second tap on Pay after the card went through, before anything here recorded it: recorded now, no second form.
  assert.deepEqual((await post(`/my/payments/${card}/intent`, { pow: await proof() }, ana)).json, { paid: true });
  assert.equal((await post(`/my/payments/${card}/check`, {}, ana)).json.status, "succeeded");
  const mine = (await get("/my/gift-cards")).filter((x: any) => x.bought);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "active");
  assert.match(mine[0].code, /^[0-9A-Z]{4}-/);

  const pay = await buy("pass.buy", { product_id: pass });
  assert.equal((await post(`/my/payments/${pay}/intent`, {}, ana)).json.error, "error.bot_check");
  assert.equal((await post(`/my/payments/${pay}/intent`, { pow: await proof() }, ana)).status, 200);
  provider.settle(await refOf(pay), "succeeded");
  assert.equal((await post(`/my/payments/${pay}/check`, {}, ana)).json.status, "succeeded");
  assert.deepEqual((await get("/my/passes")).mine.map((x: any) => [x.name, x.status, x.uses_left]), [["5 courts", "active", 5]]);
  assert.equal(provider.intents.size >= 2, true);
  assert.equal([...provider.intents.values()].filter((i) => i.status === "succeeded").length, 2, "each paid once");
});

test("buying again after a try that wasn't paid: the earlier one is called off, not left waiting on the list", async () => {
  ip = "198.51.100.231";
  await post("/auth/email/start", { email: "sam@example.test", pow: await proof() });
  const sam = (await post("/auth/email/verify", { email: "sam@example.test", code: mailer.last("sam@example.test")!.text.match(/\b(\d{6})\b/)![1]! })).cookie;
  const buy = async (action: string, input: object) => {
    const p = await post(`/actions/${action}/plan`, { person_id: people.Sam, ...input }, sam);
    return (await post(`/runs/${p.json.run_id}/apply`, {}, sam)).json.result.payment_id as string;
  };
  const cards = async () => (await (await app.request("/my/gift-cards", { headers: { cookie: sam } })).json() as any[]).filter((x) => x.bought);
  const status = async (id: string) => (await db.selectFrom("payment").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
  // A form that never opened (as on the phone), then one opened and closed: neither stays.
  const first = await buy("gift_card.buy", { cents: 5000 });
  const second = await buy("gift_card.buy", { cents: 5000 });
  assert.equal(await status(first), "failed");
  assert.equal((await post(`/my/payments/${second}/intent`, { pow: await proof() }, sam)).status, 200);
  const third = await buy("gift_card.buy", { cents: 6000 });
  assert.equal(await status(second), "failed");
  assert.ok(await db.selectFrom("event_outbox").select("id").where("topic", "=", "payment.call_off").where(sql<string>`payload->>'payment_id'`, "=", second).executeTakeFirst(), "its card form is called off at the provider");
  assert.deepEqual((await cards()).map((x) => [x.amount_cents, x.status, x.pending_payment_id]), [[6000, "pending", third]]);
  const p1 = await buy("pass.buy", { product_id: pass });
  const p2 = await buy("pass.buy", { product_id: pass });
  assert.deepEqual([await status(p1), await status(p2)], ["failed", "pending"]);
});

test("production never runs without it; a practice server can leave it off", async () => {
  assert.throws(() => makeApp({ db, mailer, production: true, botCheck: false }), /can't be switched off in production/);
  const practice = makeApp({ db, mailer, secureCookies: false });
  assert.deepEqual(await (await practice.request("/auth/challenge")).json(), { challenge: null, bits: 0 });
});
