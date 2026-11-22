// The mark on what came from Playtomic (a Playtomic copy on the Schedule): Playtomic's own small logo, so staff see at a
// glance where a booking was made. The picture is a CSS background (styles.css, .pt-mark), so it loads only when a copy
// is on the page, never with the first screen's code. One small component, so a club could change the art in one place.
import { t } from "@kumi/ui";

/** "Imported from Playtomic", as a mark: its words are its name and its tooltip. beside: next to those same words (the
 *  legend, the hover card), so it's left out for screen readers rather than read twice. */
export function ImportedMark({ class: extra, beside }: { class?: string; beside?: boolean }) {
  const cls = `pt-mark${extra ? ` ${extra}` : ""}`;
  return beside ? <span class={cls} aria-hidden="true" /> : <span class={cls} role="img" aria-label={t("ui.imported_playtomic")} title={t("ui.imported_playtomic")} />;
}
