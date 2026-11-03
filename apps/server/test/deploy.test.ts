import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

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
  assert.equal((compose.match(/postgresql:\/\/kumi_app:/g) ?? []).length, 2);   // the server and the backup service
  assert.match(compose, /db-init\.sh:\/docker-entrypoint-initdb\.d\//);
  assert.match(init, /CREATE ROLE kumi_app LOGIN NOSUPERUSER NOCREATEROLE CREATEDB/);
  assert.match(init, /ALTER DATABASE kumi OWNER TO kumi_app/);
  assert.match(update, /move_to_app_role\(\)/);
  assert.match(update, /chmod 600 \.env/);
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
