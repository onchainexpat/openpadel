// The apps' start screens and first-sign-in welcome (manifest.ts, launch_art.ts, greetDue): the phone's start screen
// and icons in the club's name and colour, drawn again when they change and not before; the iPhone start screens the
// apps ask for, and no others; and the short welcome played once per person in each app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { STARTUP, MARK_PT, bootCss, manifest, sameTag } from "../src/manifest.ts";
import { drawPng, initials, markSvg } from "../src/launch_art.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer();
const root = new URL("../../..", import.meta.url).pathname;
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => { const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

/** A PNG's width, height and the colour of one pixel (RGB, unfiltered rows as drawPng writes them). */
function pixel(png: Buffer, x: number, y: number) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let o = 8, idat: Buffer[] = [];
  while (o < png.length) { const len = png.readUInt32BE(o), type = png.toString("latin1", o + 4, o + 8); if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat)), at = y * (w * 3 + 1) + 1 + x * 3;
  return { w, h, rgb: `#${[raw[at]!, raw[at + 1]!, raw[at + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}` };
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  await run(db, "club.update", { brand_colour: "#1D4ED8" }, owner);
  await run(db, "person.create", { display_name: "Ivy Moss", email: "ivy@example.test" }, owner);
});
after(async () => drop());

test("each app's manifest is in the club's name and colour, with plain and maskable icons named for the brand", async () => {
  const m = await (await get("/manifest/member.webmanifest")).json() as any, s = await (await get("/manifest/staff.webmanifest")).json() as any;
  assert.equal(m.name, "Kestrel Padel"); assert.equal(s.name, "Kestrel Padel Staff");
  for (const j of [m, s]) {
    assert.equal(j.theme_color, "#1d4ed8"); assert.equal(j.background_color, "#1d4ed8", "Android's start screen is the club's colour");
    assert.equal(j.display, "standalone");
    assert.deepEqual(j.icons.map((i: any) => `${i.sizes} ${i.purpose}`), ["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]);
    for (const i of j.icons) assert.match(i.src, /^\/manifest\/icon-(maskable-)?\d+\.png\?v=[0-9a-f]{12}$/);
  }
  assert.equal(manifest({ name: "Riverside Racquet Club", colour: "#000000", lang: "en", v: "x" }, "member").short_name, "Riverside", "a long name is shortened under the icon");
});

test("icons and start screens: the club's colour round its mark, in the sizes asked for, and none other", async () => {
  for (const [file, size] of [["icon-180", 180], ["icon-192", 192], ["icon-512", 512], ["icon-maskable-192", 192], ["icon-maskable-512", 512]] as const) {
    const r = await get(`/manifest/${file}.png`), png = await bytes(r);
    assert.equal(r.headers.get("content-type"), "image/png");
    const corner = pixel(png, 0, 0);
    assert.deepEqual([corner.w, corner.h, corner.rgb], [size, size, "#1d4ed8"]);
  }
  for (const s of STARTUP) {
    const png = await bytes(await get(`/manifest/startup/${s.w * s.dpr}x${s.h * s.dpr}.png`));
    const p = pixel(png, 2, 2);
    assert.deepEqual([p.w, p.h, p.rgb], [s.w * s.dpr, s.h * s.dpr, "#1d4ed8"]);
  }
  assert.equal((await get("/manifest/startup/4000x9000.png")).status, 404, "only the sizes the apps ask for are drawn");
  assert.equal((await get("/manifest/startup/12x12.png")).status, 404);
});

test("drawn once per brand: the same answer is 'not changed', and a new colour or name draws new ones under new addresses", async () => {
  const first = await get("/manifest/icon-512.png"), tag = first.headers.get("etag")!, before = await bytes(first);
  assert.match(first.headers.get("cache-control")!, /max-age=\d+/);
  assert.equal((await get("/manifest/icon-512.png", { "if-none-match": tag })).status, 304);
  // As Caddy's compression can send it back: weak, or with the encoding added.
  assert.equal((await get("/manifest/icon-512.png", { "if-none-match": `W/${tag.replace(/"$/, '-gzip"')}` })).status, 304);
  assert.equal(sameTag('"other", W/"abc-zstd"', '"abc"'), true); assert.equal(sameTag(undefined, '"abc"'), false); assert.equal(sameTag('"abd"', '"abc"'), false);
  const v1 = (await (await get("/manifest/member.webmanifest")).json() as any).icons[0].src;

  await run(db, "club.update", { brand_colour: "#F5C518" }, owner);
  const second = await get("/manifest/icon-512.png", { "if-none-match": tag });
  assert.equal(second.status, 200, "a phone with the old icon gets the new one");
  const after = await bytes(second);
  assert.notDeepEqual(after, before);
  assert.equal(pixel(after, 0, 0).rgb, "#f5c518");
  assert.notEqual(second.headers.get("etag"), tag);
  const v2 = (await (await get("/manifest/member.webmanifest")).json() as any).icons[0].src;
  assert.notEqual(v2, v1, "the manifest names the new icons, so phones fetch them");

  await run(db, "club.update", { name: "Harbor Padel" }, owner);
  assert.notEqual((await (await get("/manifest/member.webmanifest")).json() as any).icons[0].src, v2, "a new name is a new mark");
  assert.match(await (await get("/manifest/mark.svg")).text(), /stroke="#111111"/, "dark letters on a yellow");
  await run(db, "club.update", { name: "Kestrel Padel", brand_colour: "#1D4ED8" }, owner);
});

test("the start screen's stylesheet: the club's colour, the text colour that reads on it, and its name kept a plain string", async () => {
  const css = await (await get("/manifest/boot.css")).text();
  assert.match(css, /--boot-bg:#1d4ed8;--boot-ink:#ffffff/);
  assert.match(css, /\.boot-name:empty::before\{content:"Kestrel Padel"\}/);
  assert.match(css, /Still loading/);
  const odd = bootCss({ name: 'Cancha "Sur"}</style> ñ', colour: "#F5C518", lang: "es" });
  assert.ok(!odd.includes('"Sur"') && !odd.includes("}</style>"), "quotes and braces in a name are escaped");
  assert.match(odd, /--boot-ink:#111111/);
  assert.match(odd, /Sigue cargando/, "in the club's own language until the app knows the reader's");
});

test("the mark: initials past the generic words, accents dropped, and a ball when there are no letters to draw", () => {
  assert.equal(initials("Kestrel Padel"), "K");
  assert.equal(initials("Riverside Racquet Club"), "RR");
  assert.equal(initials("Club de Pádel Ñandú Norte"), "NN");
  assert.equal(initials("Padel Club"), "PC", "only generic words: their own letters");
  assert.equal(initials("パデル"), "");
  assert.match(markSvg("パデル", "#fff"), /<circle/);
  assert.match(markSvg("Kestrel Padel", "#fff"), /<path d="M/);
  // The letters sit in the middle of the start screen's mark box, in the ink colour, and leave the rest the colour.
  const png = drawPng(MARK_PT, MARK_PT, "#000000", "#ffffff", "H", { size: MARK_PT, cx: MARK_PT / 2, cy: MARK_PT / 2, fit: "maskable" });
  assert.equal(pixel(png, MARK_PT / 2, MARK_PT / 2).rgb, "#ffffff", "the H's bar crosses the middle");
  assert.equal(pixel(png, 4, MARK_PT / 2).rgb, "#000000");
});

test("both apps ask for every iPhone start screen drawn, and have the start screen and the status bar's tags", () => {
  const want = STARTUP.map((s) => `(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait)" href="/manifest/startup/${s.w * s.dpr}x${s.h * s.dpr}.png"`);
  for (const a of ["member", "manager"]) {
    const html = readFileSync(`${root}apps/${a}/index.html`, "utf8");
    const links = [...html.matchAll(/rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]}" href="${m[2]}"`);
    assert.deepEqual(links.sort(), [...want].sort(), `${a}: the startup images`);
    for (const tag of ['rel="apple-touch-icon" href="/manifest/icon-180.png"', 'name="apple-mobile-web-app-status-bar-style"', 'name="apple-mobile-web-app-capable"',
      'href="/manifest/boot.css"', 'id="boot"', 'src="/manifest/mark.png"', 'class="boot-retry"']) assert.ok(html.includes(tag), `${a}: ${tag}`);
    assert.ok(!/<script(?![^>]*type="module")/.test(html), `${a}: no inline script (the apps' security policy allows none)`);
    assert.equal([...html.matchAll(/<script/g)].length, 1, `${a}: one script, the app's own`);
    assert.ok(!/name="theme-color"/.test(html), `${a}: no fixed status bar colour (the manifest's, then applyBrand's)`);
  }
});

test("the short welcome plays once per person in each app: the staff app's only for staff, and never again once played", async () => {
  const ivy = await signIn("ivy@example.test");
  let me = (await call("/me", ivy)).json;
  assert.equal(me.greet_member, true, "a first sign-in");
  assert.equal(me.greet_staff, false, "not staff");
  assert.deepEqual((await call("/me/greeted", ivy, { app: "member" })).json, { first: true });
  assert.deepEqual((await call("/me/greeted", ivy, { app: "member" })).json, { first: false });
  me = (await call("/me", ivy)).json;
  assert.equal(me.greet_member, false, "played, never again");
  // On another phone too: it's kept on the person.
  const again = await signIn("ivy@example.test");
  assert.equal((await call("/me", again)).json.greet_member, false);

  const robin = await signIn("robin@example.test");
  me = (await call("/me", robin)).json;
  assert.equal(me.greet_staff, true); assert.equal(me.greet_member, true);
  await call("/me/greeted", robin, { app: "staff" });
  me = (await call("/me", robin)).json;
  assert.equal(me.greet_staff, false); assert.equal(me.greet_member, true, "each app's own");
  assert.equal((await call("/me/greeted", robin, { app: "elsewhere" })).status, 400);
  assert.equal((await app.request("/me/greeted", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "member" }) })).status, 401);
});

test("a mid-tone neither text reads on is darkened just enough, the same everywhere the apps fill with it", () => {
  const b = { name: "Kestrel Padel", colour: "#777777", lang: "en" as const, v: "x" };
  const m = manifest(b, "member"), css = bootCss(b), fill = m.background_color as string;
  assert.notEqual(fill, "#777777");
  assert.equal(m.theme_color, fill);
  assert.ok(css.includes(`--boot-bg:${fill};--boot-ink:#ffffff`));
});
