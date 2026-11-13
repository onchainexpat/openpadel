// The start screen and the short welcomes (boot.ts, Greeting.tsx, greet.ts, the apps' index.html and CSS): the welcome
// plays once, for the right people; less motion asked for means a fade at most; and every animation moves only
// transform and opacity, which a mid-range phone's compositor keeps smooth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GREET_MS, greetFor, lessMotion } from "../src/greet.ts";

const root = new URL("../../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");

test("the welcome plays at a first sign-in only, in each app on its own, and not over the welcome for members who moved in", () => {
  assert.deepEqual(greetFor("member", { greet_member: true }), { play: true, note: true });
  assert.deepEqual(greetFor("member", { greet_member: false }), { play: false, note: false }, "played once: never again");
  assert.deepEqual(greetFor("staff", { greet_member: true, greet_staff: false }), { play: false, note: false });
  assert.deepEqual(greetFor("staff", { greet_staff: true }), { play: true, note: true });
  assert.deepEqual(greetFor("member", { greet_member: true, welcome: true }), { play: false, note: true }, "the moved-in welcome instead, noted all the same");
  assert.deepEqual(greetFor("member", { greet_member: true, gate: "verify" }), { play: false, note: false }, "not on half a sign-in");
  assert.deepEqual(greetFor("member", null), { play: false, note: false });
});

test("less motion: read from the phone's setting, and false where there's no way to ask", () => {
  assert.equal(lessMotion((q) => ({ matches: q === "(prefers-reduced-motion: reduce)" })), true);
  assert.equal(lessMotion(() => ({ matches: false })), false);
  assert.equal(lessMotion(undefined), false);
});

/** The rules inside `@media (prefers-reduced-motion: reduce) { ... }` blocks of a stylesheet. */
const reduced = (css: string) => [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n")
  + [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^\n]*)\}\s*$/gm)].map((m) => m[1]).join("\n");
/** Each @keyframes block's name and the properties it changes. */
const keyframes = (css: string) => [...css.matchAll(/@keyframes ([\w-]+) \{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)]
  .map((m) => ({ name: m[1]!, props: [...m[2]!.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]!) }));

test("with less motion the welcome only fades, the start screen's dots keep still, and the moved-in welcome only fades in", () => {
  const ui = read("packages/ui/src/styles.css"), member = read("apps/member/src/member.css");
  const r = reduced(ui);
  assert.match(r, /\.greet-mark, \.greet-title, \.greet-sub \{ animation: none; \}/);
  assert.match(r, new RegExp(`\\.greet \\{ animation-duration: ${GREET_MS.still}ms; \\}`), "the fade's length matches GREET_MS.still");
  assert.match(ui, new RegExp(`\\.greet \\{[^}]*animation: greet-show ${GREET_MS.motion}ms`), "the full welcome's length matches GREET_MS.motion");
  assert.ok(GREET_MS.motion <= 1200, "about a second at most");
  assert.match(reduced(member), /\.welcome > \*, \.welcome \.club-head \.monogram \{ animation: welcome-fade/);
  for (const a of ["member", "manager"]) assert.match(read(`apps/${a}/index.html`), /@media \(prefers-reduced-motion: reduce\) \{ \.boot-dots i \{ animation: none;/);
});

test("every animation changes only transform, opacity (and visibility, to show a message): nothing that lays the page out again", () => {
  const sheets = ["packages/ui/src/styles.css", "apps/member/src/member.css", "apps/member/index.html", "apps/manager/index.html"];
  const found: string[] = [];
  for (const s of sheets) for (const k of keyframes(read(s))) {
    if (!/^(greet|welcome|boot)-/.test(k.name)) continue;
    found.push(k.name);
    for (const p of k.props) assert.ok(["transform", "opacity", "visibility"].includes(p), `${s} @keyframes ${k.name} changes ${p}`);
  }
  for (const n of ["greet-show", "greet-grow", "greet-rise", "greet-skip", "welcome-rise", "welcome-grow", "welcome-fade", "boot-in", "boot-pulse", "boot-show"]) assert.ok(found.includes(n), n);
});

test("the welcome never takes focus or hides the page from a screen reader", () => {
  const g = read("packages/ui/src/Greeting.tsx");
  for (const bad of ["focus(", "inert", "aria-hidden", "aria-modal", "tabIndex", "tabindex"]) assert.ok(!g.includes(bad), `Greeting.tsx: ${bad}`);
  assert.match(g, /role="status"/, "the welcome is read out once");
  assert.match(g, /addEventListener\("keydown"/, "a key ends it, as a tap does");
});
