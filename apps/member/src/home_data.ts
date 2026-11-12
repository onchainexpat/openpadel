// What Home makes of the reads it already has (Home.tsx): the member's own coming bookings and places, soonest
// first, and how many of each kind of thing is on at the club in the next two weeks. No Preact here: the tests read it.

type Booking = { id: string; kind: string; status: string; pay_mode: string; players: number; start: string; end: string; court: string; time_zone: string; coach: string | null;
  open_match_id: string | null; joined: number; for_name: string | null };
type Place = { id: string; status: string; waitlist_position: number | null; name: string; first_start: string | null; offer_expires_at: string | null; for_name: string | null };

export type Upcoming = { key: string; start: string; tz: string | null; kind: "court" | "match" | "lesson" | "program"; name: string; court: string | null; coach: string | null;
  state: "in" | "held" | "waitlist" | "offer"; position: number | null; joined: { count: number; total: number } | null; for_name: string | null; href: string };

const LIMIT = 10;

/** The member's (and their juniors') bookings and places still to come, soonest first: a booking until it ends. */
export function comingUp(bookings: Booking[], places: Place[], now: number): Upcoming[] {
  const b: Upcoming[] = bookings.filter((x) => new Date(x.end).getTime() > now).map((x) => ({
    key: `b${x.id}`, start: x.start, tz: x.time_zone, kind: x.kind === "lesson" ? "lesson" : x.open_match_id ? "match" : "court", name: "", court: x.court, coach: x.coach,
    state: x.status === "held" ? "held" : "in", position: null, joined: x.pay_mode === "split" ? { count: x.joined, total: x.players } : null, for_name: x.for_name,
    // A match (or any court booking that's confirmed) has its own page; the rest are on My places.
    href: x.open_match_id ? `/match/${x.open_match_id}` : x.kind === "court" && x.status === "confirmed" ? `/match/${x.id}` : "/places",
  }));
  const p: Upcoming[] = places.filter((x) => x.first_start && new Date(x.first_start).getTime() > now).map((x) => ({
    key: `p${x.id}`, start: x.first_start!, tz: null, kind: "program", name: x.name, court: null, coach: null,
    state: x.offer_expires_at ? "offer" : x.status === "waitlisted" ? "waitlist" : "in", position: x.waitlist_position, joined: null, for_name: x.for_name, href: "/places",
  }));
  return [...b, ...p].sort((x, y) => new Date(x.start).getTime() - new Date(y.start).getTime()).slice(0, LIMIT);
}

type Program = { kind: string; first_start: string | null };
type Match = { start: string; open: boolean; cancelled: boolean; listed: boolean; spots_left: number; is_match: boolean };
/** Learning is clinics and courses; tournaments, leagues and socials are events. */
export const LEARN_KINDS = ["clinic", "course"];
const DAYS = 14;

/** What's on in the next 14 days, by kind: open matches with a place left, events, clinics, and courses starting. */
export function soonCounts(programs: Program[], matches: Match[], now: number) {
  const soon = (iso: string | null) => { if (!iso) return false; const t = new Date(iso).getTime(); return t > now && t <= now + DAYS * 86_400_000; };
  const next = programs.filter((p) => soon(p.first_start));
  return {
    matches: matches.filter((m) => m.is_match && m.open && m.listed && !m.cancelled && m.spots_left > 0 && soon(m.start)).length,
    events: next.filter((p) => !LEARN_KINDS.includes(p.kind)).length,
    clinics: next.filter((p) => p.kind === "clinic").length,
    courses: next.filter((p) => p.kind === "course").length,
  };
}
