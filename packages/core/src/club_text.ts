// The club's own words in a member's language. A plan's name and description, a program's name, the waiver, the
// public page's blurb, a coach's bio and a price's name are written by the club in its default language; each
// can also have a version in the other language, kept beside it as `translations` ({ es: { name: "..." } }).
// A member sees their language's version when there is one, and the club's own wording when there isn't:
// never a gap, never a "missing" marker.
import * as z from "zod/mini";
import { sql, type RawBuilder } from "kysely";
import { LANGS, type Lang, type Text } from "@kumi/i18n";

export type Translations = Partial<Record<Lang, Record<string, string>>>;

/** What each table can say in another language. */
export const TRANSLATED = {
  membership_plan: ["name", "description"],
  program: ["name"],
  waiver: ["body"],
  club: ["about"],
  coach: ["bio"],
  price_rule: ["name"],
} as const;
export type TranslatedTable = keyof typeof TRANSLATED;

const tr = (v: unknown): Translations => (v && typeof v === "object" ? v as Translations : {});

/** One field in one language: its own version, or the club's own wording. */
export function inLang(base: string, translations: unknown, field: string, lang: Lang): string;
export function inLang(base: string | null, translations: unknown, field: string, lang: Lang): string | null;
export function inLang(base: string | null, translations: unknown, field: string, lang: Lang): string | null {
  const own = tr(translations)[lang]?.[field]?.trim();
  return own || base;
}

/** One field in both languages, for a message or a receipt that's written once and read in either. */
export function textOf(base: string, translations: unknown, field: string): Text {
  return { en: inLang(base, translations, field, "en"), es: inLang(base, translations, field, "es") };
}

/** The same in SQL, for a read that knows its reader's language: `trSql("program", "name", lang).as("name")`. */
export function trSql(table: string, field: string, lang: Lang): RawBuilder<string> {
  return sql<string>`coalesce(nullif(btrim(${sql.ref(`${table}.translations`)} -> ${sql.lit(lang)} ->> ${sql.lit(field)}), ''), ${sql.ref(`${table}.${field}`)})`;
}

const words = z.string().check(z.maxLength(20000));
/** An action's input for a table's other-language versions: { es: { name: "..." } }. An empty string removes one. */
export function translationsInput<T extends TranslatedTable>(table: T) {
  const fields = Object.fromEntries(TRANSLATED[table].map((f) => [f, z.optional(words)])) as Record<(typeof TRANSLATED)[T][number], z.ZodMiniOptional<typeof words>>;
  const one = z.optional(z.object(fields));
  return z.optional(z.object({ en: one, es: one }));
}

/** The versions to keep: the new ones where given (blank ones dropped), the old ones for a field not mentioned. */
export function mergeTranslations(old: unknown, next: Translations | undefined): Translations {
  if (next === undefined) return tr(old);
  const out: Translations = {};
  for (const lang of LANGS) {
    const merged = { ...(tr(old)[lang] ?? {}), ...(next[lang] ?? {}) };
    const kept = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v));
    if (Object.keys(kept).length) out[lang] = kept;
  }
  return out;
}
