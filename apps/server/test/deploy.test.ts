import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("both ways of running Kumi give the apps the same security policy and the same API paths", () => {
  const script = read("deploy/server-setup.sh"), caddy = read("deploy/docker/Caddyfile");
  assert.equal(caddy.match(/Content-Security-Policy "(.*)"/)![1], script.match(/^csp="(.*)"$/m)![1]);
  assert.equal(caddy.match(/@api path (.*)/)![1].trim(), script.match(/^api='(.*)'$/m)![1]);
});

test("container images are pinned to exact versions", () => {
  for (const line of [...read("Dockerfile").matchAll(/^FROM (\S+)/gm), ...read("compose.yaml").matchAll(/image: (\S+)/g)].map((m) => m[1]!)) {
    if (!line.includes(":")) continue;   // a stage of this build, not an image
    assert.match(line, /:\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?$/, `${line} should name an exact version`);
  }
});
