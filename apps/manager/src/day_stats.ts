// What the Schedule says about a day at a glance: the kind of each thing on the grid (its colour and the legend's
// words), and the day's occupancy and number of bookings.

/** What holds a court, as the Schedule colours it. */
export type Kind = "booking" | "open_match" | "learning" | "event" | "blocked" | "hold";
type GridItem = { start: string; end: string; kind: string; booking_id?: string; booking_kind?: string; open_match?: boolean; program_kind?: string | null; pt_type?: string | null };
type GridCourt = { id: string; open: { opens: string; closes: string } | null; items: GridItem[] };

/** Playtomic's booking types (playtomic.ts) as the grid's kinds: a Playtomic copy is coloured as what it is, with a
 *  mark saying it came from Playtomic. A type Playtomic adds later, or none, is a court booking. */
const PLAYTOMIC_KINDS: Record<string, Kind> = {
  REGULAR_BOOKING: "booking", RECURRING_BOOKING: "booking", OPEN_MATCH: "open_match", OPEN_PLAY: "open_match",
  PRIVATE_CLASS: "learning", COURSE_CLASS: "learning", PUBLIC_CLASS: "learning", TOURNAMENT: "event", LEAGUE_MATCH: "event",
};

/** Lessons, clinics and courses are for learning; socials, tournaments and leagues are events. A coach's view of
 *  someone else's booking says only "booked", so it is a court booking. */
export function kindOf(it: GridItem): Kind {
  if (it.kind === "hold") return "hold";
  if (it.kind === "block") return "blocked";
  if (it.kind === "mirror") return PLAYTOMIC_KINDS[it.pt_type ?? ""] ?? "booking";
  if (it.kind === "session") return it.program_kind === "clinic" || it.program_kind === "course" ? "learning" : "event";
  if (it.booking_kind === "lesson") return "learning";
  return it.open_match ? "open_match" : "booking";
}

const ms = (iso: string) => new Date(iso).getTime();

/** The day's occupancy and bookings, as the Reports page counts occupancy: court time taken by bookings, program
 *  dates and Playtomic copies, inside each court's own hours, over those hours less the time blocked. Checkouts still
 *  being paid for aren't counted. Bookings: court bookings and lessons (open matches among them) and Playtomic copies,
 *  each once. */
export function dayStats(courts: GridCourt[]): { percent: number; bookings: number } {
  let open = 0, blocked = 0, used = 0;
  const seen = new Set<string>();
  for (const c of courts) {
    if (c.open) {
      const from = ms(c.open.opens), to = ms(c.open.closes);
      open += to - from;
      for (const it of c.items) {
        const m = Math.max(0, Math.min(ms(it.end), to) - Math.max(ms(it.start), from));
        if (it.kind === "block") blocked += m;
        else if (it.kind === "booking" || it.kind === "session" || it.kind === "mirror") used += m;
      }
    }
    for (const it of c.items) if (it.kind === "booking" || it.kind === "mirror") seen.add(it.booking_id ?? `${c.id}|${it.start}`);
  }
  return { percent: open - blocked > 0 ? Math.min(100, Math.round((used / (open - blocked)) * 100)) : 0, bookings: seen.size };
}
