// deploy/release.sh against a scratch folder, with stand-ins: the "database" is a file the Postgres stand-ins
// dump and restore, "migrations" append to it when the server starts, and curl answers /health with the release
// the app link points at, unless that release is marked broken.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../../deploy/release.sh", import.meta.url).pathname;
let t: string, root: string, stub: string, dbFile: string, envFile: string, backups: string;

function release(rev: string, marks: string[] = []): string {
  const dir = join(t, `src-${rev}`);
  mkdirSync(join(dir, "deploy"), { recursive: true });
  copyFileSync(script, join(dir, "deploy/release.sh"));
  for (const m of marks) writeFileSync(join(dir, m), "");
  const tar = join(t, `kumi-${rev}.tar`);
  assert.equal(spawnSync("tar", ["-cf", tar, "-C", dir, "."]).status, 0);
  return tar;
}
function sh(...args: string[]) {
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: {
    PATH: `${stub}:${process.env.PATH}`, KUMI_ROOT: root, KUMI_ENV_FILE: envFile, KUMI_BACKUP_DIR: backups, KUMI_PG_BIN: stub, KUMI_AS: "", KUMI_SYSTEM_FILES: "0",
    KUMI_CHECK_SECONDS: "3", KUMI_RESTART: `sh ${stub}/restart`, KUMI_STOP: "true", KUMI_INSTALL: "true", KUMI_BUILD: `sh ${stub}/build`, STUB_ROOT: root, STUB_DB: dbFile } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const running = () => readlinkSync(join(root, "app"));
const db = () => readFileSync(dbFile, "utf8");

before(() => {
  t = mkdtempSync(join(tmpdir(), "kumi-release-"));
  root = join(t, "opt"); stub = join(t, "bin"); dbFile = join(t, "db.txt"); envFile = join(t, "kumi.env"); backups = join(t, "backups");
  mkdirSync(stub); mkdirSync(join(root, "app/apps/member/dist"), { recursive: true }); mkdirSync(join(root, "app/apps/manager/dist"), { recursive: true });
  // A server from before releases were kept side by side: a plain app folder.
  writeFileSync(join(root, "app/REVISION"), "r1\n");
  for (const a of ["member", "manager"]) writeFileSync(join(root, `app/apps/${a}/dist/index.html`), "");
  writeFileSync(dbFile, "bookings: 1\n");
  writeFileSync(envFile, "NODE_ENV=production\nPORT=8790\nDATABASE_URL=postgresql://kumi@/kumi?host=/var/run/postgresql\n");
  const stubs: Record<string, string> = {
    // pg_dump ... -f <file> ...: the database file, copied.
    pg_dump: `while [ $# -gt 0 ]; do [ "$1" = -f ] && out="$2"; shift; done; cp "$STUB_DB" "$out"`,
    psql: `: > "$STUB_DB"`,
    pg_restore: `for a; do last="$a"; done; cp "$last" "$STUB_DB"`,
    // Starting the server: a release marked MIGRATE changes the database as it starts (once, as migrations do).
    restart: `rev=$(basename "$(readlink "$STUB_ROOT/app")"); [ -f "$STUB_ROOT/app/MIGRATE" ] && ! grep -q "migrated by $rev" "$STUB_DB" && echo "migrated by $rev" >> "$STUB_DB"; echo "$rev" > "$STUB_ROOT/.up"; true`,
    build: `[ -f FAILBUILD ] && exit 1; mkdir -p apps/member/dist apps/manager/dist; touch apps/member/dist/index.html apps/manager/dist/index.html`,
    curl: `for a; do url="$a"; done; rev=$(cat "$STUB_ROOT/.up" 2>/dev/null); [ -f "$STUB_ROOT/releases/$rev/BROKEN" ] && exit 7
      case "$url" in *health) printf '{"ok":true,"version":"0.1.0","revision":"%s"}' "$rev";; *club) printf 200;; esac`,
  };
  for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(stub, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stub, name), 0o755); }
});

test("an update installs beside the running release, takes a snapshot, switches and checks", () => {
  const r = sh("update", release("r2", ["MIGRATE"]), "r2");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /now running r2 \(was r1\)/);
  assert.equal(running(), "releases/r2");
  assert.ok(existsSync(join(root, "releases/r1/REVISION")), "the old plain folder became releases/r1");
  assert.equal(readFileSync(join(root, "releases/r2/REVISION"), "utf8").trim(), "r2");
  const snaps = readdirSync(backups).filter((f) => f.startsWith("update-r1-to-r2-"));
  assert.equal(snaps.length, 1);
  assert.equal(readFileSync(join(backups, snaps[0]!), "utf8"), "bookings: 1\n");
  assert.equal(db(), "bookings: 1\nmigrated by r2\n");
  // The server got a secret key of its own, never printed.
  const key = /^KUMI_SECRET_KEY=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1];
  assert.ok(key && Buffer.from(key, "base64").length === 32);
  assert.ok(!r.out.includes(key!));
  assert.match(sh("status").out, /running:  r2\nprevious: r1/);
});

test("a release that doesn't come up is taken back: the old release and the database from the snapshot", () => {
  writeFileSync(dbFile, `${db()}bookings: 2\n`);
  const before = db();
  const r = sh("update", release("r3", ["MIGRATE", "BROKEN"]), "r3");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /r3 didn't come up; putting r2 back/);
  assert.match(r.out, /back on r2 with the database as it was before/);
  assert.equal(running(), "releases/r2");
  assert.equal(db(), before);   // r3's migration undone
});

test("a release that won't build changes nothing, and takes no snapshot", () => {
  const snaps = readdirSync(backups).length;
  const r = sh("update", release("r4", ["FAILBUILD"]), "r4");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /installing r4 failed; nothing changed, still on r2/);
  assert.equal(running(), "releases/r2");
  assert.equal(readdirSync(backups).length, snaps);
  assert.ok(!existsSync(join(root, "releases/r4")));
});

test("going back needs --yes, then puts the previous release and its database back", () => {
  assert.equal(sh("update", release("r5", ["MIGRATE"]), "r5").code, 0);
  writeFileSync(dbFile, `${db()}bookings since r5\n`);
  const no = sh("rollback");
  assert.notEqual(no.code, 0);
  assert.match(no.out, /Everything since then .* is lost\. To go ahead: kumi rollback --yes/);
  assert.equal(running(), "releases/r5");
  const yes = sh("rollback", "--yes");
  assert.equal(yes.code, 0, yes.out);
  assert.equal(running(), "releases/r2");
  assert.ok(!db().includes("r5"), db());
  // Nothing more to go back to.
  assert.notEqual(sh("rollback", "--yes").code, 0);
});

test("the last 3 releases and the last 3 update snapshots are kept", () => {
  for (const rev of ["r6", "r7", "r8", "r9"]) assert.equal(sh("update", release(rev), rev).code, 0);
  const kept = readdirSync(join(root, "releases")).filter((d) => d !== "STATE");
  assert.equal(kept.length, 3, kept.join(" "));
  assert.ok(kept.includes("r9") && kept.includes("r8"));
  assert.equal(readdirSync(backups).filter((f) => f.startsWith("update-")).length, 3);
  assert.match(sh("update", release("r9b"), "r9").out, /already running r9/);
});
