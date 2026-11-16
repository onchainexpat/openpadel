// The club's phone, website and amenities: set through club.update (Settings, club.yaml), checked and kept in one
// form, said in the preview and its undo, and shown to members (/my/club), on the public page and to Settings.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { clubPhoneShown, KumiError, plan, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { AMENITIES } from "@kumi/i18n/amenities";
import { en, es } from "@kumi/i18n";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { readClubFile, setupClub } from "../src/setup.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, cookie: string;
const mailer = new MemoryMailer();
const get = async (path: string) => { const r = await app.request(path, { headers: { cookie } }); return { status: r.status, json: await r.json() as any }; };
const club = () => db.selectFrom("club").select(["phone", "website", "amenities"]).executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  await run(db, "club.update", { public_page: true }, owner);
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => drop());

test("every amenity has its words in both languages", () => {
  for (const a of AMENITIES) {
    assert.ok((en as Record<string, unknown>)[`amenity.${a}`], `en amenity.${a}`);
    assert.ok((es as Record<string, unknown>)[`amenity.${a}`], `es amenity.${a}`);
  }
});

test("a new club has none, and members see none", async () => {
  assert.deepEqual(await club(), { phone: null, website: null, amenities: [] });
  const c = (await get("/my/club")).json;
  assert.equal(c.phone, null); assert.equal(c.website, null); assert.deepEqual(c.amenities, []);
});

test("the phone is read in the club's country and kept in international form; the preview reads it as people do", async () => {
  const p = await plan(db, "club.update", { phone: "(503) 555-0142", website: "https://kestrel.example", amenities: ["cafe", "parking", "showers"] }, owner);
  assert.match(p.plan.summary.en, /the phone number to \(503\) 555-0142/);
  assert.match(p.plan.summary.en, /the website to https:\/\/kestrel\.example/);
  // In the list's order, whatever order they came in.
  assert.match(p.plan.summary.en, /what the club has to parking, showers, café/);
  assert.match(p.plan.summary.es, /lo que tiene el club a estacionamiento, duchas, cafetería/);
  await run(db, "club.update", { phone: "(503) 555-0142", website: "https://kestrel.example", amenities: ["cafe", "parking", "showers"] }, owner);
  assert.deepEqual(await club(), { phone: "+15035550142", website: "https://kestrel.example", amenities: ["parking", "showers", "cafe"] });
  // The same number typed another way is no change.
  const again = await plan(db, "club.update", { phone: "+1 503 555 0142" }, owner);
  assert.deepEqual(again.plan.details, { fields: [] });
});

test("what isn't a phone, a web link or an amenity on the list is refused", async () => {
  await assert.rejects(run(db, "club.update", { phone: "call us" }, owner), (e: unknown) => e instanceof KumiError && e.code === "error.club_phone_bad");
  await assert.rejects(run(db, "club.update", { phone: "123" }, owner), (e: unknown) => e instanceof KumiError && e.code === "error.club_phone_bad");
  for (const bad of ["javascript:alert(1)", "kestrel.example", "ftp://kestrel.example"])
    await assert.rejects(run(db, "club.update", { website: bad }, owner), (e: unknown) => e instanceof KumiError && e.code === "error.invalid_input", bad);
  await assert.rejects(run(db, "club.update", { amenities: ["sauna"] }, owner), (e: unknown) => e instanceof KumiError && e.code === "error.invalid_input");
  assert.equal((await club()).phone, "+15035550142");
});

test("members see the club's phone, website and amenities; so does the public page, and Settings starts from them", async () => {
  const c = (await get("/my/club")).json;
  assert.equal(c.phone, "+15035550142"); assert.equal(c.phone_shown, "(503) 555-0142");
  assert.equal(c.website, "https://kestrel.example"); assert.deepEqual(c.amenities, ["parking", "showers", "cafe"]);
  const s = (await get("/staff/settings")).json;
  assert.equal(s.club.phone, "(503) 555-0142"); assert.deepEqual(s.club.amenities, ["parking", "showers", "cafe"]);
  const page = await (await app.request("/public?lang=es")).text();
  assert.match(page, /href="tel:\+15035550142">\(503\) 555-0142</);
  assert.match(page, /Estacionamiento · Duchas · Cafetería/);
  assert.match(page, /"telephone":"\+15035550142"/);
});

test("a number from another country keeps its code; null and an empty list take them off, and undo puts them back", async () => {
  assert.equal(clubPhoneShown("+34911234567", "US"), "+34 911 23 45 67");
  assert.equal(clubPhoneShown("+34911234567", "ES"), "911 23 45 67");
  const off = await run(db, "club.update", { phone: null, website: null, amenities: [] }, owner);
  assert.deepEqual(await club(), { phone: null, website: null, amenities: [] });
  const u = await plan(db, "action.undo", { run_id: off.runId }, owner);
  assert.match(u.plan.summary.en, /the phone number goes back to \(503\) 555-0142/);
  await run(db, "action.undo", { run_id: off.runId }, owner);
  assert.deepEqual(await club(), { phone: "+15035550142", website: "https://kestrel.example", amenities: ["parking", "showers", "cafe"] });
});

test("club.yaml sets them when the club has none, and only notes a different one after that", async () => {
  await run(db, "club.update", { phone: null, website: null, amenities: [] }, owner);
  const dir = mkdtempSync(joinPath(tmpdir(), "kumi-contact-"));
  const path = joinPath(dir, "club.yaml");
  writeFileSync(path, `club:\n  name: Kestrel Padel\n  time_zone: America/Los_Angeles\n  phone: "503 555 0199"\n  website: https://kestrel.example/home\n  amenities: [lockers, parking]\nowner: { name: Robin Hale, email: robin@example.test }\n`);
  const planned = await setupClub(db, readClubFile(path), { apply: false, lang: "en" });
  assert.ok(planned.steps.some((s) => s.action === "club.update" && /\+15035550199/.test(s.text.en)), JSON.stringify(planned.steps.map((s) => s.text.en)));
  await setupClub(db, readClubFile(path), { apply: true, lang: "en" });
  assert.deepEqual(await club(), { phone: "+15035550199", website: "https://kestrel.example/home", amenities: ["parking", "lockers"] });
  writeFileSync(path, `club:\n  name: Kestrel Padel\n  time_zone: America/Los_Angeles\n  phone: "503 555 0100"\nowner: { name: Robin Hale, email: robin@example.test }\n`);
  const again = await setupClub(db, readClubFile(path), { apply: false, lang: "en" });
  assert.ok(!again.steps.some((s) => /phone|\+1503/.test(s.text.en)));
  assert.ok(again.notes.some((n) => /the phone number/.test(n.en)));
});
