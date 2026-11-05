// The club's wall clock and exact moments, both ways, for a given IANA zone: what staff type into a date and
// time box is the club's clock, whatever zone the device is set to (state.ts: clubMoment, clubLocal).

/** How far the zone's clock is ahead of UTC at a moment (ms). */
function zoneAhead(ms: number, zone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-06T17:00" on the zone's clock, as the exact moment (ISO, UTC); "" when it isn't a date and time. A time
 *  the clocks skip (spring forward) comes out an hour later; one they pass twice (fall back) is the first. */
export function wallToMoment(local: string, zone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return "";
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  const first = wall - zoneAhead(wall, zone), second = wall - zoneAhead(first, zone);
  // Where the two guesses differ the clocks change near here: of those whose wall time is the one asked for, the
  // first; when neither is (a skipped time), the later.
  const target = local.slice(0, 16), fits = [first, second].filter((c) => momentToWall(c, zone) === target);
  const at = fits.length ? Math.min(...fits) : Math.max(first, second);
  return new Date(at).toISOString();
}

/** A moment as the zone's clock shows it, the way a date and time box takes it ("2026-11-06T17:00"). */
export function momentToWall(at: string | number | Date, zone: string): string {
  const ms = new Date(at).getTime();
  return new Date(ms + zoneAhead(ms, zone)).toISOString().slice(0, 16);
}
