// Text people typed, made safe to show: no control or invisible formatting characters (bidi overrides that turn
// "exe.gnp" into "png.exe", zero-width spaces), new lines kept where they're allowed. The zero-width joiner stays:
// emoji like a family are built with it.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
const KEEP = new Set(["\n", "‍"]);

/** A message's words: new lines kept (three or more become two), everything else invisible removed. */
export function plainText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(INVISIBLE, (c) => (KEEP.has(c) ? c : "")).replace(/\n{3,}/g, "\n\n").trim();
}
/** A name on one line. */
export function plainName(s: string): string {
  return s.replace(INVISIBLE, (c) => (c === "‍" ? c : "")).replace(/\s+/g, " ").trim();
}
/** The start of a message, for a notification. */
export function shortText(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim(), chars = [...one];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : one;
}
