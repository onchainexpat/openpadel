// A fake club (its signing key, a door that answers the reads and changes the plugin uses, signed registration and
// events) and a fake Klaviyo (lists, profiles, the deletion jobs), both on 127.0.0.1, for the plugin's tests.
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
}
function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => r(b)); });
}

export interface ClubMember { id: string; email: string; first_name: string; language: "en" | "es" }
export const TZ = "America/Los_Angeles";
export const pid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export async function fakeClub() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const state = {
    /** The club's list as its server filters it: only who said yes. */
    members: [] as ClubMember[],
    page: 2,
    settings: {} as Record<string, unknown>,
    key: "pk_" + "k".repeat(30) as string | null,
    cards: true,
    down: false,
    token: "opa_" + "t".repeat(43),
    calls: [] as { tool: string; args: any }[],
    card: null as any,
    /** Members the plugin said unsubscribed elsewhere (club_news_unsubscribed_elsewhere): their answer turns to no. */
    reported: [] as { person_id: string; service?: string }[],
    reports: true,
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
      case "plugin_settings": return json(200, ok(rpc.id, { name: "klaviyo", status: "on", settings: state.settings, keys: [{ name: "KLAVIYO_API_KEY", added: Boolean(state.key), last4: state.key?.slice(-4) ?? null }] }));
      case "plugin_secret": return json(200, state.key ? ok(rpc.id, { name: "KLAVIYO_API_KEY", value: state.key, last4: state.key.slice(-4) }) : err(rpc.id, "error.plugin_secret_missing", "Not added yet"));
      case "club_news_list": {
        const sorted = [...state.members].sort((a, b) => a.id.localeCompare(b.id)), from = args.after ? sorted.filter((m) => m.id > args.after) : sorted;
        const page = from.slice(0, state.page);
        return json(200, ok(rpc.id, { total: sorted.length, members: page, next: from.length > state.page ? page.at(-1)!.id : null }));
      }
      case "club_news_unsubscribed_elsewhere_preview": {
        if (!state.reports) break;
        if (!state.members.some((m) => m.id === args.person_id)) return json(200, err(rpc.id, "error.nothing_changed", "Nothing to change"));
        const id = `run-${++runs}`; pending.set(id, { tool: name, args });
        return json(200, ok(rpc.id, { run_id: id, status: "planned", summary: "Club news off" }));
      }
      case "club_news_unsubscribed_elsewhere_confirm": {
        const p = pending.get(args.run_id);
        if (!p) return json(200, err(rpc.id, "error.not_found", "No such run"));
        state.reported.push(p.args);
        state.members = state.members.filter((m) => m.id !== p.args.person_id);
        return json(200, ok(rpc.id, { done: true }));
      }
      case "plugin_card_put_preview": {
        if (!state.cards) break;
        const id = `run-${++runs}`; pending.set(id, { tool: name, args });
        return json(200, ok(rpc.id, { run_id: id, status: "planned", summary: "Show a card" }));
      }
      case "plugin_card_put_confirm": {
        if (!state.cards) break;
        const p = pending.get(args.run_id);
        if (!p) return json(200, err(rpc.id, "error.not_found", "No such run"));
        state.card = p.args;
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
        plugin: { name: "klaviyo", version: "0.1.0" }, door: { mcp: `${url}/mcp`, token: state.token },
        webhooks: { secret: "whsec_" + "w".repeat(32), signature_header: "openpadel-signature" },
        hooks: { url: `${url}/plugins/klaviyo/hook`, secret: "opps_" + "h".repeat(32), signature_header: "openpadel-signature" }, settings: state.settings });
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

interface Profile { email: string; first_name: string | null; properties: Record<string, unknown>; attributes: string[];
  marketing?: { consent: "SUBSCRIBED" | "UNSUBSCRIBED" | "NEVER_SUBSCRIBED"; suppression: { reason: string }[] } }
const subs = (p: Profile) => ({ email: { marketing: p.marketing ?? { consent: "NEVER_SUBSCRIBED", suppression: [] } } });

/** Klaviyo, as much as the plugin uses: lists and their profiles, profile-import by email, deletion jobs. */
export async function fakeKlaviyo() {
  const state = {
    mode: "ok" as "ok" | "down" | "refuse",
    /** Answer this many requests with 429 (Retry-After: 1) first. */
    busy: 0,
    privacy: true,
    key: "pk_" + "k".repeat(30),
    lists: new Map<string, { name: string; members: Set<string> }>(),
    profiles: new Map<string, Profile>(),
    deleted: [] as string[],
    calls: [] as { method: string; path: string }[],
  };
  let n = 0;
  const byEmail = (email: string) => [...state.profiles].find(([, p]) => p.email === email)?.[0];
  const server = createServer(async (req, res) => {
    const raw = await readAll(req);
    const u = new URL(req.url ?? "/", "http://x"), path = u.pathname.replace(/\/+$/, "");
    state.calls.push({ method: req.method ?? "", path });
    const send = (status: number, v?: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/vnd.api+json", ...headers }); res.end(v === undefined ? "" : JSON.stringify(v)); };
    if (state.mode === "down") return send(503, { errors: [{ detail: "down" }] });
    if (state.busy > 0) { state.busy--; return send(429, { errors: [{ detail: "slow down" }] }, { "retry-after": "1" }); }
    if (state.mode === "refuse" || req.headers.authorization !== `Klaviyo-API-Key ${state.key}`) return send(401, { errors: [{ detail: "bad key" }] });
    if (!req.headers.revision) return send(400, { errors: [{ detail: "revision needed" }] });
    const body = raw ? JSON.parse(raw) : null;
    let m: RegExpExecArray | null;
    if (req.method === "GET" && (m = /^\/api\/lists\/([^/]+)$/.exec(path))) {
      const l = state.lists.get(m[1]!);
      return l ? send(200, { data: { type: "list", id: m[1], attributes: { name: l.name } } }) : send(404, { errors: [{ detail: "not found" }] });
    }
    if (req.method === "GET" && (m = /^\/api\/lists\/([^/]+)\/profiles$/.exec(path))) {
      const l = state.lists.get(m[1]!);
      if (!l) return send(404, { errors: [{ detail: "not found" }] });
      const size = Number(u.searchParams.get("page[size]") ?? 20), at = Number(u.searchParams.get("page[cursor]") ?? 0), ids = [...l.members];
      const page = ids.slice(at, at + Math.min(size, 3));   // small pages, so the plugin follows `next`
      const base = `http://${req.headers.host}`;
      return send(200, { data: page.map((id) => ({ type: "profile", id, attributes: { email: state.profiles.get(id)!.email, subscriptions: subs(state.profiles.get(id)!) } })),
        links: { next: at + page.length < ids.length ? `${base}/api/lists/${m[1]}/profiles?page[cursor]=${at + page.length}&page[size]=${size}` : null } });
    }
    if (req.method === "POST" && path === "/api/profile-import") {
      const a = body.data.attributes, had = byEmail(a.email);
      const id = had ?? `01PROF${String(++n).padStart(6, "0")}`;
      if ("subscriptions" in a) return send(400, { errors: [{ detail: "profile-import never sets consent here" }] });
      const p: Profile = { email: a.email, first_name: a.first_name, properties: a.properties ?? {}, attributes: Object.keys(a).sort(), marketing: had ? state.profiles.get(had)!.marketing : undefined };
      state.profiles.set(id, p);
      return send(had ? 200 : 201, { data: { type: "profile", id, attributes: { ...a, subscriptions: subs(p) } } });
    }
    if ((m = /^\/api\/lists\/([^/]+)\/relationships\/profiles$/.exec(path))) {
      const l = state.lists.get(m[1]!);
      if (!l) return send(404, { errors: [{ detail: "not found" }] });
      for (const p of body.data) { if (req.method === "POST") l.members.add(p.id); else l.members.delete(p.id); }
      return send(204);
    }
    if (req.method === "POST" && path === "/api/data-privacy-deletion-jobs") {
      if (!state.privacy) return send(403, { errors: [{ detail: "missing scope" }] });
      const id = body.data.attributes.profile.data.id;
      state.deleted.push(id); state.profiles.delete(id);
      for (const l of state.lists.values()) l.members.delete(id);
      return send(202);
    }
    send(404, { errors: [{ detail: "no such path" }] });
  });
  const url = await listen(server);
  return {
    url, state, close: () => server.close(),
    /** The emails on a list now, sorted. */
    emails: (list: string) => [...(state.lists.get(list)?.members ?? [])].map((id) => state.profiles.get(id)?.email ?? `?${id}`).sort(),
    /** Someone unsubscribing from a Klaviyo email (or suppressed after a bounce or complaint). */
    leaves(email: string, how: "unsubscribed" | "suppressed" = "unsubscribed") {
      const p = [...state.profiles.values()].find((x) => x.email === email)!;
      p.marketing = how === "unsubscribed" ? { consent: "UNSUBSCRIBED", suppression: [] } : { consent: "SUBSCRIBED", suppression: [{ reason: "HARD_BOUNCE" }] };
    },
    /** Someone put on the list by hand, in Klaviyo. */
    byHand(list: string, email: string) { const id = `01HAND${String(++n).padStart(6, "0")}`; state.profiles.set(id, { email, first_name: null, properties: {}, attributes: ["email"] }); state.lists.get(list)!.members.add(id); return id; },
  };
}
