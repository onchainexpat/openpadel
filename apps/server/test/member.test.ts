import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, rated: string, friendly: string, ana: string;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => { const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  const court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  for (const [name, isRated, c, days] of [["Friday Americano", true, court, 2], ["Sunday Social", false, court2, 3]] as const) {
    const id = ((await run(db, "program.create", { location_id: loc, kind: "social", format: "americano", name, capacity: 8, price_cents: 2500, rated: isRated }, owner)).result as any).program_id;
    await run(db, "session.add", { program_id: id, starts_at: new Date(Date.now() + days * 864e5).toISOString(), ends_at: new Date(Date.now() + days * 864e5 + 7200_000).toISOString(), court_ids: [c] }, owner);
    await run(db, "program.publish", { program_id: id }, owner);
    if (isRated) rated = id; else friendly = id;
  }
  ana = uuidv7();
  await db.insertInto("person").values({ id: ana, display_name: "Ana", email: "ana@example.test", locale: "es", created_via: "desk" }).execute();
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: ana, role_id: member.id, location_id: null }).execute();
});
after(async () => drop());

test("what's on: open programs, each marked rated or friendly before joining", async () => {
  const cookie = await signIn("ana@example.test");
  const r = (await call("/open-programs", cookie)).json;
  assert.deepEqual(r.map((p: any) => [p.name, p.rated]), [["Friday Americano", true], ["Sunday Social", false]]);
});

test("join, pay (stand-in), and the place shows as paid; the preview is in Spanish", async () => {
  const cookie = await signIn("ana@example.test");
  const p = await call("/actions/enrolment.join/plan", cookie, { program_id: rated, person_id: ana });
  assert.equal(p.json.summary, "Apuntar a Ana a Friday Americano por $25.00.");
  const j = await call(`/runs/${p.json.run_id}/apply`, cookie, {});
  assert.ok(j.json.result.payment_id);
  let places = (await call("/my/places", cookie)).json;
  assert.equal(places[0].paid_cents, 0); assert.equal(places[0].pending_payment_id, j.json.result.payment_id);
  assert.equal((await call(`/dev/payments/${j.json.result.payment_id}/settle`, cookie, {})).status, 200);
  places = (await call("/my/places", cookie)).json;
  assert.equal(places[0].paid_cents, 2500); assert.equal(places[0].pending_payment_id, null);
  assert.equal((await call("/open-programs", cookie)).json.find((x: any) => x.id === rated).my_status, "booked");
});

test("my level starts empty, and only my own", async () => {
  const cookie = await signIn("ana@example.test");
  const r = (await call("/my/level", cookie)).json;
  assert.equal(r.rating, null); assert.deepEqual(r.events, []);
});

test("the test payment route doesn't exist in production", async () => {
  const prod = makeApp({ db, mailer, secureCookies: false, production: true });
  const r = await prod.request("/dev/payments/00000000-0000-7000-8000-000000000000/settle", { method: "POST" });
  assert.equal(r.status, 404);
  void friendly;
});
