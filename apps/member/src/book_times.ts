// The start times Book shows for a day (Book.tsx): every half hour from when the club opens until the last start
// that ends by closing, and any court's own start besides, from now on. The ones no court is free at are shown
// struck through, so a member sees the day's shape, not only the gaps. No Preact here: the tests read it.

const STEP = 30 * 60_000;   // the server's half-hourly starts (bookings.ts, STEP_MINUTES)

type Free = { open: { opens: string; closes: string } | null; courts: { starts: string[] }[] };

/** Every start time of the day as ISO strings, soonest first: the club's half hours, and the courts' own starts. */
export function startTimes(free: Free, minutes: number, now: number): string[] {
  const all = new Set(free.courts.flatMap((c) => c.starts));
  if (free.open) {
    const len = minutes * 60_000, closes = new Date(free.open.closes).getTime();
    for (let s = new Date(free.open.opens).getTime(); s + len <= closes; s += STEP) if (s >= now) all.add(new Date(s).toISOString());
  }
  return [...all].sort();
}
