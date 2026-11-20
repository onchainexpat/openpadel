// "Coming from" presets (presets.ts) are data that only rename and reorder: each one names every menu item and table
// column exactly once (so none is added or dropped), renames only menu items and page titles, by key in both
// languages, and starts staff only on a page their roles open. Who sees which link stays with each link's own check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../../../packages/i18n/src/en.ts";
import { es } from "../../../packages/i18n/src/es.ts";
import { COMING_FROM, comingFrom, DEFAULT_COMING_FROM } from "../../../packages/i18n/src/presets.ts";
import { BOOKING_COLUMNS, CUSTOMER_COLUMNS, HOME_PAGES, MENU_ITEMS, PRESETS, homeFor, labelKey, ordered, presetFor, type HomePage, type LabelKey } from "../src/presets.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const sorted = <T>(xs: readonly T[]) => [...xs].sort();

test("every preset has data, and only the five things a preset may set", () => {
  assert.deepEqual(sorted(Object.keys(PRESETS)), sorted(COMING_FROM));
  for (const [name, p] of Object.entries(PRESETS)) assert.deepEqual(sorted(Object.keys(p)), ["bookingColumns", "customerColumns", "home", "labels", "menu"], name);
  assert.equal(DEFAULT_COMING_FROM, "playtomic", "clubs from before the setting keep what they saw");
  assert.equal(presetFor(undefined), PRESETS.playtomic);
  assert.equal(presetFor("someday"), PRESETS.playtomic, "an unknown name reads as the default");
  assert.equal(comingFrom("none"), "none");
});

test("a preset orders the menu and the tables but never adds or drops an item or a column", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.deepEqual(sorted(p.menu.flat()), sorted(MENU_ITEMS), `${name}: every menu item once`);
    assert.deepEqual(sorted(p.bookingColumns), sorted(BOOKING_COLUMNS), `${name}: every Bookings column once`);
    assert.deepEqual(sorted(p.customerColumns), sorted(CUSTOMER_COLUMNS), `${name}: every Customers column once`);
    assert.ok((HOME_PAGES as readonly string[]).includes(p.home), name);
  }
  // A column a role doesn't get (the level, for someone who doesn't read levels) stays out in every order.
  for (const p of Object.values(PRESETS)) assert.ok(!ordered(p.customerColumns, CUSTOMER_COLUMNS.filter((c) => c !== "level")).includes("level"));
});

test("playtomic keeps today's words and order; none says openPadel's own plain words, in English and Spanish", () => {
  const say = (lang: Record<string, unknown>, name: keyof typeof PRESETS, k: LabelKey) => lang[labelKey(PRESETS[name], k)];
  assert.deepEqual(PRESETS.playtomic.labels, {});
  assert.deepEqual([say(en, "playtomic", "ui.nav_day_schedule"), say(en, "playtomic", "ui.nav_people"), say(en, "playtomic", "ui.nav_programs"), say(en, "playtomic", "ui.nav_bookings")],
    ["Schedule", "Customers", "Clinics, courses and events", "Bookings"]);
  assert.deepEqual([say(es, "playtomic", "ui.nav_day_schedule"), say(es, "playtomic", "ui.nav_people"), say(es, "playtomic", "ui.nav_programs")], ["Agenda", "Clientes", "Clínicas, cursos y eventos"]);
  assert.deepEqual([say(en, "none", "ui.nav_day_schedule"), say(en, "none", "ui.nav_people"), say(en, "none", "ui.people_title"), say(en, "none", "ui.nav_programs"), say(en, "none", "ui.nav_bookings")],
    ["Courts", "People", "People", "Programs", "Bookings"]);
  assert.deepEqual([say(es, "none", "ui.nav_day_schedule"), say(es, "none", "ui.nav_people"), say(es, "none", "ui.nav_programs")], ["Canchas", "Personas", "Programas"]);
  // Every word a preset uses is in both languages, and renames only a menu item or a page title.
  for (const p of Object.values(PRESETS)) for (const [k, w] of Object.entries(p.labels)) {
    assert.match(k, /^ui\.(nav_[a-z_]+|people_title)$/);
    assert.ok(`preset.${w}` in en && `preset.${w}` in es, w);
  }
});

test("a preset's first page is used only where the person's roles open it, and only in place of the courts' day", () => {
  const pages = (open: Partial<Record<HomePage, boolean>>) => Object.fromEntries(HOME_PAGES.map((h) => [h, { page: h, open: open[h] ?? false }])) as Record<HomePage, { page: string; open: boolean }>;
  for (const home of HOME_PAGES) {
    const p = { ...PRESETS.none, home };
    assert.equal(homeFor(p, "day", "day", pages({ day: true, [home]: true })), home);
    assert.equal(homeFor(p, "day", "day", pages({ day: true })), "day", "not open to them: the courts' day stays");
    assert.equal(homeFor(p, "reports", "day", pages({ day: true, [home]: true })), "reports", "the accountant keeps the reports");
    assert.equal(homeFor(p, "schedule", "day", pages({ [home]: true })), "schedule", "a coach keeps their own schedule");
  }
});

test("the staff app's role checks don't read the preset: menu links keep their checks, the routes theirs", () => {
  const app = src("App.tsx");
  const nav = app.slice(app.indexOf("function StaffNav"), app.indexOf("/** The page's frame"));
  // Each link's check is the first thing it's given; the preset only picks the order (`preset().menu`) and words (label).
  for (const m of nav.matchAll(/link\(([^,]+(?:,[^,"]+)*), "[a-z]+", "\//g)) assert.doesNotMatch(m[1]!, /preset|label/, m[0]);
  assert.equal((nav.match(/preset\(\)/g) ?? []).length, 1, "the menu's order is the preset's only part in the menu");
  const routes = app.slice(app.indexOf("<Router>"), app.indexOf("</Router>"));
  assert.doesNotMatch(routes, /preset/i, "who opens which page doesn't depend on the preset");
  assert.match(app, /const home = homeFor\(preset\(\), base, Courts, homePages\);/);
  assert.match(app, /people: \{ page: People, open: show\("members"\) \}, programs: \{ page: Programs, open: show\("programs"\) \}/);
});
