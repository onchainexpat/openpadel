import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { readArea } from "../src/reads.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  cookies[email] = r.headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "two_factor" };
  people.Fran = ((await run(db, "person.create", { display_name: "Fran", email: "fran@example.test" }, owner)).result as any).person_id;
  const role = ((await run(db, "role.create", { name: "Tagger", grants: [{ action: "person.tag", scope: "any" }, { action: "person.untag", scope: "any" }] }, owner)).result as any).key;
  await run(db, "role.assign", { person_id: people.Fran, role }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
  for (const e of ["fran@example.test", "robin@example.test"]) await signIn(e);
});
after(async () => drop());

test("each staff page's data belongs to an area", () => {
  assert.deepEqual(["/staff/people", "/staff/people/x/level", "/staff/programs/x", "/staff/reports", "/staff/roles", "/staff/broadcasts", "/staff/grid", "/staff/locations"].map(readArea),
    ["members", "levels", "programs", "money", "settings", "messages", "bookings", null]);
});

test("someone whose only staff role is the club's own sees the areas it covers, and reads nothing else", async () => {
  const me = await get("/me", "fran@example.test");
  assert.deepEqual(me.json.areas, ["members"]);
  assert.deepEqual(me.json.roles.map((r: any) => r.name ?? r.key).sort(), ["Tagger", "member"]);
  assert.equal((await get("/staff/people", "fran@example.test")).status, 200);
  assert.equal((await get("/staff/locations", "fran@example.test")).status, 200);   // a list every area uses
  for (const path of ["/staff/programs", "/staff/settings", "/staff/roles", "/staff/reports.csv?location_id=x&from=2026-11-01&to=2026-11-02"]) assert.equal((await get(path, "fran@example.test")).status, 403, path);
  // The owner sees roles, with the club's own by name.
  const roles = await get("/staff/roles", "robin@example.test");
  assert.deepEqual(roles.json.filter((r: any) => !r.system).map((r: any) => [r.name, r.holders]), [["Tagger", 1]]);
  assert.equal((await get("/me", "robin@example.test")).json.areas, null);
});
