import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, family: string, mia: string, mid: string;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
const post = async (path: string, who: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
/** Preview and confirm through the API, as the app does. */
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
  app = makeApp({ db, mailer, secureCookies: false });
  family = ((await run(db, "membership.plan_set", { name: "Family", price_cents: 20000, period: "month", family_size: 3, extra_person_cents: 3000 }, owner)).result as any).plan_id;
  for (const name of ["Pat", "Sam", "Ann"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(`${name.toLowerCase()}@example.test`);
  }
  mia = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2015 }, as("Pat"))).result as any).person_id;
  const code = ((await run(db, "household.invite", { person_id: people.Pat }, as("Pat"))).result as any).code;
  await run(db, "household.accept_invite", { person_id: people.Sam, code }, as("Sam"));
  mid = ((await run(db, "membership.grant", { person_id: people.Pat, plan_id: family }, owner)).result as any).membership_id;
});
after(async () => drop());

test("a family plan in the app: the payer sees who it covers and whom to add; someone covered sees whose it is", async () => {
  const plans = (await get("/membership-plans", "ann@example.test")).json;
  assert.deepEqual(plans.map((p: any) => [p.name, p.family_size, p.extra_person_cents]), [["Family", 3, 3000]]);
  let m = (await get("/my/membership", "pat@example.test")).json.membership;
  assert.deepEqual([m.mine, m.covered_by, m.family.size, m.family.payer, m.family.covered, m.family.can_add.map((x: any) => x.display_name)], [true, null, 3, "Pat", [], ["Mia", "Sam"]]);
  assert.equal((await act("pat@example.test", "membership.add_person", { membership_id: mid, person_id: mia })).status, 200);
  assert.equal((await act("pat@example.test", "membership.add_person", { membership_id: mid, person_id: people.Sam })).status, 200);
  m = (await get("/my/membership", "pat@example.test")).json.membership;
  assert.deepEqual(m.family.covered.map((x: any) => [x.display_name, x.until]), [["Mia", null], ["Sam", null]]);
  assert.equal(m.price_cents, 20000);
  const sam = (await get("/my/membership", "sam@example.test")).json.membership;
  assert.deepEqual([sam.name, sam.mine, sam.covered_by, sam.pay_now, sam.family.can_add], ["Family", false, "Pat", null, []]);
  assert.equal((await act("sam@example.test", "membership.remove_person", { membership_id: mid, person_id: mia })).status, 403);   // the payer's to change
  assert.equal((await get("/my/membership", "ann@example.test")).json.membership, null);
  await run(db, "role.assign", { person_id: people.Ann, role: "front_desk" }, owner);
  const staff = (await get(`/staff/people/${people.Sam}`, "ann@example.test")).json;
  assert.deepEqual([staff.membership, staff.covered_by.payer, staff.covered_by.plan], [null, "Pat", "Family"]);
  assert.deepEqual((await get(`/staff/people/${people.Pat}`, "ann@example.test")).json.also_covers, ["Mia", "Sam"]);
  const list = (await get("/staff/memberships", "ann@example.test")).json.members;
  assert.deepEqual(list.map((x: any) => [x.display_name, x.also_covers]), [["Pat", ["Mia", "Sam"]]]);
});
