// While the club's app is read-only or has moved (read_only.ts), the members' app doesn't offer what the server would
// refuse: each button that books, joins or signs up sits in NewOnly, which says why in its place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { READ_ONLY_ALLOWED } from "../../../packages/core/src/read_only.ts";

const src = join(import.meta.dirname, "../src");
const files = Object.fromEntries(readdirSync(src).filter((f) => f.endsWith(".tsx")).map((f) => [f, readFileSync(join(src, f), "utf8")]));
/** What starts something new, as the buttons call it: straight from the button, or through the page's book(). */
const NEW = ["booking.join", "booking.join_players", "booking.ask", "enrolment.join", "enrolment.join_dates", "membership.join", "booking.request", "booking.request_courts", "lesson.request"];

test("everything those buttons start is refused while read-only, so hiding them hides nothing that works", () => {
  for (const a of NEW) assert.equal(READ_ONLY_ALLOWED.has(a), false, a);
});

test("each button that books, joins or signs up is inside NewOnly", () => {
  let buttons = 0;
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      // A button that previews one of them itself, or calls the page's book() or bookCart() that does.
      const direct = NEW.some((a) => line.includes(`preview("${a}"`)) && line.includes("<button");
      const via = /<button[^>]*onClick=\{(book|bookCart)\}/.test(line);
      if (!direct && !via) return;
      buttons++;
      assert.ok(line.includes("<NewOnly"), `${file}:${i + 1} isn't inside NewOnly`);
    });
  }
  assert.ok(buttons >= 9, `found only ${buttons} buttons: the check no longer matches the pages`);
});
