// How a match or a class fits the member's level, for the tags on Play and Learn: a great fit in the middle of its
// level band, a good fit anywhere in it, a step up below it, below your level above it. Honest when there's no level
// (none set yet) or no band (open to all levels): no tag at all. Each fit's words are ui.fit_<fit>, its look
// tag.fit-<fit> in member.css. No Preact here: the tests read it.

export type Fit = "great" | "good" | "step_up" | "below";

/** The fit of a band (`min` to `max`) for a level. The middle half of the band is a great fit; a band narrower than
 *  half a level is a great fit all through. */
export function fitOf(level: number | null | undefined, min: string | number | null | undefined, max: string | number | null | undefined): Fit | null {
  if (level === null || level === undefined || min === null || min === undefined || max === null || max === undefined) return null;
  const lo = Number(min), hi = Number(max);
  if (!Number.isFinite(level) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  if (level < lo) return "step_up";
  if (level > hi) return "below";
  const w = hi - lo, edge = w < 0.5 ? 0 : w / 4;
  return level >= lo + edge && level <= hi - edge ? "great" : "good";
}
