// kumi, the club's commands from any computer: the owner's agent, the desk's, or a person's own. It signs in to a
// club's address as an assistant connection (the same OAuth the MCP door has, oauth.ts) and then speaks to that door
// (mcp.ts): every command is one of the door's tools, so what it may do, what its preview says, the weekly spending
// limit and what's only ever done in the app are the door's, checked on the server. docs/cli/README.md is the guide.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { both, COMMAND, pickLang, t, type Key, type Lang, type Params } from "@kumi/i18n";
import { appOnly } from "@kumi/core";
import { Store, clubKey, type ClubEntry, type RunEntry, type Tokens } from "./cli_store.ts";
import { actionNamed, catalogueAction, clubTime, commands, example, findCommand, FINDERS, flagOf, match, parseInput, typeWords, UsageError, type Command, type Entity, type Parsed } from "./cli_commands.ts";
import { VERSION } from "./version.ts";
import { DEVICE_GRANT } from "./oauth.ts";
import { setting } from "@kumi/core";

/** What each exit code means (docs/cli/README.md lists them; agents branch on them). */
export const EXIT = { done: 0, failed: 1, usage: 2, refused: 3, not_found: 4, ambiguous: 5, app_only: 6, conflict: 7, signed_out: 8, unreachable: 9,
  preview: 10, approval: 11, sign_in_waiting: 12 } as const;
type Exit = (typeof EXIT)[keyof typeof EXIT];

export interface RemoteDeps {
  fetch: typeof fetch; store: Store; out: (s: string) => void; err: (s: string) => void;
  /** Opens a page in the person's browser; null where there's none (a server, a bare shell): then the sign-in is by
   *  a code shown here and allowed on another device. */
  openBrowser: ((url: string) => void) | null;
  sleep: (ms: number) => Promise<void>; now: () => number; hostname: string; env: NodeJS.ProcessEnv;
}
export function defaultDeps(): RemoteDeps {
  // Output piped into something that stops reading (| head) ends the command quietly.
  for (const s of [process.stdout, process.stderr]) s.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); });
  return {
    fetch: (u, i) => fetch(u, i), store: new Store(), out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n"),
    openBrowser: hasBrowser() ? openBrowser : null, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), hostname: osHostname(), env: process.env,
  };
}
const hasBrowser = () => setting("NO_BROWSER") !== "1" && (process.platform === "darwin" || process.platform === "win32" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
/** The program that opens a web page, and its arguments (never a shell): on Windows not cmd.exe's start, which
 *  would cut the link at its first & and could run what follows it. Null for anything but an http(s) page. */
export function browserCommand(platform: string, url: string): [string, string[]] | null {
  if (!/^https?:\/\/[^\s"]+$/i.test(url)) return null;
  return platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
}
function openBrowser(url: string): void {
  const c = browserCommand(process.platform, url);
  if (!c) return;   // the link is printed too
  try { const p = spawn(c[0], c[1], { stdio: "ignore", detached: true, shell: false }); p.on("error", () => {}); p.unref(); } catch { /* the link is printed too */ }
}

/** A failure with its exit code, worded in both languages. */
class Stop extends Error {
  readonly code: Exit; readonly key: string; readonly words: { en: string; es: string }; readonly extra?: unknown;
  constructor(code: Exit, key: string, words: { en: string; es: string }, extra?: unknown) { super(words.en); this.code = code; this.key = key; this.words = words; this.extra = extra; }
}
const stop = (code: Exit, key: Key, params: Params = {}, extra?: unknown) => new Stop(code, key, both(key, params), extra);

const GLOBAL_VALUE = new Set(["club", "lang", "key", "input"]), GLOBAL_BOOL = new Set(["json", "yes", "again", "help"]);
interface Globals { json?: boolean; yes?: boolean; again?: boolean; help?: boolean; club?: string; lang?: string; key?: string; input?: string }
export function globalsOf(argv: string[]): { g: Globals; rest: string[] } {
  const g: Globals = {}, rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") { g.help = true; continue; }
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const eq = a.indexOf("="), name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (GLOBAL_BOOL.has(name) && eq < 0) { (g as any)[name] = true; continue; }
    if (GLOBAL_VALUE.has(name)) { (g as any)[name] = eq > 0 ? a.slice(eq + 1) : argv[++i]; continue; }
    rest.push(a);
  }
  return { g, rest };
}

/** Which exit code a failure from the club gets, from its key and HTTP status (mcp.ts sends both). */
const CONFLICT = new Set(["error.changed", "error.plan_expired", "error.not_planned", "error.court_taken", "error.court_taken_by_match", "error.dates_clash", "error.coach_busy",
  "error.pair_busy", "error.offer_being_taken", "error.hours_overlap", "error.undo_changed", "error.undo_expired", "error.ask_waiting", "error.policies_changed", "error.kid_price_changed"]);
export function exitOf(key: string | undefined, status: number | undefined): Exit {
  if (key && CONFLICT.has(key)) return EXIT.conflict;
  if (key === "error.assistant_in_app" || key?.startsWith("error.strong")) return EXIT.app_only;
  if (status === 400 || status === 413 || status === 415 || status === 422) return EXIT.usage;
  if (status === 401) return EXIT.signed_out;
  if (status === 404) return EXIT.not_found;
  if (status === 429 || (status !== undefined && status >= 500)) return EXIT.unreachable;
  return EXIT.refused;
}

type Answer = { ok: true; data: unknown } | { ok: false; text: string; key?: string; status?: number; missing?: boolean };

class Club {
  readonly e: ClubEntry; private d: RemoteDeps;
  constructor(e: ClubEntry, d: RemoteDeps) { this.e = e; this.d = d; }

  /** A token that works: the one kept, or a new one from the refresh token (one process at a time, cli_store.ts). */
  async token(force = false): Promise<string> {
    const { store } = this.d, now = this.d.now();
    const fresh = (x: Tokens | null) => x && !force && x.expires_at - 60_000 > now;
    let tok = store.tokens(this.e);
    if (!tok) throw stop(EXIT.signed_out, "cli.signed_out", { club: this.e.club_name, url: this.e.url });
    if (fresh(tok)) return tok.access_token;
    const used = tok.refresh_token;
    return store.locked(`refresh-${createHash("sha256").update(this.e.url).digest("hex").slice(0, 12)}`, async () => {
      tok = store.tokens(this.e);
      if (tok && tok.refresh_token !== used) return tok.access_token;   // another command refreshed it meanwhile
      if (!tok) throw stop(EXIT.signed_out, "cli.signed_out", { club: this.e.club_name, url: this.e.url });
      const r = await post(this.d, this.e.token_endpoint, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: this.e.client_id });
      if (!r.ok) throw stop(EXIT.signed_out, "cli.signed_out", { club: this.e.club_name, url: this.e.url });
      const b = r.body as { access_token: string; refresh_token: string; expires_in: number };
      const next = { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: this.d.now() + b.expires_in * 1000 };
      store.setTokens(this.e, next);
      return next.access_token;
    });
  }

  /** One of the club's command-line routes beside the door (/mcp/connect, service_routes.ts), as the person; a sign-in
   *  that ran out is renewed once. A failure is the club's own words, with its key and status. */
  async api(method: "GET" | "POST", path: string, body: unknown, lang: Lang): Promise<any> {
    const send = async (token: string) => {
      try {
        return await this.d.fetch(`${this.e.resource.replace(/\/$/, "")}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", "accept-language": lang,
          ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (e) { throw stop(EXIT.unreachable, "cli.unreachable", { club: this.e.club_name, why: (e as Error).message }); }
    };
    let res = await send(await this.token());
    if (res.status === 401) res = await send(await this.token(true));
    if (res.status === 401) throw stop(EXIT.signed_out, "cli.signed_out", { club: this.e.club_name, url: this.e.url });
    const b = await res.json().catch(() => null) as any;
    if (!res.ok) {
      const key = typeof b?.error === "string" ? b.error : "cli.failed", words = typeof b?.message === "string" ? b.message : `HTTP ${res.status}`;
      throw new Stop(exitOf(key, res.status === 403 ? 403 : res.status), key, { en: words, es: words });
    }
    return b;
  }

  /** One of the door's tools, called as the person; a sign-in that ran out is renewed once. */
  async call(tool: string, args: Record<string, unknown>): Promise<Answer> {
    const send = async (token: string) => {
      try {
        return await this.d.fetch(this.e.resource, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
      } catch (e) { throw stop(EXIT.unreachable, "cli.unreachable", { club: this.e.club_name, why: (e as Error).message }); }
    };
    let res = await send(await this.token());
    if (res.status === 401) res = await send(await this.token(true));
    if (res.status === 401) throw stop(EXIT.signed_out, "cli.signed_out", { club: this.e.club_name, url: this.e.url });
    if (!res.ok) throw stop(EXIT.unreachable, "cli.unreachable", { club: this.e.club_name, why: `HTTP ${res.status}` });
    const body = await res.json().catch(() => null) as any;
    if (!body) throw stop(EXIT.unreachable, "cli.unreachable", { club: this.e.club_name, why: "no answer" });
    if (body.error) return { ok: false, text: String(body.error.message ?? "error"), status: 400 };
    const r = body.result ?? {}, text: string = r.content?.[0]?.text ?? "";
    if (r.isError) {
      const meta = r._meta ?? {};
      // The SDK's own refusals: a tool that isn't there for this person, or arguments that don't fit its schema.
      if (!meta["kumi/error"] && /Tool .+ not found/.test(text)) return { ok: false, text, missing: true };
      if (!meta["kumi/error"] && /Input validation error/.test(text)) return { ok: false, text: text.replace(/^MCP error -?\d+: /, ""), status: 400 };
      return { ok: false, text, key: meta["kumi/error"], status: meta["kumi/status"] };
    }
    try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
  }
}

/** How long a sign-in request may take: under the minute after which another command takes the refresh lock over
 *  (cli_store.ts), so a refresh that hangs can't be made twice, which would end the sign-in. */
export const POST_TIMEOUT_MS = 30_000;
async function post(d: RemoteDeps, url: string, form: Record<string, string>): Promise<{ ok: boolean; status: number; body: any }> {
  let res: Response;
  try { res = await d.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(POST_TIMEOUT_MS) }); }
  catch (e) { throw stop(EXIT.unreachable, "cli.unreachable", { club: new URL(url).host, why: (e as Error).message }); }
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}
async function getJson(d: RemoteDeps, url: string): Promise<any> {
  let res: Response;
  try { res = await d.fetch(url, { headers: { accept: "application/json" } }); }
  catch (e) { throw stop(EXIT.unreachable, "cli.not_a_club", { url, why: (e as Error).message }); }
  if (!res.ok) throw stop(EXIT.not_found, "cli.not_a_club", { url, why: `HTTP ${res.status}` });
  return res.json().catch(() => { throw stop(EXIT.not_found, "cli.not_a_club", { url, why: "not JSON" }); });
}

export async function remoteMain(argv: string[], deps: RemoteDeps = defaultDeps()): Promise<number> {
  const { g, rest } = globalsOf(argv);
  const d = deps, store = d.store;
  const entry = (() => { try { return store.pick(g.club, d.env); } catch { return null; } })();
  let lang: Lang = pickLang(g.lang ?? entry?.lang ?? setting("LANG", d.env) ?? d.env.LANG?.slice(0, 2), "en");
  const say = (key: Key, p: Params = {}) => t(lang, key, p);
  const emit = (v: Record<string, unknown>) => d.out(JSON.stringify(v));
  try {
    const [word, ...more] = rest;
    if (!word || word === "help" || (g.help && !word)) return help(more);
    if (g.help) return help(rest);
    if (word === "login") return await login(more);
    if (word === "clubs") return clubs();
    if (word === "use") return use(more[0]);
    if (word === "schema") return schema(more);
    if (word === "logout") return await logout(need());
    if (word === "whoami") return await whoami(need());
    if (word === "confirm") return await confirm(need(), more[0]);
    if (word === "connect") return await connect(more);
    // The command and its flags are checked before the sign-in, so a mistake in them says so first.
    const found = word === "do" ? (() => { const cmd = commands().find((c) => c.action === more[0]); return cmd ? { cmd, rest: more.slice(1) } : null; })() : findCommand(rest);
    if (!found) return refuseUnknown(word === "do" ? [...String(more[0] ?? "").split("."), ...more.slice(1)] : rest);
    const parsed = parseInput(found.cmd, found.rest, await givenInput());
    return await run(need(), found.cmd, parsed);
  } catch (e) {
    if (e instanceof UsageError) return fail(new Stop(EXIT.usage, e.key, e.text));
    if (e instanceof Stop) return fail(e);
    const msg = (e as Error).message ?? String(e);
    if (g.json) emit({ status: "error", code: "cli.failed", exit: EXIT.failed, message: msg }); else d.err(say("cli.failed", { why: msg }));
    return EXIT.failed;
  }

  function fail(s: Stop): number {
    if (g.json) emit({ status: "error", code: s.key, exit: s.code, message: s.words[lang], ...(s.extra ? { choices: s.extra } : {}) });
    else {
      d.err(s.words[lang]);
      if (Array.isArray(s.extra)) for (const c of s.extra as { id: string; name: string; hint?: string }[]) d.err(`  ${c.name}${c.hint ? ` (${c.hint})` : ""}  ${c.id}`);
    }
    return s.code;
  }
  function need(): Club {
    if (!entry) throw g.club || setting("CLUB", d.env) ? stop(EXIT.signed_out, "cli.not_signed_in_to", { url: g.club ?? setting("CLUB", d.env)! }) : stop(EXIT.signed_out, "cli.not_signed_in");
    return new Club(entry, d);
  }
  function refuseUnknown(words: string[]): number {
    const name = actionNamed(words), def = name ? catalogueAction(name) : null;
    if (def && appOnly(def)) return fail(stop(EXIT.app_only, "cli.app_only", { what: both(`action.${def.name}` as Key) }));
    return fail(stop(EXIT.usage, "cli.unknown_command", { words: words.filter((w) => !w.startsWith("--")).slice(0, 3).join(" ") }));
  }

  // ---- A service's settings (service_routes.ts): never a value on the command line, never one printed ----
  async function connect(args: string[]): Promise<number> {
    const c = parseConnect(args);
    if ("refuse" in c) throw stop(EXIT.usage, c.refuse as Key, c.params ?? {});
    const club = need();
    if (c.confirm) {
      const r = await club.api("POST", "/connect/confirm", { run_id: c.confirm }, lang);
      if (g.json) emit({ status: "applied", run_id: c.confirm, result: r.result ?? null }); else d.out(say("cli.connect_done"));
      return EXIT.done;
    }
    if (!c.service) {
      const r = await club.api("GET", "/connect", undefined, lang);
      if (g.json) { emit({ status: "ok", data: r }); return EXIT.done; }
      for (const s of r.services as { service: string; settings: Shown[] }[]) d.out(`${s.service}: ${s.settings.map((x) => shown(x)).join("; ")}`);
      return EXIT.done;
    }
    if (c.link) {
      const r = await club.api("POST", `/connect/${c.service}/link`, {}, lang);
      if (g.json) emit({ status: "ok", link: r.link, expires_at: r.expires_at }); else { d.out(say("cli.connect_link", { minutes: r.minutes })); d.out(`  ${r.link}`); }
      return EXIT.done;
    }
    if (!c.set.length && !c.remove) {
      const r = await club.api("GET", "/connect", undefined, lang);
      const one = (r.services as { service: string; settings: Shown[] }[]).find((x) => x.service === c.service);
      if (!one) throw stop(EXIT.not_found, "error.service_unknown", { service: c.service });
      if (g.json) { emit({ status: "ok", data: one }); return EXIT.done; }
      for (const x of one.settings) d.out(`  ${shown(x)}`);
      return EXIT.done;
    }
    // The values, read from what's piped in or an environment variable only. Each goes to the club once, over https, to
    // be sealed in its vault; nothing here keeps or prints it.
    const set: { field: string; value: string }[] = [];
    for (const x of c.set) {
      const value = x.from === "stdin" ? await readStdin() : d.env[x.from] ?? "";
      if (!value.trim()) throw stop(EXIT.usage, x.from === "stdin" ? "cli.connect_stdin_empty" : "cli.connect_env_empty", { name: x.from });
      set.push({ field: x.field, value: value.replace(/\r?\n$/, "") });
    }
    const p = await club.api("POST", `/connect/${c.service}/plan`, c.remove ? { remove: c.remove === true ? [] : c.remove } : { set }, lang);
    set.length = 0;
    const next = `${COMMAND} connect --confirm ${p.run_id}`;
    if (g.json) emit({ status: "preview", run_id: p.run_id, title: p.title, summary: p.summary, expires_at: p.expires_at, next });
    else { d.out(p.summary); d.out(""); d.out(say("cli.connect_confirm_next", { command: next })); }
    return EXIT.preview;
  }
  type Shown = { name: string; set: boolean; source: "server" | "app" | null; secret: boolean; last4?: string | null; value?: string | null };
  function shown(x: Shown): string {
    if (!x.set) return say("cli.connect_not_set", { name: x.name });
    const where = say(x.source === "app" ? "cli.connect_in_app" : "cli.connect_on_server");
    return x.secret ? (x.last4 ? say("cli.connect_set_ending", { name: x.name, last4: x.last4, where }) : say("cli.connect_set", { name: x.name, where }))
      : say("cli.connect_set_value", { name: x.name, value: x.value ?? "", where });
  }

  // ---- Help, and each command's schema ----
  function help(words: string[]): number {
    const found = words.length ? findCommand(words) : null;
    if (words.length && !found) return refuseUnknown(words);
    if (found) {
      const c = found.cmd;
      if (g.json) { emit({ status: "ok", data: describe(c) }); return EXIT.done; }
      d.out(`${COMMAND} ${c.words.join(" ")}: ${c.title[lang]}`);
      if (c.kind === "read") d.out(c.description);
      if (c.props.length) {
        d.out("");
        for (const p of c.props) d.out(`  --${flagOf(p)}  ${typeWords(p)}${p.required ? `  (${say("cli.needed")})` : ""}${p.description ? `\n      ${p.description}` : ""}`
          + (p.json ? `\n      ${say("cli.for_example")} --${flagOf(p)} ${p.json.example}${p.json.note ? `\n      (${p.json.note[lang]})` : ""}` : ""));
      }
      d.out(`\n${say("cli.example")}\n  ${example(c)}`);
      if (c.kind === "action") d.out(`\n${say("cli.help_preview_first")}`);
      return EXIT.done;
    }
    if (g.json) { emit({ status: "ok", data: { commands: commands().map((c) => ({ command: `${COMMAND} ${c.words.join(" ")}`, kind: c.kind, title: c.title[lang], staff: c.staff ?? undefined })) } }); return EXIT.done; }
    d.out(say("cli.club_usage"));
    const reads = commands().filter((c) => c.kind === "read");
    d.out(`\n${say("cli.help_reads")}`);
    for (const c of reads) d.out(`  kumi ${c.words.join(" ").padEnd(18)} ${c.title[lang]}${c.staff ? ` (${say("cli.staff")})` : ""}`);
    d.out(`\n${say("cli.help_changes")}`);
    const groups = new Map<string, string[]>();
    for (const c of commands().filter((x) => x.kind === "action")) groups.set(c.words[0]!, [...(groups.get(c.words[0]!) ?? []), c.words.slice(1).join(" ")]);
    for (const [k, v] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) d.out(`  kumi ${k.padEnd(14)} ${v.sort().join(", ")}`);
    return EXIT.done;
  }
  function describe(c: Command) {
    return { command: `${COMMAND} ${c.words.join(" ")}`, kind: c.kind, tool: c.tool, action: c.action, title: c.title[lang], description: c.description, staff: c.staff ?? false,
      flags: c.props.map((p) => ({ flag: `--${flagOf(p)}`, input: p.key, takes: typeWords(p), needed: p.required, description: p.description ?? null, choices: p.enum ?? null,
        ...(p.json ? { example: p.json.example, ...(p.json.note ? { note: p.json.note[lang] } : {}) } : {}) })),
      example: example(c), input_schema: c.schema };
  }
  function schema(words: string[]): number {
    const found = findCommand(words);
    if (!found) return refuseUnknown(words);
    emit({ status: "ok", data: describe(found.cmd) });
    return EXIT.done;
  }

  // ---- Signing in ----
  async function login(args: string[]): Promise<number> {
    const raw = args.find((a) => !a.startsWith("--")) ?? g.club ?? setting("CLUB", d.env);
    if (!raw) throw stop(EXIT.usage, "cli.login_which");
    let url: string;
    try { url = clubKey(raw); } catch { throw stop(EXIT.usage, "cli.not_a_club", { url: raw, why: "not an address" }); }
    const device = args.includes("--device"), noWait = args.includes("--no-wait");
    const prm = await getJson(d, `${url}/.well-known/oauth-protected-resource/mcp`);
    const issuer = String(prm.authorization_servers?.[0] ?? url), resource = String(prm.resource);
    const as = await getJson(d, `${issuer}/.well-known/oauth-authorization-server`);
    const clubName = String(prm.resource_name ?? new URL(url).host);
    // Sign in only at the club's own addresses: its sign-in server is this address or its staff app's (the same
    // domain), over https (http only on this computer), and every endpoint it names is on that server.
    const notSafe = clubsOwn(url, issuer, resource, as);
    if (notSafe) throw stop(EXIT.refused, "cli.not_safe_club", { url, where: notSafe });
    const register = async (redirect: string) => {
      const r = await d.fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: `${COMMAND} (${d.hostname})`.slice(0, 80), redirect_uris: [redirect], token_endpoint_auth_method: "none", software_id: "kumi-cli" }) })
        .catch((e) => { throw stop(EXIT.unreachable, "cli.unreachable", { club: clubName, why: (e as Error).message }); });
      if (r.status === 429) throw stop(EXIT.unreachable, "cli.unreachable", { club: clubName, why: "too many sign-ins from here; wait a while" });
      if (!r.ok) throw stop(EXIT.unreachable, "cli.unreachable", { club: clubName, why: `HTTP ${r.status}` });
      return (await r.json() as { client_id: string }).client_id;
    };
    let tokens: { access_token: string; refresh_token: string; expires_in: number }, clientId: string;
    const browser = d.openBrowser;
    if (args.includes("--agent-token")) {
      // A club agent's token (agents.ts), from OPENPADEL_AGENT_TOKEN or piped in, never typed as an argument (it would stay in
      // the shell's history). It doesn't run out, so there's nothing to renew: it ends when the club revokes it.
      const token = (setting("AGENT_TOKEN", d.env) ?? await readStdin()).trim();
      if (!/^opa_[A-Za-z0-9_-]{20,}$/.test(token)) throw stop(EXIT.usage, "cli.agent_token_bad");
      tokens = { access_token: token, refresh_token: "", expires_in: 100 * 365 * 86400 }; clientId = "openpadel-agent";
    } else if (device || !browser) {
      // Started earlier with --no-wait, and still waiting: carry on with that one.
      type Pending = { client_id: string; device_code: string; user_code: string; link: string; expires_at: number; interval: number };
      let p = store.pending(url) as Pending | null;
      if (p && p.expires_at < d.now()) { store.setPending(url, null); p = null; }
      const started = !p;
      if (!p) {
        const cid = await register("http://127.0.0.1/kumi-device");
        const r = await post(d, as.device_authorization_endpoint, { client_id: cid, resource, scope: "kumi" });
        if (!r.ok) throw stop(EXIT.unreachable, "cli.unreachable", { club: clubName, why: String(r.body.error ?? r.status) });
        // The page to type the code on; never a link with the code in it (oauth.ts).
        if (sameOrigin(String(r.body.verification_uri ?? ""), issuer) !== true) throw stop(EXIT.refused, "cli.not_safe_club", { url, where: String(r.body.verification_uri ?? "") });
        p = { client_id: cid, device_code: r.body.device_code, user_code: r.body.user_code, link: r.body.verification_uri, expires_at: d.now() + r.body.expires_in * 1000, interval: r.body.interval };
        store.setPending(url, p);
      }
      if (g.json && (noWait || started)) emit({ status: "waiting_sign_in", club: url, link: p.link, code: p.user_code, expires_at: new Date(p.expires_at).toISOString(),
        next: noWait ? `${COMMAND} login ${url} --device` : null });
      else if (!g.json && started) { d.out(say("cli.login_open", { club: clubName, url: p.link })); d.out(say("cli.login_code", { code: p.user_code })); }
      if (noWait && started) return EXIT.sign_in_waiting;
      let interval = p.interval;
      for (;;) {
        const r = await post(d, as.token_endpoint, { grant_type: DEVICE_GRANT, device_code: p.device_code, client_id: p.client_id });
        if (r.ok) { tokens = r.body; clientId = p.client_id; store.setPending(url, null); break; }
        const why = r.body.error;
        if (why === "authorization_pending" || why === "slow_down") {
          if (why === "slow_down") interval += 5;
          if (noWait) { if (!g.json) d.out(say("cli.login_still_waiting", { url })); else emit({ status: "waiting_sign_in", club: url, link: p.link, code: p.user_code, next: `${COMMAND} login ${url} --device` }); return EXIT.sign_in_waiting; }
          if (d.now() > p.expires_at) { store.setPending(url, null); throw stop(EXIT.signed_out, "cli.login_expired"); }
          await d.sleep(interval * 1000);
          continue;
        }
        store.setPending(url, null);
        if (why === "access_denied") throw stop(EXIT.refused, "cli.login_denied");
        throw stop(EXIT.signed_out, "cli.login_expired");
      }
    } else {
      // In the browser: a page on this computer's own loopback address gets the answer (RFC 8252).
      const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url"), state = randomBytes(16).toString("base64url");
      let answer: (v: { code?: string; error?: string }) => void = () => {};
      const got = new Promise<{ code?: string; error?: string }>((r) => { answer = r; });
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
        const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>kumi</title><body style="font:16px system-ui;max-width:440px;margin:40px auto;padding:0 16px"><p>${say(ok ? "cli.login_page_done" : "cli.login_page_denied")}</p></body>`);
        answer(ok ? { code: u.searchParams.get("code")! } : { error: u.searchParams.get("error") ?? "state" });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as { port: number }).port, redirect = `http://127.0.0.1:${port}/callback`;
      try {
        clientId = await register(redirect);
        const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "kumi", resource });
        const link = `${as.authorization_endpoint}?${q}`;
        browser(link);
        if (g.json) emit({ status: "waiting_sign_in", club: url, link }); else d.out(say("cli.login_browser", { url: link }));
        const timeout = new Promise<{ error: string }>((r) => setTimeout(() => r({ error: "timeout" }), 10 * 60_000).unref());
        const a: { code?: string; error?: string } = await Promise.race([got, timeout]);
        if (!a.code) throw a.error === "access_denied" ? stop(EXIT.refused, "cli.login_denied") : stop(EXIT.signed_out, "cli.login_expired");
        const r = await post(d, as.token_endpoint, { grant_type: "authorization_code", code: a.code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource });
        if (!r.ok) throw stop(EXIT.signed_out, "cli.login_expired");
        tokens = r.body;
      } finally { server.close(); }
    }
    // Who signed in, and the club's clock and version, kept beside the connection.
    const health = await getJson(d, `${url}/health`).catch(() => ({ version: "?" }));
    const draft: ClubEntry = { url, issuer, resource, token_endpoint: as.token_endpoint, client_id: clientId, person: "", lang, club_name: clubName, time_zone: "UTC", store: "file", server_version: String(health.version ?? "?") };
    const tok: Tokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: d.now() + tokens.expires_in * 1000 };
    const kept = store.saveClub(draft, tok);
    const club = new Club({ ...draft, store: kept }, d);
    const me = await club.call("whoami", {});
    const who = me.ok ? me.data as { person: string; person_id?: string; connection?: { id: string }; language: Lang; club: { name: string; time_zone: string } } : null;
    const e: ClubEntry = { ...draft, store: kept, person: who?.person ?? "", lang: who?.language ?? lang, club_name: who?.club.name ?? clubName, time_zone: who?.club.time_zone ?? "UTC",
      person_id: who?.person_id, connection_id: who?.connection?.id };
    // Someone else signed in to this club here: the previews kept are the other person's, and go.
    store.dropRuns(url, (r) => Boolean(e.person_id) && r.person === e.person_id);
    store.saveClub(e, tok);
    lang = pickLang(g.lang ?? e.lang, "en");
    if (g.json) emit({ status: "done", club: url, club_name: e.club_name, person: e.person, kept_in: kept === "keychain" ? "keychain" : join(store.dir, "secrets.json"), server_version: e.server_version, cli_version: VERSION });
    else {
      d.out(say("cli.login_done", { club: e.club_name, name: e.person }));
      d.out(kept === "keychain" ? say("cli.login_store_keychain") : say("cli.login_store_file", { file: join(store.dir, "secrets.json") }));
      if (e.server_version !== VERSION) d.err(say("cli.version_differs", { mine: VERSION, theirs: e.server_version }));
    }
    return EXIT.done;
  }
  async function logout(club: Club): Promise<number> {
    let ended = false;
    try {
      const me = await club.call("whoami", {});
      const id = me.ok ? (me.data as { connection?: { id: string } }).connection?.id : undefined;
      if (id) {
        const p = await club.call("assistant_disconnect_preview", { grant_id: id });
        if (p.ok) ended = (await club.call("assistant_disconnect_confirm", { run_id: (p.data as { run_id: string }).run_id })).ok;
      }
    } catch { /* signed out already, or the club can't be reached: forget it here all the same */ }
    store.forget(club.e.url);
    if (g.json) emit({ status: "done", club: club.e.url, ended_at_club: ended });
    else d.out(say(ended ? "cli.logout_done" : "cli.logout_local", { club: club.e.club_name }));
    return EXIT.done;
  }
  function clubs(): number {
    const c = store.clubs(), list = Object.values(c.clubs);
    if (g.json) { emit({ status: "ok", data: { current: c.current, clubs: list.map((e) => ({ url: e.url, club: e.club_name, person: e.person, kept_in: e.store })) } }); return EXIT.done; }
    if (!list.length) { d.out(say("cli.not_signed_in")); return EXIT.done; }
    for (const e of list) d.out(`${e.url === c.current ? "*" : " "} ${e.url}  ${e.club_name}  (${e.person})`);
    return EXIT.done;
  }
  function use(raw: string | undefined): number {
    if (!raw) throw stop(EXIT.usage, "cli.login_which");
    const key = clubKey(raw);
    if (!store.use(key)) throw stop(EXIT.signed_out, "cli.not_signed_in_to", { url: key });
    if (g.json) emit({ status: "done", current: key }); else d.out(say("cli.use_done", { club: store.club(key)!.club_name }));
    return EXIT.done;
  }
  async function whoami(club: Club): Promise<number> {
    const r = await club.call("whoami", {});
    if (!r.ok) return failed(r);
    const w = r.data as { person: string; roles: { key: string }[]; club: { name: string }; spending: { weekly_limit: string; left: string } };
    if (g.json) { emit({ status: "ok", data: { ...w, url: club.e.url } }); return EXIT.done; }
    d.out(say("cli.whoami", { name: w.person, club: w.club.name, roles: [...new Set(w.roles.map((x) => x.key))].join(", "), limit: w.spending.weekly_limit, left: w.spending.left }));
    return EXIT.done;
  }

  // ---- Running a command ----
  function failed(a: Answer & { ok: false }, cmd?: Command): number {
    if (a.missing) return fail(stop(EXIT.refused, "cli.not_offered", { command: cmd ? `${COMMAND} ${cmd.words.join(" ")}` : COMMAND }));
    return fail(new Stop(exitOf(a.key, a.status), a.key ?? "cli.club_said", { en: a.text, es: a.text }));
  }
  /** --input: the whole input as JSON (written there, in a file, or - for what's piped in), which flags then change. */
  async function givenInput(): Promise<Record<string, unknown>> {
    if (!g.input) return {};
    const raw = g.input === "-" ? await readStdin() : g.input.trim().startsWith("{") ? g.input : readFileSync(g.input, "utf8");
    try { const v = JSON.parse(raw); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* below */ }
    throw new UsageError("cli.flag_json", { flag: "input" });
  }
  async function inputFor(club: Club, parsed: Parsed): Promise<Record<string, unknown>> {
    for (const n of parsed.names) {
      const ids: string[] = [];
      for (const v of n.values) ids.push((await find(club, n.entity, v)).id);
      parsed.input[n.key] = n.array ? [...((parsed.input[n.key] as string[] | undefined) ?? []), ...ids] : ids[0];
    }
    for (const k of parsed.times) parsed.input[k] = clubTime(String(parsed.input[k]), club.e.time_zone);
    return parsed.input;
  }
  async function find(club: Club, entity: Entity, name: string) {
    const f = FINDERS[entity], thing = both(`cli.thing_${entity}` as Key);
    // "me": the person signed in, for anyone (a member names themselves this way).
    if (entity === "person" && /^me$/i.test(name.trim())) {
      const r = await club.call("whoami", {});
      if (r.ok) return { id: (r.data as { person_id: string }).person_id, name: (r.data as { person: string }).person };
    }
    for (const how of [f.staff, f.member]) {
      if (!how) continue;
      const r = await club.call(how.tool, (how as { args?: (v: string) => Record<string, unknown> }).args?.(name) ?? {});
      if (!r.ok) { if (r.missing) continue; throw new Stop(exitOf(r.key, r.status), r.key ?? "cli.club_said", { en: r.text, es: r.text }); }
      const m = match(name, how.list(r.data));
      if ("found" in m) return m.found;
      if ("several" in m) throw new Stop(EXIT.ambiguous, "cli.name_several", both("cli.name_several", { name, thing }), m.several);
      throw stop(EXIT.not_found, "cli.name_none", { name, thing });
    }
    throw stop(EXIT.usage, "cli.name_needs_id", { thing });
  }
  async function run(club: Club, cmd: Command, parsed: Parsed): Promise<number> {
    const input = await inputFor(club, parsed);
    if (cmd.kind === "read") {
      const r = await club.call(cmd.tool, input);
      if (!r.ok) return failed(r, cmd);
      if (g.json) emit({ status: "ok", data: r.data }); else d.out(typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2));
      return EXIT.done;
    }
    // The same change asked again: a retry of one just done (a lost answer) comes back done and isn't made twice;
    // its preview is confirmed rather than made again. The same input asked again after a different change to the
    // same thing (A, then B, then A) is a new change, previewed and made. A --key names one change: used again for a
    // different input it's refused, never made as the first one.
    const inputHash = createHash("sha256").update(JSON.stringify([cmd.tool, sorted(input)])).digest("hex");
    const key = g.key ? `key:${g.key}` : `in:${inputHash}`, targets = targetsOf(input);
    const mine = store.runs().filter((r) => r.club === club.e.url && (!club.e.person_id || r.person === club.e.person_id));   // newest first
    if (g.key && mine.some((r) => r.key === key && (r.tool !== cmd.tool || (r.input && r.input !== inputHash)))) throw stop(EXIT.conflict, "cli.key_reused", { key: g.key });
    const live = (r: RunEntry) => r.done_at ? d.now() - new Date(r.done_at).getTime() < (g.key ? 864e5 : 10 * 60_000) : new Date(r.expires_at).getTime() > d.now();
    const at = g.again ? -1 : mine.findIndex((r) => r.tool === cmd.tool && r.key === key && live(r));
    let prior = at >= 0 ? mine[at] : undefined;
    // Without a --key: a different change since, to the same thing (one of the same ids, or both naming none), and
    // this isn't a retry of the earlier one.
    if (prior && !g.key && mine.slice(0, at).some((r) => r.tool === cmd.tool && r.key !== key && overlap(r.targets ?? [], targets))) prior = undefined;
    // And on the club: anything that change made, changed since by anyone (in the app, another command, someone
    // else), and it's a new change, previewed and made. A club too old to say leaves the check above.
    if (prior?.done_at && !g.key) {
      const since = await club.call("changed_since", { run_id: prior.run_id });
      if (since.ok ? (since.data as { changed?: boolean }).changed : !since.missing) prior = undefined;
    }
    if (prior?.done_at) return alreadyDone(prior);
    if (prior && g.yes) return await apply(club, cmd.tool, prior);
    const p = await club.call(`${cmd.tool}_preview`, input);
    if (!p.ok) return failed(p, cmd);
    const v = p.data as { run_id: string; status: string; summary: string; undo: string; expires_at: string };
    const entryRun: RunEntry = { club: club.e.url, tool: cmd.tool, key, run_id: v.run_id, summary: v.summary, expires_at: v.expires_at,
      input: inputHash, person: club.e.person_id, connection: club.e.connection_id, targets, at: new Date(d.now()).toISOString() };
    store.saveRun(entryRun);
    if (v.status === "awaiting_approval") {
      if (g.json) emit({ status: "waiting_approval", run_id: v.run_id, summary: v.summary }); else { d.out(v.summary); d.out(say("cli.waiting_approval")); }
      return EXIT.approval;
    }
    if (!g.yes) {
      const until = new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: club.e.time_zone, hour: "numeric", minute: "2-digit" }).format(new Date(v.expires_at));
      if (g.json) emit({ status: "preview", run_id: v.run_id, summary: v.summary, undo: v.undo, expires_at: v.expires_at, confirm: `${COMMAND} confirm ${v.run_id}` });
      else { d.out(say("cli.preview_heading")); d.out(`  ${v.summary}`); d.out(say("cli.preview_next", { run: v.run_id, until })); }
      return EXIT.preview;
    }
    return await apply(club, cmd.tool, entryRun);
  }
  async function apply(club: Club, tool: string, r: RunEntry): Promise<number> {
    const a = await club.call(`${tool}_confirm`, { run_id: r.run_id });
    if (!a.ok) {
      // A preview that's out of date or gone is forgotten here, so the same command again previews afresh. Refused
      // too (they may no longer do it, so the club no longer even offers its confirm), the same.
      if (a.missing || exitOf(a.key, a.status) === EXIT.conflict || a.key === "error.forbidden_reason" || a.key === "error.plan_not_yours") store.dropRun(r.run_id);
      return failed(a);
    }
    const result = (a.data as { result?: unknown }).result ?? null;
    store.saveRun({ ...r, done_at: new Date(d.now()).toISOString(), result });
    if (g.json) emit({ status: "done", run_id: r.run_id, summary: r.summary, result }); else { d.out(r.summary); d.out(say("cli.done")); }
    return EXIT.done;
  }
  function alreadyDone(r: RunEntry): number {
    if (g.json) emit({ status: "done", already: true, run_id: r.run_id, summary: r.summary, result: r.result ?? null });
    else d.out(say("cli.already_done", { run: r.run_id }));
    return EXIT.done;
  }
  async function confirm(club: Club, runId: string | undefined): Promise<number> {
    if (!runId) throw stop(EXIT.usage, "cli.confirm_which");
    const r = store.runs().find((x) => x.club === club.e.url && x.run_id === runId && (!club.e.person_id || x.person === club.e.person_id));
    if (!r) throw stop(EXIT.not_found, "cli.confirm_unknown", { run: runId });
    if (r.done_at) return alreadyDone(r);
    return apply(club, r.tool, r);
  }
}

/** The ids an input names (a court, a person, a booking): a later change naming one of them is to the same thing. */
export function targetsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") { if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) out.push(v.toLowerCase()); }
  else if (Array.isArray(v)) for (const x of v) targetsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) targetsOf(x, out);
  return [...new Set(out)];
}
const overlap = (a: string[], b: string[]) => (!a.length && !b.length) || a.some((x) => b.includes(x));
const LOCAL = ["localhost", "127.0.0.1", "[::1]", "::1"];
/** True when `raw` is on `base`'s origin and over https (http only on this computer); otherwise why not. */
export function sameOrigin(raw: string, base: string): true | string {
  try {
    const x = new URL(raw), b = new URL(base);
    if (x.origin !== b.origin) return raw;
    return x.protocol === "https:" || (x.protocol === "http:" && LOCAL.includes(x.hostname)) ? true : raw;
  } catch { return raw || "?"; }
}
/** Null when a club's sign-in server and its endpoints are the club's own; otherwise the address that isn't. */
export function clubsOwn(club: string, issuer: string, resource: string, as: Record<string, unknown>): string | null {
  let c: URL, i: URL;
  try { c = new URL(club); i = new URL(issuer); } catch { return issuer || "?"; }
  // The club's own host, or its staff app's beside it (staff.<the members' app>): exactly those, never a neighbour
  // under the same suffix (co.uk, com.es) or another club on the same host (kumi.club).
  const own = (h: string) => h === c.hostname || h === `staff.${c.hostname}` || c.hostname === `staff.${h}`;
  const local = LOCAL.includes(c.hostname) && LOCAL.includes(i.hostname);
  if (!local && (i.protocol !== "https:" || !own(i.hostname))) return issuer;
  if (local && i.protocol !== "http:" && i.protocol !== "https:") return issuer;
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "device_authorization_endpoint"]) {
    if (as[k] === undefined && k === "device_authorization_endpoint") continue;
    const ok = sameOrigin(String(as[k] ?? ""), issuer);
    if (ok !== true) return ok;
  }
  if (sameOrigin(resource, club) !== true && sameOrigin(resource, issuer) !== true) return resource;
  return null;
}

/** An input with its keys in order, so the same input written two ways is the same change. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
}
async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += String(chunk);
  return s;
}

/** `openpadel connect`'s words: a service, then --set FIELD with --from-stdin or --from-env NAME (repeatable, one
 *  --from-stdin at most), --remove FIELD (or --remove-all), --link, or --confirm <run>. A value given on the command
 *  line itself (--set api_key=re_..., or a word after the field) is refused: the shell's history and the process
 *  list would keep it. */
export function parseConnect(args: string[]):
  { service: string | null; set: { field: string; from: string }[]; remove: string[] | true | null; link: boolean; confirm: string | null } | { refuse: string; params?: Record<string, string> } {
  const out = { service: null as string | null, set: [] as { field: string; from: string }[], remove: null as string[] | true | null, link: false, confirm: null as string | null };
  let stdin = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--set" || a.startsWith("--set=")) {
      const field = a === "--set" ? args[++i] : a.slice(6);
      if (!field || field.startsWith("--")) return { refuse: "cli.connect_set_how" };
      if (field.includes("=")) return { refuse: "cli.connect_no_argv" };
      const how = args[++i];
      if (how === "--from-stdin") { if (++stdin > 1) return { refuse: "cli.connect_one_stdin" }; out.set.push({ field, from: "stdin" }); continue; }
      if (how === "--from-env" || how?.startsWith("--from-env=")) {
        const name = how === "--from-env" ? args[++i] : how.slice(11);
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { refuse: "cli.connect_set_how" };
        out.set.push({ field, from: name }); continue;
      }
      // A value typed after the field, or nothing at all: never taken from the command line.
      return { refuse: how && !how.startsWith("--") ? "cli.connect_no_argv" : "cli.connect_set_how" };
    }
    if (a === "--from-stdin" || a === "--from-env" || a.startsWith("--from-env=") || a === "--value" || a.startsWith("--value=")) return { refuse: a.startsWith("--value") ? "cli.connect_no_argv" : "cli.connect_set_how" };
    if (a === "--remove") { const f = args[++i]; if (!f || f.startsWith("--")) return { refuse: "cli.connect_set_how" }; out.remove = [...(Array.isArray(out.remove) ? out.remove : []), f]; continue; }
    if (a === "--remove-all") { out.remove = true; continue; }
    if (a === "--link") { out.link = true; continue; }
    if (a === "--confirm") { const id = args[++i]; if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return { refuse: "cli.connect_set_how" }; out.confirm = id; continue; }
    if (a.startsWith("--")) return { refuse: "cli.connect_set_how" };
    if (out.service) return { refuse: "cli.connect_no_argv" };
    out.service = a.toLowerCase();
  }
  if ((out.set.length ? 1 : 0) + (out.remove ? 1 : 0) + (out.link ? 1 : 0) > 1) return { refuse: "cli.connect_set_how" };
  if ((out.set.length || out.remove || out.link) && !out.service) return { refuse: "cli.connect_set_how" };
  return out;
}
