import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { freshDb } from "./helpers.ts";
import { messageHandlers, processOutbox, pushKeys, run, runAsSystem, sendPushes, subscribePush, unsubscribePush, uuidv7, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, plan: string;
const people: Record<string, string> = {};
const phone = createECDH("prime256v1"); phone.generateKeys();
const auth = Buffer.from("phone-auth-16byt");
const device = (endpoint: string) => ({ endpoint, p256dh: phone.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
/** What the phone does with a push: decrypt it (RFC 8291) and read the JSON. */
function open(body: Buffer) {
  const salt = body.subarray(0, 16), n = body[20]!, sender = body.subarray(21, 21 + n), ct = body.subarray(21 + n);
  const ikm = Buffer.from(hkdfSync("sha256", phone.computeSecret(sender), auth, Buffer.concat([Buffer.from("WebPush: info\0"), phone.getPublicKey(), sender]), 32));
  const d = createDecipheriv("aes-128-gcm", Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const p = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(p.subarray(0, -1).toString());
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  plan = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner)).result as any).plan_id;
  for (const name of ["Ann", "Ben"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
});
after(async () => drop());

test("the club's keys are made once and kept", async () => {
  const a = await pushKeys(db), b = await pushKeys(db);
  assert.deepEqual(a, b);
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 65);
});

test("a message goes as a push to the person's devices, encrypted for each; a dead device is dropped", async () => {
  await subscribePush(db, people.Ann!, "member", device("https://fcm.googleapis.com/fcm/send/ann-phone"), "test phone");
  await subscribePush(db, people.Ann!, "member", device("https://fcm.googleapis.com/fcm/send/ann-old-tablet"), "old tablet");
  await run(db, "membership.grant", { person_id: people.Ann, plan_id: plan }, owner);
  await run(db, "membership.grant", { person_id: people.Ben, plan_id: plan }, owner);
  await processOutbox(db, messageHandlers);
  const rows = await db.selectFrom("outbound_message").select(["person_id", "channel"]).where("channel", "=", "push").execute();
  assert.deepEqual(rows.map((r) => r.person_id), [people.Ann]);   // Ben has no device: no push copy
  const sent: { url: string; body: Buffer; headers: Record<string, string> }[] = [];
  const r = await sendPushes(db, { subject: "https://play.kestrel.test", fetch: async (url, init) => {
    sent.push({ url, body: Buffer.from(init.body as Uint8Array), headers: init.headers as Record<string, string> });
    return new Response(null, { status: url.endsWith("old-tablet") ? 410 : 201 });
  } });
  assert.deepEqual(r, { sent: 1, dropped: 0, failed: 0 });
  assert.deepEqual(open(sent[0]!.body), { title: "Your membership: Monthly", body: "Your Monthly membership runs from today.", url: "/membership", tag: "membership_started" });
  assert.match(sent[0]!.headers.authorization!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const tablet = await db.selectFrom("push_subscription").select("revoked_at").where("endpoint", "=", "https://fcm.googleapis.com/fcm/send/ann-old-tablet").executeTakeFirstOrThrow();
  assert.ok(tablet.revoked_at);
});

test("staff alerts go to the staff app's devices only; turning a device off stops pushes", async () => {
  const msg = (purpose: "staff" | "account") => ({ id: uuidv7(), event_id: null, person_id: people.Ann!, kind: "test_note", channel: "push" as const, purpose, essential: true, lang: "en",
    subject: "x", body: "y", link: null, status: "waiting" as const, send_after: new Date(), stale_at: null });
  await db.insertInto("outbound_message").values(msg("staff")).execute();
  const r = await sendPushes(db, { subject: "https://play.kestrel.test", fetch: async () => new Response(null, { status: 201 }) });
  assert.deepEqual(r, { sent: 0, dropped: 1, failed: 0 });   // Ann's phone is a members'-app device
  await unsubscribePush(db, people.Ann!, "https://fcm.googleapis.com/fcm/send/ann-phone");
  await db.insertInto("outbound_message").values(msg("account")).execute();
  assert.equal((await sendPushes(db, { subject: "https://play.kestrel.test", fetch: async () => new Response(null, { status: 201 }) })).dropped, 1);
});
