// A front desk kept to one location (Kelly, 8 Nov 2026) isn't shown buttons the server refuses it: the whole club's
// messages, groups, templates, facts and tag renames sit behind mayDo, which reads /me's `cannot`, and an alert at another
// location has no Handled button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const WHOLE_CLUB = ["broadcast.send", "broadcast.cancel", "segment.save", "segment.update", "template.save", "template.update", "fact.create", "fact.update", "tag.update"];

test("mayDo hides what /me says a role kept to one location can't do", () => {
  const state = readFileSync(join(import.meta.dirname, "../../../packages/ui/src/state.ts"), "utf8");
  assert.match(state, /export const mayDo = \(action: string\) => \(!me\.value\?\.can \|\| me\.value\.can\.includes\(action\)\) && !me\.value\?\.cannot\?\.includes\(action\);/);
});

test("every whole-club button in the staff app is behind mayDo for its own kind of change", () => {
  const bad: string[] = [];
  for (const f of ["Messages.tsx", "Questions.tsx"]) {
    const lines = src(f).split("\n");
    lines.forEach((line, n) => {
      for (const a of WHOLE_CLUB) {
        if (!line.includes(`"${a}"`) || !/preview\(/.test(line)) continue;
        // Its own line or the few above it (the opening of the block it's in) ask mayDo about the same kind. A helper
        // the page's forms call (save, send, form) is covered by the form's own mayDo, checked below.
        const near = lines.slice(Math.max(0, n - 3), n + 1).join("\n"), kind = a.split(".")[0];
        if (/const (save|send|form) = /.test(lines.slice(Math.max(0, n - 4), n + 1).join("\n"))) continue;
        if (!new RegExp(`mayDo\\("${kind}\\.`).test(near)) bad.push(`${f}:${n + 1} ${a}`);
      }
    });
  }
  assert.deepEqual(bad, []);
  // The two pages whose whole job is one of these say so instead of showing the form.
  assert.match(src("Messages.tsx"), /if \(!mayDo\("broadcast\.send"\)\) return <main>.*reason\.whole_club_messages/);
  assert.match(src("Messages.tsx"), /\{mayDo\("template\.save"\) && <section class="card">\n\s+<h2>\{t\("ui\.new_template"\)\}<\/h2>/);
  assert.match(src("Messages.tsx"), /\{mayDo\("segment\.save"\) && <section class="card">\n\s+<h2>\{t\("ui\.new_group"\)\}<\/h2>/);
  assert.match(src("Questions.tsx"), /\{mayDo\("fact\.create"\) \? <section class="card">/);
  assert.match(src("Questions.tsx"), /\{editing === f\.id && mayDo\("fact\.update"\) && <FactForm/);
  assert.match(src("Messages.tsx"), /\{editing === x\.id && mayDo\("template\.update"\) && form\(/);
  assert.match(src("Messages.tsx"), /href !== "\/messages\/new" \|\| mayDo\("broadcast\.send"\)/, "no New message tab");
  assert.match(src("Messages.tsx"), /\{mayDo\("tag\.update"\) && <span><button class="small" onClick=\{\(\) => setRenaming/, "no Rename or Stop using on a tag");
});

test("an alert at another location has no Handled button", () => {
  assert.match(src("Courts.tsx"), /\{mayDo\("alert\.handle"\) && x\.can_handle !== false && <button class="small" onClick=\{\(\) => preview\("alert\.handle"/);
});
