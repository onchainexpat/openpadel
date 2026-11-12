// What Play (open matches and events) and Learn (clinics, courses, private lessons) make of the reads they have:
// which kind goes where, the week of days to pick from, what's on a day, what still has a place. No Preact here:
// the tests read it.

/** Learning is clinics and courses, under Learn; every other kind (socials, tournaments, leagues) is an event, under Play. */
export const LEARN_KINDS = ["clinic", "course"];
export const isEvent = (kind: string) => !LEARN_KINDS.includes(kind);
/** The chips over the events: open play (socials, Americanos and the like), tournaments and leagues. */
export type EventChip = "all" | "social" | "tournament" | "league";
export const EVENT_CHIPS: EventChip[] = ["all", "social", "tournament", "league"];
export const onChip = (kind: string, chip: EventChip) => chip === "all" || kind === chip;

/** The days from `today` (YYYY-MM-DD), `n` of them. */
export function nextDays(today: string, n = 7): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + k); out.push(d.toISOString().slice(0, 10)); }
  return out;
}
/** The day (YYYY-MM-DD) a time falls on in a time zone. */
export const dayIn = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));

type ProgramLike = { first_start: string | null; capacity: number; booked: number; offered: number; per_date?: boolean;
  dates?: { starts_at: string; capacity: number; booked: number; offered: number }[] };
/** A program is on a day when it starts then, or (signed up per date) one of its dates is then. "" is any day. */
export function programOn(p: ProgramLike, day: string, tz: string): boolean {
  if (!day) return true;
  return p.dates ? p.dates.some((d) => dayIn(d.starts_at, tz) === day) : Boolean(p.first_start && dayIn(p.first_start, tz) === day);
}
/** Places nobody holds: for a program signed up per date, on any of its dates. */
export function programHasPlace(p: ProgramLike): boolean {
  return p.dates ? p.dates.some((d) => d.capacity - d.booked - d.offered > 0) : p.capacity - p.booked - p.offered > 0;
}

type MatchLike = { start: string; time_zone: string; open: boolean; cancelled: boolean; spots_left: number };
export const matchOn = (m: MatchLike, day: string) => !day || dayIn(m.start, m.time_zone) === day;
export const matchHasPlace = (m: MatchLike) => m.open && !m.cancelled && m.spots_left > 0;

/** Up to two letters for a name, for its round badge ("Maria Soto" is MS). */
export const initials = (name: string | null) => (name ?? "").trim().split(/\s+/).filter(Boolean).map((w) => w[0]!).join("").slice(0, 2).toUpperCase() || "?";

/** How many weeks a course runs, its first date to its last (a clock change in between doesn't make it another). */
export function weeksOf(first: string | null, last: string | null): number {
  if (!first || !last) return 1;
  return Math.max(1, Math.round((new Date(last).getTime() - new Date(first).getTime()) / (7 * 86_400_000)) + 1);
}

/** Home's 14-day counts (GET /my/whats-on/counts). */
export type SoonCounts = { matches: number; events: number; clinics: number; courses: number };
