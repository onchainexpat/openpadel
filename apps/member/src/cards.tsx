// Pieces the cards on Play and Learn share: how many places are taken (with round badges only where the names are
// already shown to members, as on an open match), a coach's face, and the category filter.
import { t } from "@kumi/ui";
import { initials } from "./whats_on.ts";
import { genderChoices, type Gender } from "./alert_bits.ts";

/** "3/4", said in full to screen readers; with `names`, a badge for each player and an empty one for each open place. */
export function Taken({ taken, total, names }: { taken: number; total: number; names?: (string | null)[] }) {
  const open = Math.max(0, total - taken);
  return <span class="taken">
    {names && <span class="avatars" aria-hidden="true">{names.slice(0, 6).map((n) => <span class="avatar">{initials(n)}</span>)}{Array.from({ length: Math.min(open, 6 - Math.min(names.length, 6)) }, () => <span class="avatar open" />)}</span>}
    <span class="count" aria-hidden="true">{taken}/{total}</span><span class="visually-hidden">{t("ui.n_places_taken", { taken, total })}</span>
  </span>;
}

/** A coach's photo, or their initials in a circle. Decorative: their name is always written beside it. */
export function CoachFace({ name, photo, size = "small" }: { name: string; photo: string | null; size?: "small" | "big" }) {
  return photo ? <img class={`face ${size}`} src={photo} alt="" loading="lazy" /> : <span class={`face ${size}`} aria-hidden="true">{initials(name)}</span>;
}

/** Who it's for, as a filter (a label; nobody is checked against it): only the categories the list has, and only
 *  when it has one. Events use it too. */
export function GenderChips({ rows, value, onChange }: { rows: { gender?: Gender | null }[]; value: Gender | ""; onChange: (g: Gender | "") => void }) {
  const choices = genderChoices(rows);
  if (!choices.length) return null;
  return <div class="chips scroll" role="group" aria-label={t("ui.gender")}>{(["", ...choices] as const).map((g) =>
    <button type="button" class={g === value ? "chip on" : "chip"} aria-pressed={g === value} onClick={() => onChange(g)}>{g ? t(`gender.${g}`) : t("ui.gender_all")}</button>)}</div>;
}
