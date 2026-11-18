// When each court's lights should be on: from what holds the court (bookings, program dates, Playtomic's bookings) and
// the club's settings (minutes before and after). Pure: no clock, no network.

/** What the club's door says holds a court (the `day` read's items). */
export interface Held { start: string; end: string; kind: string; status?: string }
/** A stretch of time the lights are on, in milliseconds since 1970. */
export interface Window { start: number; end: number }

/** What lights a court: people playing on it. A block (maintenance, an event the club runs itself) or someone still
 *  paying for a court (a hold) doesn't; a hold that becomes a booking is a booking.created, and the club is read again. */
const LIT = new Set(["booking", "session", "mirror"]);
export const lights = (h: Held) => LIT.has(h.kind) && h.status !== "cancelled";

/** The windows the lights are on: each item from `before` minutes ahead of it to `after` minutes past it, joined where
 *  they meet or overlap, so back-to-back bookings keep the lights on between them. */
export function windows(items: Held[], beforeMin: number, afterMin: number): Window[] {
  const spans = items.filter(lights).map((h) => ({ start: Date.parse(h.start) - beforeMin * 60_000, end: Date.parse(h.end) + afterMin * 60_000 }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start).sort((a, b) => a.start - b.start);
  const out: Window[] = [];
  for (const w of spans) {
    const last = out.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/** Where a court stands at `now`: on (until when), or off (and when it's next on), and when its last window ended. */
export function at(ws: Window[], now: number): { on: boolean; until: number | null; next: number | null; lastEnded: number | null } {
  const cur = ws.find((w) => w.start <= now && now < w.end);
  const next = ws.find((w) => w.start > now)?.start ?? null;
  const lastEnded = ws.filter((w) => w.end <= now).at(-1)?.end ?? null;
  return { on: Boolean(cur), until: cur ? cur.end : null, next, lastEnded };
}

// ---- Settings ----
export interface Settings {
  homeAssistantUrl: string | null;
  /** The courts with lights, by id. */
  courts: string[];
  /** The `lights` setting: each court (by name, lowercased, or id) and its Home Assistant entities. */
  lightsFor: Map<string, string[]>;
  before: number;
  after: number;
}
export const DEFAULT_BEFORE = 10, DEFAULT_AFTER = 5;
const ENTITY = /^(light|switch)\.[a-z0-9_]{1,100}$/;
const clamp = (v: unknown, d: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 30 ? v : d;

/** The club's settings for this plugin, as plugin_settings and plugin.configured give them. Anything off is left out
 *  (an entity that isn't a light or a switch, a court map line that doesn't read): `problems` says what. */
export function parseSettings(raw: Record<string, unknown> | null | undefined): Settings & { problems: string[] } {
  const r = raw ?? {}, problems: string[] = [];
  let url: string | null = null;
  if (typeof r.home_assistant_url === "string" && r.home_assistant_url.trim()) {
    try {
      const u = new URL(r.home_assistant_url.trim());
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) url = u.toString().replace(/\/+$/, "");
      else problems.push("home_assistant_url isn't an http(s) address");
    } catch { problems.push("home_assistant_url isn't an address"); }
  }
  const courts = Array.isArray(r.courts) ? r.courts.filter((c): c is string => typeof c === "string") : [];
  const lightsFor = new Map<string, string[]>();
  if (typeof r.lights === "string") {
    for (const part of r.lights.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      const court = eq > 0 ? part.slice(0, eq).trim().toLowerCase() : "";
      const ents = eq > 0 ? part.slice(eq + 1).trim().split(/[\s+]+/).filter(Boolean) : [];
      if (!court || !ents.length || !ents.every((e) => ENTITY.test(e))) { problems.push(`lights: "${part.slice(0, 60)}" isn't "Court name = light.entity"`); continue; }
      lightsFor.set(court, ents);
    }
  }
  return { homeAssistantUrl: url, courts, lightsFor, before: clamp(r.minutes_before, DEFAULT_BEFORE), after: clamp(r.minutes_after, DEFAULT_AFTER), problems };
}

/** A court's Home Assistant entities: from the `lights` setting by its name or id, or else light.<its name> ("Court 1"
 *  is light.court_1). */
export function entitiesFor(court: { id: string; name: string }, s: Pick<Settings, "lightsFor">): string[] {
  const given = s.lightsFor.get(court.id.toLowerCase()) ?? s.lightsFor.get(court.name.trim().toLowerCase());
  if (given) return given;
  const slug = court.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  return slug ? [`light.${slug}`] : [];
}
