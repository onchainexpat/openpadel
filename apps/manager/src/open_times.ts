// The times the Today forms offer: only when a court is open that day (its own hours, which can differ from the
// location's), so nothing on a form is a time the server would refuse as closed.
type Open = { opens: string; closes: string } | null;
const HALF = 30 * 60_000;
const ms = (iso: string) => new Date(iso).getTime();

/** Every half hour a court is open that day, as instants, from its opening to its closing. None when it's closed. */
export function courtSlots(open: Open): string[] {
  const out: string[] = [];
  if (open) for (let s = ms(open.opens); s <= ms(open.closes); s += HALF) out.push(new Date(s).toISOString());
  return out;
}

/** Several courts' hours as one span: the earliest opening to the latest closing; null when every one is closed. */
export function spanOfCourts(courts: { open: Open }[]): Open {
  const open = courts.map((c) => c.open).filter((o): o is { opens: string; closes: string } => Boolean(o));
  if (!open.length) return null;
  return { opens: open.map((o) => o.opens).sort((a, b) => ms(a) - ms(b))[0]!, closes: open.map((o) => o.closes).sort((a, b) => ms(b) - ms(a))[0]! };
}

/** The desk's lengths that fit from a start before `until` (the court closing, or the next thing on it), shortest
 *  first (90 minutes is still the one chosen when it fits: DeskBooking). */
export function lengthsFitting(start: string, until: string, lengths = [30, 60, 90, 120, 150, 180]): number[] {
  return start ? lengths.filter((m) => ms(start) + m * 60_000 <= ms(until)) : [];
}
