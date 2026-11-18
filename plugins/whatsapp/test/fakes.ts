// A fake club (its signing key, a door answering what the plugin uses, signed registration, events and hooks) and a fake
// Meta Graph API, both on 127.0.0.1, for the plugin's tests.
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export const TZ = "Europe/Madrid";
function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
}
function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => r(b)); });
}
export const KEYS = { WHATSAPP_ACCESS_TOKEN: "EAAG" + "x".repeat(40), WHATSAPP_PHONE_NUMBER_ID: "106540352242922", WHATSAPP_APP_SECRET: "app-secret-0001", WHATSAPP_VERIFY_TOKEN: "verify-me-0001" };

/** What the club answers: who a number is and what to say, as the real club decides it (whatsapp.ts). */
export async function fakeClub(name = "Kestrel Padel") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const state = {
    settings: { club_number: "+34 600 000 000", template_language_es: "es_MX" } as Record<string, unknown>,
    vault: new Map<string, string>(Object.entries(KEYS)),
    linked: new Map<string, string>([["+34612345678", "Ann"]]),
    down: false,
    token: "opa_" + randomBytes(24).toString("base64url"),
    webhookSecret: "whsec_" + randomBytes(24).toString("base64url"),
    hookSecret: "opps_" + randomBytes(24).toString("base64url"),
    calls: [] as { tool: string; args: any }[],
    /** Changes confirmed, in order: { tool, args }. */
    done: [] as { tool: string; args: any }[],
    refs: new Set<string>(),
    card: null as any,
  };
  const ok = (id: unknown, v: unknown) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(v) }] } });
  const err = (id: unknown, code: string, text: string) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }], _meta: { "kumi/error": code } } });
  let runs = 0;
  const pending = new Map<string, { tool: string; args: any }>();
  const server = createServer(async (req, res) => {
    const body = await readAll(req);
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.url === "/.well-known/openpadel-plugin-key") return json(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "openpadel-plugin-1" }] });
    if (req.url !== "/mcp" || req.method !== "POST") return json(404, {});
    if (state.down) return json(502, { error: "down" });
    if (req.headers.authorization !== `Bearer ${state.token}`) return json(401, { error: "signed_out" });
    const rpc = JSON.parse(body), tool: string = rpc.params?.name, args = rpc.params?.arguments ?? {};
    state.calls.push({ tool, args });
    if (tool === "plugin_settings") return json(200, ok(rpc.id, { name: "whatsapp", status: "on", settings: state.settings,
      keys: Object.keys(KEYS).map((n) => ({ name: n, added: state.vault.has(n), last4: state.vault.get(n)?.slice(-4) ?? null })) }));
    if (tool === "plugin_secret") return json(200, state.vault.has(args.name) ? ok(rpc.id, { name: args.name, value: state.vault.get(args.name) }) : err(rpc.id, "error.plugin_secret_missing", "Not added yet"));
    if (tool.endsWith("_preview")) {
      // The club handles a message that came in once, by its id (channel_inbound).
      if (tool.startsWith("plugin_channel_") && args.ref && state.refs.has(args.ref)) return json(200, err(rpc.id, "error.nothing_changed", "Already done"));
      const id = `run-${++runs}`; pending.set(id, { tool: tool.replace(/_preview$/, ""), args });
      return json(200, ok(rpc.id, { run_id: id, status: "planned", summary: tool }));
    }
    if (tool.endsWith("_confirm")) {
      const p = pending.get(args.run_id);
      if (!p) return json(200, err(rpc.id, "error.not_found", "No such run"));
      pending.delete(args.run_id);
      state.done.push(p);
      if (p.tool.startsWith("plugin_channel_") && p.args.ref) state.refs.add(p.args.ref);
      if (p.tool === "plugin_card_put") state.card = p.args;
      if (p.tool === "plugin_channel_stop") { state.linked.delete(p.args.phone); return json(200, ok(rpc.id, { done: true, result: { people: 1, reply: `You won't get WhatsApp messages from ${name} any more.` } })); }
      if (p.tool === "plugin_channel_reply") {
        const who = state.linked.get(p.args.phone);
        const outcome = who ? "desk" : "unknown";
        return json(200, ok(rpc.id, { done: true, result: { outcome, reply: who ? `Thanks. Your message went to the front desk at ${name}.` : `This number isn't linked to a member of ${name}.` } }));
      }
      return json(200, ok(rpc.id, { done: true, result: null }));
    }
    return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `MCP error -32602: Tool ${tool} not found` } });
  });
  const url = await listen(server);
  const hmac = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  let n = 0;
  return {
    url, state, name, close: () => { server.closeAllConnections(); server.close(); },
    registration(nowMs: number) {
      const body = JSON.stringify({ type: "plugin.registered", id: "p1", sent_at: new Date(nowMs).toISOString(),
        club: { name, url, language: "en", time_zone: TZ, key_url: `${url}/.well-known/openpadel-plugin-key` },
        plugin: { name: "whatsapp", version: "0.1.0" }, door: { mcp: `${url}/mcp`, token: state.token },
        webhooks: { secret: state.webhookSecret, signature_header: "openpadel-signature" },
        hooks: { url: `${url}/plugins/whatsapp/hook`, secret: state.hookSecret, signature_header: "openpadel-signature" }, settings: state.settings });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},ed25519=${sign(null, Buffer.from(`${t}.${body}`), privateKey).toString("base64url")}` };
    },
    /** A message handed to the plugin, as sendWhatsApp writes it. */
    send(nowMs: number, to: string, o: { lang?: "en" | "es"; template?: string; words?: string; sendBefore?: number | null; id?: string } = {}) {
      const id = o.id ?? `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
      const words = o.words ?? "Booking 4F2A for Court 1, Thu 6:00 PM, is cancelled. https://play.example.test/places";
      const body = JSON.stringify({ id: `msg_${id}`, type: "message.send", created_at: new Date(nowMs).toISOString(), data: { message_id: id, channel: "whatsapp", to, language: o.lang ?? "en",
        template: { name: o.template ?? "openpadel_update", parameters: [name, words] }, text: `${name}: ${words}\n\nReply STOP to stop WhatsApp messages from us.`, essential: false,
        send_before: o.sendBefore === null ? null : new Date(o.sendBefore ?? nowMs + 3600_000).toISOString() } });
      const t = Math.floor(nowMs / 1000);
      return { id, body, header: `t=${t},v1=${hmac(state.webhookSecret, t, body)}` };
    },
    event(nowMs: number, type: string, data: Record<string, unknown> = {}) {
      const body = JSON.stringify({ id: `evt_${randomBytes(6).toString("hex")}`, type, created_at: new Date(nowMs).toISOString(), data });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},v1=${hmac(state.webhookSecret, t, body)}` };
    },
    /** What Meta posted to the club's hook, as the club passes it on: the club's signature and Meta's own header. */
    hook(nowMs: number, metaBody: unknown, o: { appSecret?: string; hookSecret?: string } = {}) {
      const body = JSON.stringify(metaBody);
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},v1=${hmac(o.hookSecret ?? state.hookSecret, t, body)}`,
        meta: `sha256=${createHmac("sha256", o.appSecret ?? KEYS.WHATSAPP_APP_SECRET).update(body, "utf8").digest("hex")}` };
    },
    verify(nowMs: number, query: Record<string, string>) {
      const body = JSON.stringify({ query });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},v1=${hmac(state.hookSecret, t, body)}` };
    },
  };
}

/** Meta's webhook body for messages that came in and statuses. */
export function metaWebhook(o: { messages?: any[]; statuses?: any[]; phoneNumberId?: string }) {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp",
    metadata: { display_phone_number: "34600000000", phone_number_id: o.phoneNumberId ?? KEYS.WHATSAPP_PHONE_NUMBER_ID },
    ...(o.messages ? { contacts: o.messages.map((m) => ({ wa_id: m.from, profile: { name: "Someone" } })), messages: o.messages } : {}), ...(o.statuses ? { statuses: o.statuses } : {}) } }] }] };
}
export const textIn = (from: string, body: string, id = `wamid.IN${randomBytes(6).toString("hex")}`) => ({ from: from.replace(/^\+/, ""), id, timestamp: "1763460000", type: "text", text: { body } });

/** The Graph API: POST /<phone number id>/messages. It can be down, busy, refuse the token or a template, or say the
 *  window is closed for a plain message. */
export async function fakeMeta() {
  const state = {
    sent: [] as any[],
    down: false,
    /** Answer 429 this many times. */
    busy: 0,
    badToken: false,
    /** Template names Meta doesn't have. */
    missing: new Set<string>(),
    /** Numbers whose 24-hour window Meta says is closed. */
    closed: new Set<string>(),
    optedOut: new Set<string>(),
    calls: 0,
  };
  let n = 0;
  const server = createServer(async (req, res) => {
    const body = await readAll(req);
    state.calls++;
    const json = (status: number, v: unknown, h: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...h }); res.end(JSON.stringify(v)); };
    const error = (status: number, code: number, message: string, h: Record<string, string> = {}) => json(status, { error: { message, type: "OAuthException", code, fbtrace_id: "x" } }, h);
    if (state.down) { req.socket.destroy(); return; }
    if (req.url !== `/v21.0/${KEYS.WHATSAPP_PHONE_NUMBER_ID}/messages` || req.method !== "POST") return error(400, 100, "Unsupported post request");
    if (state.badToken || req.headers.authorization !== `Bearer ${KEYS.WHATSAPP_ACCESS_TOKEN}`) return error(401, 190, "Error validating access token");
    if (state.busy > 0) { state.busy--; return error(429, 130429, "Rate limit hit", { "retry-after": "2" }); }
    const m = JSON.parse(body);
    if (state.optedOut.has(m.to)) return error(400, 131050, "User has stopped receiving messages");
    if (m.type === "text" && state.closed.has(m.to)) return error(400, 131047, "Re-engagement message");
    if (m.type === "template" && state.missing.has(m.template.name)) return error(404, 132001, "Template name does not exist in the translation");
    state.sent.push(m);
    return json(200, { messaging_product: "whatsapp", contacts: [{ input: m.to, wa_id: m.to }], messages: [{ id: `wamid.OUT${++n}` }] });
  });
  const url = await listen(server);
  return { url: `${url}/v21.0`, state, close: () => { server.closeAllConnections(); server.close(); } };
}
