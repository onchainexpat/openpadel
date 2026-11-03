// What both apps say at the top of the page, and in place of a button that can't work now. Plain logic, kept
// apart from the components so the tests can run it.
/** Why nothing new can be booked, joined or paid for here (read_only.ts), or null when it can. Moved comes first:
 *  a club that moved is read-only here too, and the new address is where to go. */
export function whyNothingNew(club: { read_only?: boolean; moved?: boolean } | null | undefined): "moved" | "read_only" | null {
  if (club?.moved) return "moved";
  return club?.read_only ? "read_only" : null;
}

/** The notices to show, in order: on a phone, the first, and how many more there are until they're opened. */
export function noticesShown<T>(items: (T | null | undefined | false | "")[], open: boolean, phone: boolean): { shown: T[]; more: number } {
  const all = items.filter(Boolean) as T[];
  if (open || !phone || all.length < 2) return { shown: all, more: 0 };
  return { shown: all.slice(0, 1), more: all.length - 1 };
}
