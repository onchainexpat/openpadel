import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, clinic: string, mia: string;
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
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Junior Clinic", capacity: 8, price_cents: 2500 }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 5 * 86400_000);
  await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: clinic }, owner);
  for (const name of ["Pat", "Sam", "Ann"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(`${name.toLowerCase()}@example.test`);
  }
});
after(async () => drop());

test("a family through the app: add a junior, invite the other parent, who sees the same juniors", async () => {
  assert.deepEqual((await get("/my/household", "pat@example.test")).json, { household: null, role: null });
  const add = await act("pat@example.test", "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2016 });
  assert.equal(add.status, 200);
  mia = add.json.result.person_id;
  const inv = await act("pat@example.test", "household.invite", { person_id: people.Pat });
  const h = (await get("/my/household", "pat@example.test")).json;
  assert.equal(h.role, "adult");
  assert.deepEqual(h.household.juniors.map((j: any) => [j.display_name, j.birth_year, j.level, j.waiver]), [["Mia", 2016, null, null]]);
  assert.equal(h.household.invites.length, 1);
  // The other parent opens the link: whose family, and for whom.
  const link = await get(`/my/household/invites/${inv.json.result.code}`, "sam@example.test");
  assert.deepEqual(link.json, { from: "Pat", juniors: ["Mia"], open: true, already: false });
  await act("sam@example.test", "household.accept_invite", { person_id: people.Sam, code: inv.json.result.code });
  assert.deepEqual((await get("/my/household", "sam@example.test")).json.household.adults.map((a: any) => [a.display_name, a.me]), [["Pat", false], ["Sam", true]]);
  assert.equal((await get(`/my/household/invites/${inv.json.result.code}`, "ann@example.test")).json.open, false);
});

test("the waiver: what's still to accept, for the member and each junior", async () => {
  assert.deepEqual((await get("/my/waiver", "pat@example.test")).json, { waiver: null, people: [] });
  await run(db, "waiver.set", { body: "Padel has risks. I play at my own risk and follow the club's rules." }, owner);
  const w = (await get("/my/waiver", "pat@example.test")).json;
  assert.equal(w.waiver.version_no, 1);
  assert.deepEqual(w.people.map((p: any) => [p.display_name, p.me, p.accepted_at]), [[null, true, null], ["Mia", false, null]]);
  const blocked = await post("/actions/enrolment.join/plan", "pat@example.test", { program_id: clinic, person_id: mia });
  assert.equal(blocked.json.error, "error.waiver_needed_junior");
  assert.equal((await act("pat@example.test", "waiver.accept", { person_id: mia })).status, 200);
  assert.equal((await act("pat@example.test", "waiver.accept", { person_id: people.Pat })).status, 200);
});

test("a parent sees programs as their junior would, signs them up and pays; nobody else can", async () => {
  const forMia = (await get(`/open-programs?for=${mia}`, "sam@example.test")).json;
  assert.deepEqual(forMia.map((p: any) => [p.name, p.my_status]), [["Junior Clinic", null]]);
  assert.equal((await get(`/open-programs?for=${mia}`, "ann@example.test")).status, 404);   // not Ann's junior
  const j = await act("sam@example.test", "enrolment.join", { program_id: clinic, person_id: mia });
  assert.equal(j.status, 200);
  assert.deepEqual((await get(`/open-programs?for=${mia}`, "pat@example.test")).json.map((p: any) => p.my_status), ["booked"]);
  const places = (await get("/my/places", "pat@example.test")).json;
  assert.deepEqual(places.map((p: any) => [p.name, p.for_name]), [["Junior Clinic", "Mia"]]);
  assert.ok(places[0].pending_payment_id);
  assert.equal((await post(`/my/payments/${places[0].pending_payment_id}/intent`, "ann@example.test")).status, 404);
  const intent = await post(`/my/payments/${places[0].pending_payment_id}/intent`, "pat@example.test");
  assert.equal(intent.status, 200);
  assert.equal(intent.json.provider, "test");
  // Ann (no family) sees only her own places.
  assert.deepEqual((await get("/my/places", "ann@example.test")).json, []);
});

test("staff see the family and the waiver on the person page", async () => {
  await run(db, "role.assign", { person_id: people.Ann, role: "front_desk" }, owner);
  const p = (await get(`/staff/people/${mia}`, "ann@example.test")).json;
  assert.deepEqual([p.junior, p.birth_year, p.family_role], [true, 2016, "junior"]);
  assert.deepEqual(p.family.map((x: any) => [x.display_name, x.role]), [["Pat", "adult"], ["Sam", "adult"]]);
  assert.equal(p.waiver.version_no, 1);
  assert.equal(p.waiver.accepted_by, "Pat");
  const list = (await get("/staff/people?q=Mia", "ann@example.test")).json;
  assert.deepEqual(list.map((x: any) => [x.display_name, x.junior, x.email]), [["Mia", true, null]]);
  assert.equal((await get("/staff/settings", "ann@example.test")).json.waiver.version_no, 1);
});
