// The icon set (Icon.tsx, icon_paths.ts: a few of Lucide's) and the loading shapes (Skeleton.tsx): every icon named in
// the apps is in the set, Lucide's licence stays with it, icons are hidden from screen readers unless labelled, every
// menu item and tab has one, and nothing says a bare "Loading" any more: a skeleton waits a moment, then shows the
// shape of what's coming, with the word kept for screen readers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ICONS, type IconShape } from "../src/icon_paths.ts";
import { statusIcon } from "../src/status_icon.ts";
import { MENU_ITEMS } from "../../../apps/manager/src/presets.ts";

const root = new URL("../../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");
const DIRS = ["apps/member/src", "apps/manager/src", "packages/ui/src"];
const sources = DIRS.flatMap((d) => readdirSync(`${root}${d}`).filter((f) => f.endsWith(".tsx")).map((f) => ({ f: `${d}/${f}`, src: read(`${d}/${f}`) })));
const names = new Set(Object.keys(ICONS));

test("each icon is plain SVG shapes on Lucide's grid, and Lucide's licence is kept beside them", () => {
  assert.ok(names.size >= 40, `${names.size} icons`);
  const keys = Object.keys(ICONS);
  assert.deepEqual(keys, [...keys].sort(), "kept in order, so adding one is easy to review");
  for (const [name, shapes] of Object.entries(ICONS) as [string, readonly IconShape[]][]) {
    assert.ok(shapes.length > 0, name);
    for (const [tag, attrs] of shapes) {
      assert.match(tag, /^(path|circle|rect|line|polyline|polygon|ellipse)$/, name);
      for (const k of Object.keys(attrs)) assert.match(k, /^(d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|width|height|points|fill)$/, `${name}: ${k}`);
    }
  }
  const licence = read("packages/ui/icons/LICENSE");
  assert.match(licence, /ISC License/); assert.match(licence, /Lucide Contributors/);
  assert.match(read("packages/ui/src/icon_paths.ts"), /Lucide's ISC licence is in packages\/ui\/icons\/LICENSE/);
  assert.match(read("packages/ui/icons/README.md"), /lucide-react 0\.574\.0/);
});

test("an icon takes the text's size and colour, and is hidden from screen readers unless it has a label", () => {
  const src = read("packages/ui/src/Icon.tsx");
  assert.match(src, /width="1em" height="1em" fill="none" stroke="currentColor"/);
  assert.match(src, /aria-label=\{label\} aria-hidden=\{label \? undefined : "true"\}/);
  assert.match(read("packages/ui/src/styles.css"), /\.icon \{ display: inline-block; flex: none; width: 1em; height: 1em;/);
});

test("the icons' shapes are a file of their own, loaded as an app starts, never part of the first screen's code", () => {
  assert.match(read("packages/ui/src/Icon.tsx"), /import\("\.\/icon_paths\.ts"\)\.then\(\(m\) => \{ shapes\.value = m\.ICONS; \}/);
  for (const { f, src } of [...sources, { f: "packages/ui/src/status_icon.ts", src: read("packages/ui/src/status_icon.ts") }, { f: "packages/ui/src/index.ts", src: read("packages/ui/src/index.ts") }]) {
    for (const m of src.matchAll(/^import (type )?[^;]*from "\.\/icon_paths\.ts";/gm)) assert.ok(m[1], `${f} imports the shapes themselves`);
  }
});

test("every icon the apps name is in the set, and the apps draw no icons of their own", () => {
  for (const { f, src } of sources) {
    for (const m of src.matchAll(/<Icon name="([a-z0-9-]+)"/g)) assert.ok(names.has(m[1]!), `${f}: ${m[1]} isn't in icon_paths.ts`);
    // The level picture on My level is a drawing, not an icon; Icon.tsx is the one place an icon's <svg> is written.
    if (!/MyLevel\.tsx$|Icon\.tsx$/.test(f)) assert.doesNotMatch(src, /<svg/, `${f} draws its own icon`);
  }
});

test("every staff menu item, staff phone tab and members' tab has its icon", () => {
  const app = read("apps/manager/src/App.tsx");
  const menu = app.slice(app.indexOf("const MENU_ICONS"), app.indexOf("};", app.indexOf("const MENU_ICONS")));
  for (const item of MENU_ITEMS) {
    const icon = new RegExp(`\\b${item}: "([a-z0-9-]+)"`).exec(menu)?.[1];
    assert.ok(icon && names.has(icon), `menu item ${item}`);
  }
  assert.match(app, /<Icon name=\{MENU_ICONS\[item\]\} \/><span class="nav-word">\{words\}<\/span>/, "each link: its icon, then its words");
  const tabKeys = /export type TabKey = ([^;]+);/.exec(read("apps/manager/src/phone_tabs.ts"))![1]!.match(/[a-z]+/g)!;
  const tabs = app.slice(app.indexOf("const TAB_ICONS"), app.indexOf("};", app.indexOf("const TAB_ICONS")));
  for (const k of tabKeys) assert.match(tabs, new RegExp(`\\b${k}: MENU_ICONS\\.${k}\\b`), `phone tab ${k}: the same icon as its menu item`);
  const bar = read("apps/member/src/TabBar.tsx");
  const icons = /const icons: Record<TabKey, IconName> = \{([^}]+)\}/.exec(bar)![1]!;
  for (const k of /export type TabKey = ([^;]+);/.exec(read("apps/member/src/tabs.ts"))![1]!.match(/[a-z]+/g)!) {
    const icon = new RegExp(`\\b${k}: "([a-z0-9-]+)"`).exec(icons)?.[1];
    assert.ok(icon && names.has(icon), `members' tab ${k}`);
  }
  assert.match(bar, /<Icon name=\{icons\[x\.key\]\} \/>\n\s*<span>\{t\(names\[x\.key\]\)\}<\/span>/, "the tab's name stays under its icon");
});

test("a status shows its icon beside its words: paid, waiting and cancelled each their own", () => {
  assert.equal(statusIcon("paid"), "circle-check-big");
  assert.equal(statusIcon("pending"), "hourglass"); assert.equal(statusIcon("waitlist"), "hourglass");
  assert.equal(statusIcon("cancelled"), "circle-x"); assert.equal(statusIcon("failed"), "circle-x");
  assert.equal(statusIcon("something_new"), null);
  for (const s of ["paid", "pending", "cancelled", "unpaid", "upcoming", "in_progress"]) assert.ok(names.has(statusIcon(s)!), s);
});

test("nothing says a bare Loading: each place shows a skeleton in the shape of what's coming", () => {
  for (const { f, src } of sources) if (!f.endsWith("Skeleton.tsx")) assert.doesNotMatch(src, /"ui\.loading"/, `${f} still shows the word`);
  const shapes = { page: 0, rows: 0, card: 0, line: 0 } as Record<string, number>;
  for (const { src } of sources) for (const m of src.matchAll(/<Skeleton(?: shape="(\w+)")?/g)) shapes[m[1] ?? "page"]! += 1;
  assert.ok(shapes.page! >= 50 && shapes.rows! >= 15 && shapes.card! >= 5 && shapes.line! >= 3, JSON.stringify(shapes));
});

test("a skeleton waits a moment, is marked busy, keeps the word for screen readers and shimmers only with motion", () => {
  const src = read("packages/ui/src/Skeleton.tsx");
  assert.match(src, /export const SKELETON_DELAY_MS = 150;/);
  assert.match(src, /setTimeout\(\(\) => setShown\(true\), SKELETON_DELAY_MS\)/);
  assert.match(src, /<span class="visually-hidden" role="status">\{t\("ui\.loading"\)\}<\/span>/);
  assert.equal(src.match(/aria-busy="true"/g)?.length, 4, "every shape");
  const css = read("packages/ui/src/styles.css");
  assert.match(css, /\.skel-bar \{[^}]*animation: skel-shimmer/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.skel-bar, \.skel-shown \{ animation: none; \} \}/);
  assert.ok(existsSync(`${root}packages/ui/src/Skeleton.tsx`));
});

test("an icon waiting for its shapes keeps its 1em box, so nothing moves when they arrive", () => {
  const src = read("packages/ui/src/Icon.tsx");
  const body = src.slice(src.indexOf("export function Icon("), src.indexOf("/** A status's icon"));
  // Always the same <svg>, shapes or not: no early return while they load, and its size on the element itself (so it
  // holds even before the stylesheet), filled in place once the shapes come.
  assert.doesNotMatch(body, /if \(!all\) return/);
  assert.equal(body.match(/return \(/g)?.length, 1, "one thing drawn, whether the shapes are in or not");
  assert.match(body, /<svg class=\{`icon[^>]*width="1em" height="1em"/);
  assert.match(body, /\{all\?\.\[name\]\.map\(/);
  // And the stylesheet keeps the box: inline-block, 1em by 1em, never shrunk in a row; no rule anywhere hides an empty one
  // or sizes an icon any other way than by its font size.
  const css = (read("packages/ui/src/styles.css") + read("apps/member/src/member.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.icon \{ display: inline-block; flex: none; width: 1em; height: 1em;/);
  for (const m of css.matchAll(/([^{}]*\.icon\b[^{}]*)\{([^}]*)\}/g)) {
    const [sel, rule] = [m[1]!.trim(), m[2]!];
    if (/button\.icon/.test(sel) || sel === ".icon") continue;
    assert.doesNotMatch(rule, /(^|;)\s*(width|height|display|min-width|min-height)\s*:/, `${sel} sizes or hides an icon`);
  }
  assert.doesNotMatch(css, /svg:empty|\.icon:empty/);
});
