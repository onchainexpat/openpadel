// English and Spanish, from the first string. A message is plain text with {placeholders},
// or a set of plural forms chosen by Intl.PluralRules on the `count` parameter.
import { en } from "./en.ts";
import { es } from "./es.ts";

export type Lang = "en" | "es";
export const LANGS: readonly Lang[] = ["en", "es"];
export type Plural = { one: string; other: string; many?: string };
export type Message = string | Plural;
export type Key = keyof typeof en;
/** The same text in every language, as stored in plans and shown in Changes. */
export type Text = Record<Lang, string>;
/** A parameter can itself be translated, so a Spanish sentence never gets an English word. */
export type Params = Record<string, string | number | Text>;

const catalogs: Record<Lang, Record<Key, Message>> = { en, es };
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

export function t(lang: Lang, key: Key, params: Params = {}): string {
  const m = catalogs[lang][key];
  const raw = typeof m === "string" ? m : (m[plurals[lang].select(Number(params.count ?? 0)) as keyof Plural] ?? m.other);
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) return `{${k}}`;
    return typeof v === "object" ? v[lang] : String(v);
  });
}

export function both(key: Key, params: Params = {}): Text {
  return { en: t("en", key, params), es: t("es", key, params) };
}

export function money(cents: number, lang: Lang, currency = "USD"): string {
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency }).format(cents / 100);
}

export function dateTime(d: Date, lang: Lang, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
}

export { en, es };
