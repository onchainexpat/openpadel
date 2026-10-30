import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  for (const name of ["Ann", "Ben", "Bea"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(`${name.toLowerCase()}@example.test`);
  }
});
after(async () => drop());

test("names only for friends: the search finds friends, and a link shows its owner and where you stand", async () => {
  // Before: searching finds nobody (Ben and Bea are members, but not Ann's friends).
  assert.deepEqual((await get("/my/friends/find?q=Be", "ann@example.test")).json, []);
  const ben = await get("/my/friends", "ben@example.test");
  assert.match(ben.json.code, /^[0-9a-f]{12}$/);
  const link = await get(`/my/friends/link/${ben.json.code}`, "ann@example.test");
  assert.deepEqual([link.json.display_name, link.json.status], ["Ben", "none"]);
  assert.equal((await get(`/my/friends/link/${ben.json.code}`, "ben@example.test")).json.status, "self");
  assert.equal((await get("/my/friends/link/abcdefabcdef", "ann@example.test")).status, 404);
  await run(db, "friend.add_by_code", { person_id: people.Ann, code: ben.json.code }, as("Ann"));
  assert.equal((await get(`/my/friends/link/${ben.json.code}`, "ann@example.test")).json.status, "waiting");
  assert.deepEqual((await get("/my/friends", "ben@example.test")).json.added_you.map((p: any) => p.display_name), ["Ann"]);
  assert.deepEqual((await get("/my/friends/find?q=Be", "ann@example.test")).json, []);   // not until Ben adds Ann back
  await run(db, "friend.add", { person_id: people.Ben, friend_id: people.Ann }, as("Ben"));
  assert.deepEqual((await get("/my/friends/find?q=Be", "ann@example.test")).json, [{ id: people.Ben, display_name: "Ben" }]);   // Ben, never Bea
  assert.equal((await get(`/my/friends/link/${ben.json.code}`, "ann@example.test")).json.status, "friends");
  assert.equal((await get("/my/friends", "bea@example.test")).json.friends.length, 0);
});
