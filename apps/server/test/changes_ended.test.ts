// The Changes page says why an ask ended without a yes ("Out of date: ..."), and the staff app's first look at an ask
// sends nothing until the person asks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  const owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" as const };
  const m = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: m, role: "manager" }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
});
after(async () => drop());

test("a manager's ask: shown first, asked when they say; made out of date by the owner, the Changes page says why", async () => {
  const mia = await signIn("mia@example.test"), robin = await signIn("robin@example.test");
  const look = await call("/actions/club.update/plan?ask=hold", mia, { legal_name: "Kestrel Padel Inc." });
  assert.equal(look.json.status, "would_ask");
  const asked = await call("/actions/club.update/plan", mia, { legal_name: "Kestrel Padel Inc." });
  assert.equal(asked.json.status, "awaiting_approval");
  const own = await call("/actions/club.update/plan", robin, { legal_name: "Kestrel Padel Inc." });
  assert.equal((await call(`/runs/${own.json.run_id}/apply`, robin, {})).status, 200);
  const rows = (await call("/staff/changes", robin)).json as any[];
  const row = rows.find((r) => r.id === asked.json.run_id);
  assert.equal(row.status, "failed");
  assert.match(row.ended, /^Out of date/, JSON.stringify(row));
  assert.equal(row.can_answer, false);
});
