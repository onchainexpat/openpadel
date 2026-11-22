import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      writeFileSync(join(dir, "kumi.env"), "OPENPADEL_SECRET_KEY=test\nDATABASE_URL=postgresql://nobody@/none\n");
      const junk = "echo REWRITTEN-RAN; exit 9\n".repeat(Math.ceil((statSync(copy).size * 3) / 27));
      spawnSync("mkdir", [bin]);
      // In place (the same file, truncated and written), never a new one: a new file wouldn't reach the running copy.
      // The junk goes through a file: three times a script of more than 43 kB is past the 128 kB one environment
      // string may hold, and the run wouldn't start at all.
      writeFileSync(join(dir, "junk"), junk);
      writeFileSync(join(bin, command), `#!/bin/sh\n${rewrite ? `cat "$KUMI_JUNK_FILE" > "$KUMI_COPY"` : ":"}\n${answer}\n`, { mode: 0o755 });
      const r = spawnSync("bash", [copy, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KUMI_JUNK_FILE: join(dir, "junk"), KUMI_COPY: copy, OPENPADEL_ROOT: dir, OPENPADEL_ENV_FILE: join(dir, "kumi.env") } });
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

test("Caddy's admin API never listens on TCP, where a local plugin on the server could rewrite the sites", () => {
  const block = /# --- caddy sites \(the same in server-setup\.sh and release\.sh\) ---\n([\s\S]*?)# --- end caddy sites ---/.exec(read("deploy/server-setup.sh"))![1]!;
  const r = spawnSync("bash", ["-c", `${block}\napi='/club'; csp="default-src 'self'"\nkumi_sites a.example staff.a.example 127.0.0.1:8790 /opt/kumi/app`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const conf = r.stdout.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  // The global options come first, and move the admin API to a socket only the caddy user reaches (reload uses it).
  assert.match(conf, /^\{\n\tadmin unix\/\/var\/lib\/caddy\/admin\.sock\n\}\n/);
  assert.ok(!/admin (localhost|127\.|\[?::1|:\d)/.test(conf));
  // Docker's Caddy is never reloaded: no admin API at all.
  const docker = read("deploy/docker/Caddyfile").split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
  assert.match(docker, /^\{\n\tadmin off\n\}/);
  // An update that moves it restarts Caddy when the reload can't reach the old address.
  assert.match(read("deploy/release.sh"), /if \$CADDY_RELOAD \|\| \$CADDY_RESTART; then/);
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
  assert.match(setup, /kumi_sites "\$CLUB_HOST" "staff\.\$CLUB_HOST" "\$upstream" \/opt\/kumi\/app > \/etc\/caddy\/Caddyfile/);
  // The API's paths and the apps' policy come from the release being installed (its own server-setup.sh), checked
  // by Caddy before the switch, and taken without dropping connections.
  assert.match(release, /local f="\$ROOT\/releases\/\$1\/deploy\/server-setup\.sh"/);
  assert.match(release, /\$CADDY validate --config "\$next" --adapter caddyfile/);
  assert.match(release, /CADDY_RELOAD=\$\{OPENPADEL_CADDY_RELOAD:-\$\{KUMI_CADDY_RELOAD:-systemctl reload caddy\}\}/);
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
  for (const want of ["db:/var/lib/postgresql/data:ro", "pgrun:/var/run/postgresql", "pitr:/var/lib/pgbackrest", "pitr-conf:/etc/pgbackrest", "pitr-work:/var/lib/kumi-pitr", "init: true", "OPENPADEL_PITR_PG_USER: kumi"])
    assert.ok(p.includes(want), want);
  assert.match(p, /DATABASE_URL: postgresql:\/\/kumi_app:/, "the club's database as kumi_app, like the server");
  // Nothing of it reaches the server's container: no socket (local connections there are Postgres's superuser), no
  // archive, no settings with the offsite key. The server's image stays the node user's.
  for (const s of [kumi, backup]) assert.ok(!/pgrun|pitr|pgbackrest/.test(s), s);
  assert.match(docker, /FROM node:24\.22\.0-bookworm-slim AS server\n[\s\S]*?USER node\n/);
  // The service writes the settings, makes the archive before Postgres is told to use it, then ticks hourly at :37.
  assert.match(pitr, /OPENPADEL_PITR_SYSTEM_ID=\$sid kumi pitr conf > "\$conf\.new"; rc=\$\?/);
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

test("making the point-in-time archive waits out archive-push's lock, and says it isn't ready only when it isn't", () => {
  // stanza-create is refused ([050]) while Postgres sends a piece of its log; 0.2.1's update said "isn't ready" then.
  const cases: [string, RegExp, string][] = [
    ["deploy/release.sh", /    # stanza-create takes the archive's lock[\s\S]*?\n    done\n/, "bash"],
    ["deploy/server-setup.sh", /    # stanza-create takes the archive's lock[\s\S]*?\n    done\n/, "bash"],
    ["deploy/docker/pitr.sh", /# stanza-create takes the archive's lock[\s\S]*?\ndone\n/, "sh"],
  ];
  for (const [file, block, shell] of cases) {
    const snippet = block.exec(read(file))?.[0];
    assert.ok(snippet, `${file}: no stanza-create retry`);
    const run = (refusals: number, error = "ERROR: [050]: unable to acquire lock on file") => {
      const dir = mkdtempSync(join(tmpdir(), "kumi-stanza-"));
      try {
        // pgbackrest (called directly, or through runuser) answers with the error the first `refusals` times.
        const stub = `n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/n"; [ "$n" -gt ${refusals} ] && return 0; echo "${error}"; return 50`;
        const script = `conf=/x; say() { echo "kumi pitr: $*"; }; sleep() { :; }\nrunuser() { ${stub}; }\npgbackrest() { ${stub}; }\n${snippet}echo "tries $(cat "${dir}/n")"\n`;
        const r = spawnSync(shell, ["-c", script], { encoding: "utf8" });
        return `${r.stdout}${r.stderr}`;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    assert.equal(run(2).trim(), "tries 3", `${file}: two refusals, then made`);
    assert.match(run(99), /\[050\][\s\S]*isn't ready[\s\S]*tries 6\n$/, `${file}: still locked after six tries`);
    assert.match(run(99, "ERROR: [055]: unable to load info file"), /\[055\][\s\S]*isn't ready[\s\S]*tries 1\n$/, `${file}: any other error at once`);
  }
});

test("the deploy files write OPENPADEL_ settings, and still read a server's old KUMI_ ones", () => {
  const setup = read("deploy/server-setup.sh"), release = read("deploy/release.sh"), update = read("deploy/docker/update.sh"), compose = read("compose.yaml");
  const made = /cat > \/etc\/kumi\/kumi\.env <<ENV\n([\s\S]*?)\nENV\n/.exec(setup)![1]!;
  assert.ok(!made.includes("KUMI_") && made.includes("OPENPADEL_SECRET_KEY=") && made.includes("OPENPADEL_PRACTICE=1"), "a new server's settings use the new names");
  assert.ok(!read("deploy/docker/env.example").includes("KUMI_"));
  assert.match(setup, /CLUB_HOST=\$\{OPENPADEL_HOST:-\$\{KUMI_HOST:-\}\}/);
  assert.match(setup, /sock=\$\(sed -n 's\/\^OPENPADEL_SOCKET=\/\/p' [^;]+; \[ -n "\$sock" \] \|\| sock=\$\(sed -n 's\/\^KUMI_SOCKET=\/\/p'/);
  assert.match(release, /SOCKET=\$\{OPENPADEL_SOCKET:-\$\{KUMI_SOCKET:-\}\}/);
  assert.match(release, /grep -qE '\^\(OPENPADEL\|KUMI\)_SECRET_KEY=\.' "\$ENV_FILE"/, "a server with the old key name doesn't get a second key");
  assert.match(release, /host_of "\$\{OPENPADEL_MEMBER_URL:-\$\{KUMI_MEMBER_URL:-\}\}"/);
  // Every swappable path and command in release.sh takes either name.
  for (const m of release.matchAll(/^[A-Z_]+=\$\{(OPENPADEL|KUMI)_([A-Z_]+)/gm)) assert.equal(m[1], "OPENPADEL", m[0]);
  assert.match(update, /grep -qE '\^\(OPENPADEL\|KUMI\)_SECRET_KEY=\.' \.env/);
  assert.match(update, /pw=\$\(envget DB_PASSWORD\)/);
  assert.match(update, /OPENPADEL_TAG=\$1 KUMI_TAG=\$1 docker compose up/, "going back to an older compose.yaml still finds its tag");
  for (const want of ["${OPENPADEL_DB_PASSWORD:-${KUMI_DB_PASSWORD:?", "${OPENPADEL_HOST:-${KUMI_HOST:?", "${OPENPADEL_TAG:-${KUMI_TAG:-local}}"]) assert.ok(compose.includes(want), want);
  assert.ok(read("deploy/docker/Caddyfile").includes("{$OPENPADEL_HOST}"));
  assert.match(read("deploy/docker/db-init.sh"), /\$\{OPENPADEL_DB_PASSWORD:-\$\{KUMI_DB_PASSWORD:-\}\}/);
});

test("update.sh rename-settings: .env's old names to new, a copy kept, no value changed or printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-rename-"));
  try {
    const env = "OPENPADEL_SECRET_KEY=k1\nKUMI_HOST=app.kestrel.example\n# a note\nKUMI_DB_PASSWORD=p4ss=w0rd\nOPENPADEL_LANG=es\nKUMI_LANG=es\nOPENPADEL_TAG=new\nKUMI_TAG=old\n";
    writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
    const bin = join(dir, "bin"); spawnSync("mkdir", [bin]);
    writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = rev-parse ] && echo ${dir}\n`, { mode: 0o755 });
    const go = () => spawnSync("bash", [new URL("../../../deploy/docker/update.sh", import.meta.url).pathname, "rename-settings"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const r = go();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/p4ss|kestrel|k1\b/.test(r.stdout + r.stderr), "names only");
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "OPENPADEL_SECRET_KEY=k1\nOPENPADEL_HOST=app.kestrel.example\n# a note\nOPENPADEL_DB_PASSWORD=p4ss=w0rd\nOPENPADEL_LANG=es\n"
      + "OPENPADEL_TAG=new\n# OPENPADEL_TAG is set too, and is the one used; the old line, as it was:\n# KUMI_TAG=old\n");
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    const copy = readdirSync(dir).find((f) => f.startsWith(".env.before-rename-"))!;
    assert.equal(readFileSync(join(dir, copy), "utf8"), env);
    const again = go();
    assert.equal(again.status, 0); assert.match(again.stdout, /nothing to do/);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith(".env.before-rename-")).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Docker: the image's defaults never beat a club's .env, under its old KUMI_ name or the new one, and doctor's old-names warning leaves them out", async () => {
  const { setting, oldNamesInUse, namesThatDiffer } = await import("@kumi/core");
  const docker = read("Dockerfile");
  // Each stage's environment, as `ENV` lines set it (one per stage that runs the server's code).
  const stages = docker.split(/^FROM /m).slice(1).map((st) => {
    const env: Record<string, string> = {};
    for (const m of st.matchAll(/^ENV ((?:[^\n]*\\\n)*[^\n]*)/gm)) for (const kv of m[1]!.replace(/\\\n/g, " ").matchAll(/([A-Z_]+)=("[^"]*"|\S+)/g)) env[kv[1]!] = kv[2]!.replace(/^"|"$/g, "");
    return env;
  }).filter((e) => e.OPENPADEL_IMAGE_DEFAULTS);
  assert.equal(stages.length, 2, "the server's stage and the pitr stage");
  for (const image of stages) {
    // The defaults are the old names, and the list doctor reads has each of them with its value.
    assert.ok(!Object.keys(image).some((k) => k.startsWith("OPENPADEL_") && k !== "OPENPADEL_IMAGE_DEFAULTS"), "no image default under a new name");
    const listed = Object.fromEntries(image.OPENPADEL_IMAGE_DEFAULTS!.split(" ").map((x) => x.split("=") as [string, string]));
    assert.deepEqual(listed, Object.fromEntries(Object.entries(image).filter(([k]) => k.startsWith("KUMI_"))));
    assert.deepEqual(oldNamesInUse(image), [], "the image's own defaults: no warning");
    // A club's .env replaces the image's values (compose's env_file wins over ENV): its old name, or its new one.
    const name = Object.keys(listed).find((k) => k === "KUMI_BACKUP_DIR" || k === "KUMI_CLUB_FILE")!, short = name.slice(5);
    const old = { ...image, [name]: "/srv/club/own" };
    assert.equal(setting(short, old), "/srv/club/own", "an old .env's KUMI_ value still applies");
    assert.deepEqual(oldNamesInUse(old), [name], "and doctor asks, gently, to rename what the club set");
    const renamed = { ...image, [`OPENPADEL_${short}`]: "/srv/club/own" };
    assert.equal(setting(short, renamed), "/srv/club/own");
    assert.deepEqual(oldNamesInUse(renamed), []);
    assert.deepEqual(namesThatDiffer(renamed), [], "the new name over the image's default isn't set twice");
    assert.equal(setting(short, image), listed[name], "and without the club's, the image's default");
  }
});
