// The club's own logo, in place of the mark drawn from its name (the server's launch_art.ts). The owner gives an SVG,
// PNG or JPEG; what's kept is never that file. It's checked, then drawn here as a PNG (transparent where the logo
// is, its empty margins trimmed, at most 1024 px a side), and every image the apps and phones get is made from that
// PNG: icons, start screens, the start screen and welcome in the apps, the headers. An SVG never reaches a browser.
//
// Drawing is resvg, compiled to WebAssembly: it runs no scripts, has no network and no files, and fetches nothing an
// SVG points at. On top of that an SVG is refused unless it's only shapes (svgProblem): no scripts, no embedded
// pages or HTML, no event handlers, no links to anything outside the file, no CSS imports, no entities. What's checked
// is exactly what's drawn (comments taken out first).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { crc32, deflateSync } from "node:zlib";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { contrastOf } from "@kumi/ui/brand";
import { KumiError } from "./errors.ts";

/** The largest file taken, and the most pixels a side for a PNG or JPEG (an SVG has no pixels until it's drawn). */
export const LOGO_MAX_BYTES = 1_000_000;
export const LOGO_MAX_PX = 2048;
export const LOGO_MIN_PX = 32;
/** The longest side of the PNG that's kept. A start screen shows the logo at most 576 px wide. */
export const LOGO_KEEP_PX = 1024;
/** The tiles a logo sits on where it wouldn't read on the club's colour: near-black for a light logo, white for a dark one. */
export const DARK_TILE = "#121715", LIGHT_TILE = "#ffffff";

export type LogoKind = "svg" | "png" | "jpeg";
/** The logo as kept (club_logo): the PNG and what was read from it. */
export interface Logo { png: Buffer; width: number; height: number; ink: string; backed: string | null; seems_for: "light" | "dark"; source_sha256: string }

let ready: Promise<void> | null = null;
/** resvg's WebAssembly, loaded once, the first time a logo is drawn. */
function wasm(): Promise<void> {
  ready ??= initWasm(readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")));
  return ready;
}

/** What a file's first bytes say it is. WebP isn't taken: the drawing library can't read it. */
export function logoKind(b: Buffer): LogoKind | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  const head = b.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
  // An SVG: after any XML declaration, comments and doctype, the first element is <svg.
  if (/^\s*(<\?[^>]*\?>\s*)*(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*)*<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** A PNG's or JPEG's size in pixels, from its header, without decoding it. */
export function rasterSize(b: Buffer, kind: "png" | "jpeg"): { width: number; height: number } | null {
  if (kind === "png") return b.length >= 24 && b.toString("latin1", 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  // JPEG: walk the segments to the frame header (SOF0 to SOF15, not DHT, JPG or DAC).
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1]!;
    if (m === 0xff) { o++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    o += 2 + b.readUInt16BE(o + 2);
  }
  return null;
}

// ---- Checking an SVG ----
/** SVG elements a logo may have: shapes, paint, grouping, reuse within the file, clipping, masks and filters. */
const ALLOWED = new Set(["svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "lineargradient",
  "radialgradient", "stop", "clippath", "mask", "pattern", "marker", "image", "style", "title", "desc", "metadata", "switch", "filter", "feblend",
  "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix", "fediffuselighting", "fedisplacementmap", "fedistantlight",
  "fedropshadow", "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "feimage", "femerge", "femergenode", "femorphology",
  "feoffset", "fepointlight", "fespecularlighting", "fespotlight", "fetile", "feturbulence"]);
/** Never, under any prefix: what runs, embeds a page or animates (an animation can set a link). */
const NEVER = new Set(["script", "foreignobject", "iframe", "object", "embed", "html", "body", "handler", "listener", "animate", "animatemotion",
  "animatetransform", "animatecolor", "set", "audio", "video", "a", "link", "meta", "base"]);
const TEXT = new Set(["text", "tspan", "textpath", "tref", "font", "font-face", "glyph"]);
const SVG_NS = "http://www.w3.org/2000/svg";

/** Why an SVG isn't taken, in a few words for the owner, or null when it's only shapes. `text` means it has text in
 *  it (which would draw differently, or not at all, without the font). Comments must already be out (svgText). */
export function svgProblem(svg: string): "text" | string | null {
  if (/<!ENTITY/i.test(svg) || /<!DOCTYPE[^>]*\[/i.test(svg)) return "<!ENTITY>";
  if (/<\?xml-stylesheet/i.test(svg)) return "<?xml-stylesheet?>";
  if (/@import/i.test(svg)) return "@import";
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(svg) || /vbscript:/i.test(svg)) return "javascript:";
  // Namespaces: an element with a prefix bound to SVG is an SVG element; one bound to XHTML would be a page.
  if (/xmlns(:[\w.-]+)?\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/i.test(svg)) return "XHTML";
  const svgPrefixes = new Set([...svg.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)].filter((m) => m[2] === SVG_NS).map((m) => m[1]!.toLowerCase()));
  let text = false;
  for (const m of svg.matchAll(/<\s*([A-Za-z_][\w.:-]*)/g)) {
    const full = m[1]!.toLowerCase(), [prefix, local] = full.includes(":") ? full.split(":", 2) as [string, string] : [null, full];
    if (NEVER.has(local)) return `<${m[1]}>`;
    // Elements in other namespaces (an editor's own notes: sodipodi:, inkscape:, rdf:) aren't drawn.
    if (prefix !== null && !svgPrefixes.has(prefix)) continue;
    if (TEXT.has(local)) { text = true; continue; }
    if (!ALLOWED.has(local)) return `<${m[1]}>`;
  }
  // Attributes, read across the whole file (so a ">" inside a quoted value can't hide one): no event handlers, no
  // character references in values, and links only within the file or to an embedded PNG or JPEG.
  for (const m of svg.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g)) {
    const name = m[1]!.toLowerCase(), local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name, value = m[2]!.slice(1, -1).trim();
    if (local.startsWith("on")) return `${m[1]}=`;
    if (/&#/.test(value)) return `${m[1]}=`;
    if (name === "xml:base") return "xml:base";
    if ((local === "href" || local === "src") && !/^#[\w.:-]*$/.test(value)) {
      const embedded = value.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!embedded) return `${m[1]}="${value.slice(0, 40)}"`;
      // A picture inside the SVG is held to a picture's own limits: a small file can say it's huge.
      const b = Buffer.from(embedded[2]!, "base64"), size = rasterSize(b, embedded[1]!.toLowerCase() === "png" ? "png" : "jpeg");
      if (!size || Math.max(size.width, size.height) > LOGO_MAX_PX) return `<image> ${size ? `${size.width}x${size.height}` : "?"}`;
    }
  }
  // url() in attributes and styles: only to something in the file (a gradient, a clip path).
  for (const m of svg.matchAll(/url\s*\(\s*(['"]?)\s*([^)'"]*)/gi)) if (!m[2]!.startsWith("#")) return `url(${m[2]!.slice(0, 40)})`;
  return text ? "text" : null;
}

/** The SVG as it's checked and drawn: UTF-8, without its byte-order mark or comments. */
export const svgText = (b: Buffer) => b.toString("utf8").replace(/^﻿/, "").replace(/<!--[\s\S]*?-->/g, "");

// ---- Drawing ----
/** Draws an SVG to RGBA pixels, and lets go of resvg's memory after. */
function render(svg: string, fit?: { mode: "width" | "height"; value: number }): { w: number; h: number; px: Uint8Array } {
  const r = new Resvg(svg, { font: { loadSystemFonts: false }, ...(fit ? { fitTo: fit } : {}) });
  try {
    const img = r.render();
    try {
      // resvg gives colours premultiplied by their alpha: back to plain RGBA, or every soft edge would come out dark.
      const px = img.pixels.slice();
      for (let o = 0; o < px.length; o += 4) {
        const a = px[o + 3]!;
        if (a && a < 255) for (let i = 0; i < 3; i++) px[o + i] = Math.min(255, Math.round((px[o + i]! * 255) / a));
      }
      return { w: img.width, h: img.height, px };
    } finally { img.free(); }
  } finally { r.free(); }
}
const dataUri = (type: string, b: Uint8Array) => `data:${type};base64,${Buffer.from(b).toString("base64")}`;
/** An SVG that's only a picture, drawn at w by h. */
const pictureSvg = (uri: string, w: number, h: number) =>
  `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="${uri}"/></svg>`;

/** A PNG of RGBA pixels (or RGB, three bytes a pixel), deflated, each row with whichever of PNG's filters makes it
 *  smallest (the usual guess: the least sum of differences), so a detailed logo still comes out small. */
export function encodePng(w: number, h: number, px: Uint8Array, channels: 3 | 4 = 4): Buffer {
  const rowLen = w * channels, stride = rowLen + 1, raw = Buffer.alloc(stride * h), tries = Array.from({ length: 5 }, () => Buffer.alloc(rowLen));
  for (let y = 0; y < h; y++) {
    const cur = px.subarray(y * rowLen, (y + 1) * rowLen), up = y ? px.subarray((y - 1) * rowLen, y * rowLen) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = tries[f]!; let sum = 0;
      for (let i = 0; i < rowLen; i++) {
        const a = i >= channels ? cur[i - channels]! : 0, b = up ? up[i]! : 0, c = up && i >= channels ? up[i - channels]! : 0;
        let pred = 0;
        if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (cur[i]! - pred) & 255; out[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * stride] = best; tries[best]!.copy(raw, y * stride + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The box round what shows (alpha over a hint), or null for an empty picture. */
function shownBox(w: number, h: number, px: Uint8Array) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]! > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function crop(w: number, px: Uint8Array, b: { x: number; y: number; w: number; h: number }): Uint8Array {
  const out = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) out.set(px.subarray(((b.y + y) * w + b.x) * 4, ((b.y + y) * w + b.x + b.w) * 4), y * b.w * 4);
  return out;
}
const hexOf = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** What a logo looks like: its own background colour if it has one (it's opaque all round its edge), the colour it's
 *  drawn in (weighted by how much shows; for a backed logo, the parts that stand off the background), and so the
 *  background it seems made for: a light logo for a dark one. */
export function readLook(w: number, h: number, px: Uint8Array): { ink: string; backed: string | null; seems_for: "light" | "dark" } {
  const at = (x: number, y: number) => (y * w + x) * 4;
  let edge = [0, 0, 0], n = 0, opaque = true;
  const ring = (x: number, y: number) => { const o = at(x, y); if (px[o + 3]! < 250) opaque = false; edge = edge.map((v, i) => v + px[o + i]!); n++; };
  for (let x = 0; x < w; x++) { ring(x, 0); ring(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { ring(0, y); ring(w - 1, y); }
  const backed = opaque ? edge.map((v) => v / n) : null;
  let sum = [0, 0, 0], weight = 0;
  for (let o = 0; o < px.length; o += 4) {
    const a = px[o + 3]! / 255, c = [px[o]!, px[o + 1]!, px[o + 2]!];
    if (a < 0.1) continue;
    if (backed && Math.hypot(c[0]! - backed[0]!, c[1]! - backed[1]!, c[2]! - backed[2]!) < 48) continue;
    sum = sum.map((v, i) => v + c[i]! * a); weight += a;
  }
  const ink = hexOf(weight ? sum.map((v) => v / weight) : backed ? backed.map((v) => 255 - v) : [0, 0, 0]);
  // For a backed logo, its background says what it's for; otherwise its colour does.
  const judged = backed ? hexOf(backed) : ink, lightThing = contrastOf(judged, "#000000") > contrastOf(judged, "#ffffff");
  return { ink, backed: backed ? hexOf(backed) : null, seems_for: backed ? (lightThing ? "light" : "dark") : (lightThing ? "dark" : "light") };
}

/** Checks a logo file and draws it as the PNG that's kept, or throws the reason in the owner's words. */
export async function readLogo(file: Buffer): Promise<Logo> {
  if (!file.length || file.length > LOGO_MAX_BYTES) throw new KumiError("error.logo_too_big", { kb: Math.round(LOGO_MAX_BYTES / 1000) });
  const kind = logoKind(file);
  if (!kind) throw new KumiError("error.logo_type");
  await wasm();
  let first: { w: number; h: number; px: Uint8Array };
  try {
    if (kind === "svg") {
      const svg = svgText(file), problem = svgProblem(svg);
      if (problem === "text") throw new KumiError("error.logo_svg_text");
      if (problem) throw new KumiError("error.logo_svg_unsafe", { what: problem });
      // Drawn up to twice the size kept, so trimming its margins still leaves enough pixels.
      const probe = new Resvg(svg, { font: { loadSystemFonts: false } }), [sw, sh] = [probe.width, probe.height]; probe.free();
      if (!(sw > 0 && sh > 0) || Math.max(sw, sh) / Math.min(sw, sh) > 20) throw new KumiError("error.logo_unreadable");
      first = render(svg, sw >= sh ? { mode: "width", value: LOGO_KEEP_PX * 2 } : { mode: "height", value: LOGO_KEEP_PX * 2 });
    } else {
      const size = rasterSize(file, kind);
      if (!size) throw new KumiError("error.logo_unreadable");
      const { width, height } = size;
      if (Math.max(width, height) > LOGO_MAX_PX || Math.min(width, height) < LOGO_MIN_PX) throw new KumiError("error.logo_px", { width, height, min: LOGO_MIN_PX, max: LOGO_MAX_PX });
      first = render(pictureSvg(dataUri(kind === "png" ? "image/png" : "image/jpeg", file), width, height));
    }
  } catch (e) {
    if (e instanceof KumiError) throw e;
    throw new KumiError("error.logo_unreadable");
  }
  const box = shownBox(first.w, first.h, first.px);
  if (!box) throw new KumiError("error.logo_empty");
  let w = box.w, h = box.h, px = crop(first.w, first.px, box);
  // Down to the size kept, by drawing the trimmed picture again at that size.
  const k = Math.min(1, LOGO_KEEP_PX / Math.max(w, h));
  if (k < 1) {
    const [tw, th] = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
    px = render(pictureSvg(dataUri("image/png", encodePng(w, h, px)), tw, th)).px; w = tw; h = th;
  }
  const png = encodePng(w, h, px);
  // What the database keeps at most (migration 117): only a very detailed picture comes near it.
  if (png.length > 4_000_000) throw new KumiError("error.logo_too_big", { kb: Math.round(LOGO_MAX_BYTES / 1000) });
  return { png, width: w, height: h, ...readLook(w, h, px), source_sha256: createHash("sha256").update(file).digest("hex") };
}

/** What the logo sits on: the club's colour when it reads there (a logo made for that side of light and dark, at 3:1,
 *  WCAG's line for graphics), otherwise a tile, near-black for a light logo and white for a dark one. A logo with its
 *  own background brings its own tile. Null: straight on the club's colour. */
export function logoTile(fill: string, logo: { ink: string; backed: string | null; seems_for: "light" | "dark" }, logoFor: "light" | "dark" | null): string | null {
  if (logo.backed) return logo.backed;
  const madeFor = logoFor ?? logo.seems_for, fillDark = contrastOf(fill, "#ffffff") >= contrastOf(fill, "#000000");
  if ((madeFor === "dark") === fillDark && contrastOf(logo.ink, fill) >= 3) return null;
  return madeFor === "dark" ? DARK_TILE : LIGHT_TILE;
}

/** A PNG w by h with the logo on it: `bg` all over (null: transparent), then, if there is one, a rounded `tile` the
 *  size of the box centred at (cx, cy), and the logo fitted inside the box (a share `fit` of it, less on a tile). */
export async function drawLogo(logo: { png: Buffer }, o: { w: number; h: number; bg: string | null; tile: string | null; box: { size: number; cx: number; cy: number }; fit: number }): Promise<Buffer> {
  await wasm();
  const { w, h, box } = o, s = box.size, inner = s * (o.tile ? Math.min(o.fit, 0.74) : o.fit), n = (v: number) => v.toFixed(2);
  const colour = (c: string) => { if (!/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`not a colour: ${c}`); return c; };
  const svg = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + (o.bg ? `<rect width="${w}" height="${h}" fill="${colour(o.bg)}"/>` : "")
    + (o.tile && o.tile !== o.bg ? `<rect x="${n(box.cx - s / 2)}" y="${n(box.cy - s / 2)}" width="${n(s)}" height="${n(s)}" rx="${n(s * 0.22)}" fill="${colour(o.tile)}"/>` : "")
    + `<image x="${n(box.cx - inner / 2)}" y="${n(box.cy - inner / 2)}" width="${n(inner)}" height="${n(inner)}" preserveAspectRatio="xMidYMid meet" xlink:href="${dataUri("image/png", logo.png)}"/></svg>`;
  const r = render(svg);
  return encodePng(r.w, r.h, r.px);
}

/** Any SVG of our own making (the drawn mark) as a PNG of `size` px a side, transparent round it. */
export async function svgToPng(svg: string, size: number): Promise<Buffer> {
  await wasm();
  const r = render(svg, { mode: "width", value: size });
  return encodePng(r.w, r.h, r.px);
}
