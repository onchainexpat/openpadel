// The staff app's renameable words and orders, as the club's "Coming from" preset sets them (presets.ts).
import { club, t } from "@kumi/ui";
import type { Key } from "@kumi/i18n/format";
import { presetFor, type LabelKey, type Preset } from "./presets.ts";

/** The club's preset, from its setting (the default until the club has loaded). */
export const preset = (): Preset => presetFor(club.value?.coming_from);

/** A menu item's or page title's words, in the reader's language: the preset's own key where it has one. */
export function label(k: LabelKey): string {
  const own = preset().labels[k];
  return t(own ? `preset.${own}` as Key : k);
}
