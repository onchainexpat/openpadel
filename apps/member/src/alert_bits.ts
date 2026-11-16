// The pieces of the "tell me when" alerts and the category filter that need no Preact, so tests can read them
// (Alerts.tsx, Play.tsx, Programs.tsx, Book.tsx).

/** A club day's start times a court alert's window can use, as HH:MM in the location's time: every half hour from
 *  opening to the last start an hour before closing. Closed (or not known yet): none. */
export function windowTimes(open: { opens: string; closes: string } | null, tz: string): string[] {
  if (!open) return [];
  const hm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  const out: string[] = [], last = new Date(open.closes).getTime() - 60 * 60_000;
  for (let s = new Date(open.opens).getTime(); s <= last; s += 30 * 60_000) out.push(hm(s));
  return out;
}

/** Who a match or event is meant for: a label, never checked. Empty is open to all. */
export type Gender = "mixed" | "women" | "men" | "mixed_pairs";
/** The category filter on Play: nothing chosen shows everything; a category shows the ones marked with it. */
export const genderShown = (g: Gender | null | undefined, filter: Gender | "") => !filter || g === filter;
/** The filter's choices: only categories something in the list has, so a choice never empties the list. */
export const genderChoices = (rows: { gender?: Gender | null }[]): Gender[] =>
  (["mixed", "women", "men", "mixed_pairs"] as const).filter((g) => rows.some((r) => r.gender === g));
