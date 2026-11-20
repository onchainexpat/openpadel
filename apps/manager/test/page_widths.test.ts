// One width rule for every staff page on a desktop (styles.css): each starts at the same left edge, beside the menu.
// Tables, calendars and boards (main.wide) take the width there is, up to 1400px; forms and feeds keep a readable 760px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");
const page = (f: string) => read(`apps/manager/src/${f}.tsx`);
/** The pages that are tables, calendars or boards: full width. */
const WIDE = ["Today", "Courts", "Bookings", "People", "Payments", "Reports", "Connectors", "Levels", "Mirror", "Competition", "Night", "MoveSteps"];
/** Forms and feeds: the readable width. */
const READABLE = ["Approvals", "Changes", "Chats", "Coaches", "Memberships", "Messages", "Questions", "Settings", "Roles", "Programs", "Program", "Schedule", "Usage", "Vault", "Support"];

test("the rule: every page left-aligned beside the menu, wide pages up to 1400px, the rest 760px", () => {
  const css = read("packages/ui/src/styles.css");
  assert.match(css, /\.shell-main > \* \{ max-width: 760px; margin-left: 0; margin-right: auto; \}/);
  assert.match(css, /\.shell-main > main\.wide \{ max-width: 1400px; \}/);
  // No page keeps a width of its own, or centres itself, beside the rule.
  assert.doesNotMatch(css, /\.shell-main > main\.(today|money)\b[^{]*\{[^}]*max-width/);
  assert.equal(css.match(/\.shell-main > [^{]*\{[^}]*max-width/g)?.length, 2);
});

test("tables, calendars and boards are wide; forms and feeds are not", () => {
  for (const f of WIDE) assert.match(page(f), /<main class="wide[ "]/, `${f} is a table, calendar or board`);
  for (const f of READABLE) assert.doesNotMatch(page(f), /<main class="wide/, `${f} is a form or a feed`);
  // Every staff page is one or the other, on purpose.
  for (const f of readdirSync(`${root}apps/manager/src`).filter((x) => x.endsWith(".tsx"))) {
    const name = f.replace(".tsx", "");
    if (/<main class="wide/.test(page(name))) assert.ok(WIDE.includes(name), `${name} is wide but not listed`);
  }
});
