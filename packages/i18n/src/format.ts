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
  // A value that ends its own sentence ("Fine for now.", a question) takes the place of the full stop after it, so a
  // reason or a note someone typed never shows "..". A Spanish time ("9:00 a.m.") at a sentence's end is the same.
  return sayFormer(raw.replace(/\{(\w+)\}(\.(?!\.))?/g, (_, k: string, stop: string | undefined) => {
    // The club's currency sign and how it writes an amount fill {currency} and {amount_example} when not given.
    const v = params[k] ?? (k === "currency" ? currencySign() : k === "amount_example" ? amountExample() : undefined);
    if (v === undefined) return `{${k}}${stop ?? ""}`;
    const s = typeof v === "object" ? v[lang] : String(v);
    return stop && /[.!?…]$/.test(s.trimEnd()) ? s.trimEnd() : s + (stop ?? "");
  }).replace(/([ap]\.\s?m\.)\./g, "$1"), lang);
}

/** The club's currency and formats. A Kumi server runs one club, and so does each app, so this is set once: the
 *  server from the club's settings as it starts and whenever they change (setClubFormat), each app from /club.
 *  Until then, and in a club that never changes them, US dollars the US way. */
export interface ClubFormat { currency: string; locale: string; country?: string }
let clubFmt: ClubFormat = { currency: "USD", locale: "en-US", country: "US" };
export function setClubFormat(f: Partial<ClubFormat>): void {
  clubFmt = { currency: (f.currency || clubFmt.currency).toUpperCase(), locale: f.locale || clubFmt.locale, country: (f.country || clubFmt.country || "US").toUpperCase() };
}
export const clubFormat = (): ClubFormat => clubFmt;

/** Stripe's zero-decimal currencies (an amount is whole units: 1500 is ¥1,500) and the three-decimal ones it rounds
 *  to tens, which Kumi doesn't take. Every other currency has two decimals. Amounts are always stored in the
 *  currency's smallest unit (cents, pence, yen), as Stripe takes them. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
export const minorUnits = (currency: string = clubFmt.currency): number => ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
/** From the smallest unit to the whole one (4050 -> 40.5) and back (rounded to the smallest unit). */
export const toMajor = (minor: number, currency?: string): number => minor / 10 ** minorUnits(currency);
export const fromMajor = (major: number, currency?: string): number => Math.round(major * 10 ** minorUnits(currency));
/** An amount as a plain number, for spreadsheets and structured data: "1234.50", "1234" for yen. */
export const plainAmount = (minor: number, currency?: string): string => toMajor(minor, currency).toFixed(minorUnits(currency));
/** An amount input's step and smallest value: "0.01" in most currencies, "1" in zero-decimal ones. */
export const amountStep = (currency?: string): string => minorUnits(currency) ? "0.01" : "1";
/** Why a currency can't be the club's: not a currency code Intl knows, or one with three decimals. */
export function currencyProblem(code: string): "unknown" | "three_decimals" | null {
  const c = code.toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return "unknown";
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : null;
  if (known && !known.includes(c)) return "unknown";
  return THREE_DECIMAL.has(c) ? "three_decimals" : null;
}

/** The locale numbers are written in for the club (its own locale's separators: "1,200.50" in the US, "1.200,50"
 *  in Spain), and the reader's language for words. */
export function formatLocale(lang: Lang): string {
  const key = `${lang}|${clubFmt.locale}`, known = localeCache.get(key);
  if (known) return known;
  let tag = lang === "es" ? "es-US" : "en-US";
  try {
    const club = new Intl.Locale(clubFmt.locale), region = club.maximize().region;
    // The reader's words in the club's region ("en-ES": English, Spain's order and separators), and the club's clock:
    // 24 hours where the club's locale uses them, whatever the reader's language would.
    const hc = new Intl.DateTimeFormat(clubFmt.locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    tag = new Intl.Locale(lang, { ...(region ? { region } : {}), ...(hc ? { hourCycle: hc } : {}) }).toString();
    new Intl.DateTimeFormat(tag);   // a tag Intl refuses falls back to the US one
  } catch { tag = lang === "es" ? "es-US" : "en-US"; }
  localeCache.set(key, tag);
  return tag;
}
const localeCache = new Map<string, string>();
/** The first day of the club's week (1 Monday ... 7 Sunday), from its locale: Sunday in the US, Monday in most of
 *  Europe. */
export function firstDayOfWeek(locale: string = clubFmt.locale): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const d = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay;
    if (d) return d;
  } catch { /* an odd tag: the table below */ }
  const region = (() => { try { return new Intl.Locale(locale).maximize().region ?? ""; } catch { return ""; } })();
  return ["US", "CA", "MX", "BR", "JP", "KR", "AU", "IL", "PH", "ZA", "IN", "CO", "PE", "VE", "GT", "HN", "SV", "NI", "PA", "DO", "PR", "TW", "HK"].includes(region) ? 7 : 1;
}
/** The days of the club's week in order, as weekday numbers 0 (Sunday) to 6 (Saturday), first day first. */
export function weekOrder(locale?: string): number[] {
  const first = firstDayOfWeek(locale) % 7;   // 7 (Sunday) -> 0
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}
/** Whether the club's clock runs to 24 hours (so "17:00", not "5:00 PM"). */
export const clock24 = (locale: string = clubFmt.locale): boolean => {
  const hc = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return hc === "h23" || hc === "h24";
};

const esc = (c: string) => /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c === "\u00a0" ? "\\u00a0" : c;
function separators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  return { group: parts.find((p) => p.type === "group")?.value ?? ",", decimal: parts.find((p) => p.type === "decimal")?.value ?? "." };
}
/** An amount as staff type it, the club's way: in the US "1,200.50", "$40", "12.5" (separators only between
 *  thousands, a point and at most two figures after it); in a club whose locale writes "1.200,50", that. A currency
 *  sign or code before or after is fine. The same as an input's pattern, so the form says so before anything is
 *  sent. Anything that could be read two ways ("12,5" in the US) isn't read at all. */
export function amountPattern(f: ClubFormat = clubFmt): string {
  const { group, decimal } = separators(f.locale), d = minorUnits(f.currency);
  const g = /\s/.test(group) || group === "\u202f" ? "[ \\u00a0\\u202f]" : esc(group);
  const sign = "(?:[\\p{Sc}\\p{L}]{1,4}\\s*)?", after = "(?:\\s*[\\p{Sc}\\p{L}]{1,4})?";
  return `\\s*${sign}(\\d{1,3}(?:${g}\\d{3})+|\\d+)${d ? `(?:${esc(decimal)}(\\d{1,${d}}))?` : ""}${after}\\s*`;
}
/** The club's currency sign ("$", "€", "£", "¥"), as labels show it: "Price ($)". */
export function currencySign(currency: string = clubFmt.currency): string {
  return new Intl.NumberFormat(clubFmt.locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
}
/** How the club writes an amount, for a hint: "1,200.50" in the US, "1.200,50" in Spain, "1,200" in yen. */
export function amountExample(f: ClubFormat = clubFmt): string {
  const d = minorUnits(f.currency);
  return new Intl.NumberFormat(f.locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(d ? 1200.5 : 1200);
}
/** US dollars, for code and tests written before clubs had their own currency. */
export const AMOUNT_PATTERN = amountPattern({ currency: "USD", locale: "en-US" });
/** The amount in the smallest unit, or null when it can't be read for sure. */
export function parseAmount(s: string, f: ClubFormat = clubFmt): number | null {
  const m = new RegExp(`^${amountPattern(f)}$`, "u").exec(s);
  if (!m) return null;
  const whole = Number(m[1]!.replace(/\D/g, "")), d = minorUnits(f.currency);
  return whole * 10 ** d + (d ? Number((m[2] ?? "").padEnd(d, "0")) : 0);
}
/** The club's amount parser under its old name (it read US dollars only). */
export const parseDollars = (s: string): number | null => parseAmount(s);

export function money(minor: number, lang: Lang, currency: string = clubFmt.currency): string {
  const d = minorUnits(currency);
  return new Intl.NumberFormat(formatLocale(lang), { style: "currency", currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(toMajor(minor, currency));
}

export function dateTime(d: Date, lang: Lang, timeZone: string): string {
  return new Intl.DateTimeFormat(formatLocale(lang), { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
}
