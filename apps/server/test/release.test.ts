// deploy/release.sh against a scratch folder, with stand-ins: the "database" is a file the Postgres stand-ins
// dump and restore, "migrations" append to it when the server starts, and curl answers /health with the release
// the app link points at, unless that release is marked broken. Caddy's stand-in refuses a config with /refuse-me
// in it, and won't reload while NORELOAD is there. Each release's server-setup.sh adds a path of its own to the API's.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../../deploy/release.sh", import.meta.url).pathname;
let t: string, root: string, stub: string, dbFile: string, envFile: string, backups: string, caddyfile: string;

const CSP = "default-src 'self'; frame-ancestors 'none'";
const apiOf = (rev: string, extra = "") => `/auth/* /club /health /only-${rev}${extra}`;
const setupOf = (rev: string, extra = "") => `#!/usr/bin/env bash\napi='${apiOf(rev, extra)}'\ncsp="${CSP}"\n`;
function release(rev: string, marks: string[] = [], extraApi = ""): string {
  const dir = join(t, `src-${rev}`);
  mkdirSync(join(dir, "deploy"), { recursive: true });
  copyFileSync(script, join(dir, "deploy/release.sh"));
  writeFileSync(join(dir, "deploy/server-setup.sh"), setupOf(rev, extraApi));
  for (const m of marks) writeFileSync(join(dir, m), "");
  const tar = join(t, `kumi-${rev}.tar`);
  assert.equal(spawnSync("tar", ["-cf", tar, "-C", dir, "."]).status, 0);
  return tar;
}
function sh(...args: string[]) {
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: {
    PATH: `${stub}:${process.env.PATH}`, KUMI_ROOT: root, KUMI_ENV_FILE: envFile, KUMI_BACKUP_DIR: backups, KUMI_PG_BIN: stub, KUMI_AS: "", KUMI_SYSTEM_FILES: "0",
    KUMI_CHECK_SECONDS: "3", KUMI_RESTART: `sh ${stub}/restart`, KUMI_STOP: "true", KUMI_INSTALL: "true", KUMI_BUILD: `sh ${stub}/build`, STUB_ROOT: root, STUB_DB: dbFile,
    KUMI_CADDYFILE: caddyfile, KUMI_CADDY: `${stub}/caddy`, KUMI_CADDY_RELOAD: `sh ${stub}/reload`, KUMI_CADDY_RESTART: `sh ${stub}/caddy_restart` } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const running = () => readlinkSync(join(root, "app"));
const db = () => readFileSync(dbFile, "utf8");
const caddy = () => readFileSync(caddyfile, "utf8");
const reloads = () => (existsSync(join(root, ".reloads")) ? readFileSync(join(root, ".reloads"), "utf8").split("\n").length - 1 : 0);
/** Caddy's config as server-setup.sh writes it, from the block it shares with release.sh. */
function sites(rev: string, upstream = "127.0.0.1:8790"): string {
  const block = /# --- caddy sites \(the same in server-setup\.sh and release\.sh\) ---\n([\s\S]*?)# --- end caddy sites ---/.exec(readFileSync(script, "utf8"))![1]!;
  const r = spawnSync("bash", ["-c", `${block}\napi='${apiOf(rev)}'; csp="${CSP}"\nkumi_sites kestrel.example staff.kestrel.example "$1" "$2"`, "sites", upstream, join(root, "app")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

before(() => {
  t = mkdtempSync(join(tmpdir(), "kumi-release-"));
  root = join(t, "opt"); stub = join(t, "bin"); dbFile = join(t, "db.txt"); envFile = join(t, "kumi.env"); backups = join(t, "backups");
  mkdirSync(stub); mkdirSync(join(root, "app/apps/member/dist"), { recursive: true }); mkdirSync(join(root, "app/apps/manager/dist"), { recursive: true });
  // A server from before releases were kept side by side: a plain app folder.
  writeFileSync(join(root, "app/REVISION"), "r1\n");
  for (const a of ["member", "manager"]) writeFileSync(join(root, `app/apps/${a}/dist/index.html`), "");
  writeFileSync(dbFile, "bookings: 1\n");
  writeFileSync(envFile, "NODE_ENV=production\nPORT=8790\nDATABASE_URL=postgresql://kumi@/kumi?host=/var/run/postgresql\n"
    + "KUMI_PUBLIC_URL=https://staff.kestrel.example\nKUMI_MEMBER_URL=https://kestrel.example\n");
  // Caddy's config as server-setup.sh wrote it for r1.
  mkdirSync(join(root, "app/deploy")); writeFileSync(join(root, "app/deploy/server-setup.sh"), setupOf("r1"));
  caddyfile = join(t, "Caddyfile"); writeFileSync(caddyfile, sites("r1"));
  const stubs: Record<string, string> = {
    // pg_dump ... -f <file> ...: the database file, copied.
    pg_dump: `while [ $# -gt 0 ]; do [ "$1" = -f ] && out="$2"; shift; done; cp "$STUB_DB" "$out"`,
    // psql: emptying the database (before a restore), and the carry-over of what was sent since the snapshot
    // (one message that had gone, and its fingerprint; the snapshot's Kumi looks for fingerprints) and of the usage
    // meter (a month's texts, and its 80% message; the snapshot's Kumi has the meter), each call written down.
    psql: `echo "$*" >> "$STUB_ROOT/.psql"; case "$*" in *"DROP SCHEMA"*) : > "$STUB_DB";; *"COPY (SELECT id, status"*) printf 'm1\\tsent\\t2026-11-03 10:00:00+00\\t\\\\N\\n';;
      *"COPY (SELECT id, encode"*) printf 'm1\\tf1\\t2026-11-03 10:00:00+00\\n';; *"table_name = 'sent_before_restore'"*) echo 1;;
      *"COPY (SELECT month, kind"*) printf '2026-11-01\\ttexts\\t3\\t0\\t0\\t3\\t3.78\\t2026-11-03 10:00:00+00\\n';; *"COPY (SELECT month, near_cap"*) printf '2026-11-01\\t5000\\t\\\\N\\t\\\\N\\n';;
      *"table_name = 'usage_month'"*) echo 1;;
      *"COPY (SELECT p.id, p.redacted_at"*) printf 'p1\\t2026-11-03 10:00:00+00\\tself\\n';; *"table_name = 'erase_after_restore' AND column_name = 'deleted_by'"*) echo 1;; *"table_name = 'erase_after_restore'"*) echo 1;;
      *"COPY (SELECT id, removed_at"*) printf 'c1\\t2026-11-03 10:00:00+00\\t\\\\N\\t\\\\N\\tt\\n';; *"table_name = 'chat_message'"*) echo 1;;
      *"COPY (SELECT token_hash::text, revoked_at FROM web_session"*) printf 's1\\t2026-11-03 10:00:00+00\\n';; *"table_name = 'web_session' AND column_name = 'revoked_at'"*) echo 1;; esac`,
    pg_restore: `for a; do last="$a"; done; cp "$last" "$STUB_DB"`,
    // Starting the server: a release marked MIGRATE changes the database as it starts (once, as migrations do).
    restart: `rev=$(basename "$(readlink "$STUB_ROOT/app")"); [ -f "$STUB_ROOT/app/MIGRATE" ] && ! grep -q "migrated by $rev" "$STUB_DB" && echo "migrated by $rev" >> "$STUB_DB"; echo "$rev" > "$STUB_ROOT/.up"; true`,
    // A release marked INJECT stands for a build (the kumi user's) that rewrote the release's own server-setup.sh:
    // a policy that ends Caddy's quoted string and opens a site of its own in root's Caddyfile.
    build: `[ -f FAILBUILD ] && exit 1; mkdir -p apps/member/dist apps/manager/dist; touch apps/member/dist/index.html apps/manager/dist/index.html
      [ -f INJECT ] && printf '%s\\n' "api='/auth/* /club /health'" "csp=\\"default-src 'self'\\" } evil.example { respond \\"pwned\\"" > deploy/server-setup.sh; true`,
    curl: `for a; do url="$a"; done; [ "$1" = --unix-socket ] && echo "$2 $url" >> "$STUB_ROOT/.socket"
      rev=$(cat "$STUB_ROOT/.up" 2>/dev/null); [ -f "$STUB_ROOT/releases/$rev/BROKEN" ] && exit 7
      case "$url" in *health) printf '{"ok":true,"version":"0.1.0","revision":"%s"}' "$rev";; *club) printf 200;; esac`,
    // caddy validate --config <file> --adapter caddyfile
    caddy: `grep -q /refuse-me "$3" && { echo "Error: adapting config using caddyfile: /refuse-me"; exit 1; }; exit 0`,
    reload: `[ -f "$STUB_ROOT/NORELOAD" ] && exit 1; [ -f "$STUB_ROOT/OLDADMIN" ] && exit 1; echo reloaded >> "$STUB_ROOT/.reloads"`,
    // Restarting Caddy: what an update does when a reload can't reach the admin API where the new config says it is.
    caddy_restart: `[ -f "$STUB_ROOT/NORELOAD" ] && exit 1; rm -f "$STUB_ROOT/OLDADMIN"; echo restarted >> "$STUB_ROOT/.restarts"`,
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
  // Caddy has r2's config: the paths r2 answers on.
  assert.equal(caddy(), sites("r2"));
  assert.equal(reloads(), 1);
  assert.ok(!readdirSync(t).some((f) => f.startsWith("Caddyfile.")), "no config left beside Caddy's");
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
  // What r3 sent while it ran was read before the snapshot went back, and carried over after: nothing goes twice.
  const calls = readFileSync(join(root, ".psql"), "utf8");
  assert.ok(calls.indexOf("COPY (SELECT id, status") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("UPDATE outbound_message"), calls);
  // And what it had sent that the snapshot has no row for: fingerprints, so a job making it again doesn't send it.
  assert.ok(calls.indexOf("COPY (SELECT id, encode") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("INSERT INTO sent_before_restore"), calls);
  // And the usage meter: what was spent since the snapshot stays counted, and the 80% message said since stays said.
  assert.ok(calls.indexOf("COPY (SELECT month, kind") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("INSERT INTO usage_month"), calls);
  assert.ok(calls.indexOf("COPY (SELECT month, near_cap") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("INSERT INTO usage_alert"), calls);
  // And what was taken away on request since (after_restore.ts GONE): an account deleted is queued to be deleted
  // again as the server starts, words taken back stay taken back, a sign-in ended stays ended; each only where the
  // snapshot's Kumi has that table or column (the stub has none of the others: they're left alone).
  assert.ok(calls.indexOf("COPY (SELECT p.id, p.redacted_at") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("INSERT INTO erase_after_restore"), calls);
  assert.ok(calls.indexOf("COPY (SELECT id, removed_at") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("UPDATE chat_message"), calls);
  assert.ok(calls.indexOf("COPY (SELECT token_hash::text, revoked_at FROM web_session") < calls.indexOf("DROP SCHEMA") && calls.indexOf("DROP SCHEMA") < calls.indexOf("UPDATE web_session x SET revoked_at"), calls);
  assert.ok(!calls.includes("UPDATE passkey x"), "a table the snapshot's Kumi doesn't have is left alone");
  assert.equal(caddy(), sites("r2"));
  assert.equal(reloads(), 1);
  assert.ok(!readdirSync(t).some((f) => f.startsWith("Caddyfile.")));
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
  assert.equal(caddy(), sites("r5"));
  const yes = sh("rollback", "--yes");
  assert.equal(yes.code, 0, yes.out);
  assert.equal(running(), "releases/r2");
  assert.ok(!db().includes("r5"), db());
  assert.equal(caddy(), sites("r2"));   // r2's paths again
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

test("root never follows a link the kumi user left, and an odd backup name is one file", () => {
  // A link where the state file used to be written first (releases/STATE.tmp): writing through it would let
  // kumi overwrite any file as root. The state is now written to a new temporary file instead.
  const victim = join(t, "victim.txt"); writeFileSync(victim, "untouched\n");
  symlinkSync(victim, join(root, "releases/STATE.tmp"));
  // An old update snapshot with a space in its name: split on the space, it was two names, and root deleted the
  // second one (a path relative to /). Now it's one file, tidied like the others.
  const odd = join(backups, "update-old snap.dump"); writeFileSync(odd, "");
  const past = new Date("2020-01-01T00:00:00Z"); utimesSync(odd, past, past);
  assert.equal(sh("update", release("r10"), "r10").code, 0);
  assert.equal(readFileSync(victim, "utf8"), "untouched\n");
  assert.ok(!existsSync(odd), "the oldest snapshot, odd name and all, is tidied");
  assert.equal(readdirSync(backups).filter((f) => f.startsWith("update-")).length, 3);
  assert.ok(!readdirSync(join(root, "releases")).some((f) => f.startsWith(".STATE.")), "no temporary state file left");
});

test("a release whose Caddy config Caddy refuses changes nothing, and takes no snapshot", () => {
  const before = caddy(), snaps = readdirSync(backups).length, was = running();
  const r = sh("update", release("r11", [], " /refuse-me"), "r11");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Caddy refused r11's config .*nothing changed, still on r10/s);
  assert.match(r.out, /\/refuse-me/);
  assert.equal(running(), was);
  assert.equal(caddy(), before);
  assert.equal(readdirSync(backups).length, snaps);
  assert.ok(!readdirSync(t).some((f) => f.startsWith("Caddyfile.")));
});

test("if Caddy won't take the new config, its old one goes back and the update is undone", () => {
  const before = caddy(), data = db(), was = running(), n = reloads();
  writeFileSync(join(root, "NORELOAD"), "");
  const r = sh("update", release("r12", ["MIGRATE"]), "r12");
  rmSync(join(root, "NORELOAD"));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Caddy didn't take the new config, so it has its old one back/);
  assert.equal(running(), was);
  assert.equal(caddy(), before);
  assert.equal(db(), data);
  assert.equal(reloads(), n);
  assert.ok(!readdirSync(t).some((f) => f.startsWith("Caddyfile.")));
});

test("a config written before Caddy's admin API moved to its socket is still Kumi's: it's replaced, and Caddy restarted once", () => {
  // The running release's config as a release before plugins wrote it: the same sites, without the global block (3 lines).
  const cur = running().split("/").pop()!, lines = sites(cur).split("\n"), at = lines.indexOf("{");
  assert.ok(at > 0);
  writeFileSync(caddyfile, [...lines.slice(0, at), ...lines.slice(at + 3)].join("\n"));
  writeFileSync(join(root, "OLDADMIN"), "");   // the running Caddy still listens on 127.0.0.1:2019: a reload can't reach it
  const r = sh("update", release("r20"), "r20");
  assert.equal(r.code, 0, r.out);
  assert.equal(caddy(), sites("r20"));
  assert.match(caddy(), /\tadmin unix\/\/var\/lib\/caddy\/admin\.sock/);
  assert.ok(existsSync(join(root, ".restarts")) && !existsSync(join(root, "OLDADMIN")), "restarted, since the reload couldn't reach it");
});

test("a Caddy config changed by hand is left as it is, and the update says so", () => {
  writeFileSync(caddyfile, `${caddy()}\nshop.kestrel.example {\n\trespond "hi"\n}\n`);
  const mine = caddy(), n = reloads();
  const r = sh("update", release("r13"), "r13");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /was changed by hand, so it's left as it is/);
  assert.equal(running(), "releases/r13");
  assert.equal(caddy(), mine);
  assert.equal(reloads(), n);
  // Comments don't count as changes: a config Kumi wrote, with a note added, is still Kumi's.
  writeFileSync(caddyfile, `# a note\n${sites("r13")}`);
  assert.equal(sh("update", release("r14"), "r14").code, 0);
  assert.equal(caddy(), sites("r14"));
});

test("on its unix socket: the update asks the server there, and Caddy sends the API there", () => {
  const sock = "/run/kumi-kestrel/http.sock";
  writeFileSync(envFile, `${readFileSync(envFile, "utf8")}KUMI_SOCKET=${sock}\n`);
  writeFileSync(caddyfile, sites("r14", `unix/${sock}`));
  const r = sh("update", release("r15"), "r15");
  assert.equal(r.code, 0, r.out);
  assert.equal(caddy(), sites("r15", `unix/${sock}`));
  assert.match(caddy(), /reverse_proxy unix\/\/run\/kumi-kestrel\/http\.sock\n/);
  assert.match(readFileSync(join(root, ".socket"), "utf8"), /^\/run\/kumi-kestrel\/http\.sock http:\/\/localhost\/health$/m);
});

test("what the kumi user's build says goes into root's Caddyfile only if it's plain paths and a policy", () => {
  const before = caddy(), was = running(), n = reloads();
  const r = sh("update", release("r16", ["INJECT"]), "r16");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /r16's api= or csp= line .* can't safely take/);
  assert.match(r.out, /nothing changed/);
  assert.equal(caddy(), before);
  assert.ok(!caddy().includes("evil.example"));
  assert.equal(running(), was);
  assert.equal(reloads(), n);
});
