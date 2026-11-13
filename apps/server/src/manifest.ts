// What lets a phone install the apps and open them on the club's own start screen, all in the club's name and colour:
// a web app manifest for each app (Android draws its start screen from its colours and icons), icons with the club's
// mark (launch_art.ts: its initials, or a ball), iPhone start screens for the common sizes, the mark as SVG, and a
// small stylesheet with the club's colour and name for the start screen each app shows while it loads (index.html).
// Images are drawn once per brand and kept: a new name or colour gives new ones, under new addresses in the manifest.
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Db } from "@kumi/core";
import { t, type Lang } from "@kumi/i18n";
import { brandColours } from "@kumi/ui/brand";
import { drawPng, markSvg } from "./launch_art.ts";

/** The club's colour as the apps fill with it (their --brand: darkened only where no text would read on it), and the
 *  text colour that reads on that (their --on-brand), from the same helper (brand.ts). */
export const fillOf = (colour: string) => brandColours(colour)?.fill ?? colour;
export const inkOn = (colour: string) => brandColours(colour)?.onBrand ?? "#ffffff";

/** iPhone start screens (portrait), as the apps' index.html asks for them: the screen in points, its pixel ratio, and
 *  the status bar's height, so the mark sits where the app's own start screen puts it (the middle of the page below
 *  the bar). A test keeps this list and the apps' links the same. */
export const STARTUP: readonly { w: number; h: number; dpr: number; bar: number }[] = [
  { w: 440, h: 956, dpr: 3, bar: 62 }, { w: 430, h: 932, dpr: 3, bar: 59 }, { w: 402, h: 874, dpr: 3, bar: 62 }, { w: 393, h: 852, dpr: 3, bar: 59 },
  { w: 428, h: 926, dpr: 3, bar: 47 }, { w: 390, h: 844, dpr: 3, bar: 47 }, { w: 414, h: 896, dpr: 3, bar: 44 }, { w: 375, h: 812, dpr: 3, bar: 44 },
  { w: 414, h: 896, dpr: 2, bar: 48 }, { w: 375, h: 667, dpr: 2, bar: 20 }, { w: 320, h: 568, dpr: 2, bar: 20 },
];
/** How wide the mark is on a start screen, in points (CSS pixels): the same in the apps' start screen. */
export const MARK_PT = 192;
const ICONS = { "icon-180": { size: 180, fit: "any" }, "icon-192": { size: 192, fit: "any" }, "icon-512": { size: 512, fit: "any" },
  "icon-maskable-192": { size: 192, fit: "maskable" }, "icon-maskable-512": { size: 512, fit: "maskable" } } as const;

type Brand = { name: string; colour: string; lang: Lang; v: string };
/** A name and colour's own tag: it names the images drawn for them, so a change gives new ones. */
export const brandTag = (name: string, colour: string) => createHash("sha256").update(`${name}\n${colour.toLowerCase()}`).digest("hex").slice(0, 12);

export function manifestRoutes(db: Db) {
  const app = new Hono();
  const brand = async (): Promise<Brand> => {
    const k = await db.selectFrom("club").select(["name", "brand_colour", "default_language"]).executeTakeFirstOrThrow();
    return { name: k.name, colour: k.brand_colour, lang: (k.default_language === "es" ? "es" : "en"), v: brandTag(k.name, k.brand_colour) };
  };
  // Drawn images for the last two brands (a request that read the brand just before a change can still be finishing),
  // at most 16 images each, a few MB in all.
  const drawn = new Map<string, Buffer>(), tags: string[] = [];
  const image = (b: Brand, key: string, make: () => Buffer) => {
    if (!tags.includes(b.v)) {
      tags.push(b.v);
      while (tags.length > 2) { const old = tags.shift()!; for (const k of drawn.keys()) if (k.startsWith(`${old}/`)) drawn.delete(k); }
    }
    let png = drawn.get(`${b.v}/${key}`);
    if (!png) { png = make(); if (tags.includes(b.v)) drawn.set(`${b.v}/${key}`, png); }
    return png;
  };
  /** Answers with what's drawn for this brand, or "not changed" to a phone that already has it. */
  const send = (c: Context, b: Brand, type: string, body: string | Buffer, maxAge = 86_400) => {
    const etag = `"${b.v}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}"`;
    // A day fresh, and up to a month while a newer one is fetched behind it: a slow connection never waits on these.
    c.header("cache-control", `public, max-age=${maxAge}, stale-while-revalidate=2592000`); c.header("etag", etag);
    if (sameTag(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    c.header("content-type", type);
    return c.body(typeof body === "string" ? body : new Uint8Array(body));
  };
  for (const which of ["member", "staff"] as const) {
    app.get(`/manifest/${which}.webmanifest`, async (c) => {
      const b = await brand();
      return send(c, b, "application/manifest+json", JSON.stringify(manifest(b, which)), 3600);
    });
  }
  for (const [file, { size, fit }] of Object.entries(ICONS)) {
    app.get(`/manifest/${file}.png`, async (c) => {
      const b = await brand();
      return send(c, b, "image/png", image(b, file, () => drawPng(size, size, fillOf(b.colour), inkOn(b.colour), b.name, { size, cx: size / 2, cy: size / 2, fit })));
    });
  }
  app.get("/manifest/startup/:file{[0-9]+x[0-9]+\\.png}", async (c) => {
    const [w, h] = c.req.param("file").replace(".png", "").split("x").map(Number) as [number, number];
    const s = STARTUP.find((x) => x.w * x.dpr === w && x.h * x.dpr === h);
    if (!s) return c.json({ error: "error.not_found" }, 404);
    const b = await brand(), d = s.dpr;
    return send(c, b, "image/png", image(b, `startup-${w}x${h}`, () =>
      drawPng(w, h, fillOf(b.colour), inkOn(b.colour), b.name, { size: MARK_PT * d, cx: w / 2, cy: ((s.h + s.bar) / 2) * d, fit: "maskable" })));
  });
  app.get("/manifest/mark.svg", async (c) => { const b = await brand(); return send(c, b, "image/svg+xml", markSvg(b.name, inkOn(b.colour))); });
  // The start screen's colour and words, read before the app's first paint (index.html), so it opens in the club's colour.
  app.get("/manifest/boot.css", async (c) => { const b = await brand(); return send(c, b, "text/css; charset=utf-8", bootCss(b), 3600); });
  return app;
}

/** Whether a phone's If-None-Match names this tag. Caddy's compression can mark it weak (W/) or add the encoding
 *  ("abc-gzip"), so those are read as the same tag. */
export const sameTag = (header: string | undefined, etag: string) => {
  const plain = (x: string) => x.trim().replace(/^W\//, "").replace(/-(gzip|zstd|br)"$/, '"');
  return Boolean(header) && header!.split(",").some((x) => x.trim() === "*" || plain(x) === plain(etag));
};

/** One app's web app manifest. The start screen Android draws is its background colour with its icon. */
export function manifest(b: { name: string; colour: string; lang: Lang; v: string }, which: "member" | "staff") {
  const name = which === "staff" ? `${b.name} Staff` : b.name;
  const icon = (file: string, size: number, purpose: string) => ({ src: `/manifest/${file}.png?v=${b.v}`, sizes: `${size}x${size}`, type: "image/png", purpose });
  return {
    name, short_name: name.length > 12 && which === "member" ? name.split(/\s+/)[0] : name, lang: b.lang,
    start_url: "/", scope: "/", display: "standalone", background_color: fillOf(b.colour), theme_color: fillOf(b.colour),
    icons: [icon("icon-192", 192, "any"), icon("icon-512", 512, "any"), icon("icon-maskable-192", 192, "maskable"), icon("icon-maskable-512", 512, "maskable")],
  };
}

/** A CSS string: every character outside plain ASCII letters, digits and spaces escaped, so a name can't end it. */
const cssString = (s: string) => `"${[...s].map((ch) => /[A-Za-z0-9 ]/.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16)} `).join("")}"`;

/** The start screen's stylesheet: the club's colour and the colour that reads on it, its name, and (in the club's own
 *  language, until the app knows the reader's) what a slow start says. The app fills the words in once it runs. */
export function bootCss(b: { name: string; colour: string; lang: Lang }): string {
  return [
    `:root{--boot-bg:${fillOf(b.colour)};--boot-ink:${inkOn(b.colour)}}`,
    `.boot-name:empty::before{content:${cssString(b.name)}}`,
    `.boot-late-text:empty::before{content:${cssString(t(b.lang, "ui.boot_slow"))}}`,
    `.boot-retry:empty::before{content:${cssString(t(b.lang, "ui.try_again"))}}`,
  ].join("\n") + "\n";
}
