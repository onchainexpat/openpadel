// The service worker (packages/ui/sw/worker.js, written into each app's /sw.js by offlineShell() in packages/ui/vite.ts):
// pages come from the network first and from the build's put-aside copy when it can't answer, so the start screen shows
// with no connection at all; only the build's first-screen files and the start screen's look are ever kept, never the
// club's API; a new build's set goes aside whole or not at all, and the old ones go. Run here in node, with a pretend
// browser around it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { offlineShell, shellFiles, workerSource } from "../vite.ts";

const root = new URL("../../..", import.meta.url).pathname;
const ORIGIN = "https://club.example";
const SHELL = { version: "v1", files: ["/assets/index-A.js", "/assets/index-A.css", "/assets/en-A.js", "/assets/es-A.js"] };
const PAGE = `<html><link rel="stylesheet" href="/manifest/boot.css"><script type="module" crossorigin src="/assets/index-A.js"></script><link rel="stylesheet" crossorigin href="/assets/index-A.css"></html>`;

type Res = { status: number; ok: boolean; type: string; redirected: boolean; body: string; headers: { get(k: string): string | null }; clone(): Res; text(): Promise<string> };
const res = (body: string, status = 200, type = body.startsWith("<html") ? "text/html" : "text/javascript"): Res => ({ status, ok: status >= 200 && status < 300, type: "basic", redirected: false, body,
  headers: { get: (k: string) => k.toLowerCase() === "content-type" ? type : null }, clone() { return this; }, async text() { return body; } });
type Req = { url: string; method: string; mode: string; cache?: string };
class FakeRequest {
  url: string; method: string; mode: string; cache: string | undefined;
  constructor(input: string | Req, init: { cache?: string; method?: string } = {}) {
    const from = typeof input === "string" ? undefined : input;
    this.url = new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
    this.method = init.method ?? from?.method ?? "GET"; this.mode = from?.mode ?? "cors"; this.cache = init.cache ?? from?.cache;
  }
}
const keyOf = (r: string | Req, ignoreSearch = false) => { const u = new URL(typeof r === "string" ? r : r.url, ORIGIN); return u.pathname + (ignoreSearch ? "" : u.search); };

/** The worker in a pretend browser: its caches, the network (a function of the request), every cache write, and the
 *  events it listens to. */
function load(shell: typeof SHELL | null, network: (r: Req) => Promise<Res>) {
  const stores = new Map<string, Map<string, Res>>(), puts: string[] = [], fetched: Req[] = [];
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      async put(k: string | Req, v: Res) { puts.push(keyOf(k)); m.set(keyOf(k), v); },
      async match(k: string | Req, o?: { ignoreSearch?: boolean }) { return m.get(keyOf(k, o?.ignoreSearch)); },
    };
  };
  const caches = { open, async keys() { return [...stores.keys()]; }, async delete(n: string) { return stores.delete(n); },
    async match(k: string | Req, o: { cacheName: string }) { return stores.get(o.cacheName)?.get(keyOf(k)); } };
  const on = new Map<string, (e: unknown) => void>();
  let waited = false;
  const self = { location: { origin: ORIGIN }, addEventListener: (t: string, f: (e: unknown) => void) => on.set(t, f),
    skipWaiting: async () => { waited = true; }, clients: { claim: async () => {} }, registration: {} };
  const ctx = vm.createContext({ self, caches, Request: FakeRequest, URL, Promise, setTimeout, clearTimeout,
    fetch: (r: Req) => { fetched.push(r); return network(r); } });
  vm.runInContext(workerSource(shell), ctx);
  /** Sends an event; what it waited on (install, activate) or answered with (fetch), or undefined when it let it be. */
  const send = async (type: string, extra: Record<string, unknown> = {}) => {
    let wait: Promise<unknown> | undefined, answer: Promise<Res> | undefined;
    on.get(type)?.({ ...extra, waitUntil: (p: Promise<unknown>) => { wait = p; }, respondWith: (p: Promise<Res>) => { answer = p; } });
    if (wait) await wait;
    return answer;
  };
  const get = (path: string, mode = "cors", method = "GET") => send("fetch", { request: Object.assign(new FakeRequest(`${path.startsWith("http") ? "" : ORIGIN}${path}`, { method }), { mode }) });
  return { ctx: ctx as Record<string, any>, stores, puts, fetched, on, send, get, waited: () => waited };
}
const online = async (r: Req) => keyOf(r) === "/" ? res(PAGE) : res(`file ${keyOf(r)}`);
const offline = async (): Promise<Res> => { throw new TypeError("Failed to fetch"); };

test("the worker's list of API paths is Caddy's (server-setup.sh's api=), which the docker Caddyfile also uses", () => {
  const script = readFileSync(`${root}deploy/server-setup.sh`, "utf8");
  const w = load(SHELL, online);
  assert.equal(vm.runInContext("API_PATHS.join(' ')", w.ctx), script.match(/^api='(.*)'$/m)![1]);
});

test("what the worker does with each request", () => {
  const route = (url: string, mode = "cors", method = "GET", shell: typeof SHELL | null = SHELL) =>
    load(SHELL, online).ctx.routeOf({ url: url.startsWith("http") ? url : ORIGIN + url, mode, method }, ORIGIN, shell);
  // Pages of the app: network first, the put-aside page when that fails.
  for (const p of ["/", "/bookings", "/people/42?tab=x", "/membership", "/me-and-you"]) assert.equal(route(p, "navigate"), "page", p);
  // The build's files: from a put-aside set when they're in one (never kept from here).
  for (const p of ["/assets/index-A.js", "/assets/es-A.js", "/assets/Settings-A.js"]) assert.equal(route(p), "file", p);
  // The start screen's look, with or without its ?v=.
  for (const p of ["/manifest/boot.css", "/manifest/mark.png", "/manifest/mark.png?v=abc"]) assert.equal(route(p), "brand", p);
  // Left alone: other files, a file with a query, the worker itself, posts, other sites, and every API path, even opened as a page.
  for (const p of ["/assets/index-A.js?x=1", "/sw.js", "/manifest/icon-192.png", "/manifest/staff.webmanifest", "/"]) assert.equal(route(p), null, p);
  assert.equal(route("/", "navigate", "POST"), null);
  assert.equal(route("https://js.stripe.com/v3", "navigate"), null);
  assert.equal(route("https://other.example/assets/index-A.js"), null);
  for (const p of ["/me", "/me/sessions", "/club", "/auth/passkey", "/oauth/authorize?x=1", "/unsubscribe/abc", "/calendar/c.ics", "/public", "/.well-known/x", "/my/push", "/mcp", "/health"]) {
    assert.equal(route(p), null, p); assert.equal(route(p, "navigate"), null, `${p} as a page`);
  }
  // Without a set (developing), nothing.
  assert.equal(route("/", "navigate", "GET", null), null);
});

test("no API answer is ever kept, online or off, as a page or a request", async () => {
  const script = readFileSync(`${root}deploy/server-setup.sh`, "utf8");
  const paths = script.match(/^api='(.*)'$/m)![1]!.split(" ").map((p) => p.replace("*", "x"));
  for (const up of [true, false]) {
    let net = online;
    const w = load(SHELL, (r) => net(r));
    await w.send("install");
    assert.ok(w.puts.includes("/"), "the set is aside");
    if (!up) net = offline;
    const before = w.puts.length;
    for (const p of [...paths, "/me", "/club", "/my/bookings", "/manifest/icon-192.png", "/manifest/staff.webmanifest"]) for (const mode of ["cors", "navigate", "no-cors"]) {
      assert.equal(await w.get(p, mode), undefined, `${p} (${mode}) is left to the browser`);
    }
    assert.equal(w.puts.length, before, "and nothing more is kept");
    assert.ok(w.puts.every((k) => k === "/" || SHELL.files.includes(k) || k === "/manifest/boot.css" || k === "/manifest/mark.png"), w.puts.join());
  }
});

test("installing puts the page, its files and the start screen's look aside; with no connection a page is the put-aside one", async () => {
  let up = true;
  const w = load(SHELL, (r) => up ? online(r) : offline());
  await w.send("install");
  assert.ok(w.waited(), "takes over once its set is aside");
  assert.deepEqual([...w.stores.get("openpadel-shell-v1")!.keys()].sort(), ["/", ...SHELL.files].sort());
  assert.deepEqual([...w.stores.get("openpadel-brand")!.keys()].sort(), ["/manifest/boot.css", "/manifest/mark.png"]);
  assert.equal(w.fetched.find((r) => keyOf(r) === "/")!.cache, "reload", "the page is fetched past the browser's cache");
  // Online: the network's page.
  assert.equal((await w.get("/bookings", "navigate"))!.body, "file /bookings");
  up = false;
  // Offline: the put-aside page for any page of the app, its files, and the club's look.
  assert.equal((await w.get("/bookings", "navigate"))!.body, PAGE);
  assert.equal((await w.get("/", "navigate"))!.body, PAGE);
  assert.equal((await w.get("/assets/index-A.js"))!.body, "file /assets/index-A.js");
  assert.equal((await w.get("/manifest/boot.css"))!.body, "file /manifest/boot.css");
  assert.equal((await w.get("/manifest/mark.png?v=zz"))!.body, "file /manifest/mark.png");
});

test("a server error gets the put-aside page; other answers are the network's", async () => {
  let net: (r: Req) => Promise<Res> = online;
  const w = load(SHELL, (r) => net(r));
  await w.send("install");
  net = async () => res("bad gateway", 502);
  assert.equal((await w.get("/", "navigate"))!.body, PAGE);
  net = async () => res("not here", 404);
  assert.equal((await w.get("/x", "navigate"))!.status, 404);
});

test("a network that doesn't answer in time: the put-aside page after the wait", async () => {
  const w = load(SHELL, online);
  await w.send("install");
  const hang = () => new Promise<never>(() => {});
  const page = await w.ctx.withinTime(hang(), 5);
  assert.equal(page, undefined, "gives up after the wait");
  assert.equal((await w.ctx.withinTime(Promise.reject(new Error("x")), 1000)), undefined, "and on a failure, at once");
  // The page itself, with a network that never answers: the put-aside page once the wait is over.
  const ctx = vm.createContext({ self: { addEventListener() {}, location: { origin: ORIGIN } }, Request: FakeRequest, URL, setTimeout, clearTimeout });
  vm.runInContext(workerSource(SHELL).replace("const NETWORK_WAIT_MS = 4000;", "const NETWORK_WAIT_MS = 5;"), ctx);
  const store = { keys: async () => ["openpadel-shell-v1"], match: async () => res(PAGE) };
  assert.equal((await ctx.answerPage({ request: new FakeRequest("/x") }, SHELL, hang, store)).body, PAGE);
});

test("with no set put aside yet, a failed page is the browser's own failure, as with no worker", async () => {
  const w = load(SHELL, offline);
  await w.send("install");
  assert.ok(w.waited(), "installing still finishes (notifications wait for it), with no set");
  assert.equal(w.stores.has("openpadel-shell-v1"), false);
  await assert.rejects(w.get("/", "navigate"), /Failed to fetch/);
});

test("a page from another release, a missing file, or a file that comes back as the page: no set, and the old one stays", async () => {
  const cases: [string, (r: Req) => Promise<Res>][] = [
    ["another release", async (r) => keyOf(r) === "/" ? res(PAGE.replaceAll("index-A", "index-B")) : online(r)],
    ["a 404", async (r) => keyOf(r) === "/assets/es-A.js" ? res("", 404) : online(r)],
    // Caddy answers a file that isn't there (yet, or any more) with the app's page and a 200 (try_files).
    ["the page for a file", async (r) => keyOf(r) === "/assets/index-A.css" ? res(PAGE) : online(r)],
    ["a file that never comes", async (r) => keyOf(r) === "/assets/en-A.js" ? offline() : online(r)],
  ];
  for (const [why, net] of cases) {
    const w = load({ ...SHELL, version: "v2" }, net);
    const old = await (w.ctx.caches as { open(n: string): Promise<{ put(k: string, v: Res): Promise<void> }> }).open("openpadel-shell-v1");
    await old.put("/", res(PAGE)); await old.put("/assets/index-A.js", res("old code"));
    await w.send("install");
    await w.send("activate");
    assert.equal(w.stores.has("openpadel-shell-v2"), false, `${why}: nothing of the new set is kept`);
    assert.ok(w.stores.has("openpadel-shell-v1"), `${why}: the old set stays`);
  }
});

test("with only an older build's set (this one's couldn't go aside), offline still starts from it, and a later page load fills the set in", async () => {
  let up = false;
  const w = load({ ...SHELL, version: "v2" }, (r) => up ? online(r) : offline());
  const old = await (w.ctx.caches as { open(n: string): Promise<{ put(k: string, v: Res): Promise<void> }> }).open("openpadel-shell-v1");
  await old.put("/", res("<html>old page</html>")); await old.put("/assets/index-OLD.js", res("old code"));
  await w.send("install");
  await w.send("activate");
  assert.equal((await w.get("/", "navigate"))!.body, "<html>old page</html>");
  assert.equal((await w.get("/assets/index-OLD.js"))!.body, "old code", "with its own files");
  up = true;
  vm.runInContext("lastFill = 0", w.ctx);
  await w.get("/", "navigate");
  await vm.runInContext("filling || Promise.resolve()", w.ctx);
  assert.deepEqual([...w.stores.keys()].sort(), ["openpadel-brand", "openpadel-shell-v1", "openpadel-shell-v2"], "filled in");
  assert.equal((await w.get("/assets/index-A.js"))!.body, "file /assets/index-A.js", "its own set first now");
  // Filling in never deletes another set (an old worker finishing late could otherwise delete a newer build's); the
  // next build to take over does.
  const next = load({ ...SHELL, version: "v3" }, online);
  for (const [n, m] of w.stores) next.stores.set(n, m);
  await next.send("install"); await next.send("activate");
  assert.deepEqual([...next.stores.keys()].sort(), ["openpadel-brand", "openpadel-shell-v3"]);
});

test("a new build's worker deletes the old builds' sets when it takes over, and keeps the start screen's look", async () => {
  const w = load({ ...SHELL, version: "v2" }, online);
  for (const n of ["openpadel-shell-v1", "openpadel-shell-v0", "openpadel-brand", "someone-elses"]) await (w.ctx.caches as { open(n: string): Promise<unknown> }).open(n);
  await w.send("install");
  await w.send("activate");
  assert.deepEqual([...w.stores.keys()].sort(), ["openpadel-brand", "openpadel-shell-v2", "someone-elses"]);
});

test("the start screen's look: checked with the server each time (a new logo shows at once), the last copy offline", async () => {
  let up = true, mark = "logo 1";
  const w = load(SHELL, async (r) => { if (!up) throw new TypeError("offline"); return keyOf(r, true) === "/manifest/mark.png" ? res(mark) : online(r); });
  await w.send("install");
  mark = "logo 2";
  assert.equal((await w.get("/manifest/mark.png", "no-cors"))!.body, "logo 2");
  assert.equal(w.fetched.at(-1)!.cache, "no-cache", "without its ?v=, past the browser's cache");
  up = false;
  assert.equal((await w.get("/manifest/mark.png", "no-cors"))!.body, "logo 2", "offline: the last one seen");
});

test("push notifications work as before, and without a set (developing) the worker only does those", () => {
  const w = load(null, online);
  assert.deepEqual([...w.on.keys()].sort(), ["notificationclick", "push"]);
  assert.deepEqual([...load(SHELL, online).on.keys()].sort(), ["activate", "fetch", "install", "notificationclick", "push"]);
});

test("the build's set: entry code, what it imports up front, its styles and each language's first wording", () => {
  const chunk = (fileName: string, o: { isEntry?: boolean; imports?: string[]; css?: string[]; facade?: string } = {}) =>
    ({ type: "chunk" as const, fileName, isEntry: o.isEntry ?? false, imports: o.imports ?? [], facadeModuleId: o.facade ?? null, viteMetadata: { importedCss: new Set(o.css ?? []) } });
  const bundle = {
    "assets/index-A.js": chunk("assets/index-A.js", { isEntry: true, imports: ["assets/pow-A.js"], css: ["assets/index-A.css"] }),
    "assets/pow-A.js": chunk("assets/pow-A.js"),
    "assets/en-A.js": chunk("assets/en-A.js", { facade: "\0virtual:kumi-wording/en" }),
    "assets/es-A.js": chunk("assets/es-A.js", { facade: "\0virtual:kumi-wording/es" }),
    "assets/rest-A.js": chunk("assets/rest-A.js", { facade: "\0virtual:kumi-wording/en/rest" }),
    "assets/Settings-A.js": chunk("assets/Settings-A.js", { imports: ["assets/pow-A.js"] }),
    "assets/court-A.webp": { type: "asset" as const, fileName: "assets/court-A.webp", source: "" },
  };
  assert.deepEqual(shellFiles(bundle), ["/assets/en-A.js", "/assets/es-A.js", "/assets/index-A.css", "/assets/index-A.js", "/assets/pow-A.js"]);
  // The plugin writes sw.js with it, and fails the build when the page loads something the set doesn't hold.
  const emitted: { fileName: string; source: string }[] = [];
  const ctx = { error(m: string): never { throw new Error(m); }, emitFile(f: { fileName: string; source: string }) { emitted.push(f); } };
  offlineShell().generateBundle.call(ctx, {}, { ...bundle, "index.html": { type: "asset", fileName: "index.html", source: PAGE } });
  assert.equal(emitted[0]!.fileName, "sw.js");
  assert.match(emitted[0]!.source, /^const SHELL = \{"version":"[0-9a-f]{12}","files":\["\/assets\/en-A\.js"/);
  assert.throws(() => offlineShell().generateBundle.call(ctx, {}, { ...bundle, "index.html": { type: "asset", fileName: "index.html", source: PAGE.replace("index-A.css", "other-A.css") } }), /other-A\.css, not in the offline set/);
});

test("both apps build the worker, and nothing else serves an old one", () => {
  for (const app of ["member", "manager"]) assert.match(readFileSync(`${root}apps/${app}/vite.config.ts`, "utf8"), /offlineShell\(\)/, app);
  assert.match(readFileSync(`${root}packages/ui/src/boot.ts`, "utf8"), /navigator\.serviceWorker\?\.register\("\/sw\.js"\)/, "registered for everyone once the app starts");
});
