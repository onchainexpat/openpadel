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
  for (const page of ["/membership", "/memberships", "/book", "/places", "/people", "/courts", "/settings", "/join/abc", "/play", "/match/abc", "/scores", "/vault"]) assert.ok(!routed(page), `${page} is an app page`);
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

test("ship.sh hands the release to its own release.sh", () => {
  const ship = read("deploy/ship.sh");
  assert.match(ship, /tar -xOf .*deploy\/release\.sh/);
  assert.match(ship, /release\.sh update /);
});
