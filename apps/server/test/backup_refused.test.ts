// A backup that can't be made leaves nothing behind: on the trial, a restore refused because the copy of the
// database as it was couldn't be made (a table the kumi user couldn't read) left its .part file in the backups folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeBackup } from "../src/backups.ts";

const { db, drop } = await freshDb();
after(async () => { await drop(); });

test("a dump that fails leaves no .part file", async () => {
  const bin = mkdtempSync(join(tmpdir(), "kumi-pgbin-")), dir = mkdtempSync(join(tmpdir(), "kumi-backups-"));
  writeFileSync(join(bin, "pg_dump"), "#!/bin/sh\necho 'pg_dump: error: query failed: ERROR:  permission denied for table mine' >&2\nexit 1\n");
  chmodSync(join(bin, "pg_dump"), 0o755);
  await assert.rejects(makeBackup(db, { url: "postgres://x@127.0.0.1/x", dir, label: "20261103T0300Z-before-restore", env: { KUMI_PG_BIN: bin } }), /permission denied/);
  assert.deepEqual(readdirSync(dir), []);
});
