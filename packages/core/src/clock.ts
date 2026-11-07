// Clock time in a club's time zone (house rule 5: never the server's). Dates as "2026-11-07" and times as
// "07:30" or "24:00" are what a club means; these turn them into instants and back, across clock changes.

// One formatter per time zone, kept: making one costs about 60 µs, and a report or a desk's day reads the clock
// thousands of times (atLocal three times a call). A club has a zone or two.
const partsFormats = new Map<string, Intl.DateTimeFormat>();
function partsFormat(tz: string): Intl.DateTimeFormat {
  let f = partsFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    if (partsFormats.size >= 64) partsFormats.clear();
    partsFormats.set(tz, f);
  }
  return f;
}

/** What the clock in `tz` shows at `d`. */
export function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(partsFormat(tz).formatToParts(d).map((x) => [x.type, x.type === "weekday" ? x.value : Number(x.value)]));
  return { y: p.year as number, m: p.month as number, d: p.day as number, h: p.hour as number, min: p.minute as number, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday as string) };
}

/** The instant the clock in `tz` shows that local date and time. In a spring-forward gap it lands just after. */
export function atLocal(y: number, m: number, d: number, h: number, tz: string, min = 0): Date {
  const want = Date.UTC(y, m - 1, d, h, min);
  let guess = want;
  for (let i = 0; i < 3; i++) { const p = localParts(new Date(guess), tz); guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - want; }
  return new Date(guess);
}

/** "2026-11-07" at "07:30" (or "24:00", the end of that day) in `tz`. */
export function onDate(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number], [h, min] = time.split(":").map(Number) as [number, number];
  return h === 24 ? atLocal(y, m, d + 1, 0, tz, min) : atLocal(y, m, d, h, tz, min);
}

/** The club's date ("2026-11-07") at an instant. */
export function localDate(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** The weekday of a club date, 0 for Sunday. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
