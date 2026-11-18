// A fake club on 127.0.0.1 for the plugin's tests: its signing key (published as the real club publishes it), a door
// (the MCP tools this plugin calls), and the registration and events it sends, signed as the real club signs them.
// Add the tools your plugin calls to `tools`.
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

export async function fakeClub() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const state = {
    token: "opa_" + "t".repeat(43), webhookSecret: "whsec_" + "w".repeat(32),
    settings: {} as Record<string, unknown>,
    locations: [{ id: "loc-1", name: "Main" }],
    items: [] as { kind: string; status?: string }[],
    cards: true, down: false,
    card: null as any, calls: [] as string[],
  };
  const ok = (id: unknown, v: unknown) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(v) }] } });
  let runs = 0;
  const tools: Record<string, (args: any) => unknown> = {
    plugin_settings: () => ({ name: "bookings-today", status: "on", settings: state.settings, keys: [] }),
    locations: () => state.locations,
    day: () => ({ courts: [{ id: "c1", items: state.items }] }),
    plugin_card_put_preview: (args) => { runs++; pending.set(`run-${runs}`, args); return { run_id: `run-${runs}`, status: "planned" }; },
    plugin_card_put_confirm: (args) => { state.card = pending.get(args.run_id); return { done: true }; },
  };
  const pending = new Map<string, unknown>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/.well-known/openpadel-plugin-key") return json(200, { keys: [publicKey.export({ format: "jwk" })] });
      if (req.url !== "/mcp") return json(404, {});
      if (state.down) return json(502, {});
      if (req.headers.authorization !== `Bearer ${state.token}`) return json(401, {});
      const rpc = JSON.parse(body), name = rpc.params.name as string;
      state.calls.push(name);
      const tool = tools[name];
      if (!tool || (!state.cards && name.startsWith("plugin_card"))) return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `MCP error -32602: Tool ${name} not found` } });
      return json(200, ok(rpc.id, tool(rpc.params.arguments ?? {})));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, state, close: () => server.close(),
    registration(nowMs: number, o: { stranger?: boolean } = {}) {
      const body = JSON.stringify({ type: "plugin.registered", id: "p1", sent_at: new Date(nowMs).toISOString(),
        club: { name: "Kestrel Padel", url, language: "en", time_zone: "America/Los_Angeles", key_url: `${url}/.well-known/openpadel-plugin-key` },
        plugin: { name: "bookings-today", version: "0.1.0" }, door: { mcp: `${url}/mcp`, token: state.token },
        webhooks: { secret: state.webhookSecret, signature_header: "openpadel-signature" }, settings: state.settings });
      const t = Math.floor(nowMs / 1000), key = o.stranger ? generateKeyPairSync("ed25519").privateKey : privateKey;
      return { body, header: `t=${t},ed25519=${sign(null, Buffer.from(`${t}.${body}`), key).toString("base64url")}` };
    },
    event(nowMs: number, type: string, data: Record<string, unknown> = {}, o: { id?: string; secret?: string } = {}) {
      const body = JSON.stringify({ id: o.id ?? `evt_${Math.random().toString(36).slice(2)}`, type, created_at: new Date(nowMs).toISOString(), data });
      const t = Math.floor(nowMs / 1000);
      return { body, header: `t=${t},v1=${createHmac("sha256", o.secret ?? state.webhookSecret).update(`${t}.${body}`).digest("hex")}` };
    },
  };
}
