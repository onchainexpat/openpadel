// WhatsApp as a plugin's message channel (whatsapp.ts): the manifest's `channel`, one per club; a member's yes and the
// code that links their number; messages written only for members who said yes and linked a number, handed to the plugin
// signed on its own webhook with only the number, the template and its words; quiet hours, stale and STOP checked again at
// the send; the plugin's reports, STOP and replies through the door as its own changes (a reply goes to the front desk as
// a question); nobody else can call those, not even the owner or another plugin; and Meta's GET check of the hook address
// passed on to that plugin alone. The plugin is a fake HTTP server on 127.0.0.1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { atLocal, checkManifestAtClub, exportData, localParts, manifestRows, messageHandlers, parseManifest, plan, processOutbox, run, runAsSystem, sendWhatsApp, sendWebhooks, uuidv7, verifyWebhookSignature,
  WHATSAPP_FORM, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, TZ = "America/Los_Angeles";
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/whatsapp/openpadel-plugin.json", import.meta.url), "utf8"));
const LIGHTS = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/court-lights/openpadel-plugin.json", import.meta.url), "utf8"));
const SAMPLE = JSON.parse(readFileSync(new URL("../../../packages/core/src/plugin_catalog.sample.json", import.meta.url), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, server: Server, PLUGIN = "";
let token = "", lights = "", hookSecret = "", court = "", loc = "";
const people: Record<string, string> = {}, cookies: Record<string, string> = {};
const got: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const ANN = "+34612345678", BEA = "+5215512345678";
let refs = 0;
const ref = () => `wamid.TEST${++refs}`;

async function call(tok: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status === 401) return { error: "signed_out" };
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}
async function tools(tok: string): Promise<string[]> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  return ((await r.json() as any).result.tools as { name: string }[]).map((x) => x.name);
}
/** A change through the door as the plugin makes it: preview, then confirm. */
async function door(tok: string, base: string, args: Record<string, unknown>) {
  const p = await call(tok, `${base}_preview`, args);
  if (p.error) return p;
  const c = await call(tok, `${base}_confirm`, { run_id: p.run_id });
  return { ...c, summary: p.summary };
}
const get = async (who: string, path: string) => { const r = await app.request(`${BASE}${path}`, { headers: { cookie: cookies[who]!, "accept-language": who === "Bea" ? "es" : "en" } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
const post = async (who: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await app.request(`${BASE}${path}`, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json", "accept-language": who === "Bea" ? "es" : "en", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function say(who: string, granted: boolean) {
  const p = await post(who, "/actions/consent.whatsapp/plan", { person_id: people[who], granted, ...(granted ? { form_version: WHATSAPP_FORM, app: "member" } : {}) });
  if (p.status !== 200) return p;
  return post(who, `/runs/${p.json.run_id}/apply`, {}, { "idempotency-key": p.json.run_id });
}
async function session(name: string, id: string) {
  const tok = `${name}-session`;
  await db.insertInto("web_session").values({ token_hash: sha(tok), person_id: id, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[name] = `kumi_session=${tok}`;
}
const registrationOf = (name: string) => got.filter((g) => g.path.endsWith("/register")).map((g) => JSON.parse(g.body)).filter((b) => b.plugin.name === name).at(-1);
/** The next time it's this hour at the club, after now (within a day, so a message written now isn't too old by then). */
function nextAt(hour: number): Date {
  const p = localParts(new Date(), TZ);
  let d = atLocal(p.y, p.m, p.d, hour, TZ, 30);
  if (d.getTime() <= Date.now()) d = new Date(d.getTime() + 86400_000);
  return d;
}
async function waitingMessage(to: string, o: { essential?: boolean; kind?: string; stale?: Date | null } = {}) {
  const id = uuidv7();
  await db.insertInto("outbound_message").values({ id, event_id: null, person_id: to, kind: o.kind ?? "offered", channel: "whatsapp", purpose: "account", essential: o.essential ?? false, lang: "en",
    subject: "A place", body: "A place opened up in Thursday clinic, Thu 6:00 PM. It's yours if you take it in the app by 8:00 PM:", link: "/places", status: "waiting", send_after: new Date(Date.now() - 1000),
    stale_at: o.stale ?? null, failure: null, sent_at: null, read_at: null }).execute();
  return id;
}
const handed = async () => (await db.selectFrom("webhook_delivery").select(["id", "body", "status", "topic"]).where("topic", "=", "message.send").orderBy("id").execute()).map((d) => ({ ...d, json: JSON.parse(d.body) }));

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      got.push({ path: req.url ?? "", body, headers: req.headers });
      if (req.url === "/w/verify") {
        const q = JSON.parse(body).query ?? {};
        res.writeHead(q["hub.verify_token"] === "right-token" ? 200 : 403, { "content-type": "application/json" });
        return res.end(JSON.stringify(q["hub.verify_token"] === "right-token" ? { answer: q["hub.challenge"] } : { error: "no" }));
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PLUGIN = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ db, drop } = await freshDb());
  const setup = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (setup.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  for (const name of ["Ann", "Bea", "Cy"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Bea!).execute();
  for (const n of ["Ann", "Bea", "Cy"]) await session(n, people[n]!);
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  await run(db, "plugin.install", { manifest: JSON.stringify({ ...LIGHTS, $schema: undefined, run: { mode: "remote", url: `${PLUGIN}/p` } }) }, owner);
  lights = registrationOf("court-lights").door.token;
});
after(async () => { await drop(); server.close(); });

test("the manifest: a channel needs its hook and a string setting with the club's number, says so in the preview, and the catalog has it", async () => {
  const m = parseManifest(JSON.stringify(EXAMPLE));
  await checkManifestAtClub(db, m);
  const { $schema: _, ...bare } = EXAMPLE;
  assert.deepEqual(SAMPLE.plugins.find((p: any) => p.manifest.name === "whatsapp").manifest, bare, "the sample catalog has the documented example");
  const rows = manifestRows(m).map((r) => `${r.label.en}: ${r.text.en}`);
  assert.ok(rows.some((r) => r.startsWith("Messages: it sends the club's WhatsApp messages, only to members who said yes")), rows.join("\n"));
  assert.ok(rows.some((r) => r.startsWith("Reads: nothing") || r.startsWith("It reads: nothing") || /nothing/.test(r)), "it reads nothing of the club");
  assert.ok(manifestRows(m).every((r) => !/[—–]/.test(r.text.en + r.text.es)));
  assert.throws(() => parseManifest(JSON.stringify({ ...EXAMPLE, hook: undefined })), (e: any) => /needs one/.test(String(e.params?.details ?? e.message)));
  assert.throws(() => parseManifest(JSON.stringify({ ...EXAMPLE, channel: { kind: "whatsapp", address_setting: "nope" } })), (e: any) => /address_setting/.test(String(e.params?.details ?? e.message)));
  assert.throws(() => parseManifest(JSON.stringify({ ...EXAMPLE, channel: { kind: "telegram", address_setting: "club_number" } })));
});

test("installing it: the club's number set, registered, and a second WhatsApp plugin refused", async () => {
  // Before it's installed, members aren't offered WhatsApp and can't say yes.
  assert.equal((await get("Ann", "/my/whatsapp")).json.on, false);
  assert.equal((await post("Ann", "/actions/consent.whatsapp/plan", { person_id: people.Ann, granted: true, form_version: WHATSAPP_FORM })).json.error, "error.whatsapp_off");
  const m = { ...EXAMPLE, $schema: undefined, run: { mode: "remote", url: `${PLUGIN}/w` } };
  await run(db, "plugin.install", { manifest: JSON.stringify(m), settings: { club_number: "+1 (503) 555-0100" } }, owner);
  const reg = registrationOf("whatsapp");
  token = reg.door.token; hookSecret = reg.hooks.secret;
  assert.equal((await db.selectFrom("plugin").select("status").where("name", "=", "whatsapp").executeTakeFirstOrThrow()).status, "on");
  await assert.rejects(plan(db, "plugin.install", { manifest: JSON.stringify({ ...m, name: "whatsapp-two" }) }, owner), (e: any) => e.code === "error.plugin_channel_taken");
});

test("a member says yes, is shown a code and the club's number, and linking it by WhatsApp is the plugin's change", async () => {
  const card = (await get("Ann", "/my/whatsapp")).json;
  assert.equal(card.on, true);
  assert.equal(card.answer, null);
  assert.match(card.form.words, /Kestrel Padel may send me WhatsApp messages/);
  const yes = await say("Ann", true);
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  const after = (await get("Ann", "/my/whatsapp")).json;
  assert.equal(after.answer, true);
  assert.equal(after.linked_ending, null);
  assert.match(after.code.code, /^\d{6}$/);
  assert.equal(after.code.link, `https://wa.me/15035550100?text=${encodeURIComponent(`Link my WhatsApp: ${after.code.code}`)}`);
  assert.equal(after.club_number, "+15035550100");
  // The consent is kept with its words, like texts'.
  const c = await db.selectFrom("channel_consent").select(["granted", "form_version", "evidence"]).where("person_id", "=", people.Ann!).where("channel", "=", "whatsapp").executeTakeFirstOrThrow();
  assert.equal(c.form_version, WHATSAPP_FORM);
  assert.match((c.evidence as any).words, /WhatsApp messages about my bookings/);
  // An assistant can't say yes for them (only the app can), as with texts.
  assert.equal((await post("Ann", "/actions/consent.whatsapp/plan", { person_id: people.Bea, granted: true, form_version: WHATSAPP_FORM })).status, 403, "nobody says yes for someone else");

  // A stranger's number sending a wrong code: not linked, told so.
  const wrong = await door(token, "plugin_channel_reply", { phone: "+447700900123", body: "Link my WhatsApp: 000001", ref: ref() });
  assert.equal(wrong.result.outcome, "unknown");
  assert.match(wrong.result.reply, /isn't linked to a member of Kestrel Padel/);
  // Ann's own number sends hers: linked, the code spent, the answer in her language.
  const r = await door(token, "plugin_channel_reply", { phone: ANN, body: `Link my WhatsApp: ${after.code.code}`, ref: ref() });
  assert.equal(r.result.outcome, "link", JSON.stringify(r));
  assert.match(r.summary, /Link the number ending in 5678/);
  assert.ok(!r.summary.includes("Ann"), "the plugin isn't told who it is");
  assert.match(r.result.reply, /Your WhatsApp is linked to Kestrel Padel/);
  assert.equal((await get("Ann", "/my/whatsapp")).json.linked_ending, "5678");
  assert.equal((await get("Ann", "/my/whatsapp")).json.code, null);
  // The same message again (WhatsApp retries): handled once.
  const again = await call(token, "plugin_channel_reply_preview", { phone: ANN, body: "x", ref: `wamid.TEST${refs}` });
  assert.equal(again.error, "error.nothing_changed");
  // A number that keeps guessing codes stops being tried.
  for (let k = 0; k < 6; k++) await door(token, "plugin_channel_reply", { phone: "+447700900999", body: `${100000 + k}`, ref: ref() });
  const runs = await db.selectFrom("channel_inbound").select("outcome").orderBy("at", "desc").limit(1).executeTakeFirstOrThrow();
  assert.equal(runs.outcome, "too_many");
});

test("consent: messages are written only for a member who said yes and linked a number, and the sender checks again", async () => {
  // Bea links a number but never says yes; Cy says yes but never links one.
  await db.insertInto("whatsapp_number").values({ person_id: people.Bea!, phone: BEA }).execute();
  assert.equal((await say("Cy", true)).status, 200);
  const when = new Date(Date.now() + 3 * 864e5);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: when.toISOString(), minutes: 60, person_id: people.Ann }, owner)).result as any).booking_id;
  for (const who of ["Bea", "Cy"]) await run(db, "booking.add_player", { booking_id: b, person_id: people[who] }, owner);
  await run(db, "booking.cancel", { booking_id: b }, owner);
  await processOutbox(db, messageHandlers);
  const rows = await db.selectFrom("outbound_message").select(["person_id", "kind", "body", "status"]).where("channel", "=", "whatsapp").where("kind", "=", "booking_cancelled").execute();
  assert.deepEqual(rows.map((r) => r.person_id), [people.Ann], "only Ann: Bea said no yes, Cy has no number");
  // Handed to the plugin: only the number, the template and its words, the language and the plain text, signed.
  const out = await sendWhatsApp(db, { memberUrl: "https://play.example.test" });
  assert.equal(out.handed, 1);
  const d = (await handed()).at(-1)!;
  assert.deepEqual(Object.keys(d.json.data).sort(), ["channel", "essential", "language", "message_id", "send_before", "template", "text", "to"]);
  assert.equal(d.json.data.to, ANN);
  assert.equal(d.json.data.template.name, "openpadel_update");
  assert.equal(d.json.data.template.parameters[0], "Kestrel Padel");
  assert.match(d.json.data.template.parameters[1], /is cancelled\..* https:\/\/play\.example\.test\/places$/);
  assert.ok(!d.body.includes("Ann") && !d.body.includes("ann@"), "no name or email");
  assert.match(d.json.data.text, /^Kestrel Padel: .*\n\nReply STOP to stop WhatsApp messages from us\.$/s);
  await sendWebhooks(db, async (url, body, headers) => { got.push({ path: new URL(url).pathname, body, headers }); return 200; });
  const sent = got.filter((g) => g.path === "/w/events").map((g) => ({ ...g, json: JSON.parse(g.body) })).find((g) => g.json.type === "message.send")!;
  const reg = registrationOf("whatsapp");
  assert.ok(verifyWebhookSignature(reg.webhooks.secret, String(sent.headers["openpadel-signature"]), sent.body), "signed with the plugin's webhook secret");
  // Said no since it was written: the sender drops it.
  const late = await waitingMessage(people.Ann!, { essential: true });
  assert.equal((await say("Ann", false)).status, 200);
  assert.equal((await sendWhatsApp(db)).dropped, 1);
  assert.equal((await db.selectFrom("outbound_message").select("failure").where("id", "=", late).executeTakeFirstOrThrow()).failure, "no consent");
  // Turning it off in the app unlinks her number: yes again, and she links it again with a new code.
  assert.equal((await get("Ann", "/my/whatsapp")).json.linked_ending, null);
  assert.equal((await say("Ann", true)).status, 200);
  const code = (await get("Ann", "/my/whatsapp")).json.code.code;
  assert.equal((await door(token, "plugin_channel_reply", { phone: ANN, body: code, ref: ref() })).result.outcome, "link");
});

test("quiet hours: what can wait waits them out, essential goes, and what's stale is dropped", async () => {
  const before = (await handed()).length;
  const can = await waitingMessage(people.Ann!), must = await waitingMessage(people.Ann!, { essential: true }), stale = await waitingMessage(people.Ann!, { stale: new Date(Date.now() - 1000) });
  const night = nextAt(23);
  const r = await sendWhatsApp(db, { now: night });
  assert.deepEqual([r.handed, r.dropped, r.waiting], [1, 1, 1]);
  const rows = await db.selectFrom("outbound_message").select(["id", "status", "send_after", "failure"]).where("id", "in", [can, must, stale]).execute();
  const by = (id: string) => rows.find((x) => x.id === id)!;
  assert.equal(by(must).status, "sent");
  assert.equal(by(stale).failure, "stale");
  assert.equal(by(can).status, "waiting");
  assert.equal(localParts(by(can).send_after, TZ).h, 8, "until 8 in the morning, the club's time");
  const essential = (await handed()).slice(before);
  assert.equal(essential.length, 1);
  assert.equal(essential[0]!.json.data.send_before, null, "an essential message may go whenever");
  // In the day it goes, and the plugin is told not to send it after quiet hours start.
  const day = nextAt(12);
  assert.equal((await sendWhatsApp(db, { now: new Date(Math.max(day.getTime(), by(can).send_after.getTime() + 1000)) })).handed, 1);
  const last = (await handed()).at(-1)!;
  assert.equal(localParts(new Date(last.json.data.send_before), TZ).h, 21);
});

test("the plugin's reports: delivered and read, a failure kept with its reason; only for WhatsApp messages", async () => {
  const id = await waitingMessage(people.Ann!, { essential: true });
  await sendWhatsApp(db);
  assert.equal((await door(token, "plugin_message_status", { message_id: id, status: "sent", ref: "wamid.OUT1" })).done, true);
  await door(token, "plugin_message_status", { message_id: id, status: "delivered" });
  await door(token, "plugin_message_status", { message_id: id, status: "read" });
  const m = await db.selectFrom("outbound_message").select(["provider_ref", "delivered_at", "seen_at", "status"]).where("id", "=", id).executeTakeFirstOrThrow();
  assert.equal(m.provider_ref, "wamid.OUT1");
  assert.ok(m.delivered_at && m.seen_at);
  const bad = await waitingMessage(people.Ann!, { essential: true });
  await sendWhatsApp(db);
  await door(token, "plugin_message_status", { message_id: bad, status: "failed", error: "131026 message undeliverable" });
  assert.deepEqual(await db.selectFrom("outbound_message").select(["status", "failure"]).where("id", "=", bad).executeTakeFirstOrThrow(), { status: "failed", failure: "whatsapp: 131026 message undeliverable" });
  // An email isn't the plugin's to report on.
  const email = await db.selectFrom("outbound_message").select("id").where("channel", "=", "email").limit(1).executeTakeFirstOrThrow();
  assert.equal((await call(token, "plugin_message_status_preview", { message_id: email.id, status: "delivered" })).error, "error.not_found");
});

test("a reply goes to the front desk as the member's question; STOP turns WhatsApp off at once and drops what waits", async () => {
  const r = await door(token, "plugin_channel_reply", { phone: ANN, body: "Can I bring a guest on Thursday?", ref: ref() });
  assert.equal(r.result.outcome, "desk");
  assert.match(r.result.reply, /went to the front desk at Kestrel Padel/);
  const q = await db.selectFrom("question").innerJoin("question_message", "question_message.question_id", "question.id").select(["question.status", "question.asked_by", "question_message.body", "question_message.side"])
    .where("question.asked_by", "=", people.Ann!).execute();
  assert.equal(q.length, 1);
  assert.equal(q[0]!.status, "open");
  assert.equal(q[0]!.side, "member");
  assert.match(q[0]!.body, /^Can I bring a guest on Thursday\?\n\n\(Sent by WhatsApp\)$/);
  // A second message the same week joins that question.
  await door(token, "plugin_channel_reply", { phone: ANN, body: "Thanks!", ref: ref() });
  assert.equal((await db.selectFrom("question").select("id").where("asked_by", "=", people.Ann!).execute()).length, 1);

  // Something waiting for Ann, already handed to the plugin and not yet posted, and something not handed yet.
  const waiting = await waitingMessage(people.Ann!, { essential: true });
  await sendWhatsApp(db);
  const notYet = await waitingMessage(people.Ann!, { essential: true });
  const s = await door(token, "plugin_channel_reply", { phone: ANN, body: "STOP", ref: ref() });
  assert.equal(s.result.outcome, "stop");
  assert.match(s.result.reply, /won't get WhatsApp messages from Kestrel Padel/);
  assert.equal((await get("Ann", "/my/whatsapp")).json.answer, false);
  assert.equal((await db.selectFrom("outbound_message").select("status").where("id", "=", notYet).executeTakeFirstOrThrow()).status, "dropped");
  const d = (await handed()).find((x) => x.json.data.message_id === waiting)!;
  assert.equal(d.status, "dropped", "what was on its way to the plugin goes no further");
  // Her email and texts are as she left them: WhatsApp only.
  assert.equal((await db.selectFrom("channel_consent").select("id").where("person_id", "=", people.Ann!).where("channel", "!=", "whatsapp").where("source", "=", "whatsapp_stop").execute()).length, 0);
  // Meta's own opt-out comes as plugin.channel_stop; Spanish answer for a Spanish reader. STOP kept her number linked,
  // so yes again in the app needs no new code.
  assert.equal((await say("Ann", true)).status, 200);
  assert.equal((await get("Ann", "/my/whatsapp")).json.code, null);
  assert.equal((await get("Ann", "/my/whatsapp")).json.linked_ending, "5678");
  const meta = await door(token, "plugin_channel_stop", { phone: ANN, said: "WhatsApp opt-out (131050)" });
  assert.equal(meta.result.people, 1);
  assert.equal((await get("Ann", "/my/whatsapp")).json.answer, false);
  const bea = await door(token, "plugin_channel_stop", { phone: BEA, said: "BAJA" });
  assert.match(bea.result.reply, /Ya no recibirás mensajes de WhatsApp de Kestrel Padel/);
});

test("the channel's tools are that plugin's alone: not another plugin's, not the owner's", async () => {
  const mine = await tools(token);
  assert.ok(["plugin_channel_reply_preview", "plugin_channel_stop_confirm", "plugin_message_status_preview"].every((x) => mine.includes(x)), mine.join(","));
  const theirs = await tools(lights);
  assert.ok(!theirs.some((x) => x.startsWith("plugin_channel_") || x.startsWith("plugin_message_status")), "court lights isn't offered them");
  assert.equal((await call(lights, "plugin_channel_stop_preview", { phone: ANN, said: "STOP" })).error !== undefined, true);
  await assert.rejects(plan(db, "plugin.channel_stop", { phone: ANN, said: "STOP" }, owner), (e: any) => e.code === "error.forbidden_reason");
  await assert.rejects(plan(db, "plugin.channel_reply", { phone: ANN, body: "hi", ref: "x" }, { ...owner }), (e: any) => e.code === "error.forbidden_reason");
});

test("Meta's check of the hook address reaches that plugin alone, signed, with only the query, and only its answer comes back", async () => {
  const before = got.length;
  const r = await app.request(`${BASE}/plugins/whatsapp/hook?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=right-token`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "1158201444");
  assert.match(r.headers.get("content-type") ?? "", /^text\/plain/);
  const fwd = got.slice(before);
  assert.deepEqual(fwd.map((g) => g.path), ["/w/verify"], "to the WhatsApp plugin, nowhere else");
  assert.deepEqual(JSON.parse(fwd[0]!.body), { query: { "hub.mode": "subscribe", "hub.challenge": "1158201444", "hub.verify_token": "right-token" } });
  const [t, v1] = String(fwd[0]!.headers["openpadel-signature"]).split(",").map((p) => p.split("=")[1]);
  assert.equal(v1, createHmac("sha256", hookSecret).update(`${t}.${fwd[0]!.body}`).digest("hex"));
  assert.equal(fwd[0]!.headers.cookie, undefined);
  // The wrong token: refused, and nothing of the plugin's answer shown.
  const no = await app.request(`${BASE}/plugins/whatsapp/hook?hub.mode=subscribe&hub.challenge=1&hub.verify_token=wrong`);
  assert.equal(no.status, 403);
  assert.equal(await no.text(), "refused");
  // A plugin whose hook doesn't say `challenge` (court lights) is never asked.
  const n = got.length;
  assert.equal((await app.request(`${BASE}/plugins/court-lights/hook?hub.challenge=1`)).status, 404);
  assert.equal(got.length, n);
  // Paused, it isn't either.
  await run(db, "plugin.pause", { plugin: "whatsapp" }, owner);
  assert.equal((await app.request(`${BASE}/plugins/whatsapp/hook?hub.challenge=1&hub.verify_token=right-token`)).status, 404);
  assert.equal((await get("Ann", "/my/whatsapp")).json.on, false, "and members aren't offered WhatsApp while it's paused");
  // What waits while it's paused stays waiting (and goes stale), never handed over.
  const id = await waitingMessage(people.Ann!, { essential: true });
  const h = (await handed()).length;
  await sendWhatsApp(db);
  assert.equal((await handed()).length, h);
  assert.equal((await db.selectFrom("outbound_message").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status, "waiting");
  await run(db, "plugin.resume", { plugin: "whatsapp" }, owner);
});

test("a member's WhatsApp number is in their data download, and goes when they're erased", async () => {
  const file = await exportData(db, people.Bea!, new Date(), "es") as any;
  assert.deepEqual(file.whatsapp_number.map((w: any) => w.phone), [BEA]);
  await run(db, "privacy.erase", { person_id: people.Bea }, { ...owner, auth: "passkey" });
  assert.equal(await db.selectFrom("whatsapp_number").select("phone").where("phone", "=", BEA).executeTakeFirst(), undefined);
});
