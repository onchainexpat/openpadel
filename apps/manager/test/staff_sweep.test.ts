// What the staff app's browser check of 6 Nov 2026 found and left for later: Undo offered on every change, the
// Reports table of payments found with no column names and a date over three lines, still-booked rows with nowhere
// to go, a person page scrolling sideways in Spanish on a phone, and small toggles and checkboxes on a touch screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const css = readFileSync(join(import.meta.dirname, "../../../packages/ui/src/styles.css"), "utf8");
const coarse = /@media \(pointer: coarse\) \{\n([\s\S]*?)\n\}/.exec(css.slice(css.indexOf("every control is at least 44 px")))?.[1] ?? "";

test("Changes shows Undo only where the server says it can work", () => {
  const page = src("Changes.tsx");
  assert.match(page, /\{r\.can_undo && <button class="small" onClick=\{\(\) => previewUndo\(r\.id\)\}>/);
  assert.doesNotMatch(page, /r\.status === "applied" && r\.action !== "action\.undo"/, "the old rule offered Undo on receipts, alerts and money sent");
});

test("Reports' payments found: column names on a wide screen, the date on one line", () => {
  const page = src("Reports.tsx");
  const section = page.slice(page.indexOf('t("ui.found_title")'), page.indexOf('t("ui.still_booked_title")'));
  assert.match(section, /<div class="table-scroll"><table class="stack">/, "styled like the other Reports tables, which keep each cell on one line");
  assert.match(section, /<thead><tr><th>\{t\("ui\.col_date"\)\}<\/th><th>\{t\("ui\.col_total"\)\}<\/th><th>\{t\("ui\.found_who"\)\}<\/th><th>\{t\("ui\.found_col_next"\)\}<\/th><\/tr><\/thead>/);
  assert.match(section, /<td class="wrap" data-label=\{t\("ui\.found_who"\)\}>/, "only the long who-and-what column wraps");
  assert.match(css, /\.table-scroll td\.wrap \{ white-space: normal;/);
});

test("each still-booked row opens where it's settled", () => {
  const page = src("Reports.tsx");
  assert.match(page, /<a href=\{`\/people\/\$\{b\.person_id\}#booking-\$\{b\.booking_id\}`\}>\{t\("ui\.still_booked_booking"/);
  assert.match(page, /<a href=\{`\/programs\/\$\{p\.program_id\}`\}>\{t\("ui\.still_booked_place"/);
  const person = src("Person.tsx");
  assert.match(person, /<li class="row" key=\{b\.id\} id=\{`booking-\$\{b\.id\}`\}>/, "the booking it links to has that id");
  assert.match(person, /location\.hash\.startsWith\("#booking-"\)\) document\.getElementById\(location\.hash\.slice\(1\)\)\?\.scrollIntoView/);
});

test("a row of a list wraps rather than pushing the page sideways", () => {
  assert.match(css, /li\.row, div\.row \{ display: flex; flex-wrap: wrap;/);
  assert.match(css, /li\.row > \*, div\.row > \* \{ min-width: 0; \}/);
});

test("on a touch screen, toggles are 44 px tall and every checkbox is the larger size", () => {
  assert.ok(coarse, "the touch-screen rules");
  assert.match(coarse, /summary \{ min-height: 44px;/);
  assert.match(coarse, /input\[type="checkbox"\], input\[type="radio"\] \{ width: 24px; height: 24px; min-width: 24px; min-height: 24px; \}/);
});

test("a checkbox or choice keeps its size beside a long label (phone run 7: 13 of 46 in Settings were squeezed)", () => {
  assert.match(css, /input\[type="checkbox"\], input\[type="radio"\] \{ flex-shrink: 0; \}/);
});
