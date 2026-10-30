// A parent signs up and books for their juniors too: which of them a page is for, and whether the club's
// waiver is still waiting for anyone. Loaded once when the app opens, and again after a change on Family.
import { signal } from "@preact/signals";
import { api, me, t } from "@kumi/ui";

type Named = { id: string; display_name: string };
/** The juniors the member manages (empty for most members). */
export const juniors = signal<Named[]>([]);
/** Someone (the member, or one of their juniors) still has to accept the club's waiver. */
export const waiverDue = signal(false);

export async function loadFamily(): Promise<void> {
  try {
    const h = await api<{ role: string | null; household: { juniors: Named[] } | null }>("/my/household");
    juniors.value = h.role === "adult" ? h.household?.juniors.map((j) => ({ id: j.id, display_name: j.display_name })) ?? [] : [];
    const w = await api<{ waiver: unknown; people: { accepted_at: string | null }[] }>("/my/waiver");
    waiverDue.value = Boolean(w.waiver) && w.people.some((p) => !p.accepted_at);
  } catch { /* offline or signed out: keep what we had */ }
}

/** "For: Me · Mia · Leo", shown only to a member with juniors. */
export function ForWhom({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  if (!juniors.value.length) return null;
  const mine = me.value!.person.id;
  return (
    <div class="chips" role="group" aria-label={t("ui.for_whom")}>
      <span class="meta">{t("ui.for_whom")}:</span>
      {[{ id: mine, display_name: t("ui.for_me") }, ...juniors.value].map((p) =>
        <button type="button" class={p.id === value ? "chip on" : "chip"} onClick={() => onChange(p.id)}>{p.display_name}</button>)}
    </div>
  );
}
