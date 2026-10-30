// The wording machinery without the wording: picking a language, plural forms and {placeholders}, money
// and dates. The server pairs it with both whole catalogs (index.ts); each app loads only the keys its
// own code uses, in one language at a time (wording.ts and vite.ts build those).
import type { en } from "./en.ts";

export type Lang = "en" | "es";
export const LANGS: readonly Lang[] = ["en", "es"];
export type Plural = { one: string; other: string; many?: string };
export type Message = string | Plural;
export type Key = keyof typeof en;
/** The same text in every language, as stored in plans and shown in Changes. */
export type Text = Record<Lang, string>;
/** A parameter can itself be translated, so a Spanish sentence never gets an English word. */
export type Params = Record<string, string | number | Text>;
/** One language's messages: all of them on the server, an app's own keys in the browser. */
export type Catalog = Partial<Record<Key, Message>>;

const plurals = { en: new Intl.PluralRules("en"), es: new Intl.PluralRules("es") };

export function isLang(v: unknown): v is Lang { return v === "en" || v === "es"; }

/** Picks a supported language from an Accept-Language header or a stored locale. */
export function pickLang(v: string | null | undefined, fallback: Lang = "en"): Lang {
  for (const part of (v ?? "").split(",")) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return fallback;
}

/** The name an erased account keeps (one stored string), and how each language says it. A sentence that
 *  names them gets the reader's word, wherever the name came from. */
export const FORMER_MEMBER = "Former member";
export const formerMember: Text = { en: FORMER_MEMBER, es: "Exmiembro" };
export const sayFormer = (s: string, lang: Lang) => lang === "en" || !s.includes(FORMER_MEMBER) ? s : s.replaceAll(FORMER_MEMBER, formerMember[lang]);

/** One message from a catalog. A key the catalog doesn't have comes back as the key itself, so a gap shows. */
export function format(catalog: Catalog, lang: Lang, key: Key, params: Params = {}): string {
  const m = catalog[key];
  if (m === undefined) return key;
  const raw = typeof m === "string" ? m : (m[plurals[lang].select(Number(params.count ?? 0)) as keyof Plural] ?? m.other);
  return sayFormer(raw.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) return `{${k}}`;
    return typeof v === "object" ? v[lang] : String(v);
  }).replace(/([ap]\.\s?m\.)\./g, "$1"), lang);   // a sentence ending on a Spanish time ("9:00 a.m.") keeps one full stop
}

export function money(cents: number, lang: Lang, currency = "USD"): string {
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency }).format(cents / 100);
}

export function dateTime(d: Date, lang: Lang, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
}
