// Every time the apps show is on the club's clock, and every "now" they compare with is the server's: a member's
// phone can be set to another zone (travelling, or just wrong) or hours slow, and the club's times are the club's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const dirs = ["apps/member/src", "apps/manager/src", "packages/ui/src"];
const sources = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: `${d}/${f}`, text: readFileSync(join(root, d, f), "utf8") })));
const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
/** The text between a call's parentheses, from the "(" at `open`. */
function args(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

test("every date and time formatter names a time zone (clubTime gives the club's)", () => {
  const bad: string[] = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/new Intl\.DateTimeFormat\(/g)) {
      if (!args(text, m.index! + m[0].length - 1).includes("timeZone")) bad.push(`${file}:${lineOf(text, m.index!)}`);
    }
    for (const m of text.matchAll(/\.toLocale(Date|Time)String\(|new Date\([^()]*\)\.toLocaleString\(/g)) bad.push(`${file}:${lineOf(text, m.index!)}`);
  }
  assert.deepEqual(bad, [], `format these with clubTime (packages/ui/src/state.ts), or name the zone: ${bad.join(", ")}`);
});

test("the screens compare with the server's now (serverNow), never the phone's clock", () => {
  const bad: string[] = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/Date\.now\(\)|new Date\(\)/g)) {
      const line = text.split("\n")[lineOf(text, m.index!) - 1]!;
      // state.ts keeps the clock itself (serverNow, from the Date header) and a guard timed on the device alone.
      if (file === "packages/ui/src/state.ts" && /skew|RELOADED|serverNow = /.test(line)) continue;
      bad.push(`${file}:${lineOf(text, m.index!)}`);
    }
  }
  assert.deepEqual(bad, [], `use serverNow(): ${bad.join(", ")}`);
});

test("what staff type into a date and time box is read on the club's clock (clubMoment), never the device's", () => {
  const bad: string[] = [];
  for (const { file, text } of sources) {
    if (!text.includes('type="datetime-local"')) continue;
    // new Date(typed).toISOString() reads the box in the device's zone: 5 PM typed on a phone set to Asuncion was 1 PM at the club.
    for (const m of text.matchAll(/new Date\(([A-Za-z_][\w.[\]]*(?: \?\? "")?)\)\.toISOString\(\)/g)) bad.push(`${file}:${lineOf(text, m.index!)} new Date(${m[1]})`);
    if (!text.includes("clubMoment(")) bad.push(`${file}: has a date and time box but never uses clubMoment`);
  }
  assert.deepEqual(bad, [], `read typed dates and times with clubMoment (packages/ui/src/state.ts): ${bad.join(", ")}`);
});
