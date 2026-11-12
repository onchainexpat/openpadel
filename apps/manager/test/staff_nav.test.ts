// The staff app's menu down the left and the Schedule as home (11 Nov 2026): every link keeps the role check it had in
// the old row of links, the grid's colours and day figures come from what the server sends, and nothing on the
// Schedule offers money or a change to someone whose roles don't allow it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayStats, kindOf } from "../src/day_stats.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");

test("each menu link is shown only to the roles that read its area, as before", () => {
  const app = src("App.tsx");
  const gates: [string, string][] = [
    ['show("bookings")', "/courts"], ["coach", "/schedule"], ['show("members")', "/people"], ['show("programs")', "/programs"], ['show("money")', "/payments"],
    ['show("memberships")', "/memberships"], ['coach || desk || areas?.includes("coaches")', "/coaches"], ['show("levels")', "/levels"], ['show("levels")', "/scores"],
    ["messages", "/messages"], ['show("members") && club.value?.players_chat', "/chats"], ["me.value?.playtomic", "/playtomic"], ['show("money") || coachSide', "/reports"],
    ["changes", "/usage"], ["changes", "/changes"], ['show("settings")', "/settings"], ["true", "/profile"],
  ];
  for (const [gate, href] of gates) assert.ok(app.includes(`{link(${gate}, "${href}"`), `${href} behind ${gate}`);
  assert.match(app, /const messages = desk \|\| Boolean\(areas\?\.includes\("messages"\)\);/);
  assert.match(app, /\{messages && <li><QuestionsLink /, "Questions, with its badge, for the desk and message roles only");
  assert.match(app, /<li><InboxLink current=/);
  // The old top row of links is gone: one menu, not two.
  assert.doesNotMatch(app, /<nav>\{coach && <a href="\/schedule">/);
});

test("the Schedule is home for those who read bookings; a coach keeps their own schedule and the accountant the reports", () => {
  const app = src("App.tsx");
  assert.match(app, /const home = areas \? \(coach \? Schedule : areas\.includes\("bookings"\) \? Courts : areaHome\[areas\[0\] \?\? ""\] \?\? Profile\)\n\s+: desk \? Courts : coach \? Schedule : roles\.includes\("accountant"\) \? Reports : show\("bookings"\) \? Courts : Programs;/);
  // Old addresses still open what they did.
  for (const path of ["/courts", "/people", "/programs", "/schedule"]) assert.ok(app.includes(`<Route path="${path}"`), path);
});

test("the menu over the page on a phone: a real button opens it, Escape and the back button close it", () => {
  const app = src("App.tsx");
  assert.match(app, /<button type="button" class="menu-button" aria-expanded=\{shown\} aria-controls="staff-menu"/);
  assert.match(app, /useBackCloses\(shown, close\);\n\s+const rail = useDrawer<HTMLDivElement>\(shown, close, true\);/);
  const drawer = src("drawer.ts");
  assert.match(drawer, /if \(e\.key === "Escape"\)/);
  assert.match(drawer, /if \(trap && before && document\.contains\(before\)\) before\.focus\(\);/, "focus goes back where it was");
});

test("on the grid, owed money shows only to those who see what members paid, and + Create offers only what the role may do", () => {
  const courts = src("Courts.tsx");
  assert.match(courts, /\{g\.money !== false && isBooking\(it\) && unpaid\(it\) > 0 && <span class="pill-unpaid">/);
  assert.match(courts, /const here = coversLocation\(shown\);\n\s+const programs = mayCreate\("program\.create"\), desk = here && mayCreate\("booking\.create"\), courts = open && desk;/);
  assert.match(courts, /courts && mayCreate\("booking\.repeat"\) && \{ key: "weekly"/);
  assert.match(courts, /open && here && mayCreate\("court\.block"\) && \{ key: "block"/);
  // mayCreate asks /me's `creates` too, which counts built-in roles: a front desk isn't offered a program.
  assert.match(readFileSync(join(import.meta.dirname, "../../../packages/ui/src/state.ts"), "utf8"), /export const mayCreate = \(action: string\) => mayDo\(action\) && \(me\.value\?\.creates\?\.includes\(action\) \?\? true\);/);
  // The Create button is there only when at least one choice can be made.
  assert.match(courts, /\{choices\.some\(\(x\) => x\.items\.some\(\(i\) => !i\.soon\)\) && <button type="button" class="primary sched-create"/);
  // The Programs form opened from Create is still behind the same check.
  assert.match(src("Programs.tsx"), /KINDS\.includes\(asked\) && mayCreate\("program\.create"\) \? asked : ""/);
  assert.match(src("Programs.tsx"), /\{mayCreate\("program\.create"\) && <button onClick=\{\(\) => setOpen\(!open\)\}/);
});

const at = (h: string) => `2026-11-11T${h}:00Z`;
test("each thing on the grid has its kind: lessons, clinics and courses for learning; socials, leagues and tournaments are events", () => {
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "booking", booking_kind: "court" }), "booking");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "booking", booking_kind: "court", open_match: true }), "open_match");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "booking", booking_kind: "lesson" }), "learning");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "session", program_kind: "course" }), "learning");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "session", program_kind: "league" }), "event");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "block" }), "blocked");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "mirror" }), "playtomic");
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "hold" }), "hold");
  // A coach's view of someone else's booking: only "booked", still a court booking.
  assert.equal(kindOf({ start: at("10:00"), end: at("11:00"), kind: "booking" }), "booking");
});

test("the day's occupancy counts court time inside each court's hours, less what's blocked; bookings are counted once", () => {
  const open = { opens: at("08:00"), closes: at("18:00") };   // 10 hours a court
  const s = dayStats([
    { id: "c1", open, items: [
      { start: at("07:00"), end: at("09:00"), kind: "booking", booking_id: "b1" },   // 1 hour of it inside the hours
      { start: at("10:00"), end: at("12:00"), kind: "session" },
      { start: at("12:00"), end: at("13:00"), kind: "hold", booking_id: "h1" },     // still being paid for: not yet
      { start: at("16:00"), end: at("18:00"), kind: "block" }] },
    { id: "c2", open, items: [{ start: at("09:00"), end: at("10:00"), kind: "mirror" }, { start: at("11:00"), end: at("12:00"), kind: "booking" }] },
    { id: "c3", open: null, items: [] },
  ]);
  // Used 1 + 2 + 1 + 1 = 5 hours, of 20 open less 2 blocked = 18.
  assert.deepEqual(s, { percent: 28, bookings: 3 });
  assert.deepEqual(dayStats([]), { percent: 0, bookings: 0 });
});
