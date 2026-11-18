// The WhatsApp plugin against a fake club and a fake Meta: a message outside WhatsApp's 24-hour window goes as the
// approved template in the club's template language, inside it as a plain message; Meta's statuses go to the club; STOP
// (and BAJA, and Meta's own opt-out) turns WhatsApp off at the club at once and nothing waiting for that number goes; a
// reply goes to the front desk with the club's answer sent back (once an hour); a message past its time (quiet hours, no
// longer news) isn't sent; a forged Meta signature is refused; Meta down or busy is waited out and tried again, then
// given up on and said; a template Meta doesn't have is said on the card; Meta's check of the hook address; nothing
// secret or a whole number in its log; and its release.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { plugin, type Plugin } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { redact } from "../src/log.ts";
import { isStop } from "../src/meta.ts";
import { MAX_ATTEMPTS } from "../src/club.ts";
import { fakeClub, fakeMeta, KEYS, metaWebhook, textIn } from "./fakes.ts";

const ANN = "+34612345678", BEA = "+5215512345678";
const logs: string[] = [];
const log = (level: string, msg: string, f: Record<string, unknown> = {}) => { logs.push(redact(JSON.stringify({ level, msg, ...f }))); };
let clock = Date.UTC(2026, 10, 18, 10, 0);

interface Run { p: Plugin; server: Server; base: string }
let club: Awaited<ReturnType<typeof fakeClub>>, meta: Awaited<ReturnType<typeof fakeMeta>>, run: Run;

async function post(base: string, path: string, body: string, headers: Record<string, string>) {
  const r = await fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const runner = () => run.p.runners.get(club.url)!;
async function settle() { await runner().idle(); await runner().idle(); }
async function tickAt(t: number) { clock = t; await runner().serial(() => runner().tick(clock)); }
/** The club hands it a message. */
async function hand(to: string, o: Parameters<typeof club.send>[2] = {}) {
  const m = club.send(clock, to, o);
  assert.equal((await post(run.base, "/events", m.body, { "openpadel-signature": m.header })).status, 200);
  await settle();
  return m.id;
}
/** Meta posts to the club's hook, and the club passes it on. */
async function fromMeta(body: unknown, o: { appSecret?: string; hookSecret?: string } = {}) {
  const h = club.hook(clock, body, o);
  const r = await post(run.base, "/hook", h.body, { "openpadel-signature": h.header, "x-hub-signature-256": h.meta });
  await settle();
  return r.status;
}
const done = (tool: string) => club.state.done.filter((d) => d.tool === tool).map((d) => d.args);
const lastSent = () => meta.state.sent.at(-1);

before(async () => {
  club = await fakeClub(); meta = await fakeMeta();
  const p = plugin({ store: memoryStore(), log, allowHttp: true, timers: false, now: () => clock, graph: meta.url, sleep: async () => {} });
  const server = await p.listen(0, "127.0.0.1");
  run = { p, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
});
after(() => { run.p.stop(); run.server.closeAllConnections(); run.server.close(); club.close(); meta.close(); });

test("a registration is kept only when the club's key signs it; then it reads its keys and shows its card", async () => {
  const r = club.registration(clock);
  assert.equal((await post(run.base, "/register", r.body.replace("Kestrel", "Forged"), { "openpadel-signature-ed25519": r.header })).status, 401);
  assert.equal((await post(run.base, "/register", r.body, { "openpadel-signature-ed25519": r.header })).status, 200);
  await settle();
  assert.deepEqual(club.state.calls.filter((c) => c.tool === "plugin_secret").map((c) => c.args.name).sort(), Object.keys(KEYS).sort(), "its four keys, through the door");
  assert.equal(club.state.card.slot, "connectors");
  assert.deepEqual(club.state.card.rows[0], { label: { en: "Number", es: "Número" }, text: { en: "+34 600 000 000", es: "+34 600 000 000" } });
  assert.equal(club.state.card.tone, "ok");
  const h = await (await fetch(`${run.base}/health`)).json() as any;
  assert.equal(h.ok, true);
  assert.deepEqual(h.keys_missing, []);
});

test("outside WhatsApp's 24-hour window a message goes as the approved template, in the club's template language; inside it, as a plain message", async () => {
  const id = await hand(ANN);
  const t = lastSent();
  assert.equal(t.type, "template");
  assert.equal(t.to, "34612345678");
  assert.deepEqual(t.template, { name: "openpadel_update", language: { code: "en_US" }, components: [{ type: "body", parameters: [
    { type: "text", text: "Kestrel Padel" }, { type: "text", text: "Booking 4F2A for Court 1, Thu 6:00 PM, is cancelled. https://play.example.test/places" }] }] });
  assert.deepEqual(done("plugin_message_status").at(-1), { message_id: id, status: "sent", ref: `wamid.OUT${meta.state.sent.length}` });
  // Spanish, in the language the club's Spanish templates were approved in (its setting).
  await hand(ANN, { lang: "es", template: "openpadel_place" });
  assert.deepEqual([lastSent().template.name, lastSent().template.language.code], ["openpadel_place", "es_MX"]);
  // Ann writes to the club: for a day, what goes to her is a plain message (free, and no template needed).
  await fromMeta(metaWebhook({ messages: [textIn(ANN, "Hola")] }));
  await hand(ANN);
  assert.equal(lastSent().type, "text");
  assert.match(lastSent().text.body, /^Kestrel Padel: Booking 4F2A .*\n\nReply STOP to stop WhatsApp messages from us\.$/s);
  // The window closed sooner than the plugin knew (Meta says so): the template instead, at once.
  meta.state.closed.add("34612345678");
  await hand(ANN);
  assert.equal(lastSent().type, "template");
  meta.state.closed.clear();
  // A day later, the template again.
  clock += 25 * 3600_000;
  await hand(ANN);
  assert.equal(lastSent().type, "template");
});

test("Meta's statuses go to the club as the message's own: delivered, read, and a failure with its reason", async () => {
  const id = await hand(ANN);
  const wamid = done("plugin_message_status").at(-1)!.ref;
  assert.equal(await fromMeta(metaWebhook({ statuses: [{ id: wamid, status: "delivered", timestamp: "1", recipient_id: "34612345678" },
    { id: wamid, status: "read", timestamp: "2", recipient_id: "34612345678" }] })), 200);
  assert.deepEqual(done("plugin_message_status").slice(-2), [{ message_id: id, status: "delivered", ref: wamid }, { message_id: id, status: "read", ref: wamid }]);
  // The same status again (Meta retries): once.
  const n = done("plugin_message_status").length;
  await fromMeta(metaWebhook({ statuses: [{ id: wamid, status: "read", timestamp: "2", recipient_id: "34612345678" }] }));
  assert.equal(done("plugin_message_status").length, n);
  // A status for a message that isn't this plugin's: ignored.
  await fromMeta(metaWebhook({ statuses: [{ id: "wamid.SOMEONE_ELSES", status: "delivered", timestamp: "3", recipient_id: "1" }] }));
  assert.equal(done("plugin_message_status").length, n);
  const other = await hand(ANN);
  const w2 = done("plugin_message_status").at(-1)!.ref;
  await fromMeta(metaWebhook({ statuses: [{ id: w2, status: "failed", timestamp: "4", recipient_id: "34612345678", errors: [{ code: 131026, title: "Message undeliverable" }] }] }));
  assert.deepEqual(done("plugin_message_status").at(-1), { message_id: other, status: "failed", ref: w2, error: "131026 Message undeliverable" });
});

test("STOP: the club turns WhatsApp off at once, nothing waiting for that number goes, and the club's answer is sent", async () => {
  // A message waits for Ann while Meta is busy.
  meta.state.busy = 1;
  const waiting = await hand(ANN);
  assert.equal(runner().rec.queue.length, 1);
  await fromMeta(metaWebhook({ messages: [textIn(ANN, "Baja, por favor")] }));
  assert.equal(done("plugin_channel_stop").at(-1)!.phone, ANN);
  assert.equal(done("plugin_channel_stop").at(-1)!.said, "Baja, por favor");
  assert.equal(runner().rec.queue.length, 0, "what waited for that number is gone");
  assert.deepEqual(done("plugin_message_status").find((s) => s.message_id === waiting), { message_id: waiting, status: "failed", error: "stopped: the member sent STOP" });
  assert.equal(lastSent().type, "text");
  assert.match(lastSent().text.body, /won't get WhatsApp messages from Kestrel Padel/);
  // A message the club handed before the STOP reached it (it was on its way): not sent.
  const sent = meta.state.sent.length;
  const m = club.send(clock - 5000, ANN);
  await post(run.base, "/events", m.body, { "openpadel-signature": m.header });
  await settle();
  assert.equal(meta.state.sent.length, sent);
  // One handed later: Ann said yes again in the app since, so it goes.
  clock += 60_000;
  await hand(ANN);
  assert.equal(meta.state.sent.length, sent + 1);
  for (const w of ["STOP", "stop please", "BAJA", "Parar", "unsubscribe"]) assert.ok(isStop(w), w);
  for (const w of ["Can I stop by at 6?", "cancel my booking tomorrow", "no puedo ir"]) assert.ok(!isStop(w), w);
});

test("Meta's own opt-out (131050) turns WhatsApp off at the club", async () => {
  meta.state.optedOut.add("5215512345678");
  await hand(BEA);
  assert.equal(done("plugin_channel_stop").at(-1)!.phone, BEA);
  assert.match(done("plugin_channel_stop").at(-1)!.said, /131050/);
  assert.match(done("plugin_message_status").at(-1)!.error, /^stopped at WhatsApp/);
  meta.state.optedOut.clear();
});

test("a reply goes to the front desk, the club's answer goes back once an hour, and the same message twice counts once", async () => {
  club.state.linked.set(ANN, "Ann");
  const m = textIn(ANN, "Can I bring a guest on Thursday?");
  await fromMeta(metaWebhook({ messages: [m] }));
  assert.deepEqual(done("plugin_channel_reply").at(-1), { phone: ANN, body: "Can I bring a guest on Thursday?", ref: m.id });
  assert.match(lastSent().text.body, /went to the front desk at Kestrel Padel/);
  const sent = meta.state.sent.length, replies = done("plugin_channel_reply").length;
  await fromMeta(metaWebhook({ messages: [m] }));
  assert.equal(done("plugin_channel_reply").length, replies, "Meta sent it again: handled once");
  await fromMeta(metaWebhook({ messages: [textIn(ANN, "And a racket?")] }));
  assert.equal(done("plugin_channel_reply").length, replies + 1);
  assert.equal(meta.state.sent.length, sent, "the answer isn't sent again within the hour");
  // A number the club doesn't know is answered once a day.
  await fromMeta(metaWebhook({ messages: [textIn("+447700900123", "hi")] }));
  await fromMeta(metaWebhook({ messages: [textIn("+447700900123", "hello?")] }));
  assert.equal(meta.state.sent.filter((s) => s.to === "447700900123").length, 1);
  // A photo comes as words the desk can read.
  await fromMeta(metaWebhook({ messages: [{ from: "34612345678", id: "wamid.PHOTO", timestamp: "1", type: "image", image: { id: "x" } }] }));
  assert.equal(done("plugin_channel_reply").at(-1)!.body, "(A WhatsApp message that isn't text)");
});

test("the club's door down: replies and reports wait, in order, and go when it's back", async () => {
  club.state.down = true;
  await fromMeta(metaWebhook({ messages: [textIn(ANN, "Are you open on Sunday?")] }));
  const n = done("plugin_channel_reply").length;
  assert.equal(runner().rec.reports.length, 1);
  club.state.down = false;
  await tickAt(clock + 10_000);
  assert.equal(done("plugin_channel_reply").length, n + 1);
  assert.equal(done("plugin_channel_reply").at(-1)!.body, "Are you open on Sunday?");
  assert.equal(runner().rec.reports.length, 0);
});

test("a message past its time (quiet hours began, or it's no longer news) isn't sent", async () => {
  const sent = meta.state.sent.length;
  meta.state.down = true;
  const id = await hand(ANN, { sendBefore: clock + 60_000 });
  meta.state.down = false;
  await tickAt(clock + 2 * 60 * 60_000);
  assert.equal(meta.state.sent.length, sent);
  assert.deepEqual(done("plugin_message_status").at(-1), { message_id: id, status: "failed", error: "not sent: past its time (quiet hours, or no longer news)" });
});

test("a forged Meta signature is refused, and so is a hook the club didn't pass on", async () => {
  const n = club.state.done.length;
  assert.equal(await fromMeta(metaWebhook({ messages: [textIn(ANN, "STOP")] }), { appSecret: "not-the-clubs" }), 401);
  assert.equal(await fromMeta(metaWebhook({ messages: [textIn(ANN, "STOP")] }), { hookSecret: "opps_forged" }), 401);
  assert.equal(club.state.done.length, n, "nothing reached the club");
  // Another business's number on the same app: not this club's, ignored.
  assert.equal(await fromMeta(metaWebhook({ messages: [textIn(ANN, "STOP")], phoneNumberId: "999" })), 200);
  assert.equal(club.state.done.length, n);
});

test("Meta down or busy: messages wait and are tried again with growing waits, then go; after six tries the club is told", async () => {
  meta.state.down = true;
  const id = await hand(ANN);
  const q = runner().rec.queue[0]!;
  assert.equal(q.attempts, 1);
  const h = await fetch(`${run.base}/health`);
  assert.equal(h.status, 503);
  assert.equal((await h.json() as any).failing, "down");
  assert.match(JSON.stringify(club.state.card.rows), /Meta isn't answering/);
  await tickAt(clock + 10_000);
  assert.equal(runner().rec.queue[0]!.attempts, 1, "not before its wait");
  meta.state.down = false;
  meta.state.busy = 1;
  await tickAt(q.next_at);
  assert.equal(runner().rec.queue[0]!.attempts, 2, "busy: waits again");
  await tickAt(runner().rec.queue[0]!.next_at);
  assert.equal(runner().rec.queue.length, 0);
  assert.deepEqual(done("plugin_message_status").at(-1)!.message_id, id);
  assert.equal(done("plugin_message_status").at(-1)!.status, "sent");
  assert.equal((await fetch(`${run.base}/health`)).status, 200);
  // Down for good: given up on after six tries, and said.
  meta.state.down = true;
  const lost = await hand(ANN, { sendBefore: null });
  for (let k = 1; k < MAX_ATTEMPTS; k++) await tickAt(runner().rec.queue[0]!.next_at);
  assert.equal(runner().rec.queue.length, 0);
  assert.equal(done("plugin_message_status").at(-1)!.message_id, lost);
  assert.match(done("plugin_message_status").at(-1)!.error, /^Meta didn't take it after 6 tries/);
  meta.state.down = false;
});

test("a template Meta doesn't have: that message fails with Meta's reason, and the card says which template", async () => {
  meta.state.missing.add("openpadel_place");
  clock += 2 * 86400_000;
  await hand(BEA, { lang: "es", template: "openpadel_place" });
  assert.match(done("plugin_message_status").at(-1)!.error, /^132001/);
  assert.equal(club.state.card.tone, "warn");
  assert.match(JSON.stringify(club.state.card.rows), /openpadel_place \(es_MX\)/);
  meta.state.missing.clear();
  await hand(BEA);
  assert.equal(club.state.card.tone, "ok", "a message that goes clears it");
});

test("Meta's check of the hook address: the challenge back only with the club's verify token", async () => {
  const good = club.verify(clock, { "hub.mode": "subscribe", "hub.challenge": "1158201444", "hub.verify_token": KEYS.WHATSAPP_VERIFY_TOKEN });
  const r = await post(run.base, "/verify", good.body, { "openpadel-signature": good.header });
  assert.deepEqual([r.status, r.json], [200, { answer: "1158201444" }]);
  const bad = club.verify(clock, { "hub.mode": "subscribe", "hub.challenge": "1", "hub.verify_token": "guess" });
  assert.equal((await post(run.base, "/verify", bad.body, { "openpadel-signature": bad.header })).status, 403);
  assert.equal((await post(run.base, "/verify", good.body, { "openpadel-signature": "t=1,v1=00" })).status, 401);
});

test("its log: no token, key or whole number, and nothing a member wrote", () => {
  const all = logs.join("\n");
  for (const v of Object.values(KEYS)) assert.ok(!all.includes(v), "no key");
  assert.ok(!all.includes(club.state.token) && !all.includes(club.state.webhookSecret) && !all.includes(club.state.hookSecret));
  assert.ok(!all.includes("34612345678") && !all.includes("5215512345678"), "numbers only by their last four");
  assert.ok(!all.includes("bring a guest"), "nor what they wrote");
  assert.match(all, /…5678/);
});

test("the release for a club's own server: the same bytes every time, its entry executable, pinned in its manifest", async () => {
  const { pack } = await import("../tools/pack.ts");
  const { execFileSync } = await import("node:child_process");
  const out = mkdtempSync(join(tmpdir(), "whatsapp-pack-"));
  const a = pack({ releaseUrl: "https://example.test/whatsapp-0.1.0.tar.gz", out: join(out, "a") });
  const b = pack({ releaseUrl: "https://example.test/whatsapp-0.1.0.tar.gz", out: join(out, "b") });
  assert.equal(a.sha256, b.sha256, "reproducible");
  assert.deepEqual((a.manifest as any).run, { mode: "local", release_url: "https://example.test/whatsapp-0.1.0.tar.gz", sha256: a.sha256, entry: "bin/start" });
  assert.equal((a.manifest as any).channel.kind, "whatsapp");
  const listing = execFileSync("tar", ["-tvzf", a.file], { encoding: "utf8" });
  assert.match(listing, /^-rwxr-xr-x .* bin\/start$/m);
  assert.match(listing, / src\/main\.ts$/m);
  assert.ok(!/ test\//.test(listing) && !/ dist\//.test(listing), "only what it runs");
});
