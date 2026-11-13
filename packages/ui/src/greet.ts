// When the apps' short welcome plays (Greeting.tsx) and how long, and whether the person asked for less motion: plain
// functions, with no page or app state, so tests can hold them to it.

/** Whether the person asked their phone for less motion: the start screen and the welcomes keep still (or just fade). */
export const lessMotion = (mm: ((q: string) => { matches: boolean }) | undefined = typeof matchMedia === "function" ? matchMedia : undefined) =>
  Boolean(mm?.("(prefers-reduced-motion: reduce)").matches);

type Who = { gate?: unknown; welcome?: boolean; greet_member?: boolean; greet_staff?: boolean } | null | undefined;
/** Whether this app's welcome is still to play for the person signed in (`play`), and whether to note it as played
 *  (`note`). The members' app doesn't play it for someone it sends to the welcome for members who moved in
 *  (Welcome.tsx), which has its own entrance; it's noted all the same, so neither shows twice. */
export function greetFor(which: "member" | "staff", m: Who): { play: boolean; note: boolean } {
  if (!m || m.gate) return { play: false, note: false };
  const due = which === "member" ? Boolean(m.greet_member) : Boolean(m.greet_staff);
  return { play: due && !(which === "member" && m.welcome), note: due };
}

/** How long it plays, in ms, with motion and with less of it (only a fade): styles.css's .greet keeps to the same. */
export const GREET_MS = { motion: 1100, still: 900 } as const;
