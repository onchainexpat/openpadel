// A coach's level check after a session (SessionLevels.tsx), its sums kept apart from the page so they're tested on
// their own: the −/+ 0.1 steps, which players a save changes, and the reasons offered as chips.

/** One step of 0.1 from what's typed (or from where they were, when nothing is), kept between their floor (or 0) and 7,
 *  to two decimals as the levels are. Nothing typed and no level yet: nothing to step from. */
export function stepLevel(typed: string, was: string | null, delta: number, floor: string | null): string {
  const from = typed.trim() !== "" && Number.isFinite(Number(typed)) ? Number(typed) : was !== null ? Number(was) : null;
  if (from === null) return typed;
  const low = floor !== null ? Number(floor) : 0;
  return Math.min(7, Math.max(low, Number((from + delta).toFixed(2)))).toFixed(2);
}

/** Whether a row's typed level is a change: a number from 0 to 7 that isn't the level they have (to two decimals). */
export function isChange(typed: string, was: string | null): boolean {
  if (typed.trim() === "") return false;
  const n = Number(typed);
  if (!Number.isFinite(n) || n < 0 || n > 7) return false;
  return was === null || n.toFixed(2) !== Number(was).toFixed(2);
}

/** The players a save would change, as the action takes them. */
export function changedRows(players: { person_id: string; level: string | null }[], typed: Record<string, string>) {
  return players.filter((p) => isChange(typed[p.person_id] ?? "", p.level)).map((p) => ({ person_id: p.person_id, level: Number(typed[p.person_id]) }));
}

/** The reasons a coach picks from (ui.level_reason_*); "other" is their own words. */
export const LEVEL_REASONS = ["assessment", "injury", "results", "other"] as const;
