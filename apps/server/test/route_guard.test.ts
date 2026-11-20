// The checks that cover a whole group of pages (the staff reads behind /staff/*) hold for unusual addresses too: an
// encoded line break or other line terminator in the path (GHSA-h7mg-cq63-vhpq, fixed in Hono 4.13.16), a backslash,
// doubled slashes. Signed out, each is turned away as signed out, never answered and never sent past the check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false });
});
after(async () => { await drop(); });

test("signed out, the staff reads say so for every spelling of their address", async () => {
  const plain = await app.request("/staff/counts");
  assert.equal(plain.status, 401, "the plain address");
  for (const path of ["/staff/counts%0A", "/staff/counts%0D", "/staff/%0Acounts", "/staff/counts%E2%80%A8", "/staff/counts%E2%80%A9",
    "/staff/people%0A", "/staff//counts", "/staff/counts/", "/staff/plugins%0A", "/staff/vault%0D"]) {
    const r = await app.request(path);
    assert.equal(r.status, 401, `${path} is turned away as signed out (got ${r.status})`);
  }
});
