// Every button the staff and members' apps hide behind mayDo is an action /me tells them about (CLIENT_ACTIONS):
// one missing reads as "not allowed" for anyone sent `can` (a coach, a role the club made), whatever their roles give.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAction } from "@kumi/core";
import { CLIENT_ACTIONS } from "../src/app.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === "node_modules" ? [] : files(p)) : /\.tsx?$/.test(f) ? [p] : [];
});
const sources = ["apps/manager/src", "apps/member/src", "packages/ui/src"].flatMap((d) => files(join(root, d))).map((p) => ({ p, text: readFileSync(p, "utf8") }));

test("every action a mayDo call names (or a wrapper around it) is in CLIENT_ACTIONS, and is a real action", () => {
  // Wrappers like Courts' `const mayHere = (action: string) => mayDo(action) && ...`.
  const wrappers = new Set(["mayDo"]);
  for (const { text } of sources) for (const m of text.matchAll(/const (\w+) = \((\w+)(?::[^)]*)?\) => mayDo\(\2\)/g)) wrappers.add(m[1]!);
  const named = new Set<string>(), loose: string[] = [];
  for (const { p, text } of sources) {
    for (const w of wrappers) for (const m of text.matchAll(new RegExp(`\\b${w}\\(([^)]*)\\)`, "g"))) {
      const arg = m[1]!.trim(), lit = /^"([a-z_]+\.[a-z_]+)"$/.exec(arg);
      if (lit) named.add(lit[1]!);
      // The definition of mayDo and the wrappers' own pass-through are the only calls without a name in them.
      else if (!(w === "mayDo" && /^\w+$/.test(arg) && new RegExp(`=> mayDo\\(${arg}\\)`).test(text)) && !text.includes(`export const mayDo = (${arg}`)) loose.push(`${p}: ${m[0]}`);
    }
  }
  assert.deepEqual(loose, [], "mayDo calls must name the action as a string, so this test can check it");
  assert.ok(named.size > 30, `found ${named.size}`);
  const missing = [...named].filter((a) => !CLIENT_ACTIONS.includes(a)).sort();
  assert.deepEqual(missing, [], "add these to CLIENT_ACTIONS (apps/server/src/app.ts)");
  for (const a of CLIENT_ACTIONS) assert.doesNotThrow(() => getAction(a), a);
});
