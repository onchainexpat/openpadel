// Email that can't arrive (email_suppression.ts, email_events.ts): Resend's signed reports of a hard bounce, a spam
// complaint or an address it won't send to; the club's email held back from that address (the in-app copy stays, and
// sign-in codes still go); the member's app and the person's staff page saying so; the desk sending to it again; a
// restore keeping what was reported since the copy; `kumi doctor`; and the leaving emails saying what becomes of the
// club's email domain.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { messageHandlers, processOutbox, readEmailReport, run, runAsSystem, sendEmails, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { verifyEmailSignature } from "../src/email_events.ts";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";
import { checkSendingDomain, MemoryMailer } from "../src/mailer.ts";
import { doctor } from "../src/doctor.ts";

const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const FROM = "Kestrel Padel <hello@kestrel.mail.kumi.club>";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, clock = new Date();
const mailer = new MemoryMailer(), people: Record<string, string> = {}, cookies: Record<string, string> = {};
const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";

/** What Resend would post: signed with the endpoint's secret, at the server's time unless said otherwise. */
function signed(body: unknown, o: { secret?: string; at?: number; id?: string } = {}) {
  const raw = JSON.stringify(body), id = o.id ?? `msg_${randomBytes(6).toString("hex")}`, ts = String(o.at ?? Math.floor(clock.getTime() / 1000));
  const key = Buffer.from((o.secret ?? SECRET).slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { raw, headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` } };
}
const post = (s: { raw: string; headers: Record<string, string> }) => app.request("/webhooks/resend", { method: "POST", headers: s.headers, body: s.raw });
const event = (type: string, to: string, extra: Record<string, unknown> = {}, from = FROM) =>
  ({ type, created_at: clock.toISOString(), data: { email_id: `e_${randomBytes(4).toString("hex")}`, from, to: [to], subject: "x", ...extra } });
const held = (address: string) => db.selectFrom("email_suppression").selectAll().where("address", "=", address).executeTakeFirst();
const req = async (path: string, who: string, body?: unknown) => {
  const r = await app.request(path, body === undefined ? { headers: { cookie: cookies[who]! } } : { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function signIn(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[name] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
/** A message to the person waiting in the outbox (an essential one: a booking confirmation would be). */
async function waiting(personId: string, subject: string) {
  const id = uuidv7();
  await db.insertInto("outbound_message").values({ id, person_id: personId, kind: "test", channel: "email", purpose: "account", essential: true, lang: "en", subject, body: "b", link: null,
    status: "waiting", send_after: new Date(clock.getTime() - 1000), stale_at: null } as any).execute();
  return id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test", now: () => clock, emailEvents: { secret: SECRET, from: FROM } });
  for (const name of ["Ann", "Ben", "Cat", "Kim", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(name);
  }
  await run(db, "role.assign", { person_id: people.Kim!, role: "coach" }, owner);
  await run(db, "role.assign", { person_id: people.Fay!, role: "front_desk" }, owner);
});
after(async () => drop());

test("only a signed, recent post is read; without the secret the webhook isn't there", async () => {
  const body = event("email.bounced", "ann@example.test", { bounce: { type: "Permanent", subType: "General", message: "550 no such user" } });
  const ok = signed(body);
  assert.equal(verifyEmailSignature(ok.raw, { id: ok.headers["svix-id"], timestamp: ok.headers["svix-timestamp"], signature: ok.headers["svix-signature"] }, SECRET, clock.getTime()), true);
  // Another secret, a changed body, an old post, no signature, a v2 signature only: all refused, nothing recorded.
  const other = signed(body, { secret: `whsec_${randomBytes(24).toString("base64")}` });
  assert.equal((await post(other)).status, 400);
  assert.equal((await post({ raw: ok.raw.replace("ann@", "ben@"), headers: ok.headers })).status, 400);
  assert.equal((await post(signed(body, { at: Math.floor(clock.getTime() / 1000) - 600 }))).status, 400);
  assert.equal((await post({ raw: ok.raw, headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await post({ raw: ok.raw, headers: { ...ok.headers, "svix-signature": ok.headers["svix-signature"].replace("v1,", "v2,") } })).status, 400);
  assert.equal(await held("ann@example.test"), undefined);
  // One of several signatures matching is enough (a secret being rotated).
  const two = signed(body);
  assert.equal(verifyEmailSignature(two.raw, { id: two.headers["svix-id"], timestamp: two.headers["svix-timestamp"], signature: `v1,${randomBytes(32).toString("base64")} ${two.headers["svix-signature"]}` }, SECRET, clock.getTime()), true);
  const none = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test", now: () => clock });
  assert.equal((await none.request("/webhooks/resend", { method: "POST", headers: ok.headers, body: ok.raw })).status, 404);
});

test("what Resend's events say: hard bounces, complaints and its own list count; a bounce that may clear doesn't", () => {
  assert.deepEqual(readEmailReport(event("email.bounced", "A@Example.test", { bounce: { type: "Transient", subType: "MailboxFull" } })), { ignored: "a bounce that may clear (Transient)" });
  const b = readEmailReport(event("email.bounced", "A@Example.test", { bounce: { type: "Permanent", subType: "Suppressed", message: "on the suppression list" } }));
  assert.ok(!("ignored" in b) && b.reason === "bounce" && b.addresses[0] === "a@example.test" && b.detail === "on the suppression list");
  assert.equal((readEmailReport(event("email.complained", "a@example.test")) as any).reason, "complaint");
  assert.equal((readEmailReport(event("email.suppressed", "a@example.test", { suppressed: { type: "OnAccountSuppressionList", message: "on the account list" } })) as any).reason, "provider");
  assert.ok("ignored" in readEmailReport(event("email.delivered", "a@example.test")));
  assert.ok("ignored" in readEmailReport({ type: "email.bounced", data: {} }));
});

test("a hard bounce holds the address back: what was sent is marked as not arrived, what waits isn't sent, sign-in codes still go", async () => {
  // The email Resend took: its id is kept, so the bounce finds it.
  const first = await waiting(people.Ann!, "Your booking");
  const took: string[] = [];
  await sendEmails(db, { async send(m) { took.push(m.to); return { ref: "e_ann_1" }; } }, clock);
  assert.deepEqual(took, ["ann@example.test"]);
  assert.equal((await db.selectFrom("outbound_message").select("provider_ref").where("id", "=", first).executeTakeFirstOrThrow()).provider_ref, "e_ann_1");
  const body = { ...event("email.bounced", "ann@example.test", { bounce: { type: "Permanent", subType: "General", message: "550 5.1.1 no such user" } }) };
  body.data.email_id = "e_ann_1";
  assert.equal((await post(signed(body))).status, 204);
  const row = await held("ann@example.test");
  assert.equal(row?.reason, "bounce"); assert.equal(row?.detail, "550 5.1.1 no such user"); assert.equal(row?.cleared_at, null);
  const m = await db.selectFrom("outbound_message").select(["status", "failure"]).where("id", "=", first).executeTakeFirstOrThrow();
  assert.equal(m.status, "failed"); assert.match(m.failure!, /^bounced: 550/);
  // The next one, essential or not, isn't sent.
  const next = await waiting(people.Ann!, "Your refund");
  const sent: string[] = [];
  await sendEmails(db, { async send(x) { sent.push(x.to); } }, clock);
  assert.deepEqual(sent, []);
  const n = await db.selectFrom("outbound_message").select(["status", "failure"]).where("id", "=", next).executeTakeFirstOrThrow();
  assert.equal(n.status, "dropped"); assert.equal(n.failure, "held back: bounced");
  // A sign-in code still goes: she just asked for one.
  const before = mailer.sent.length;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@example.test" }) });
  assert.equal(mailer.sent.length, before + 1);
  // Her app says why, and so does her page in the staff app.
  assert.equal((await req("/me", "Ann")).json.email_problem.reason, "bounce");
  assert.equal((await req(`/staff/people/${people.Ann}`, "Fay")).json.email_problem.reason, "bounce");
  assert.equal((await req("/me", "Ben")).json.email_problem, null);
});

test("a complaint and the service's own list hold back too; email from another domain on a shared account is left alone", async () => {
  assert.equal((await post(signed(event("email.complained", "ben@example.test")))).status, 204);
  assert.equal((await held("ben@example.test"))?.reason, "complaint");
  assert.equal((await post(signed(event("email.suppressed", "cat@example.test", { suppressed: { type: "OnAccountSuppressionList", message: "on the account's list" } })))).status, 204);
  assert.equal((await held("cat@example.test"))?.reason, "provider");
  // Another club's email on the same Resend account: not this club's to act on.
  assert.equal((await post(signed(event("email.complained", "kim@example.test", {}, "Osprey <hello@osprey.mail.kumi.club>")))).status, 204);
  assert.equal(await held("kim@example.test"), undefined);
  // Not acted on: a bounce that may clear.
  assert.equal((await post(signed(event("email.bounced", "kim@example.test", { bounce: { type: "Transient" } })))).status, 204);
  assert.equal(await held("kim@example.test"), undefined);
});

test("the desk sends email to an address again; a report from before that doesn't undo it, a newer one does", async () => {
  // A coach can't; the person has to be held back for it to make sense.
  assert.notEqual((await req("/actions/person.email_unsuppress/plan", "Kim", { person_id: people.Ann })).status, 200);
  assert.equal((await req("/actions/person.email_unsuppress/plan", "Fay", { person_id: people.Kim })).json.error, "error.email_not_held");
  const p = await req("/actions/person.email_unsuppress/plan", "Fay", { person_id: people.Ann });
  assert.equal(p.status, 200, JSON.stringify(p.json)); assert.match(p.json.summary, /ann@example\.test/);
  assert.equal((await req(`/runs/${p.json.run_id}/apply`, "Fay", {})).status, 200);
  const cleared = await held("ann@example.test");
  assert.ok(cleared?.cleared_at); assert.equal(cleared?.cleared_by, people.Fay);
  assert.equal((await req("/me", "Ann")).json.email_problem, null);
  // A report from before the clear (Resend retrying a delivery) leaves it cleared.
  const old = event("email.bounced", "ann@example.test", { bounce: { type: "Permanent" } });
  old.created_at = new Date(clock.getTime() - 3600_000).toISOString();
  await post(signed(old));
  assert.ok((await held("ann@example.test"))?.cleared_at);
  // Email goes to her again.
  await waiting(people.Ann!, "Welcome back");
  const sent: string[] = [];
  await sendEmails(db, { async send(x) { sent.push(x.to); } }, clock);
  assert.deepEqual(sent, ["ann@example.test"]);
  // It bounces again: held back again.
  clock = new Date(clock.getTime() + 60_000);
  await post(signed(event("email.bounced", "ann@example.test", { bounce: { type: "Permanent" } })));
  const again = await held("ann@example.test");
  assert.equal(again?.cleared_at, null); assert.equal(again?.times, 3);
  // The service's own list: the desk is told it may still refuse.
  const q = await req("/actions/person.email_unsuppress/plan", "Fay", { person_id: people.Cat });
  assert.match(q.json.summary, /may still refuse/);
});

test("a restore keeps what was reported since the copy, and what the desk cleared since", async () => {
  const url = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
  const before = await readSentBefore(url);
  assert.ok(before?.suppressions?.length);
  const ben = (await held("ben@example.test"))!;
  // The copy is from before Ben's complaint, and before the desk cleared Cat.
  const cat = await held("cat@example.test");
  await db.deleteFrom("email_suppression").where("address", "=", "ben@example.test").execute();
  await db.updateTable("email_suppression").set({ cleared_at: null, cleared_by: null }).where("address", "=", "cat@example.test").execute();
  before!.suppressions = before!.suppressions!.map((s) => s.address === "cat@example.test" ? { ...s, cleared_at: new Date(clock.getTime() + 1000), cleared_by: people.Fay! } : s);
  await afterRestore(url, before, clock);
  assert.equal((await held("ben@example.test"))?.reason, ben.reason);
  assert.ok((await held("cat@example.test"))?.cleared_at, `cat: ${JSON.stringify(cat)}`);
});

test("doctor: the sending domain verified (asked of Resend, or by its DNS record with a key that can only send), and the reports set up", async () => {
  const env = { NODE_ENV: "production", KUMI_PRACTICE: "1", KUMI_PUBLIC_URL: "https://play.kestrel.test", KUMI_RESEND_API_KEY: "re_x", KUMI_MAIL_FROM: FROM };
  const fullKey = async (u: string) => u === "https://api.resend.com/domains"
    ? new Response(JSON.stringify({ data: [{ name: "kestrel.mail.kumi.club", status: "verified" }, { name: "osprey.mail.kumi.club", status: "pending" }] }), { status: 200 })
    : new Response("{}", { status: 200 });
  const byId = async (e: Record<string, string>, fetch: any, resolveTxt?: any) => Object.fromEntries((await doctor(db, e, { fetch, resolveTxt, now: clock })).map((c) => [c.id, c.state]));
  let s = await byId(env, fullKey);
  assert.equal(s.email_domain, "ok"); assert.equal(s.email_reports, "warn");   // no webhook secret
  s = await byId({ ...env, KUMI_MAIL_FROM: "Osprey <hello@osprey.mail.kumi.club>", KUMI_RESEND_WEBHOOK_SECRET: SECRET }, fullKey);
  assert.equal(s.email_domain, "fail"); assert.equal(s.email_reports, "ok");
  // A sending-only key: Resend says so, and the DKIM record decides.
  const restricted = async (u: string) => u === "https://api.resend.com/domains" ? new Response(JSON.stringify({ name: "restricted_api_key" }), { status: 401 }) : new Response("{}", { status: 200 });
  assert.deepEqual(await checkSendingDomain("re_x", "kestrel.mail.kumi.club", { fetch: restricted, resolveTxt: async (n: string) => n === "resend._domainkey.kestrel.mail.kumi.club" ? [["p=MIGf", "MA0"]] : [] }), { state: "dkim", found: true });
  s = await byId(env, restricted, async () => { throw Object.assign(new Error("no record"), { code: "ENOTFOUND" }); });
  assert.equal(s.email_domain, "warn");
  // Addresses held back are counted.
  const checks = await doctor(db, { ...env, KUMI_RESEND_WEBHOOK_SECRET: SECRET }, { fetch: fullKey, now: clock });
  assert.match(checks.find((c) => c.id === "email_reports")!.text.en, /2 addresses are held back/);
});

test("the leaving emails say what becomes of the club's email domain", async () => {
  const on = new Date(clock.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
  await runAsSystem(db, "club.leaving", { on, kept_days: 30, email_domain: "kestrel.mail.kumi.club", email_domain_host: true }, "cli", { now: clock });
  await processOutbox(db, messageHandlers, 100, clock);
  const mail = await db.selectFrom("outbound_message").select("body").where("kind", "=", "club_leaving_staff").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.match(mail.body, /come from kestrel\.mail\.kumi\.club, which belongs to the club's host/);
  // The same date again with the club's own domain: kept for the reminders, nobody told again now.
  await runAsSystem(db, "club.leaving", { on, email_domain: "mail.kestrelpadel.com" }, "cli", { now: clock });
  const c = await db.selectFrom("club").select(["leaving_email_domain", "leaving_email_domain_host"]).executeTakeFirstOrThrow();
  assert.deepEqual(c, { leaving_email_domain: "mail.kestrelpadel.com", leaving_email_domain_host: false });
  await runAsSystem(db, "club.leaving", { on: null }, "cli", { now: clock });
  assert.equal((await db.selectFrom("club").select("leaving_email_domain").executeTakeFirstOrThrow()).leaving_email_domain, null);
});
