import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, headers: r.headers, text: await r.text() }; };
const post = async (path: string, who: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
async function codeFor(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
}
async function signIn(email: string) { cookies[email] = (await codeFor(email)).headers.get("set-cookie")!.split(";")[0]!; }
async function act(who: string, action: string, input: unknown) {
  const p = await post(`/actions/${action}/plan`, who, input);
  if (p.status !== 200) return p;
  return post(`/runs/${p.json.run_id}/apply`, who);
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new TestProvider());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  await run(db, "club.update", { sign_up_open: true }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
  for (const name of ["Ann", "Ben"]) people[name] = ((await run(db, "person.create", { display_name: `${name} Example`, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  for (const e of ["ann@example.test", "ben@example.test", "robin@example.test"]) await signIn(e);
});
after(async () => drop());

test("a member downloads their own file, once they've confirmed it; nobody else can fetch it", async () => {
  const check = JSON.parse((await get("/my/privacy/check", "ann@example.test")).text);
  assert.deepEqual(check, { blockers: [], juniors: [], ends: [] });
  assert.equal((await get(`/my/privacy/check?person_id=${people.Ben}`, "ann@example.test")).status, 404);   // not hers to look at
  const r = await act("ann@example.test", "privacy.export", { person_id: people.Ann });
  assert.equal(r.status, 200);
  const file = await get(r.json.result.download, "ann@example.test");
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition")!, /^attachment; filename="kestrel-padel-data-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(file.headers.get("cache-control"), "no-store");
  const data = JSON.parse(file.text);
  assert.equal(data.format, "kumi-export-1");
  assert.equal(data.profile.email, "ann@example.test");
  assert.equal((await get(r.json.result.download, "ben@example.test")).status, 404);
  // The owner, for a member who asked: the same file, to the owner.
  const o = await act("robin@example.test", "privacy.export", { person_id: people.Ben });
  assert.equal(JSON.parse((await get(o.json.result.download, "robin@example.test")).text).profile.email, "ben@example.test");
});

test("after deleting, the old session and the old address lead nowhere; a Spanish reader sees Exmiembro", async () => {
  const r = await act("ann@example.test", "privacy.erase", { person_id: people.Ann });
  assert.equal(r.status, 200);
  assert.equal((await get("/me", "ann@example.test")).status, 401);
  // The address now belongs to nobody: a code to it is a code to join, not a way back in.
  const again = await (await codeFor("ann@example.test")).json() as any;
  assert.equal(again.sign_up, true);
  assert.equal(again.signed_in, undefined);
  await run(db, "person.update_profile", { person_id: owner.personId, locale: "es" }, owner);
  const page = JSON.parse((await get(`/staff/people/${people.Ann}`, "robin@example.test")).text);
  assert.equal(page.display_name, "Exmiembro");
  assert.ok(page.redacted_at);
});
