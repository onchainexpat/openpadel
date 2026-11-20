// Small things the sweep found: the Schedule asked for a calendar link the owner can't have (a 403 on every load), and
// file pickers showed the browser's own "Choose File / No file chosen" in English on a Spanish page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");

test("the Schedule asks for the calendar link only for a coach, who is the only one with one", () => {
  const src = read("apps/manager/src/Schedule.tsx");
  assert.match(src, /export const hasCalendarLink = \(roles: \{ key: string \}\[\] \| undefined\) => Boolean\(roles\?\.some\(\(r\) => r\.key === "coach"\)\);/);
  assert.match(src, /useEffect\(\(\) => \{ if \(coach\) api<\{ path: string \| null \}>\("\/staff\/calendar-link"\)/);
  // And the server still answers only a coach (calendar.ts).
  assert.match(read("apps/server/src/calendar.ts"), /where\("role\.key", "=", "coach"\)/);
});

test("every file picker in both apps is the app's own (FileInput), in the person's language", () => {
  for (const d of ["apps/manager/src", "apps/member/src", "packages/ui/src"]) for (const f of readdirSync(`${root}${d}`).filter((x) => x.endsWith(".tsx"))) {
    if (f === "FileInput.tsx") continue;
    assert.doesNotMatch(read(`${d}/${f}`), /type="file"/, `${d}/${f} has a bare file input`);
  }
  assert.match(read("apps/manager/src/Settings.tsx"), /<FileInput label=\{t\("ui\.logo_choose"\)\}[^>]*describedBy="logo-help"/);
  const input = read("packages/ui/src/FileInput.tsx");
  assert.match(input, /\{t\("ui\.file_choose"\)\}/); assert.match(input, /\{name \?\? t\("ui\.file_none"\)\}/);
});
