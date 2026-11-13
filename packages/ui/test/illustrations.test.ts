// The line drawings (Illustration.tsx, styles.css, packages/ui/assets/illustrations): each one named has its file and
// its rule, the files stay small, none is hidden from the rule that hides it with less motion, and the start screen's
// "can't reach the club" drawing is inside the page itself, so it shows with no connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { bootArt, OFFLINE_ART, offlineArtUrl } from "../vite.ts";

const root = new URL("../../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");
const dir = "packages/ui/assets/illustrations";
const names = [...read("packages/ui/src/Illustration.tsx").match(/export type IllustrationName = ([^;]+);/)![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);

test("every drawing named has its file, its size on the page and its mask, and every file is small", () => {
  const css = read("packages/ui/src/styles.css");
  assert.ok(names.length >= 7, names.join());
  for (const n of names) {
    const rule = css.match(new RegExp(`\\.illus-${n} \\{([^}]*)\\}`))?.[1] ?? "";
    assert.match(rule, /aspect-ratio: \d+ \/ \d+/, `${n}: an aspect ratio, so the page doesn't move when it loads`);
    assert.ok(rule.includes(`-webkit-mask-image: url("../assets/illustrations/${n}.webp")`) && rule.includes(`mask-image: url("../assets/illustrations/${n}.webp")`), `${n}: its mask`);
  }
  for (const f of readdirSync(`${root}${dir}`).filter((x) => x.endsWith(".webp"))) {
    assert.ok(statSync(`${root}${dir}/${f}`).size < 25_000, `${f} is over 25 kB`);
    assert.ok(f === "offline.webp" || names.includes(f.replace(".webp", "")), `${f}: used`);
  }
  assert.match(read(`${dir}/README.md`), /original/i, "the README says where they come from");
  assert.match(read(`${dir}/README.md`), /AGPL-3\.0-only/, "and their licence");
});

test("drawings are decorative: hidden from screen readers, no motion when less is asked for", () => {
  const src = read("packages/ui/src/Illustration.tsx");
  assert.match(src, /return <span class=\{`illus illus-\$\{name\}.*\} aria-hidden="true" \/>;/);
  const css = read("packages/ui/src/styles.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.illus \{ animation: none; \} \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.greet \.greet-art \{ animation: none; \} \}/);
});

test("no drawing is part of the apps' first-screen code: a class, never an import of the picture", () => {
  for (const d of ["apps/member/src", "apps/manager/src", "packages/ui/src"]) for (const f of readdirSync(`${root}${d}`)) {
    if (!/\.tsx?$/.test(f)) continue;
    assert.ok(!/(from |import\(|new URL\().*assets\/illustrations/.test(read(`${d}/${f}`)), `${d}/${f} imports a drawing`);
  }
});

test("the start screen's offline drawing is written into both apps' page, as a data: URL", () => {
  const url = offlineArtUrl();
  assert.ok(url.startsWith("data:image/webp;base64,"));
  assert.deepEqual(Buffer.from(url.split(",")[1]!, "base64"), readFileSync(`${root}${dir}/offline.webp`));
  assert.ok(url.length < 8_000, `the page carries ${url.length} bytes for it`);
  for (const a of ["member", "manager"]) {
    const html = read(`apps/${a}/index.html`);
    assert.equal([...html.matchAll(new RegExp(`url\\(${OFFLINE_ART}\\)`, "g"))].length, 2, `${a}: mask and -webkit-mask`);
    assert.match(html, /<p class="boot-late" role="status"><span class="boot-art" aria-hidden="true"><\/span>/, `${a}: with the start screen's words`);
    assert.match(read(`apps/${a}/vite.config.ts`), /plugins: \[[^\]]*bootArt\(\)/, `${a}: the build fills it in`);
    const built = bootArt().transformIndexHtml.handler(html);
    assert.ok(!built.includes(OFFLINE_ART) && built.includes(`url(${url})`), `${a}: filled in`);
  }
});

test("Home's faint court drawing leaves the muted words over it at 4.5:1, for any club colour, on both themes", async () => {
  const { brandColours, contrastOf } = await import("../src/brand.ts");
  const css = read("packages/ui/src/styles.css");
  const light = Number(css.match(/\.illus-faint \{[^}]*opacity: ([\d.]+)/)![1]);
  const dark = Number(css.match(/@media \(prefers-color-scheme: dark\) \{ \.illus-faint \{ opacity: ([\d.]+); \} \}/)![1]);
  const vars = (scheme: string) => Object.fromEntries([...scheme.matchAll(/--(bg|muted|ink): (#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const root = vars(css.match(/^:root \{[^}]*\}/m)![0]), night = vars(css.match(/@media \(prefers-color-scheme: dark\) \{ :root \{[^}]*\}/)![0]);
  const nums = (c: string) => c.startsWith("#") ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.match(/\d+/g)!.map(Number);
  const over = (ink: string, bg: string, a: number) => `rgb(${nums(bg).map((v, i) => Math.round(v + (nums(ink)[i]! - v) * a)).join(" ")})`;
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const colour = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, c = brandColours(colour)!;
    for (const [ink, t, a] of [[c.inkLight, root, light], [c.inkDark, night, dark]] as const) {
      for (const words of [t.muted!, t.ink!]) assert.ok(contrastOf(words, over(ink, t.bg!, a)) >= 4.5, `${colour}: ${words} over the drawing`);
    }
  }
});
