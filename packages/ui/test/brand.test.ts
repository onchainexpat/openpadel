// A club's colour stays readable on both themes (brand.ts): the dark-mode links the real-phone run found at 2.25:1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { brandColours, contrastOf } from "../src/brand.ts";

const LIGHT = ["#f6f6f2", "#ffffff"], DARK = ["#121715", "#1b2220"];
test("links, outlines and notes read at 4.5:1 on both themes, whatever colour the club picks", () => {
  for (const colour of ["#0B5A55", "#1D4ED8", "#F5C518", "#111111", "#E11D48", "#7FDBCA"]) {
    const b = brandColours(colour)!;
    for (const bg of LIGHT) assert.ok(contrastOf(b.inkLight, bg) >= 4.5, `${colour} on ${bg}: ${contrastOf(b.inkLight, bg)}`);
    for (const bg of DARK) assert.ok(contrastOf(b.inkDark, bg) >= 4.5, `${colour} on ${bg} (dark): ${contrastOf(b.inkDark, bg)}`);
    assert.ok(contrastOf(b.onBrand, colour) >= 4.5 || b.onBrand === "#111111", `text on ${colour}`);
  }
});
test("a colour that already reads stays as it is; Kumi's green gets lighter only on the dark theme", () => {
  const g = brandColours("#0B5A55")!;
  assert.equal(g.inkLight, "rgb(11 90 85)");
  assert.ok(contrastOf("#0B5A55", "#121715") < 4.5 && contrastOf(g.inkDark, "#121715") >= 4.5);
  assert.equal(brandColours("#F5C518")!.onBrand, "#111111", "dark text on a yellow button");
  assert.equal(brandColours("#0B5A55")!.onBrand, "#ffffff");
  assert.equal(brandColours("teal"), null, "a named colour is used as it is, without tints");
});
