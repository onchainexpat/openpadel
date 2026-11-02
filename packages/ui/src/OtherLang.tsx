// The same words in the club's other language, under the field in its own: optional. A member who reads Kumi in
// that language sees this version; without one they see the club's own words. When the server can make one,
// "Offer a draft" fills it from the club's own words for a person to read and change before saving.
import { useState } from "preact/hooks";
import type { Lang } from "@kumi/i18n";
import { api, club, t } from "./state.ts";

/** The club's other language, or null for a club with one language. */
export function otherLang(): Lang | null {
  const c = club.value;
  if (!c || c.languages.length < 2) return null;
  return c.default_language === "es" ? "en" : "es";
}
/** A form's other-language fields as an action's `translations`, e.g. { es: { name, description } }: a blank one
 *  clears that version. Nothing at all for a club with one language. */
export function translationsOf(fields: Record<string, string>): Record<string, Record<string, string>> | undefined {
  const other = otherLang();
  return other ? { [other]: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim()])) } : undefined;
}
/** A row's saved version of one field in the other language, for filling the form. */
export function savedIn(translations: unknown, field: string): string {
  const other = otherLang(), tr = translations as Record<string, Record<string, string>> | null | undefined;
  return (other && tr?.[other]?.[field]) || "";
}

export function OtherLang({ value, onInput, source, multiline, maxLength, rows }: {
  value: string; onInput: (v: string) => void; source: string; multiline?: boolean; maxLength?: number; rows?: number;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [drafted, setDrafted] = useState(false);
  const other = otherLang();
  if (!other) return null;
  const draft = async () => {
    setBusy(true); setError(null);
    try { onInput((await api<{ draft: string }>("/staff/translate", { text: source, from: club.value!.default_language, to: other })).draft); setDrafted(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const field = multiline
    ? <textarea rows={rows ?? 4} maxLength={maxLength} value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    : <input maxLength={maxLength} value={value} onInput={(e) => onInput(e.currentTarget.value)} />;
  return (
    <div class="other-lang">
      <label>{t(other === "es" ? "ui.in_spanish" : "ui.in_english")}{field}</label>
      {club.value?.drafts && source.trim() !== "" &&
        <button type="button" class="small" disabled={busy} onClick={draft}>{busy ? t("ui.drafting") : t(value.trim() ? "ui.offer_draft_again" : "ui.offer_draft")}</button>}
      {drafted && <p class="meta">{t("ui.draft_check")}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </div>
  );
}
