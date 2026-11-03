// Where the server listens, and whose word it takes for a visitor's address. On a server several clubs share, a club
// listening on a port could be reached by another club's process on 127.0.0.1, which Kumi believed as its own proxy:
// a forged X-Forwarded-For got around the sign-in limits, and /health/deep answered it. On its own unix socket a club
// has no port at all, and only its proxy (and root) can open the socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describeListen, listen, listenFrom } from "../src/listen.ts";
import { clientIp } from "../src/limits.ts";
import { fromThisServer } from "../src/health.ts";

/** A server that says who it thinks each visitor is, and whether the request came from this machine. */
const witness = (env: Record<string, string | undefined>) => new Hono().get("/who", (c) => c.json({ ip: clientIp(c, env), local: fromThisServer(c, env) })).fetch;

function ask(o: { socketPath?: string; port?: number; host?: string; headers?: Record<string, string> }): Promise<{ ip: string | null; local: boolean }> {
  return new Promise((resolve, reject) => {
    const r = request({ ...o, path: "/who", headers: { host: "kestrel.kumi.club", ...o.headers } }, (res) => {
      let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve(JSON.parse(body)));
    });
    r.on("error", reject); r.end();
  });
}

test("the settings: 127.0.0.1 and PORT unless told otherwise; a socket is a full path", () => {
  assert.deepEqual(listenFrom({}), { address: "127.0.0.1", port: 8790 });
  assert.deepEqual(listenFrom({ PORT: "9100", KUMI_LISTEN_ADDRESS: "0.0.0.0" }), { address: "0.0.0.0", port: 9100 });
  assert.deepEqual(listenFrom({ PORT: "9100", KUMI_SOCKET: "/run/kumi-kestrel/http.sock" }), { socket: "/run/kumi-kestrel/http.sock" });
  assert.throws(() => listenFrom({ KUMI_SOCKET: "http.sock" }), /full path/);
  assert.throws(() => listenFrom({ PORT: "eighty" }), /PORT is a number/);
  assert.equal(describeListen({ socket: "/run/k/http.sock" }), "unix socket /run/k/http.sock");
  assert.equal(describeListen({ address: "::1", port: 8790 }), "http://[::1]:8790");
});

test("by default only this machine can reach the server", async () => {
  const env = {}, server = await listen(witness(env), { address: "127.0.0.1", port: 0 });
  try {
    const a = server.address();
    assert.ok(a && typeof a === "object");
    assert.equal(a.address, "127.0.0.1");   // not every address, as before
    assert.equal(describeListen({ address: "127.0.0.1", port: 0 }, server), `http://127.0.0.1:${a.port}`);
    // One club on the machine: Caddy beside it is believed (unchanged).
    assert.deepEqual(await ask({ port: a.port, host: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.66" } }), { ip: "198.51.100.66", local: false });
  } finally { server.close(); }
});

test("on its own unix socket a club has no port, takes its proxy's word, and keeps the socket to its owner and group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-socket-")), sock = join(dir, "http.sock"), env = { KUMI_SOCKET: sock };
  const server = await listen(witness(env), listenFrom(env));
  try {
    assert.equal(server.address(), sock);   // no port another club's process could reach
    assert.equal(statSync(sock).mode & 0o777, 0o660);
    // Through the proxy: the visitor it names.
    assert.deepEqual(await ask({ socketPath: sock, headers: { "x-forwarded-for": "203.0.113.9" } }), { ip: "203.0.113.9", local: false });
    assert.deepEqual(await ask({ socketPath: sock, headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.10" } }), { ip: "203.0.113.10", local: false });
    // Without a proxy in between: someone on this server (root, or the club itself), with no address to count.
    assert.deepEqual(await ask({ socketPath: sock }), { ip: null, local: true });
  } finally { server.close(); }
});

test("a socket left by a server that stopped is replaced; anything else there is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-socket-")), sock = join(dir, "http.sock");
  // A server killed before it could tidy up leaves its socket behind.
  const left = spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.equal(left.signal, "SIGKILL");
  assert.ok(statSync(sock).isSocket());
  const server = await listen(witness({ KUMI_SOCKET: sock }), { socket: sock });
  assert.deepEqual(await ask({ socketPath: sock, headers: { "x-forwarded-for": "203.0.113.9" } }), { ip: "203.0.113.9", local: false });
  server.close();

  const file = join(dir, "notes.txt");
  writeFileSync(file, "keep me\n");
  await assert.rejects(listen(witness({}), { socket: file }), /isn't a socket: not replacing it/);
  assert.ok(existsSync(file));
});
