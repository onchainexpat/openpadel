import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

/** Runs a copy of a script twice: as it is, and with its first use of `command` rewriting the copy in place (as an
 *  update can rewrite the file a script runs from). Bash reads a script as it goes, so one that hasn't read itself in
 *  full before running anything goes on with the new text; one that has behaves the same both times. */
function rewrittenWhileRunning(script: string, args: string[], command: string, answer = "") {
  const once = (rewrite: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "kumi-selfread-")), copy = join(dir, "script.sh"), bin = join(dir, "bin");
    try {
      writeFileSync(copy, read(script));
      // release.sh reads the server's settings before anything else: a scratch file of them.
      writeFileSync(join(dir, "kumi.env"), "KUMI_SECRET_KEY=test\nDATABASE_URL=postgresql://nobody@/none\n");
      const junk = "echo REWRITTEN-RAN; exit 9\n".repeat(Math.ceil((statSync(copy).size * 3) / 27));
      spawnSync("mkdir", [bin]);
      // In place (the same file, truncated and written), never a new one: a new file wouldn't reach the running copy.
      writeFileSync(join(bin, command), `#!/bin/sh\n${rewrite ? `printf '%s' "$KUMI_JUNK" > "$KUMI_COPY"` : ":"}\n${answer}\n`, { mode: 0o755 });
      const r = spawnSync("bash", [copy, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KUMI_JUNK: junk, KUMI_COPY: copy, KUMI_ROOT: dir, KUMI_ENV_FILE: join(dir, "kumi.env") } });
      return { out: `${r.stdout}${r.stderr}`.replaceAll(dir, "<dir>"), status: r.status };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  return { as: once(false), rewritten: once(true) };
}

test("the update scripts run only their own text, whatever happens to their file while they run", () => {
  // update.sh switches its own checkout (git checkout) as it goes; release.sh installs itself as root's copy.
  const update = rewrittenWhileRunning("deploy/docker/update.sh", ["v9.9.9"], "git", '[ "$1" = rev-parse ] && pwd');
  assert.equal(update.as.status, 1); assert.match(update.as.out, /no \.env here/);
  assert.deepEqual(update.rewritten, update.as);
  const release = rewrittenWhileRunning("deploy/release.sh", ["status"], "ls");
  assert.equal(release.as.status, 0); assert.match(release.as.out, /running: +none/);
  assert.deepEqual(release.rewritten, release.as);
  // The kumi command is rewritten by every update while `sudo kumi update` runs it: a new file moved into place, so
  // the running one keeps reading its own.
  for (const f of ["deploy/server-setup.sh", "deploy/release.sh"]) {
    const s = read(f);
    assert.ok(!s.includes("cat > /usr/local/bin/kumi <<"), f);
    assert.match(s, /cat > \/usr\/local\/bin\/kumi\.new <<'SH'\n[\s\S]*?\nSH\nchmod 755 \/usr\/local\/bin\/kumi\.new && mv -f \/usr\/local\/bin\/kumi\.new \/usr\/local\/bin\/kumi\n/, f);
  }
});

test("both ways of running Kumi give the apps the same security policy and the same API paths", () => {
  const script = read("deploy/server-setup.sh"), caddy = read("deploy/docker/Caddyfile");
  assert.equal(caddy.match(/Content-Security-Policy "(.*)"/)![1], script.match(/^csp="(.*)"$/m)![1]);
  assert.equal(caddy.match(/@api path (.*)/)![1]!.trim(), script.match(/^api='(.*)'$/m)![1]);
});

test("every API route reaches the server through Caddy, and the apps' pages don't", async () => {
  const { makeApp } = await import("../src/app.ts");
  const app = makeApp({ db: {} as any, mailer: { send: async () => {} }, secureCookies: true, production: true });   // as served (no development routes)
  const patterns = read("deploy/docker/Caddyfile").match(/@api path (.*)/)![1]!.trim().split(/\s+/);
  const routed = (path: string) => patterns.some((p) => (p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p));
  const paths = [...new Set(app.routes.map((r) => r.path.replace(/:[a-z_]+/g, "x")).filter((p) => p !== "/*" && !p.endsWith("/*")))];
  assert.ok(paths.length > 40);
  for (const p of paths) assert.ok(routed(p), `${p} isn't sent to the server by Caddy`);
  for (const page of ["/changes", "/membership", "/memberships", "/book", "/places", "/people", "/courts", "/settings", "/join/abc", "/play", "/match/abc", "/scores", "/vault"]) assert.ok(!routed(page), `${page} is an app page`);
});

test("container images are pinned to exact versions", () => {
  for (const line of [...read("Dockerfile").matchAll(/^FROM (\S+)/gm), ...read("compose.yaml").matchAll(/image: (\S+)/g)].map((m) => m[1]!)) {
    if (!line.includes(":")) continue;   // a stage of this build, not an image
    if (line.startsWith("kumi-")) continue;   // Kumi's own images, built here (update.sh tags each release)
    assert.match(line, /:\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?$/, `${line} should name an exact version`);
  }
});

test("a fresh server and an updated one get the same kumi command, backup and restore-test timers", () => {
  const block = (text: string) => { const m = /# --- system files \(the same in server-setup\.sh and release\.sh\) ---\n([\s\S]*?)# --- end system files ---/.exec(text); assert.ok(m, "no system files block"); return m[1]!; };
  const setup = block(read("deploy/server-setup.sh")), release = block(read("deploy/release.sh"));
  assert.equal(setup, release);
  for (const want of ["kumi-backup.timer", "kumi-restore-test.timer", "cli.ts backup", "cli.ts restore-test", "kumi_restore_test", "rollback|releases"]) assert.ok(setup.includes(want), want);
});

test("a fresh server and an updated one get the same Caddy sites, and an update writes them from its own release", () => {
  const block = (text: string) => { const m = /# --- caddy sites \(the same in server-setup\.sh and release\.sh\) ---\n([\s\S]*?)# --- end caddy sites ---/.exec(text); assert.ok(m, "no caddy sites block"); return m[1]!; };
  const setup = read("deploy/server-setup.sh"), release = read("deploy/release.sh");
  assert.equal(block(setup), block(release));
  assert.match(setup, /kumi_sites "\$KUMI_HOST" "staff\.\$KUMI_HOST" "\$upstream" \/opt\/kumi\/app > \/etc\/caddy\/Caddyfile/);
  // The API's paths and the apps' policy come from the release being installed (its own server-setup.sh), checked
  // by Caddy before the switch, and taken without dropping connections.
  assert.match(release, /local f="\$ROOT\/releases\/\$1\/deploy\/server-setup\.sh"/);
  assert.match(release, /\$CADDY validate --config "\$next" --adapter caddyfile/);
  assert.match(release, /CADDY_RELOAD=\$\{KUMI_CADDY_RELOAD:-systemctl reload caddy\}/);
  assert.match(release, /if \$RESTART && check "\$new" && caddy_use "\$caddy"; then/);
});

test("ship.sh hands the release to its own release.sh", () => {
  const ship = read("deploy/ship.sh");
  assert.match(ship, /tar -xOf .*deploy\/release\.sh/);
  assert.match(ship, /release\.sh update /);
});

test("root runs only root's files: its own copy of release.sh, releases made root's once built, Caddy outside kumi", () => {
  const setup = read("deploy/server-setup.sh"), release = read("deploy/release.sh");
  // `sudo kumi rollback|releases` used to run release.sh from the running release, a file the kumi user owned.
  assert.ok(!/bash \/opt\/kumi\/app\/deploy\/release\.sh/.test(setup + release));
  assert.match(release, /exec bash \/usr\/local\/lib\/kumi\/release\.sh/);
  assert.match(release, /install -D -m 755 -o root -g root "\$\{BASH_SOURCE\[0\]\}" \/usr\/local\/lib\/kumi\/release\.sh/);
  assert.match(release, /chown -R root:root "\$dir\.new"/);
  assert.match(setup, /install -d -m 755 -o root -g root \/opt\/kumi \/opt\/kumi\/releases/);
  assert.match(setup, /--home-dir \/var\/lib\/kumi/);
  // Caddy reads the apps as anyone does; in the kumi group it could also read the settings file.
  assert.ok(!/usermod -aG kumi caddy/.test(setup));
  assert.match(setup + release, /gpasswd -d caddy kumi/);
  // After a restore, the server starts again unless the database may be empty (exit code 4).
  assert.match(release, /if \[ "\$rc" = 4 \]; then .* else systemctl start kumi; fi/);
});

test("Docker: the server connects as kumi_app, not the database's superuser; older setups move over once", () => {
  const compose = read("compose.yaml"), init = read("deploy/docker/db-init.sh"), update = read("deploy/docker/update.sh");
  assert.ok(!/postgresql:\/\/kumi:/.test(compose), "no service connects as the superuser kumi");
  assert.equal((compose.match(/postgresql:\/\/kumi_app:/g) ?? []).length, 3);   // the server, the backup and the pitr services
  assert.match(compose, /db-init\.sh:\/docker-entrypoint-initdb\.d\//);
  assert.match(init, /CREATE ROLE kumi_app LOGIN NOSUPERUSER NOCREATEROLE CREATEDB/);
  assert.match(init, /ALTER DATABASE kumi OWNER TO kumi_app/);
  assert.match(update, /move_to_app_role\(\)/);
  assert.match(update, /chmod 600 \.env/);
});

test("Docker: point-in-time backups beside Postgres, as its own user, never in the server's container", () => {
  const compose = read("compose.yaml"), docker = read("Dockerfile"), update = read("deploy/docker/update.sh");
  const push = read("deploy/docker/pgbackrest-archive-push"), pitr = read("deploy/docker/pitr.sh");
  // A service's own lines: up to the next service, or the comment above it.
  const service = (name: string) => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  (?:#|[a-z]+:\\n)|\\nvolumes:)`).exec(compose)![1]!;
  const db = service("db"), kumi = service("kumi"), backup = service("backup"), p = service("pitr");
  // The same Postgres as before (Alpine's): another image would bring other files' owner and another text ordering.
  assert.match(docker, /FROM postgres:17\.9-alpine AS db\n/);
  assert.match(docker, /apk add --no-cache --virtual postgresql libpq && apk add --no-cache pgbackrest=2\.57\.0-r0/);
  // Postgres archives through the wrapper (pgBackRest's check wants its name in archive_command), which lets each
  // piece go until the pitr service has written the settings.
  assert.match(db, /"archive_mode=on", "-c", "archive_command=\/usr\/local\/bin\/kumi-pgbackrest-archive-push %p", "-c", "archive_timeout=60"/);
  assert.match(docker, /COPY deploy\/docker\/pgbackrest-archive-push \/usr\/local\/bin\/kumi-pgbackrest-archive-push/);
  assert.match(push, /\[ -f \/etc\/pgbackrest\/pgbackrest\.conf \] \|\| exit 0\nexec pgbackrest --stanza=kumi archive-push "\$1"/);
  assert.match(db, /pitr-conf:\/etc\/pgbackrest:ro/);
  // The pitr service: the db image's postgres user, the database's folder read-only, Postgres's socket, the archive.
  assert.match(docker, /FROM db AS pitr\n[\s\S]*USER postgres\n/);
  for (const want of ["db:/var/lib/postgresql/data:ro", "pgrun:/var/run/postgresql", "pitr:/var/lib/pgbackrest", "pitr-conf:/etc/pgbackrest", "pitr-work:/var/lib/kumi-pitr", "init: true", "KUMI_PITR_PG_USER: kumi"])
    assert.ok(p.includes(want), want);
  assert.match(p, /DATABASE_URL: postgresql:\/\/kumi_app:/, "the club's database as kumi_app, like the server");
  // Nothing of it reaches the server's container: no socket (local connections there are Postgres's superuser), no
  // archive, no settings with the offsite key. The server's image stays the node user's.
  for (const s of [kumi, backup]) assert.ok(!/pgrun|pitr|pgbackrest/.test(s), s);
  assert.match(docker, /FROM node:24\.22\.0-bookworm-slim AS server\n[\s\S]*?USER node\n/);
  // The service writes the settings, makes the archive before Postgres is told to use it, then ticks hourly at :37.
  assert.match(pitr, /KUMI_PITR_SYSTEM_ID=\$sid kumi pitr conf > "\$conf\.new"; rc=\$\?/);
  assert.match(pitr, /pgbackrest --config="\$conf\.new" --stanza=kumi --log-level-console=warn stanza-create[\s\S]*mv -f "\$conf\.new" "\$conf"/);
  // A base backup at every start: after a stretch without archiving, the minutes since are reachable at once.
  assert.match(pitr, /tick=--now\nwhile :; do\n\s+kumi pitr tick \$tick; tick=\n\s+kumi pitr test --scheduled/);
  assert.match(pitr, /\(2220 - \$\(date \+%s\) % 3600/);
  // Updates: the pitr image is kept under the old commit's tag; it's stopped for a snapshot's restore only where the
  // checkout's compose.yaml has it; going back to a release without it stops it too.
  assert.match(update, /for i in kumi-server kumi-web kumi-pitr; do/);
  assert.match(update, /stop_app\(\) \{ docker compose stop kumi backup \$\(docker compose config --services 2>\/dev\/null \| grep -x pitr \|\| true\); \}/);
  assert.match(update, /docker compose up -d --remove-orphans; \}/);
});

test("putting a snapshot back holds the same notices as kumi restore: everything but refunds", async () => {
  const { MONEY_TOPICS } = await import("../../../packages/core/src/outbox.ts");
  const kept = /e\.topic NOT IN \(([^)]*)\)/.exec(read("deploy/release.sh"))![1]!.split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(kept, [...MONEY_TOPICS].sort());
});

test("putting a snapshot back keeps fingerprints the way kumi restore does: the same fingerprint, for the same week", async () => {
  const { MESSAGE_FP, REPEAT_WINDOW_DAYS } = await import("../../../packages/core/src/repeats.ts");
  const release = read("deploy/release.sh");
  assert.ok(release.includes(`COPY (SELECT id, ${MESSAGE_FP}, sent_at FROM outbound_message WHERE status = 'sent' AND channel <> 'inbox'`), "release.sh reads the same fingerprint");
  assert.match(release, new RegExp(`now\\(\\) \\+ interval '${REPEAT_WINDOW_DAYS} days'`));
});

test("a restore to a minute takes its extract away afterwards, and sudo kumi pitr test runs as the postgres user", () => {
  const setup = read("deploy/server-setup.sh");
  assert.match(setup, /if \[ "\$rc" = 4 \]; then echo "kumi: the database as it was at that minute is in \$extract" >&2; else rm -f "\$extract"; fi/);
  assert.match(setup, /case "\$\{2:-\}" in tick\|test\|extract\)\n\s+root pitr; cd \/opt\/kumi\/app && exec runuser -u postgres --/);
  for (const lang of ["en", "es"]) assert.ok(!read(`packages/i18n/src/${lang}.ts`).includes("sudo -u postgres kumi"), "the kumi command can't run as postgres (its own sudo -u kumi asks for a password)");
});
