// English and Spanish, from the first string. A message is plain text with {placeholders},
// or a set of plural forms chosen by Intl.PluralRules on the `count` parameter. This is the server's
// way in, with both whole catalogs; the apps use format.ts and only their own keys (vite.ts).
import { en } from "./en.ts";
import { es } from "./es.ts";
import { format, type Catalog, type Key, type Lang, type Params, type Text } from "./format.ts";

export * from "./format.ts";

const catalogs: Record<Lang, Catalog> = { en, es };

export function t(lang: Lang, key: Key, params: Params = {}): string {
  return format(catalogs[lang], lang, key, params);
}

export function both(key: Key, params: Params = {}): Text {
  return { en: t("en", key, params), es: t("es", key, params) };
}

export { en, es };
