// Today and Approvals in the staff menu (14 Nov 2026): both for everyone but a coach on their own (the server sends each
// person only what their roles read, today.ts), with the menu's counts from one small read; Today is home only where the
// club's "Coming from" preset says so (openPadel's own words), and Playtomic clubs keep starting on the Schedule. The
// pages load when opened, so the first screen stays inside its budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "../src/presets.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");

test("Today and Approvals are menu links behind their checks, with counts from /staff/counts", () => {
  const app = src("App.tsx");
  assert.ok(app.includes('today: link(!coachOnly, "today", "/today", label("ui.nav_today"), on("/today") ?? home("today"), n.today)'));
  assert.ok(app.includes('approvals: link(!coachOnly || n.approvals > 0, "approvals", "/approvals", label("ui.nav_approvals"), on("/approvals"), n.approvals)'));
  assert.ok(app.includes('api<Counts>("/staff/counts")'));
  assert.ok(!app.includes("/staff/questions/count"), "the Questions badge reads the same counts, not a read of its own");
  // Loaded when opened (or fetched while the person looks at their first page), never in the first screen.
  assert.match(app, /const Today = lazyPage\(\(\) => import\("\.\/Today\.tsx"\)/);
  assert.match(app, /const Approvals = lazyPage\(\(\) => import\("\.\/Approvals\.tsx"\)/);
  assert.match(src("Courts.tsx"), /export const NewBooking = lazyPage\(/);
  assert.match(src("Courts.tsx"), /export const SessionPanel = lazyPage\(/);
});

test("Playtomic clubs keep the Schedule as home; openPadel's own words start on Today", () => {
  assert.equal(PRESETS.playtomic.home, "day");
  assert.equal(PRESETS.none.home, "today");
  assert.match(src("App.tsx"), /today: \{ page: Today, open: !coachOnly \}/);
});
