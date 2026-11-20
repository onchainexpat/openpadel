// A club open midnight to midnight says it's open all day, and a closing time at midnight is written the way the
// reader's clock writes times: 12:00 AM beside 7:00 AM, 24:00 beside 07:00, never "12:00 AM to 24:00".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allDay, clock, weekLines } from "../src/hours.ts";

const sp = (s: string) => s.replace(/\s/g, " ");
const words = { to: "to", closed: "Closed", allDay: "Open all day" };

test("midnight to midnight is all day, in the week's lines and on Home", () => {
  assert.equal(allDay("00:00", "24:00"), true); assert.equal(allDay("00:00", "00:00"), true);
  assert.equal(allDay("07:00", "24:00"), false); assert.equal(allDay(null, null), false);
  const week = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" }));
  assert.deepEqual(weekLines(week, "en-US", words), [{ days: "Mon to Sun", hours: "Open all day" }]);
  const home = readFileSync(new URL("../src/Home.tsx", import.meta.url), "utf8");
  assert.match(home, /allDay\(today\.opens, today\.closes\) \? t\("ui\.home_open_all_day"\)/);
  assert.match(home, /allDay: t\("ui\.open_all_day"\)/);
});

test("a closing time at midnight follows the reader's clock, so a line never mixes 12- and 24-hour times", () => {
  assert.equal(sp(clock("24:00", "en-US")), "12:00 AM");
  assert.equal(sp(`${clock("07:00", "en-US")} to ${clock("24:00", "en-US")}`), "7:00 AM to 12:00 AM");
  assert.equal(clock("24:00", "es-ES"), "24:00");
  assert.equal(clock("07:00", "es-ES"), "7:00");
  const late = [{ weekday: 5, opens: "08:00", closes: "24:00" }];
  for (const l of ["en-US", "es-MX", "es-ES", "en-GB"]) {
    const line = weekLines(late, l, words).find((r) => r.days.length && r.hours !== "Closed")!.hours;
    const twelve = /[AP]\.?\s?M\.?/i.test(line) || /a\.\s?m\.|p\.\s?m\./i.test(line);
    if (twelve) assert.doesNotMatch(line, /24:00/, `${l}: ${line}`); else assert.match(line, /24:00/, `${l}: ${line}`);
  }
});
