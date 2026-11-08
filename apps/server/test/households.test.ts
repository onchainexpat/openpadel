import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, messageHandlers, processOutbox, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
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

test("a parent brings their junior's level from another app on Family; the other parent sees it, nobody else can", async () => {
  assert.equal((await get(`/my/level?for=${mia}`, "ann@example.test")).status, 404);   // not Ann's junior, staff or not
  const first = (await get(`/my/level?for=${mia}`, "pat@example.test")).json;
  assert.deepEqual([first.rating, first.import, first.can_claim], [null, null, true]);
  const low = await post("/actions/level.claim/plan", "pat@example.test", { person_id: mia, platform: "playtomic", value: 2.4 });
  assert.equal(low.json.summary, "Start Mia's level at 2.40, from Playtomic (2.4). It's provisional: their first games here move it quickly. It can be taken away before 5 rated games.");
  assert.equal((await post(`/runs/${low.json.run_id}/apply`, "pat@example.test")).status, 200);
  const seen = (await get(`/my/level?for=${mia}`, "sam@example.test")).json;
  assert.equal(seen.rating.level, "2.40");
  assert.match(seen.import.explanation, /Given in the app by Pat on /, "the junior's history says which parent gave it");
  assert.equal((await get("/my/household", "pat@example.test")).json.household.juniors[0].level, 2.4);
  const rm = await post("/actions/level.remove_import/plan", "sam@example.test", { person_id: mia });
  assert.equal(rm.json.summary, "Take away Mia's starting level from Playtomic (2.40). With nothing else behind it, they'll have no level until they play here.");
  assert.equal((await post(`/runs/${rm.json.run_id}/apply`, "sam@example.test")).status, 200);
  // Above the club's line it waits for staff, and their answer reaches the parents, pointing to Family.
  const high = await post("/actions/level.claim/plan", "pat@example.test", { person_id: mia, platform: "playtomic", value: 5 });
  assert.equal(high.json.summary, "Send Mia's level on Playtomic (5) to the club. Staff check levels above 4.50 first, for example by looking at the app. You'll hear in the app.");
  await post(`/runs/${high.json.run_id}/apply`, "pat@example.test");
  assert.equal((await get(`/my/level?for=${mia}`, "sam@example.test")).json.review.open.kind, "import");
  // Staff hear whose word it is, on Today and in the Levels queue.
  await processOutbox(db, messageHandlers);
  const staff = await db.selectFrom("outbound_message").select(["kind", "body"]).where("person_id", "=", owner.personId!).where("kind", "like", "level_import_claimed%").where("channel", "=", "inbox").execute();
  assert.deepEqual(staff.map((m) => m.kind), ["level_import_claimed_staff_by"]);
  assert.match(staff[0]!.body, /^Pat says Mia's level on Playtomic is 5\./);
  await signIn("robin@example.test");
  assert.equal((await get("/staff/levels", "robin@example.test")).json.requests.find((r: any) => r.person_id === mia).sent_by, "Pat");
  await run(db, "level.answer_review", { person_id: mia, outcome: "accept" }, owner);
  await processOutbox(db, messageHandlers);
  assert.match((await get(`/my/level?for=${mia}`, "pat@example.test")).json.import.explanation, /Given in the app by Pat and checked by Robin Hale on /);
  const told = await db.selectFrom("outbound_message").select(["person_id", "subject", "link"]).where("kind", "=", "level_import_accepted").where("channel", "=", "inbox").execute();
  assert.deepEqual(told.map((m) => [m.person_id === people.Pat || m.person_id === people.Sam, m.subject, m.link]).sort(),
    [[true, "Mia: Your level starts at 5.00", "/family"], [true, "Mia: Your level starts at 5.00", "/family"]]);
  // A parent's own level still reads as theirs.
  assert.match((await post("/actions/level.claim/plan", "pat@example.test", { person_id: people.Pat, platform: "playtomic", value: 3 })).json.summary, /^Start your level at 3\.00/);
});

test("a junior's level is only their parents': a stranger learns nothing from a preview, a parent who left can't confirm, a kid with a login and the parent who sent it both hear", async () => {
  people.Zed = ((await run(db, "person.create", { display_name: "Zed", email: "zed@example.test" }, owner)).result as any).person_id;
  await signIn("zed@example.test");
  // Mia has a level from Playtomic now: a stranger is refused as for anyone, not told "already brought".
  for (const [action, input] of [["level.claim", { person_id: mia, platform: "playtomic", value: 3 }], ["level.remove_import", { person_id: mia }], ["level.request_review", { person_id: mia }]] as const) {
    const r = await post(`/actions/${action}/plan`, "zed@example.test", input);
    assert.equal(r.status, 403, action);
  }
  // Sam previews taking Mia's away, leaves the family, and can't confirm it.
  const take = await post("/actions/level.remove_import/plan", "sam@example.test", { person_id: mia });
  assert.equal(take.status, 200);
  await act("sam@example.test", "household.leave", { person_id: people.Sam });
  assert.equal((await post(`/runs/${take.json.run_id}/apply`, "sam@example.test")).status, 403);
  assert.ok((await get(`/my/level?for=${mia}`, "pat@example.test")).json.import, "Mia's level from Playtomic stays");
  // Leo, 14, has a login of his own: Pat sends his level, and the club's answer reaches Leo and Pat (who sent it).
  const leo = (await act("pat@example.test", "household.add_junior", { person_id: people.Pat, display_name: "Leo", birth_year: new Date().getFullYear() - 14 })).json.result.person_id;
  await db.updateTable("person").set({ own_login: true }).where("id", "=", leo).execute();
  const sent = await post("/actions/level.claim/plan", "pat@example.test", { person_id: leo, platform: "playtomic", value: 5.1 });
  assert.match(sent.json.summary, /^Send Leo's level on Playtomic \(5\.1\) to the club\..* You'll hear in the app\.$/);
  await post(`/runs/${sent.json.run_id}/apply`, "pat@example.test");
  await run(db, "level.answer_review", { person_id: leo, outcome: "keep", reason: "Let's see a few games first" }, owner);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["person_id", "subject", "link"]).where("kind", "=", "level_import_kept").where("channel", "=", "inbox").orderBy("person_id").execute();
  assert.deepEqual(told.map((m) => [m.person_id === leo ? "Leo" : m.person_id === people.Pat ? "Pat" : "someone else", m.subject, m.link]).sort(),
    [["Leo", "Your level from Playtomic", "/level"], ["Pat", "Leo: Your level from Playtomic", "/family"]]);
});

test("a junior's places, family and account are their parents' alone: a stranger learns nothing from a preview, a parent who left can't confirm", async () => {
  const where = await db.selectFrom("court").select(["id", "location_id"]).executeTakeFirstOrThrow();
  await run(db, "hours.set", { location_id: where.location_id, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  const day = localDate(new Date(Date.now() + 3 * 86400_000), "America/Los_Angeles");
  const court = ((await run(db, "booking.create", { court_id: where.id, starts_at: `${day}T18:00:00-08:00`, minutes: 60, person_id: mia }, owner)).result as any).booking_id;
  const place = (await db.selectFrom("enrolment").select("id").where("person_id", "=", mia).where("status", "=", "booked").executeTakeFirstOrThrow()).id;
  const leo = (await db.selectFrom("person").select("id").where("display_name", "=", "Leo").executeTakeFirstOrThrow()).id;
  // Zed, a stranger. Each of these said what stood in the way, and whose: "Mia still has places", "Mia can have a login
  // of their own from 2034", "Mia has accepted it already", "Mia is signed up already", the family has no card. Now a plain no.
  for (const [action, input] of [
    ["household.remove_junior", { person_id: mia }], ["household.give_login", { person_id: mia, email: "mia@example.test" }], ["waiver.accept", { person_id: mia }],
    ["kid.give_login", { person_id: mia, email: "mia@example.test" }], ["kid.set_rules", { person_id: leo, courts: false }], ["family_card.remove", { person_id: people.Pat }],
    ["program.watch", { program_id: clinic, person_id: mia }], ["enrolment.leave", { enrolment_id: place }], ["booking.cancel", { booking_id: court }],
  ] as const) {
    const r = await post(`/actions/${action}/plan`, "zed@example.test", input);
    assert.equal(r.status, 403, `${action}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, "error.forbidden_reason", action);
    assert.doesNotMatch(JSON.stringify(r.json), /Mia|Leo|20\d\d/, action);
  }
  // Sam joins the family again: Mia's court and her place are Sam's to give up too, and what stands in the way is said.
  const inv = await act("pat@example.test", "household.invite", { person_id: people.Pat });
  assert.equal((await act("sam@example.test", "household.accept_invite", { person_id: people.Sam, code: inv.json.result.code })).status, 200);
  const cancel = await post("/actions/booking.cancel/plan", "sam@example.test", { booking_id: court });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
  const leave = await post("/actions/enrolment.leave/plan", "sam@example.test", { enrolment_id: place });
  assert.equal(leave.status, 200, JSON.stringify(leave.json));
  const remove = await post("/actions/household.remove_junior/plan", "sam@example.test", { person_id: mia });
  assert.equal(remove.json.error, "error.junior_has_places");
  assert.match(remove.json.message, /Mia/);
  // Sam leaves the family before saying yes: neither goes through, and Mia keeps both.
  assert.equal((await act("sam@example.test", "household.leave", { person_id: people.Sam })).status, 200);
  for (const run_ of [cancel, leave]) assert.equal((await post(`/runs/${run_.json.run_id}/apply`, "sam@example.test")).status, 403);
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", court).executeTakeFirstOrThrow()).status, "confirmed");
  assert.equal((await db.selectFrom("enrolment").select("status").where("id", "=", place).executeTakeFirstOrThrow()).status, "booked");
  // Pat, still her parent, cancels her court.
  assert.equal((await act("pat@example.test", "booking.cancel", { booking_id: court })).status, 200);
});
