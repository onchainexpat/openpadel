// docs/cli/reference.md is made from the catalogue (tools/gen_cli_reference.ts): it fails here when an action, its
// input, a read or a built-in role's grants changed and the reference wasn't made again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { actions, type Db } from "@kumi/core";
import { builtInGrants } from "../src/cli_reference.ts";
import { commands, findCommand, parseInput, referenceMarkdown } from "../src/cli_commands.ts";
import { globalsOf } from "../src/cli_remote.ts";

let db: Db, drop: () => Promise<void>;
before(async () => { ({ db, drop } = await freshDb()); });
after(async () => drop());

test("docs/cli/reference.md is current: node tools/gen_cli_reference.ts makes it again", async () => {
  const want = referenceMarkdown(await builtInGrants(db));
  const have = readFileSync(new URL("../../../docs/cli/reference.md", import.meta.url), "utf8");
  if (have !== want) {
    const a = have.split("\n"), b = want.split("\n"), i = a.findIndex((l, n) => l !== b[n]);
    assert.fail(`docs/cli/reference.md is out of date (first difference at line ${i + 1}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}). Run: node tools/gen_cli_reference.ts`);
  }
});

test("every command is in the reference, and none has a flag spelled twice or a name that's another's start", () => {
  const md = readFileSync(new URL("../../../docs/cli/reference.md", import.meta.url), "utf8");
  for (const c of commands()) assert.ok(md.includes(`openpadel ${c.words.join(" ")}\n`), c.words.join(" "));
  const words = commands().map((c) => c.words.join(" "));
  assert.equal(new Set(words).size, words.length);
  for (const w of words) assert.ok(!words.some((x) => x.startsWith(`${w} `)), `${w} is the start of another command`);
  assert.ok(!/—/.test(md), "no em dashes in what people read");
});

/** A line of shell as its words: "double quotes" and 'single' keep spaces. */
const words = (line: string) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
test("every openpadel command in the guide (docs/cli/README.md) is a real command with flags it takes", () => {
  const md = readFileSync(new URL("../../../docs/cli/README.md", import.meta.url), "utf8");
  // The command line's own commands, and the one server command the guide shows (sign-in-link, for an owner's first sign-in).
  const own = new Set(["login", "logout", "whoami", "clubs", "use", "confirm", "help", "schema", "sign-in-link"]);
  let checked = 0;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/^\$ /, "").replace(/\s+#.*$/, "").trim();
    if (!line.startsWith("openpadel ") || line.includes("<")) continue;
    const { rest } = globalsOf(words(line).slice(1));
    if (own.has(rest[0]!) || line === "openpadel waiver accept") continue;   // the guide's example of what's only done in the app
    const found = findCommand(rest);
    assert.ok(found, line);
    assert.doesNotThrow(() => parseInput(found!.cmd, found!.rest), line);
    checked++;
  }
  assert.ok(checked >= 10, `only ${checked} examples checked`);
});

test("every flag that takes JSON shows a whole example, and each example is one the command takes", () => {
  const ID = "0190f0f0-0000-7000-8000-000000000001";
  let checked = 0;
  for (const c of commands()) for (const p of c.props) {
    const takesJson = p.type === "object" || (p.type === "array" && (p.items === "object" || p.items === "array"));
    if (!takesJson) continue;
    assert.ok(p.json, `${c.words.join(" ")} --${p.key} has no example`);
    assert.match(p.json!.example, /^'.*'$/, "single-quoted, as it's typed");
    const value = JSON.parse(p.json!.example.slice(1, -1).replaceAll('"<id>"', JSON.stringify(ID)));
    if (c.kind === "action") {
      const def = actions().find((a) => a.name === c.action)!;
      const field = (def.input as any)._zod.def.shape[p.key];
      const r = field.safeParse(value);
      // A plugin's settings depend on the plugin: only their shape (names to values) is checked.
      assert.ok(r.success || p.key === "settings", `${c.words.join(" ")} --${p.key}: ${p.json!.example} is refused: ${JSON.stringify(r.error?.issues?.slice(0, 2))}`);
    }
    checked++;
  }
  assert.ok(checked >= 20, `only ${checked} checked`);
  const md = readFileSync(new URL("../../../docs/cli/reference.md", import.meta.url), "utf8");
  // The weekday numbering is said wherever a weekday is typed.
  for (const cmd of ["hours set", "court hours-set", "coach set-hours"]) {
    const at = md.indexOf(`#### openpadel ${cmd}\n`), section = md.slice(at, md.indexOf("\n#### ", at + 1));
    assert.match(section, /0 is Sunday, 1 Monday/, cmd);
    assert.match(section, /\{"weekday":\d,/, cmd);
  }
});
