# packages/i18n
English and Spanish catalogs, plural rules and formatting.

- `en.ts`, `es.ts`: every message, in both languages. The type checker makes a key missing from `es.ts` an error.
- `format.ts`: picking a language, plural forms, {placeholders}, money and dates, with no catalogs.
- `index.ts`: the server's way in: `format.ts` with both whole catalogs (`t`, `both`).
- `wording.ts` and `vite.ts`: the apps' way in. The build finds the keys an app's code names and makes
  one module per language with only those (`virtual:kumi-wording/en`, `/es`); the app fetches the
  person's language before its first screen, and another only when someone switches. The members'
  app's build fails over its 200 kB budget.
- `test/wording.test.ts`: every `t()` call in the apps asks for keys the app ships.
