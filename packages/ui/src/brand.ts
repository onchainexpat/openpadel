// The club's colour, made readable: a tint of it for text and outlines that reads at 4.5:1 (WCAG AA) on each
// theme's background and cards, and the text colour that reads on it as a fill. No DOM here (applyBrand in state.ts).
const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const lum = (c: number[]) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
/** The colour moved toward white (or black) just far enough to read at 4.5:1 on every background given. */
function readable(c: number[], on: number[][], toward: number[]) {
  for (let t = 0; t <= 1; t += 0.02) {
    const m = c.map((v, i) => Math.round(v + (toward[i]! - v) * t));
    if (on.every((b) => contrast(m, b) >= 4.5)) return `rgb(${m.join(" ")})`;
  }
  return `rgb(${toward.join(" ")})`;
}
/** The tints for a club colour (#rrggbb): text and outlines on the light theme and on the dark one, and text on the colour. */
export function brandColours(colour: string): { inkLight: string; inkDark: string; onBrand: string } | null {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return null;
  const c = rgb(colour), white = [255, 255, 255], black = [0, 0, 0];
  return { inkLight: readable(c, [rgb("#f6f6f2"), white], black), inkDark: readable(c, [rgb("#121715"), rgb("#1b2220")], white), onBrand: contrast(white, c) >= 4.5 ? "#ffffff" : "#111111" };
}
/** For tests: how far apart two colours read (WCAG's contrast ratio). */
export const contrastOf = (a: string, b: string) => contrast(a.startsWith("#") ? rgb(a) : a.match(/\d+/g)!.map(Number), b.startsWith("#") ? rgb(b) : b.match(/\d+/g)!.map(Number));
