// The staff app's tabs at the bottom of a phone (phone_tabs.ts, PhoneTabs in App.tsx): the pages a person's roles open
// most, as the staff phone boards show them, with + opening the Schedule's + Create; the Menu stays for everything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phoneTabs, plusAt, tabIsOn, type TabAccess } from "../src/phone_tabs.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const keys = (a: TabAccess) => phoneTabs(a).map((x) => x.key);
const all = () => true;
const only = (...areas: string[]) => (x: string) => areas.includes(x);

test("a manager or the desk: Today, the Schedule, Approvals and Members, as ManagerToday shows", () => {
  assert.deepEqual(keys({ coachOnly: false, coach: false, desk: true, coachSide: false, show: all }), ["today", "day", "approvals", "people"]);
  // A manager who also coaches keeps the same four: their own schedule is in the Menu.
  assert.deepEqual(keys({ coachOnly: false, coach: true, desk: true, coachSide: false, show: all }), ["today", "day", "approvals", "people"]);
});

test("a coach on their own: their schedule, the courts' day, Levels and Programs, never a page their role doesn't open", () => {
  const coach = { coachOnly: true, coach: true, desk: false, coachSide: true, show: only("bookings", "programs", "levels", "coaches") };
  assert.deepEqual(keys(coach), ["schedule", "day", "levels", "programs"]);
  assert.ok(!keys(coach).includes("people") && !keys(coach).includes("approvals") && !keys(coach).includes("today"));
});

test("the accountant and a role the club made get only what they open, at most four", () => {
  assert.deepEqual(keys({ coachOnly: false, coach: false, desk: false, coachSide: false, show: only("money") }), ["today", "approvals", "reports", "profile"]);
  assert.deepEqual(keys({ coachOnly: false, coach: false, desk: false, coachSide: false, show: only("members") }), ["today", "approvals", "people", "profile"]);
  for (const show of [all, only(), only("bookings", "members", "programs", "levels", "money")])
    assert.ok(phoneTabs({ coachOnly: false, coach: true, desk: false, coachSide: true, show }).length <= 4);
});

test("a tab stays lit on the pages under it, and on / when it's the person's home", () => {
  const [today, day] = phoneTabs({ coachOnly: false, coach: false, desk: true, coachSide: false, show: all });
  assert.ok(tabIsOn(day!, "/courts?create=1", "/courts"));
  assert.ok(tabIsOn(day!, "/", "/courts") && !tabIsOn(today!, "/", "/courts"));
  assert.ok(!tabIsOn(today!, "/todayish", null));
  assert.equal(plusAt(4), 2); assert.equal(plusAt(1), 1);
});

test("on a phone only; + opens the Schedule's + Create, and the Menu at the top still opens everything", () => {
  const app = src("App.tsx"), courts = src("Courts.tsx"), css = readFileSync(join(import.meta.dirname, "../../../packages/ui/src/styles.css"), "utf8");
  assert.match(app, /\{narrow && <PhoneTabs a=\{a\} n=\{n\} \/>\}/);
  assert.match(app, /class="menu-button"/, "the Menu button stays");
  assert.match(app, /route\("\/courts\?create=1"\)/);
  assert.match(app, /dispatchEvent\(new Event\("kumi:create"\)\)/);
  assert.match(courts, /addEventListener\("kumi:create", open\)/);
  assert.match(courts, /useState\(query\.create === "1"\)/);
  // The page and the docked preview keep clear of the tabs, and the phone's home bar.
  assert.match(css, /body:has\(\.phone-tabs\) \.shell-main \{ padding-bottom: calc\(80px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(css, /body:has\(\.phone-tabs\) \.dock:not\(:empty\) \{ bottom: calc\(64px/);
  assert.match(css, /@media \(min-width: 900px\) \{ \.phone-tabs \{ display: none; \} \}/);
});
