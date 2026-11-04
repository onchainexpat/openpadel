# packages/i18n
English and Spanish catalogs, plural rules and formatting.

- `en.ts`, `es.ts`: every message, in both languages. The type checker makes a key missing from `es.ts` an error.
- `format.ts`: picking a language, plural forms, {placeholders}, money and dates, with no catalogs.
- `index.ts`: the server's way in: `format.ts` with both whole catalogs (`t`, `both`).
- `wording.ts` and `vite.ts`: the apps' way in. The build finds the keys an app's code names and makes
  two modules per language with only those: the keys of the files the first screen loads
  (`virtual:kumi-wording/en`, `/es`) and the rest (`/en/rest`, `/es/rest`), which only pages loaded when first
  opened use. The app fetches the first part of the person's language before its first screen and the rest
  just after; a page loaded later (`lazyPage`) waits for it. Another language comes only when someone switches,
  both parts at once. An app's build fails over its budget (members 200 kB, staff 160 kB), counting its code
  and one language's first part.
- `test/wording.test.ts`: every `t()` call in the apps asks for keys the app ships, and one on the first screen
  only for keys in the first part.
