// openPadel's service worker, one per app (each app's /sw.js, written by the build: offlineShell() in packages/ui/vite.ts,
// which puts the line `const SHELL = ...` above this file). It does two jobs:
//
// 1. The club's push notifications (shows them, and opens the app where each one points), as it always has.
// 2. The start screen with no connection at all. Pages always come from the network first; when the network can't
//    answer (airplane mode, no signal, a few seconds of nothing, or a server error) the app's own page comes from what
//    this build put aside instead, so the app starts, can't reach the club, says so in the club's colour with its
//    logo, and carries on by itself once the phone is back online.
//
// What's put aside, and nothing else: the app's page (index.html), the code and styles its first screen needs and the
// first screen's wording (SHELL.files, hashed names from the build), and the start screen's look from the club
// (/manifest/boot.css and /manifest/mark.png). Never an answer from the club's API, never /me, never anything behind
// sign-in, never another site's. The page and its files are one set, kept under the build's own version and written
// whole or not at all (a page from another release, or a file that comes back as a page, fails it). The old sets are
// deleted only once the new one is aside. So a page from the cache never points at files the cache doesn't have.
//
// The logic is in plain functions (the test runs this file in node, packages/ui/test/sw.test.ts); the events are wired
// at the bottom.

/* global SHELL */

/** Where the club's API answers (Caddy sends these to the server, deploy/server-setup.sh's api=; a test keeps the two
 *  the same). The worker never answers for these, never caches them, and never opens the app on them. */
const API_PATHS = "/auth/* /me /me/* /my/* /club /actions /actions/* /runs /runs/* /staff/* /oauth/* /.well-known/* /mcp /mcp/* /assistant /assistant/* /health /health/* /open-programs /payments/* /webhooks/* /manifest/* /availability /booking-options /quote /bookings/* /membership-plans /open-matches /matches/* /public /public/* /calendar/* /unsubscribe/*".split(" ");

/** The start screen's look from the club: its colour and words, and its logo or mark. Public, the same for everyone,
 *  read with or without a query (the app adds ?v= for the current logo). The only server answers ever kept. */
const BRAND_PATHS = ["/manifest/boot.css", "/manifest/mark.png"];

/** How long a page may take before the copy put aside answers instead, in ms; and the start screen's look, which
 *  holds the page's first paint, so it waits less. */
const NETWORK_WAIT_MS = 4000;
const BRAND_WAIT_MS = 1500;
/** After a set couldn't be put aside, how long before trying again on a page load, in ms. */
const RETRY_SET_MS = 10 * 60 * 1000;
/** How long one fetch for the set may take, in ms. */
const FETCH_GIVE_UP_MS = 15000;
/** A signal that gives up after FETCH_GIVE_UP_MS (none on a browser without AbortSignal.timeout). */
const giveUp = () => typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(FETCH_GIVE_UP_MS) : undefined;

const SHELL_PREFIX = "openpadel-shell-";
const BRAND_CACHE = "openpadel-brand";

/** Whether a path is the club's API (Caddy's matchers: "/x" is exactly /x, "/x/*" is everything under /x/). */
function isApiPath(path) {
  return API_PATHS.some((p) => p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p);
}

/** What the worker does with a request: "page" (a page of the app: network first, the put-aside page when that fails),
 *  "file" (a build's file, /assets/ with hashed names: from a put-aside set if it's there, else the network; never
 *  kept from here), "brand" (the start screen's look: network first, the last copy when that fails), or null: left to
 *  the browser, never touched or kept. */
function routeOf(req, origin, shell) {
  if (!shell || req.method !== "GET") return null;
  let url;
  try { url = new URL(req.url); } catch { return null; }
  if (url.origin !== origin) return null;
  const path = url.pathname;
  if (BRAND_PATHS.includes(path)) return "brand";
  if (isApiPath(path) || path === "/sw.js") return null;
  if (req.mode === "navigate") return "page";
  if (!url.search && path.startsWith("/assets/")) return "file";
  return null;
}

/** The cache that holds this build's set. */
function shellCacheName(shell) { return SHELL_PREFIX + shell.version; }

/** The caches to delete once this build takes over: other builds' sets (never the start screen's look, which a new
 *  build keeps, or caches that aren't this worker's). */
function staleCaches(names, shell) {
  return names.filter((n) => n.startsWith(SHELL_PREFIX) && n !== shellCacheName(shell));
}

/** The files a page loads from /assets/ (its scripts, styles and preloads). */
function assetsIn(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]))];
}

/** Whether a page belongs to this build: every file it loads is in the set. A page from another release (the server
 *  updated while this worker was being fetched) fails, and the worker doesn't take over with it. */
function pageMatches(html, shell) {
  const files = assetsIn(html);
  return files.length > 0 && files.every((f) => shell.files.includes(f));
}

/** Whether an answer from the server can stand in for a page: anything but a server error. */
function pageAnswered(res) { return Boolean(res) && res.status < 500; }

/** The network's answer, or undefined after `ms` (the fetch carries on behind it). Never rejects. */
function withinTime(p, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then((r) => { clearTimeout(timer); resolve(r); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

/** The first put-aside set holding `key`: this build's, else another build's still here (each set is whole, its page
 *  with its own files, so an older one still starts). */
async function fromSets(key, shell, store) {
  const own = shellCacheName(shell);
  for (const name of [own, ...(await store.keys()).filter((n) => n.startsWith(SHELL_PREFIX) && n !== own)]) {
    const hit = await store.match(key, { cacheName: name });   // (open() would make an empty cache)
    if (hit) return hit;
  }
  return undefined;
}

/** Whether this build's set is aside: its page is written last, so with the page the set is whole. */
async function hasSet(shell, store = caches) {
  return Boolean(await store.match("/", { cacheName: shellCacheName(shell) }));
}

/** A page: the network's, unless it can't answer in time or answers with a server error; then a put-aside page (or,
 *  with none, whatever the network gives in the end, so the browser's own error shows as it would with no worker). */
async function answerPage(event, shell, net = fetch, store = caches) {
  const fromNet = net(event.request);
  const res = await withinTime(fromNet, NETWORK_WAIT_MS);
  if (pageAnswered(res)) return res;
  return (await fromSets("/", shell, store)) || res || fromNet;
}

/** A build's file: from a put-aside set (hashed names never change), else the network. */
async function answerFile(event, shell, net = fetch, store = caches) {
  const path = new URL(event.request.url).pathname;
  return (await fromSets(path, shell, store)) || net(event.request);
}

/** The start screen's look: the network's (and a copy kept for next time), or the last copy when the network can't
 *  answer in time. Kept by path, so the logo's ?v= addresses share one copy. index.html asks for these without a ?v=,
 *  so those are checked with the server each time (a quick "not changed" when they haven't): a club's new logo or
 *  colour shows on the next start with a connection, not a day later. */
async function answerBrand(event, net = fetch, store = caches) {
  const url = new URL(event.request.url), path = url.pathname;
  const fromNet = net(url.search ? event.request : new Request(event.request, { cache: "no-cache" }));
  const res = await withinTime(fromNet, BRAND_WAIT_MS);
  const cache = await store.open(BRAND_CACHE);
  if (res && res.ok && res.type === "basic") { await cache.put(path, res.clone()); return res; }
  return (await cache.match(path)) || res || fromNet;
}

/** Whether a file came back as itself: a missing file gets the app's page from Caddy (try_files), with a 200. */
function fileAnswered(res) {
  return res.ok && !res.redirected && !/^text\/html\b/i.test(res.headers.get("content-type") || "");
}

/** Puts this build's set aside: its page (fetched past the browser's cache, and checked to be this build's) and its
 *  files, all or nothing (the page written last, so a set with its page is whole; a set that fails partway is
 *  deleted); then the start screen's look, if the server gives it. Each fetch gives up after FETCH_GIVE_UP_MS, so a
 *  stalled connection can't hold the install (and notifications, which wait for it) for long. Other builds' sets go
 *  only when a worker takes over (activate): an old worker filling its set in late must never delete a newer one's. */
async function putAside(shell, net = fetch, store = caches) {
  const name = shellCacheName(shell);
  try {
    const page = await net(new Request("/", { cache: "reload", credentials: "same-origin", signal: giveUp() }));
    if (!page.ok || page.redirected) throw new Error(`The app's page answered ${page.status}`);
    if (!pageMatches(await page.clone().text(), shell)) throw new Error("The app's page is from another release");
    const files = await Promise.all(shell.files.map(async (f) => {
      const res = await net(new Request(f, { credentials: "same-origin", signal: giveUp() }));
      if (!fileAnswered(res)) throw new Error(`${f} answered ${res.status} ${res.headers.get("content-type") || ""}`);
      return [f, res];
    }));
    const cache = await store.open(name);
    for (const [f, res] of files) await cache.put(f, res);
    await cache.put("/", page);
  } catch (e) {
    await store.delete(name);
    throw e;
  }
  const brand = await store.open(BRAND_CACHE);
  await Promise.all(BRAND_PATHS.map((p) => net(new Request(p, { cache: "no-cache", credentials: "same-origin", signal: giveUp() }))
    .then((res) => res.ok ? brand.put(p, res) : undefined, () => undefined)));
}

/** Deletes other builds' sets, when this build takes over. Only once its own is aside: until then an older set still
 *  starts the app (and goes when the next build takes over). */
async function clearStale(shell, store = caches) {
  if (!(await hasSet(shell, store))) return;
  await Promise.all(staleCaches(await store.keys(), shell).map((n) => store.delete(n)));
}

/** Puts the set aside if it isn't (an install that couldn't, say with a weak connection), one try at a time and at
 *  most every RETRY_SET_MS while the worker runs (the browser stops an idle worker, so after that, on the next start). */
let filling = null, lastFill = 0;
function fillIfMissing(shell, now = Date.now()) {
  if (filling || now - lastFill < RETRY_SET_MS) return filling || Promise.resolve();
  lastFill = now;
  filling = hasSet(shell).then((ok) => ok ? undefined : putAside(shell)).catch(() => undefined).finally(() => { filling = null; });
  return filling;
}

// --- the events ---

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Kumi", { body: d.body || "", tag: d.tag, data: { url: d.url || "/" }, icon: "/manifest/icon-192.png", badge: "/manifest/icon-192.png" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && "focus" in c) return c.navigate(url).then((w) => (w || c).focus());
    return self.clients.openWindow(url);
  }));
});

// With no set (the app run by Vite while developing), the worker only does notifications.
if (SHELL) {
  // A new build takes over once it has tried to put its set aside. Installing never fails on the set (notifications
  // wait for a worker, and must not hang on a weak connection): a set that couldn't go aside is tried again on a later
  // page load, and until it is, the old build's set (whole, with its own files) still starts the app offline. Pages
  // always come from the network first, so an open page of the old build keeps working.
  self.addEventListener("install", (event) => {
    lastFill = Date.now();
    event.waitUntil(putAside(SHELL).catch(() => undefined).then(() => self.skipWaiting()));
  });
  self.addEventListener("activate", (event) => { event.waitUntil(clearStale(SHELL).then(() => self.clients.claim())); });
  self.addEventListener("fetch", (event) => {
    const route = routeOf(event.request, self.location.origin, SHELL);
    if (route === "page") { event.respondWith(answerPage(event, SHELL)); event.waitUntil(fillIfMissing(SHELL)); }
    else if (route === "file") event.respondWith(answerFile(event, SHELL));
    else if (route === "brand") event.respondWith(answerBrand(event));
  });
}
