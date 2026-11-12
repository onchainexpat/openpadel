// The club's opening hours as Home shows them (Home.tsx), from /my/club: the week with days of the same hours
// together ("Mon to Fri", "Sat, Sun"), and today's, a special day's hours first. No Preact here: the tests read it.

export type Hours = { weekday: number; opens: string | null; closes: string | null };
export type Special = { on_date: string; opens: string | null; closes: string | null };

const ORDER = [1, 2, 3, 4, 5, 6, 0];   // Monday first

/** A clock time ("07:00", "24:00") in the reader's language: "7:00 AM", "07:00". Midnight at the end of a day stays 24:00. */
export function clock(hm: string, locale: string): string {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  if (h >= 24) return hm.slice(0, 5);
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5, h, m)));
}

/** A weekday's short name (0 is Sunday). */
export function dayName(w: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
}

/** The week in lines: next-door days with the same hours share one ("Mon to Fri" once there are three or more).
 *  `to` joins two days or two times ("to", "a"), `closed` is a closed day. */
export function weekLines(days: Hours[], locale: string, words: { to: string; closed: string }): { days: string; hours: string }[] {
  const text = (d: Hours | undefined) => (d?.opens && d.closes ? `${clock(d.opens, locale)} ${words.to} ${clock(d.closes, locale)}` : words.closed);
  const groups: { days: number[]; hours: string }[] = [];
  for (const w of ORDER) {
    const hours = text(days.find((d) => d.weekday === w)), last = groups.at(-1);
    if (last && last.hours === hours) last.days.push(w); else groups.push({ days: [w], hours });
  }
  const span = (ds: number[]) => ds.length > 2 ? `${dayName(ds[0]!, locale)} ${words.to} ${dayName(ds.at(-1)!, locale)}` : ds.map((w) => dayName(w, locale)).join(", ");
  return groups.map((g) => ({ days: span(g.days), hours: g.hours }));
}

/** Today's hours (the club's date, YYYY-MM-DD): a special day's when there is one, else the weekday's. Null when closed. */
export function hoursOn(date: string, days: Hours[], special: Special[]): { opens: string; closes: string } | null {
  const s = special.find((x) => x.on_date === date);
  const d = s ?? days.find((x) => x.weekday === new Date(`${date}T12:00:00Z`).getUTCDay());
  return d?.opens && d.closes ? { opens: d.opens, closes: d.closes } : null;
}
