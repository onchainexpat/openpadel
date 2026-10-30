// What lets a phone install the apps to its home screen: a web app manifest for each, in the club's
// name and brand color, and icons drawn in that color (a white ball) until the club uploads a logo.
import { deflateSync, crc32 } from "node:zlib";
import { Hono } from "hono";
import type { Db } from "@kumi/core";

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

/** A square PNG of the club's color with a white ball in the middle, smoothed at its edge. */
export function iconPng(size: number, colour: string): Buffer {
  const [r, g, b] = hex(colour), raw = Buffer.alloc((size * 4 + 1) * size), c = (size - 1) / 2, radius = size * 0.3;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // no filter on this row
    for (let x = 0; x < size; x++) {
      const inside = Math.max(0, Math.min(1, radius - Math.hypot(x - c, y - c) + 0.5));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(r + (255 - r) * inside); raw[o + 1] = Math.round(g + (255 - g) * inside); raw[o + 2] = Math.round(b + (255 - b) * inside); raw[o + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const SIZES = [180, 192, 512] as const;

export function manifestRoutes(db: Db) {
  const app = new Hono();
  const club = () => db.selectFrom("club").select(["name", "brand_colour", "default_language"]).executeTakeFirstOrThrow();
  for (const which of ["member", "staff"] as const) {
    app.get(`/manifest/${which}.webmanifest`, async (c) => {
      const k = await club(), name = which === "staff" ? `${k.name} Staff` : k.name;
      c.header("content-type", "application/manifest+json"); c.header("cache-control", "public, max-age=3600");
      return c.body(JSON.stringify({
        name, short_name: name.length > 12 && which === "member" ? name.split(/\s+/)[0] : name, lang: k.default_language,
        start_url: "/", scope: "/", display: "standalone", background_color: "#f6f6f2", theme_color: k.brand_colour,
        icons: [192, 512].map((s) => ({ src: `/manifest/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "any maskable" })),
      }));
    });
  }
  for (const s of SIZES) {
    app.get(`/manifest/icon-${s}.png`, async (c) => {
      c.header("content-type", "image/png"); c.header("cache-control", "public, max-age=3600");
      return c.body(new Uint8Array(iconPng(s, (await club()).brand_colour)));
    });
  }
  return app;
}
