// The club's mark, drawn without fonts or image libraries: one or two capital letters from its name, as plain strokes
// with round ends, on its colour. The same strokes make the SVG the apps show while they start (mark.svg) and the
// PNG icons and iPhone start screens (manifest.ts), so what the phone shows and what the app shows next line up.
// Letters only cover A to Z and 0 to 9 (accents are dropped first); a name with none of them gets a white ball.
import { deflateSync, crc32 } from "node:zlib";

type Pt = [number, number];
type Line = Pt[];

/** Points along an ellipse, from angle a0 to a1 in degrees (0 is right, 90 is down), smooth enough for an icon. */
const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Line => {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 8)), out: Line = [];
  for (let i = 0; i <= n; i++) { const a = ((a0 + (a1 - a0) * i / n) * Math.PI) / 180; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
};
const cat = (...parts: Line[]): Line => parts.flat();

/** Each glyph: its width and its strokes, on a grid 10 high (0 the top of a capital, 10 its foot). */
const GLYPHS: Record<string, { w: number; s: Line[] }> = {
  A: { w: 7, s: [[[0, 10], [3.5, 0], [7, 10]], [[1.3, 6.4], [5.7, 6.4]]] },
  B: { w: 7, s: [cat([[0, 10], [0, 0], [3.8, 0]], arc(3.8, 2.5, 2.6, 2.5, -90, 90), [[0, 5], [4.3, 5]], arc(4.3, 7.5, 2.7, 2.5, -90, 90), [[0, 10]])] },
  C: { w: 8.6, s: [arc(5, 5, 5, 5, -45, -315)] },
  D: { w: 8, s: [cat([[3, 0], [0, 0], [0, 10], [3, 10]], arc(3, 5, 5, 5, 90, -90))] },
  E: { w: 6.5, s: [[[6.5, 0], [0, 0], [0, 10], [6.5, 10]], [[0, 5], [5.2, 5]]] },
  F: { w: 6.5, s: [[[6.5, 0], [0, 0], [0, 10]], [[0, 5], [5.2, 5]]] },
  G: { w: 10, s: [cat(arc(5, 5, 5, 5, -45, -360), [[5.6, 5]])] },
  H: { w: 7, s: [[[0, 0], [0, 10]], [[7, 0], [7, 10]], [[0, 5], [7, 5]]] },
  I: { w: 0, s: [[[0, 0], [0, 10]]] },
  J: { w: 6, s: [cat([[6, 0], [6, 7]], arc(3, 7, 3, 3, 0, 180))] },
  K: { w: 7, s: [[[0, 0], [0, 10]], [[7, 0], [0, 6.5]], [[2.4, 4.4], [7, 10]]] },
  L: { w: 6.2, s: [[[0, 0], [0, 10], [6.2, 10]]] },
  M: { w: 9, s: [[[0, 10], [0, 0], [4.5, 7], [9, 0], [9, 10]]] },
  N: { w: 7.5, s: [[[0, 10], [0, 0], [7.5, 10], [7.5, 0]]] },
  O: { w: 10, s: [arc(5, 5, 5, 5, 0, 360)] },
  P: { w: 6.8, s: [cat([[0, 10], [0, 0], [4, 0]], arc(4, 2.75, 2.8, 2.75, -90, 90), [[0, 5.5]])] },
  Q: { w: 10, s: [arc(5, 5, 5, 5, 0, 360), [[6.2, 7], [10, 10.4]]] },
  R: { w: 7, s: [cat([[0, 10], [0, 0], [4, 0]], arc(4, 2.75, 2.8, 2.75, -90, 90), [[0, 5.5]]), [[3.6, 5.5], [7, 10]]] },
  S: { w: 7, s: [cat(arc(3.5, 2.5, 3.3, 2.5, -15, -270), arc(3.5, 7.5, 3.5, 2.5, -90, 165))] },
  T: { w: 8, s: [[[0, 0], [8, 0]], [[4, 0], [4, 10]]] },
  U: { w: 7, s: [cat([[0, 0], [0, 6.5]], arc(3.5, 6.5, 3.5, 3.5, 180, 0), [[7, 0]])] },
  V: { w: 7.6, s: [[[0, 0], [3.8, 10], [7.6, 0]]] },
  W: { w: 10.4, s: [[[0, 0], [2.6, 10], [5.2, 2.6], [7.8, 10], [10.4, 0]]] },
  X: { w: 7, s: [[[0, 0], [7, 10]], [[7, 0], [0, 10]]] },
  Y: { w: 7.6, s: [[[0, 0], [3.8, 5.2], [7.6, 0]], [[3.8, 5.2], [3.8, 10]]] },
  Z: { w: 7, s: [[[0, 0], [7, 0], [0, 10], [7, 10]]] },
  "0": { w: 7, s: [arc(3.5, 5, 3.5, 5, 0, 360)] },
  "1": { w: 3.4, s: [[[0, 2.2], [3.4, 0], [3.4, 10]]] },
  "2": { w: 7, s: [cat(arc(3.5, 3.3, 3.4, 3.3, -165, 30), [[0, 10], [7, 10]])] },
  "3": { w: 7, s: [cat(arc(3.4, 2.5, 3.2, 2.5, -160, 90), arc(3.4, 7.5, 3.6, 2.5, -90, 160))] },
  "4": { w: 7.4, s: [[[5.4, 10], [5.4, 0], [0, 7], [7.4, 7]]] },
  "5": { w: 7, s: [cat([[6.5, 0], [1, 0], [0.5, 4.8]], arc(3.6, 7, 3.4, 3, -140, 150))] },
  "6": { w: 7, s: [arc(3.5, 6.6, 3.5, 3.4, 0, 360), arc(7, 6.6, 6.9, 6.6, 180, 250)] },
  "7": { w: 7, s: [[[0, 0], [7, 0], [2.4, 10]]] },
  "8": { w: 7, s: [arc(3.5, 2.5, 3, 2.5, 0, 360), arc(3.5, 7.5, 3.5, 2.5, 0, 360)] },
  "9": { w: 7, s: [arc(3.5, 3.4, 3.5, 3.4, 0, 360), arc(0, 3.4, 6.9, 6.6, 0, 70)] },
};

/** Words that say what a club is rather than which one, passed over for its letters while another word is left. */
const GENERIC = new Set(["PADEL", "CLUB", "CLUBE", "CLUBS", "THE", "DE", "DEL", "LA", "EL", "LOS", "LAS", "AND", "Y", "E", "OF", "TENNIS", "TENIS",
  "SPORTS", "SPORT", "CENTER", "CENTRE", "CENTRO", "ACADEMY", "ACADEMIA", "COURTS", "COURT", "STAFF"]);

/** The letters of a club's mark: the first letters of its first two words that aren't generic ones, else its first. */
export function initials(name: string): string {
  const words = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const own = words.filter((w) => !GENERIC.has(w));
  return (own.length ? own : words).slice(0, 2).map((w) => w[0]!).join("");
}

/** Where things sit in a square box `size` wide: the letters' strokes (in the box's own units) and their half-width.
 *  `fit` is the share of the box the letters may take: smaller for a maskable icon, which a phone crops to a circle. */
function layout(letters: string, size: number, fit: "any" | "maskable") {
  const gs = [...letters].map((ch) => GLYPHS[ch]!).filter(Boolean);
  if (!gs.length) return null;
  const gap = 3.2, w = gs.reduce((n, g) => n + g.w, 0) + gap * (gs.length - 1);
  // Letters 10 units high; the box allows so much height and so much width, whichever is tighter.
  const [hMax, wMax] = fit === "maskable" ? [0.34, 0.56] : [0.42, 0.66];
  const k = Math.min((hMax * size) / 10, (wMax * size) / Math.max(w, 1));
  const x0 = (size - w * k) / 2, y0 = (size - 10 * k) / 2, lines: Line[] = [];
  let x = x0;
  for (const g of gs) { for (const s of g.s) lines.push(s.map(([px, py]) => [x + px * k, y0 + py * k] as Pt)); x += (g.w + gap) * k; }
  return { lines, half: 0.85 * k };
}

/** The mark as SVG: the letters on a transparent square (the page or the image behind gives the colour), or a ball. */
export function markSvg(name: string, ink: string): string {
  const L = layout(initials(name), 100, "maskable");
  const body = L
    ? `<g fill="none" stroke="${ink}" stroke-width="${(2 * L.half).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${
      L.lines.map((l) => `<path d="M${l.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}"/>`).join("")}</g>`
    : `<circle cx="50" cy="50" r="22" fill="${ink}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${body}</svg>`;
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

/** Distance from p to the segment a-b. */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** An opaque PNG `w` by `h` of the colour `bg`, with the mark drawn in `ink` in a square `box` wide centred on (cx, cy).
 *  Only the mark's own pixels are worked out; the rest is the colour, row by row. */
export function drawPng(w: number, h: number, bg: string, ink: string, name: string, box: { size: number; cx: number; cy: number; fit: "any" | "maskable" }): Buffer {
  const [r, g, b] = hex(bg), [ir, ig, ib] = hex(ink), stride = w * 3 + 1, raw = Buffer.alloc(stride * h);
  // Every row the colour, then the mark over it.
  const row = Buffer.alloc(stride); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  for (let y = 0; y < h; y++) row.copy(raw, y * stride);
  const ox = box.cx - box.size / 2, oy = box.cy - box.size / 2, L = layout(initials(name), box.size, box.fit);
  const cover = new Float32Array(w * h);
  const paint = (x0: number, y0: number, x1: number, y1: number, at: (x: number, y: number) => number) => {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w - 1, Math.ceil(x1)); x++) {
        const c = at(x + 0.5, y + 0.5); if (c > cover[y * w + x]!) cover[y * w + x] = c;
      }
  };
  if (L) {
    for (const l of L.lines) for (let i = 1; i < l.length; i++) {
      const [ax, ay] = [l[i - 1]![0] + ox, l[i - 1]![1] + oy], [bx, by] = [l[i]![0] + ox, l[i]![1] + oy], m = L.half + 1;
      paint(Math.min(ax, bx) - m, Math.min(ay, by) - m, Math.max(ax, bx) + m, Math.max(ay, by) + m,
        (x, y) => Math.max(0, Math.min(1, L.half - toSegment(x, y, ax, ay, bx, by) + 0.5)));
    }
  } else {
    const rad = box.size * 0.22, cx = box.cx, cy = box.cy;
    paint(cx - rad - 1, cy - rad - 1, cx + rad + 1, cy + rad + 1, (x, y) => Math.max(0, Math.min(1, rad - Math.hypot(x - cx, y - cy) + 0.5)));
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cover[y * w + x]!; if (!c) continue;
    const o = y * stride + 1 + x * 3;
    raw[o] = Math.round(r + (ir - r) * c); raw[o + 1] = Math.round(g + (ig - g) * c); raw[o + 2] = Math.round(b + (ib - b) * c);
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
