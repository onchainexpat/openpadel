// Every button in both apps has a name a screen reader can say: words inside it, or an aria-label. A button that is
// only an icon or a symbol is refused here (the real-phone check of 5 Nov found the page read out as "button").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const dirs = ["apps/member/src", "apps/manager/src", "packages/ui/src"];
const files = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".tsx")).map((f) => join(root, d, f)));

test("every button has words or an aria-label", () => {
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<button\b([^>]*?)(\/>|>([\s\S]*?)<\/button>)/g)) {
      const attrs = m[1] ?? "", inner = m[3] ?? "";
      if (/aria-label=|aria-labelledby=|title=/.test(attrs)) continue;
      // Words: a translation, a {name} expression, or letters typed in the markup.
      if (/\{[^}]*\bt\(|\{[^}]*(name|label|text|title|summary|amount)\b|[A-Za-z]{2,}/.test(inner.replace(/<[^>]+>/g, " "))) continue;
      const line = src.slice(0, m.index).split("\n").length;
      bad.push(`${f.slice(root.length)}:${line} ${m[0].slice(0, 80).replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(bad, [], `buttons with no name:\n${bad.join("\n")}`);
});
