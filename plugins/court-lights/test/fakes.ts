// A fake club (its signing key, a door that answers the reads and changes the plugin uses, signed registration and
// events) and a fake Home Assistant, both on 127.0.0.1, for the plugin's tests.
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";

export const TZ = "America/Los_Angeles", TODAY = "2026-11-17", TOMORROW = "2026-11-18", LOC = "loc-1";
/** A time at the club on TODAY (or the next day for hours past 24), as an ISO instant (PST is UTC-8 in November). */
export const local = (hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 17, hh + 8, mm)).toISOString();
export const ms = (hh: number, mm = 0) => Date.parse(local(hh, mm));

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
}
function readAll(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => r(b)); });
}

export interface Item { court_id: string; start: string; end: string; kind: string; status?: string }

export async function fakeClub() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const state = {
    courts: [{ id: "c1", name: "Court 1", location_id: LOC, kind: "padel" }, { id: "c2", name: "Court 2", location_id: LOC, kind: "padel" }],
    items: [] as Item[],
    settings: {} as Record<string, unknown>,
    haToken: "ha-secret-token-0001" as string | null,
    cards: true,
    down: false,
    token: "opa_" + "t".repeat(43),
    calls: [] as { tool: string; args: any }[],
    shown: new Map<string, any>(),
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
    const rpc = JSON.parse(body), name: string = rpc.params?.name, args = rpc.params?.arguments ?? {};
    state.calls.push({ tool: name, args });
    switch (name) {
      case "plugin_settings": return json(200, ok(rpc.id, { name: "court-lights", status: "on", settings: state.settings, keys: [{ name: "HA_TOKEN", added: Boolean(state.haToken), last4: state.haToken?.slice(-4) ?? null }] }));
      case "plugin_secret": return json(200, state.haToken ? ok(rpc.id, { name: "HA_TOKEN", value: state.haToken, last4: state.haToken.slice(-4) }) : err(rpc.id, "error.plugin_secret_missing", "Not added yet"));
      case "courts": return json(200, ok(rpc.id, state.courts));
      case "day": {
        const date = args.date ?? TODAY;
        const on = (iso: string) => new Date(Date.parse(iso) - 8 * 3600_000).toISOString().slice(0, 10);
        return json(200, ok(rpc.id, { date, today: TODAY, time_zone: TZ, courts: state.courts.filter((c) => c.location_id === args.location_id).map((c) => ({ id: c.id, name: c.name,
          items: state.items.filter((i) => i.court_id === c.id && (on(i.start) === date || on(i.end) === date)).map(({ court_id: _, ...i }) => i) })) }));
      }
      case "plugin_card_put_preview": case "plugin_card_clear_preview": {
        if (!state.cards) break;
        const id = `run-${++runs}`; pending.set(id, { tool: name, args });
        return json(200, ok(rpc.id, { run_id: id, status: "planned", summary: "Show a card" }));
      }
      case "plugin_card_put_confirm": case "plugin_card_clear_confirm": {
        if (!state.cards) break;
        const p = pending.get(args.run_id);
        if (!p) return json(200, err(rpc.id, "error.not_found", "No such run"));
        if (p.tool.startsWith("plugin_card_put")) state.shown.set(p.args.subject, p.args); else state.shown.delete(p.args.subject);
        return json(200, ok(rpc.id, { done: true }));
      }
    }
    return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `MCP error -32602: Tool ${name} not found` } });
  });
  const url = await listen(server);
  return {
    url, state, close: () => server.close(),
    /** The club's registration, signed at `nowMs` (or with a stranger's key). */
    registration(nowMs: number, o: { stranger?: boolean } = {}) {
      const body = JSON.stringify({ type: "plugin.registered", id: "p1", sent_at: new Date(nowMs).toISOString(),
        club: { name: "Kestrel Padel", url, language: "en", time_zone: TZ, key_url: `${url}/.well-known/openpadel-plugin-key` },
        plugin: { name: "court-lights", version: "0.1.0" }, door: { mcp: `${url}/mcp`, token: state.token },
        webhooks: { secret: "whsec_" + "w".repeat(32), signature_header: "openpadel-signature" },
        hooks: { url: `${url}/plugins/court-lights/hook`, secret: "opps_" + "h".repeat(32), signature_header: "openpadel-signature" }, settings: state.settings });
      const t = Math.floor(nowMs / 1000), key = o.stranger ? generateKeyPairSync("ed25519").privateKey : privateKey;
      return { body, header: `t=${t},ed25519=${sign(null, Buffer.from(`${t}.${body}`), key).toString("base64url")}` };
    },
    /** An event as the club sends it, signed under the webhook's secret (or a wrong one). */
    event(nowMs: number, type: string, data: Record<string, unknown> = {}, o: { id?: string; secret?: string } = {}) {
      const body = JSON.stringify({ id: o.id ?? `evt_${Math.random().toString(36).slice(2)}`, type, created_at: new Date(nowMs).toISOString(), data });
      const t = Math.floor(nowMs / 1000);
      const v1 = createHmac("sha256", o.secret ?? "whsec_" + "w".repeat(32)).update(`${t}.${body}`, "utf8").digest("hex");
      return { body, header: `t=${t},v1=${v1}` };
    },
  };
}

export async function fakeHomeAssistant() {
  const state = { mode: "ok" as "ok" | "down" | "refuse", calls: [] as { service: string; entities: string[]; auth: string }[] };
  const server = createServer(async (req, res) => {
    const body = await readAll(req);
    if (state.mode === "down") { res.writeHead(503); return res.end("down"); }
    if (state.mode === "refuse") { res.writeHead(401); return res.end("unauthorized"); }
    if (req.method === "GET" && req.url === "/api/") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"message":"API running."}'); }
    const m = /^\/api\/services\/(light|switch)\/(turn_on|turn_off)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) { res.writeHead(404); return res.end(); }
    state.calls.push({ service: `${m[1]}.${m[2]}`, entities: JSON.parse(body).entity_id, auth: String(req.headers.authorization) });
    res.writeHead(200, { "content-type": "application/json" }); res.end("[]");
  });
  const url = await listen(server);
  return { url, state, close: () => server.close(), ons: () => state.calls.filter((c) => c.service.endsWith("turn_on")), offs: () => state.calls.filter((c) => c.service.endsWith("turn_off")) };
}
