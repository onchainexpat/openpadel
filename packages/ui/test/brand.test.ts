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

test("the fill and the text on it read at 4.5:1 for any colour; only a mid-tone neither reads on is darkened", () => {
  // A grid of colours (red and green in steps of 51, blue in steps of 17): very light, very dark, greys, saturated, mid-tones.
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 17) {
    const colour = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, x = brandColours(colour)!;
    assert.ok(contrastOf(x.onBrand, x.fill) >= 4.5, `${colour}: ${x.onBrand} on ${x.fill} reads ${contrastOf(x.onBrand, x.fill)}`);
    if (x.fill !== colour) assert.ok(contrastOf("#ffffff", colour) < 4.5 && contrastOf("#111111", colour) < 4.5, `${colour} darkened only when it had to be`);
  }
  // Kept as they are: the default green (white text), a very light one and yellow (dark text), a very dark one.
  for (const [colour, on] of [["#0b5a55", "#ffffff"], ["#fdfdf0", "#111111"], ["#f5c518", "#111111"], ["#050a08", "#ffffff"]] as const)
    assert.deepEqual([brandColours(colour)!.fill, brandColours(colour)!.onBrand], [colour, on]);
  // A mid-tone grey neither white nor near-black reads on at 4.5:1: darkened until white does, and no further than needed.
  const mid = brandColours("#777777")!;
  assert.ok(contrastOf("#ffffff", "#777777") < 4.5 && contrastOf("#111111", "#777777") < 4.5);
  assert.notEqual(mid.fill, "#777777"); assert.equal(mid.onBrand, "#ffffff");
  assert.ok(contrastOf("#ffffff", mid.fill) < 5.2, `not darker than it has to be: ${mid.fill}`);
});
