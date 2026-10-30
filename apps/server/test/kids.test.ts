import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, mia: string;
const programs: Record<string, string> = {};
const stripe = new TestProvider(), mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
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
/** Preview and confirm through the API, as the app does. */
async function act(who: string, action: string, input: unknown): Promise<{ status: number; json: any; summary?: string }> {
  const p = await post(`/actions/${action}/plan`, who, input);
  if (p.status !== 200) return p;
  const a = await post(`/runs/${p.json.run_id}/apply`, who);
  return { ...a, summary: p.json.summary as string };
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  const start = new Date(Date.now() + 5 * 86400_000);
  for (const [name, cents] of [["Junior Clinic", 2500], ["Volley Clinic", 2500], ["Lob Clinic", 1500]] as const) {
    programs[name] = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name, capacity: 8, price_cents: cents }, owner)).result as any).program_id;
    const at = new Date(start.getTime() + Object.keys(programs).length * 3 * 3600_000);
    await run(db, "session.add", { program_id: programs[name], starts_at: at.toISOString(), ends_at: new Date(at.getTime() + 3600_000).toISOString(), court_ids: [court] }, owner);
    await run(db, "program.publish", { program_id: programs[name] }, owner);
  }
  people.Pat = ((await run(db, "person.create", { display_name: "Pat", email: "pat@example.test" }, owner)).result as any).person_id;
  await signIn("pat@example.test");
  await signIn("robin@example.test");
});
after(async () => drop());

test("a parent turns on a kid's login and saves the family card; the kid signs in and sees their rules", async () => {
  mia = (await act("pat@example.test", "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: new Date().getFullYear() - 14 })).json.result.person_id;
  const login = await act("pat@example.test", "kid.give_login", { person_id: mia, email: "mia@example.test" });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  await signIn("mia@example.test");
  assert.deepEqual((await get("/me", "mia@example.test")).json.kid, { friends: false });
  assert.equal((await get("/me", "pat@example.test")).json.kid, null);
  // The family card: a card setup, nothing charged.
  const open = await post("/my/family/card", "pat@example.test");
  assert.equal(open.status, 200);
  assert.equal((await post("/my/family/card", "mia@example.test")).status, 409);   // a kid doesn't save it
  const ref = (await db.selectFrom("family_card").select("provider_ref").where("id", "=", open.json.card_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settleSetup(ref);
  assert.deepEqual((await post(`/my/family/card/${open.json.card_id}/check`, "pat@example.test")).json, { status: "succeeded" });
  const kids = (await get("/my/kids", "pat@example.test")).json;
  assert.deepEqual(kids.kids.map((k: any) => [k.display_name, k.own_login, k.email, k.rules.monthly_limit_cents, k.spent_cents]), [["Mia", true, "mia@example.test", 10000, 0]]);
  assert.equal(kids.card.saved_by, "Pat");
  const me = (await get("/my/kid", "mia@example.test")).json.kid;
  assert.deepEqual([me.parents, me.card, me.spent_cents], [["Pat"], true, 0]);
});

test("a kid signs up: paid on the family card, so the app gets no card form to open", async () => {
  const r = await act("mia@example.test", "enrolment.join", { program_id: programs["Junior Clinic"], person_id: mia });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.result.family, { status: "paid", cents: 2500 });
  assert.equal(r.json.result.payment_id, undefined);
  assert.equal((await get("/my/kid", "mia@example.test")).json.kid.spent_cents, 2500);
});

test("over the limit: the kid's plan asks the parents; a parent's yes signs them up and pays", async () => {
  assert.equal((await act("pat@example.test", "kid.set_rules", { person_id: mia, monthly_limit_cents: 4000 })).status, 200);
  const r = await act("mia@example.test", "enrolment.join", { program_id: programs["Volley Clinic"], person_id: mia });
  assert.match(r.summary ?? "", /^Ask your parents to approve this: Sign Mia up for Volley Clinic/);
  assert.equal(r.json.result.asked_parent, true);
  const asked = (await get("/my/kids", "pat@example.test")).json.requests;
  assert.deepEqual(asked.map((x: any) => [x.name, x.cents]), [["Mia", 2500]]);
  assert.equal((await post(`/my/kids/requests/${asked[0].id}/approve`, "mia@example.test")).status, 403);
  assert.deepEqual((await post(`/my/kids/requests/${asked[0].id}/approve`, "pat@example.test")).json, { outcome: "done", paid: "paid" });
  const mine = (await get("/my/kid", "mia@example.test")).json.kid;
  assert.deepEqual(mine.requests.map((x: any) => x.status), ["done"]);
  assert.equal(mine.spent_cents, 5000);
});

test("a declined family card: the kid's pay sheet says a parent will pay; the parent pays with the card form", async () => {
  await act("pat@example.test", "kid.set_rules", { person_id: mia, monthly_limit_cents: 10000 });
  stripe.failNextCharge = "card_declined";
  const r = await act("mia@example.test", "enrolment.join", { program_id: programs["Lob Clinic"], person_id: mia });
  assert.deepEqual(r.json.result.family, { status: "parent", cents: 1500, why: "declined" });
  const owed = (await get("/my/kids", "pat@example.test")).json.to_pay;
  assert.equal(owed.length, 1);
  assert.match(owed[0].what, /^Lob Clinic, /);
  assert.deepEqual((await post(`/my/payments/${owed[0].payment_id}/intent`, "mia@example.test")).json, { family: "parent" });
  const form = await post(`/my/payments/${owed[0].payment_id}/intent`, "pat@example.test");
  assert.ok(form.json.client_secret);
});

test("a kid sees the waiver as their parents' to accept; staff see the login and the rules", async () => {
  await run(db, "waiver.set", { body: "Padel is a sport with risks. I play at my own risk and follow the club's rules." }, owner);
  const w = (await get("/my/waiver", "mia@example.test")).json;
  assert.deepEqual(w.people.map((p: any) => [p.me, p.by_parent]), [[true, true]]);
  const staff = (await get(`/staff/people/${mia}`, "robin@example.test")).json;
  assert.equal(staff.kid.email, "mia@example.test");
  assert.match(staff.kid.rules, /^They can book open matches, courts, programs and lessons on their own, up to \$100\.00 a month/);
});
