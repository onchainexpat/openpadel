import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { plan, run, runAsSystem, KumiError, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, c1: string, c2: string;
const mailer = new MemoryMailer();
const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2", kind: "outdoor" }, owner)).result as any).court_id;
});
after(async () => drop());

async function cookie(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const settings = async (ck: string) => (await (await app.request("/staff/settings", { headers: { cookie: ck } })).json()) as any;

test("settings: the club and each location with its courts", async () => {
  const s = await settings(await cookie("robin@example.test"));
  assert.equal(s.club.name, "Kestrel Padel"); assert.equal(s.club.sign_up_open, true);
  assert.deepEqual(s.locations[0].courts.map((c: any) => [c.name, c.kind]), [["Court 1", "indoor"], ["Court 2", "outdoor"]]);
});

test("closing sign-up is a club setting, previewed like any other", async () => {
  const p = await plan(db, "club.update", { sign_up_open: false }, owner);
  assert.equal(p.plan.summary.en, "Change whether people can join by themselves.");
  await run(db, "club.update", { sign_up_open: false }, owner);
  assert.equal((await db.selectFrom("club").select("sign_up_open").executeTakeFirstOrThrow()).sign_up_open, false);
  await run(db, "club.update", { sign_up_open: true }, owner);
});

test("a court is renamed; it can't be archived while dates still use it; archiving can be undone", async () => {
  await run(db, "court.update", { court_id: c2, name: "Court 2 (glass)", kind: "covered_outdoor" }, owner);
  const p = (await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Clinic", capacity: 4, price_cents: 0 }, owner)).result as any;
  await run(db, "session.add", { program_id: p.program_id, starts_at: later(48), ends_at: later(49), court_ids: [c1] }, owner);
  await assert.rejects(plan(db, "court.archive", { court_id: c1 }, owner), (e: unknown) => {
    assert.ok(e instanceof KumiError); assert.equal(e.code, "error.court_in_use");
    assert.equal(e.text.en, "That court has 1 date still to come. Move it to another court first."); return true;
  });
  const archived = await run(db, "court.archive", { court_id: c2 }, owner);
  const ck = await cookie("robin@example.test");
  assert.deepEqual((await settings(ck)).locations[0].courts.map((c: any) => c.name), ["Court 1"]);
  await run(db, "action.undo", { run_id: archived.runId }, owner);
  assert.deepEqual((await settings(ck)).locations[0].courts.map((c: any) => [c.name, c.kind]), [["Court 1", "indoor"], ["Court 2 (glass)", "covered_outdoor"]]);
});
