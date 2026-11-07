// Writes docs/cli/reference.md: every club command of the command line (cli_commands.ts), made from the actions and
// reads the assistant door offers, with who may do each with the club's built-in roles as the migrations make them.
// Run after changing an action, its input or a role's grants: `node tools/gen_cli_reference.ts`; `--check` only says
// whether the file is current (exit 1 if not). Needs the test database (KUMI_TEST_ADMIN_URL), as the tests do.
import { readFileSync, writeFileSync } from "node:fs";
import { freshDb } from "../packages/core/test/helpers.ts";
import { builtInGrants } from "../apps/server/src/cli_reference.ts";
import { referenceMarkdown } from "../apps/server/src/cli_commands.ts";

const file = new URL("../docs/cli/reference.md", import.meta.url).pathname;
const { db, drop } = await freshDb();
try {
  const md = referenceMarkdown(await builtInGrants(db));
  const now = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
  if (process.argv.includes("--check")) { console.log(now === md ? "docs/cli/reference.md is current" : "docs/cli/reference.md is out of date: run node tools/gen_cli_reference.ts"); process.exitCode = now === md ? 0 : 1; }
  else { writeFileSync(file, md); console.log(`wrote docs/cli/reference.md (${md.split("\n").length} lines)`); }
} finally { await drop(); }
