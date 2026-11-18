// What a game's card says, in English and Spanish (US and Latin American, with "tú"), through plugin.card_put. Each
// row is one line; the card's title ("Video and stats", "Video y estadísticas") comes from the manifest. Words from the
// vendor (a stat's own label) are cleaned to the club's rules: one line, no control characters, no em or en dashes.
import type { Stat, Words } from "./adapters/types.ts";

export interface Row { label: Words; text: Words }
export interface Card { tone: "ok" | "warn" | "off"; rows: Row[]; link?: { url: string; label: Words } }
export interface Clip { id: string; url: string; seconds: number | null; start: number }
export interface GameStats { id: string; url: string | null; stats: Stat[] }

export const CARD_ROWS = 6;
const n = (v: number, lang: "en" | "es", digits = 0) => new Intl.NumberFormat(lang === "en" ? "en-US" : "es-US", { maximumFractionDigits: digits }).format(v);
const both = (f: (l: "en" | "es") => string): Words => ({ en: f("en"), es: f("es") });

/** The stats openPadel has words for. A vendor's other stats bring their own label, in both languages. */
export const STATS: Record<string, { label: Words; text: (v: number, l: "en" | "es") => string }> = {
  rallies: { label: { en: "Rallies", es: "Peloteos" }, text: (v, l) => n(v, l) },
  longest_rally_shots: { label: { en: "Longest rally", es: "Peloteo más largo" }, text: (v, l) => (l === "en" ? `${n(v, l)} ${v === 1 ? "shot" : "shots"}` : `${n(v, l)} ${v === 1 ? "golpe" : "golpes"}`) },
  shots: { label: { en: "Shots", es: "Golpes" }, text: (v, l) => n(v, l) },
  smashes: { label: { en: "Smashes", es: "Remates" }, text: (v, l) => n(v, l) },
  winners: { label: { en: "Winners", es: "Golpes ganadores" }, text: (v, l) => n(v, l) },
  distance_m: { label: { en: "Distance run", es: "Distancia recorrida" }, text: (v, l) => (v >= 1000 ? `${n(v / 1000, l, 1)} km` : `${n(v, l)} m`) },
  top_speed_kmh: { label: { en: "Fastest shot", es: "Golpe más rápido" }, text: (v, l) => `${n(v, l)} km/h` },
  minutes_played: { label: { en: "Time played", es: "Tiempo de juego" }, text: (v, l) => `${n(v, l)} min` },
};

/** One line of the club's words: no control characters, no em or en dashes, at most `max` characters. */
export const clean = (s: string, max: number) => {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s*[–—]\s*/g, ", ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const cleanBoth = (w: Words, max: number): Words => ({ en: clean(w.en, max), es: clean(w.es, max) });

/** 0:45, 2:10, 1:02:03. */
export function length(seconds: number): string {
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function statRow(s: Stat): Row | null {
  const known = STATS[s.key];
  const label = s.label ? cleanBoth(s.label, 40) : known?.label;
  if (!label || !label.en || !label.es) return null;
  const text = typeof s.value === "number" ? (known ? both((l) => known.text(s.value as number, l)) : both((l) => n(s.value as number, l, 2))) : cleanBoth(s.value, 200);
  return text.en && text.es ? { label, text } : null;
}

/** A game's card: its clips (how many, how long), the game's stats, and a link to watch. */
export function cardFor(clips: Clip[], stats: GameStats | null): Card {
  const rows: Row[] = [];
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  if (sorted.length) {
    const total = sorted.reduce((t, c) => t + (c.seconds ?? 0), 0), known = sorted.every((c) => c.seconds !== null);
    const count = sorted.length;
    rows.push({ label: { en: "Highlights", es: "Jugadas destacadas" }, text: count === 1
      ? (known ? { en: `1 clip, ${length(total)}`, es: `1 video, ${length(total)}` } : { en: "1 clip", es: "1 video" })
      : (known ? { en: `${count} clips, ${length(total)} in all`, es: `${count} videos, ${length(total)} en total` } : { en: `${count} clips`, es: `${count} videos` }) });
  }
  for (const s of stats?.stats ?? []) {
    if (rows.length >= CARD_ROWS) break;
    const r = statRow(s);
    if (r) rows.push(r);
  }
  let link: Card["link"];
  if (sorted.length === 1) link = { url: sorted[0]!.url, label: { en: "Watch the highlight", es: "Ver la jugada destacada" } };
  else if (sorted.length > 1 && stats?.url) link = { url: stats.url, label: { en: "Watch the highlights", es: "Ver las jugadas destacadas" } };
  else if (sorted.length > 1) link = { url: sorted.at(-1)!.url, label: { en: "Watch the latest highlight", es: "Ver la última jugada destacada" } };
  else if (stats?.url) link = { url: stats.url, label: { en: "See the game's stats", es: "Ver las estadísticas del partido" } };
  if (!rows.length) rows.push({ label: { en: "Video", es: "Video" }, text: { en: "Ready at the camera system", es: "Listo en el sistema de cámaras" } });
  return { tone: "ok", rows, ...(link ? { link } : {}) };
}
