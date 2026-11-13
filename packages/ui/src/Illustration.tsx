// The apps' line drawings (packages/ui/assets/illustrations): decorative, so hidden from screen readers, and only
// a class here. styles.css paints each one through mask-image in a colour that reads (the club's, made readable by
// brand.ts, or the text's on the club's colour), so one file suits every club and both themes. The picture loads
// only when one is on the page, never with the first screen's code, and one that fails to load shows nothing.
import type { ComponentChildren } from "preact";

export type IllustrationName = "welcome" | "no-matches" | "no-bookings" | "no-classes" | "coach" | "youre-in" | "court";

/** tone: "brand" the club's colour as text reads it (the default), "on-brand" the text colour on the club's colour,
 *  "faint" the club's colour, low-key, for behind words. size: "m" about a third of a phone's width, "s" smaller. */
export function Illustration({ name, tone = "brand", size = "m", class: extra }: { name: IllustrationName; tone?: "brand" | "on-brand" | "faint"; size?: "s" | "m"; class?: string }) {
  return <span class={`illus illus-${name} illus-${tone} illus-${size}${extra ? ` ${extra}` : ""}`} aria-hidden="true" />;
}

/** An empty list's card: its drawing above the words. */
export function EmptyState({ art, size, class: extra, children }: { art: IllustrationName; size?: "s" | "m"; class?: string; children: ComponentChildren }) {
  return <div class={`card empty${extra ? ` ${extra}` : ""}`}><Illustration name={art} size={size} /><p>{children}</p></div>;
}
