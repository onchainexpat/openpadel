// The tab, its history and the share sheet name the club, never a product (phone run 8 found "Kumi" there,
// on a club running openPadel itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageTitle } from "../src/title.ts";

test("the members' app is called by the club's name, the staff app by it and Staff, as their installed names are", () => {
  assert.equal(pageTitle("Kestrel Padel", "member"), "Kestrel Padel");
  assert.equal(pageTitle(" Kestrel Padel ", "staff"), "Kestrel Padel Staff");
});

test("before the club is known, the pages' own titles name no product", () => {
  for (const app of ["member", "manager"]) {
    const html = readFileSync(new URL(`../../../apps/${app}/index.html`, import.meta.url), "utf8");
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    assert.ok(title.length > 0, `${app} has a title`);
    assert.doesNotMatch(title, /kumi|openpadel/i, `${app}'s title: ${title}`);
  }
});
