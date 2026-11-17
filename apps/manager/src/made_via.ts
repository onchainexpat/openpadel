// How a change came in, in words, from the `via` its run keeps (actions.ts: the app, an assistant on /mcp, setup, the
// command line on the server, a scheduled job, an import, the Playtomic copy): Changes and Approvals show it beside
// who made it. Plain data, so a test can read it without the app: the screens put it through t().
const KNOWN = ["web", "setup", "cli", "import", "household", "signup", "support", "staff", "restore"] as const;
const JOBS = ["job", "jobs", "schedule", "texting"];
/** The end of a `ui.made_via_*` key, and what it fills in. */
export type ViaWord = (typeof KNOWN)[number] | "mcp" | "assistant" | "playtomic" | "parent" | "text" | "job";
export type ViaWords = { word: ViaWord; params: Record<string, string> };

/** The words for a run's `via`, or null when there's nothing worth saying (a test's, a developer's own). */
export function viaWords(via: string | null | undefined): ViaWords | null {
  if (!via) return null;
  const at = via.indexOf(":"), head = at < 0 ? via : via.slice(0, at), rest = at < 0 ? "" : via.slice(at + 1);
  const w = (word: ViaWord, params: Record<string, string> = {}) => ({ word, params });
  if (head === "mcp") return w("mcp", { name: rest });
  // Ask openPadel, the hosted assistant (assistant:hosted:staff or :member): previewed by it, confirmed by the person.
  if (head === "assistant") return w("assistant");
  if (head === "mirror") return w("playtomic");
  if (head === "parent") return w("parent");
  if (head === "text") return w("text");
  if (JOBS.includes(head)) return w("job");
  return (KNOWN as readonly string[]).includes(head) ? w(head as (typeof KNOWN)[number]) : null;
}

/** How long ago, as a whole number of the nearest unit, for Intl.RelativeTimeFormat: [-4, "minute"]; null under a
 *  minute (the screens say "just now"). */
export function agoParts(iso: string | Date, now: number): [number, "minute" | "hour" | "day"] | null {
  const s = Math.round((new Date(iso).getTime() - now) / 1000), a = Math.abs(s);
  if (a < 60) return null;
  if (a < 3600) return [Math.round(s / 60), "minute"];
  if (a < 86400) return [Math.round(s / 3600), "hour"];
  return [Math.round(s / 86400), "day"];
}
