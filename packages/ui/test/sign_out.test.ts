// Signing out goes through signOutHere (state.ts), which takes this device's notifications with it: a sign-out
// button that called the server itself would leave a shared phone getting the last person's messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const dirs = ["packages/ui/src", "apps/member/src", "apps/manager/src"];

test("every sign-out goes through signOutHere, which sends this device's push endpoint", () => {
  const bad: string[] = [];
  for (const d of dirs) for (const f of readdirSync(join(root, d)).filter((x) => /\.tsx?$/.test(x))) {
    const text = readFileSync(join(root, d, f), "utf8");
    if (text.includes('"/auth/sign-out"') && !(d === "packages/ui/src" && f === "state.ts")) bad.push(`${d}/${f}`);
  }
  assert.deepEqual(bad, []);
  const state = readFileSync(join(root, "packages/ui/src/state.ts"), "utf8");
  assert.match(state, /api\("\/auth\/sign-out", sub \? \{ endpoint: sub\.endpoint \} : \{\}\)/);
  assert.match(state, /sub\?\.unsubscribe\(\)/);
});
