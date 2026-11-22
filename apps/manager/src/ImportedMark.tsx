// The mark on what came from Playtomic (a Playtomic copy on the Schedule): a plain "imported" arrow from the icon set,
// never Playtomic's own logo (their trademark). One small component, so a club could change the art in one place.
import { Icon, t } from "@kumi/ui";

/** "Imported from Playtomic", as a mark: its words are its name and its tooltip. */
export function ImportedMark({ class: extra }: { class?: string }) {
  return <span class={`pt-mark${extra ? ` ${extra}` : ""}`} title={t("ui.imported_playtomic")}><Icon name="import" label={t("ui.imported_playtomic")} /></span>;
}
