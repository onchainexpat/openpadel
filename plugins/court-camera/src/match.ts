// Which court a camera films, and which booking a clip belongs to. Pure: no clock, no network.
import { createHmac } from "node:crypto";

/** What the club's door says holds a court (the `day` read's items). */
export interface Held { start: string; end: string; kind: string; status?: string; booking_id?: string }

/** A clip may start this long before its booking does (the camera starts early) and be matched to it. */
export const EARLY_MS = 5 * 60_000;
/** And this long after it ends (the last point, the players walking off). Past that, the court was someone else's or
 *  nobody's. */
export const LATE_MS = 15 * 60_000;

/** Only a booking gets a card: a program date (a clinic) has no players' page to show it on, a Playtomic copy is
 *  Playtomic's, and a block or a hold has nobody playing. */
const isGame = (h: Held) => h.kind === "booking" && h.status !== "cancelled" && typeof h.booking_id === "string";

/** The id the cameras know a booking by: the booking's own id, keyed with the plugin's secret, so the vendor learns
 *  nothing it could look up at the club. The same booking always gets the same one. */
export const sessionId = (key: string, bookingId: string) => `ses_${createHmac("sha256", key).update(bookingId).digest("hex").slice(0, 32)}`;

/** The booking a clip belongs to: the one whose session the vendor sent back, else the one on the court when it
 *  happened (`at`), allowing EARLY_MS before and LATE_MS after. Between two back-to-back bookings, the one it falls
 *  inside wins, then the nearest. Null: the court was empty then. */
export function matchBooking(items: Held[], at: number, o: { session?: string | null; key?: string } = {}): string | null {
  const games = items.filter(isGame);
  if (o.session && o.key) {
    const s = games.find((h) => sessionId(o.key!, h.booking_id!) === o.session);
    if (s) return s.booking_id!;
  }
  let best: { id: string; off: number } | null = null;
  for (const h of games) {
    const a = Date.parse(h.start), b = Date.parse(h.end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || at < a - EARLY_MS || at > b + LATE_MS) continue;
    const off = at < a ? a - at : at >= b ? at - b + 1 : 0;
    if (!best || off < best.off) best = { id: h.booking_id!, off };
  }
  return best?.id ?? null;
}

/** The middle of what a notice covers: what it's matched by. */
export const momentOf = (start: number, end: number | null) => (end !== null && end > start ? start + Math.floor((end - start) / 2) : start);

// ---- Settings ----
export interface Settings {
  /** The courts with cameras, by id. */
  courts: string[];
  /** The `cameras` setting: each court (its name, lowercased, or its id) and its camera's id at the vendor. */
  camerasFor: Map<string, string>;
  vendorUrl: string | null;
  tell: boolean;
}
const CAMERA = /^[A-Za-z0-9._:-]{1,100}$/;

/** The club's settings for this plugin, as plugin_settings and plugin.configured give them. Anything off is left out,
 *  and `problems` says what. */
export function parseSettings(raw: Record<string, unknown> | null | undefined): Settings & { problems: string[] } {
  const r = raw ?? {}, problems: string[] = [];
  let vendorUrl: string | null = null;
  if (typeof r.vendor_url === "string" && r.vendor_url.trim()) {
    try {
      const u = new URL(r.vendor_url.trim());
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) vendorUrl = u.toString().replace(/\/+$/, "");
      else problems.push("vendor_url isn't an http(s) address");
    } catch { problems.push("vendor_url isn't an address"); }
  }
  const courts = Array.isArray(r.courts) ? r.courts.filter((c): c is string => typeof c === "string") : [];
  const camerasFor = new Map<string, string>();
  if (typeof r.cameras === "string") {
    for (const part of r.cameras.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      const court = eq > 0 ? part.slice(0, eq).trim().toLowerCase() : "", cam = eq > 0 ? part.slice(eq + 1).trim() : "";
      if (!court || !CAMERA.test(cam)) { problems.push(`cameras: "${part.slice(0, 60)}" isn't "Court name = camera id"`); continue; }
      camerasFor.set(court, cam);
    }
  }
  return { courts, camerasFor, vendorUrl, tell: r.tell_cameras === true, problems };
}

/** A court's camera: from the `cameras` setting by its name or id, or else its name as an id ("Court 1" is court_1). */
export function cameraFor(court: { id: string; name: string }, s: Pick<Settings, "camerasFor">): string | null {
  const given = s.camerasFor.get(court.id.toLowerCase()) ?? s.camerasFor.get(court.name.trim().toLowerCase());
  if (given) return given;
  const slug = court.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  return slug || null;
}
