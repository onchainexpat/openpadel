// A small QR code encoder, for the link an authenticator app reads: byte mode, error correction level M,
// versions 1 to 10 (up to 213 bytes). It follows ISO/IEC 18004 the way Project Nayuki's reference encoder
// does; qr.test.ts checks it module for module against an independent encoder.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // level M, by version
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const QR_MAX_VERSION = 10;

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree: number): number[] {
  const r: number[] = Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j]!, root); if (j + 1 < r.length) r[j]! ^= r[j + 1]!; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data: number[], div: number[]): number[] {
  const r: number[] = div.map(() => 0);
  for (const b of data) { const f = b ^ r.shift()!; r.push(0); div.forEach((c, i) => { r[i]! ^= gfMul(c, f); }); }
  return r;
}

function alignment(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

/** The modules (true is dark), without the quiet zone. `mask` fixes the mask; otherwise the best is chosen. */
export function qrMatrix(text: string, mask?: number): boolean[][] {
  const bytes = [...Buffer.from(text, "utf8")];
  let ver = 1;
  while (ver <= QR_MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > QR_MAX_VERSION) throw new Error("too long for a QR code here");
  // The bits: byte mode, the length, the bytes, then the end and the padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length)); put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  // Error correction per block, then interleaved.
  const nBlocks = BLOCKS[ver]!, eccLen = ECC_PER_BLOCK[ver]!, raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks), shortLen = Math.floor(raw / nBlocks), div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]!); });

  const size = ver * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { m[y]![x] = dark; fn[y]![x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const)
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  const al = alignment(ver), last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mk: number) => {
    let rem = mk;   // level M's two bits are 00
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((mk << 10) | rem) ^ 0x5412, bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
  }
  // The codewords, two columns at a time, up and down.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y]![x] && i < all.length * 8) { m[y]![x] = ((all[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
  const masked = (mk: number) => {
    const r = m.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const inv = [(x + y) % 2, y % 2, x % 3, (x + y) % 3, (Math.floor(x / 3) + Math.floor(y / 2)) % 2, ((x * y) % 2) + ((x * y) % 3), (((x * y) % 2) + ((x * y) % 3)) % 2, (((x + y) % 2) + ((x * y) % 3)) % 2][mk] === 0;
      if (!fn[y]![x] && inv) r[y]![x] = !r[y]![x];
    }
    // The format bits for this mask go on top.
    const keep = m.map((row) => row.slice());
    format(mk);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (fn[y]![x]) r[y]![x] = m[y]![x]!;
    for (let y = 0; y < size; y++) m[y] = keep[y]!;
    return r;
  };
  if (mask !== undefined) return masked(mask);
  let best: boolean[][] = [], bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) { const r = masked(mk), s = penalty(r); if (s < bestScore) { best = r; bestScore = s; } }
  return best;
}

/** The standard's penalty: long runs, 2x2 blocks, finder-like patterns, and dark far from half. */
function penalty(m: boolean[][]): number {
  const size = m.length, lines: string[] = [];
  for (let y = 0; y < size; y++) lines.push(m[y]!.map((d) => (d ? "1" : "0")).join(""));
  for (let x = 0; x < size; x++) lines.push(m.map((row) => (row[x] ? "1" : "0")).join(""));
  let s = 0;
  for (const l of lines) {
    for (const run of l.match(/0{5,}|1{5,}/g) ?? []) s += run.length - 2;
    for (const p of ["10111010000", "00001011101"]) for (let i = l.indexOf(p); i >= 0; i = l.indexOf(p, i + 1)) s += 40;
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y]![x];
    if (m[y]![x + 1] === c && m[y + 1]![x] === c && m[y + 1]![x + 1] === c) s += 3;
  }
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0), total = size * size;
  s += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return s;
}

/** An SVG of the code with a four-module quiet zone, to show as an image. */
export function qrSvg(text: string): string {
  const m = qrMatrix(text), n = m.length + 8;
  let path = "";
  m.forEach((row, y) => row.forEach((d, x) => { if (d) path += `M${x + 4},${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
