// "Coming from" (presets.ts): a club setting for the staff app's words and order. Set through a preview like any other
// setting, recorded in Changes, set by club.yaml, suggested (never set) when a club brings Playtomic in, and never a
// change to what any role may see or do: each role reads the same pages, with the same answers, under every preset.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { plan, run, runAsSystem, KumiError, type Actor, type Db } from "@kumi/core";
import { COMING_FROM } from "@kumi/i18n/presets";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { readClubFile, setupClub } from "../src/setup.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court: string;
const mailer = new MemoryMailer();
const cookies: Record<string, string> = {};

async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const get = async (path: string, cookie?: string) => {
  const r = await app.request(path, { headers: cookie ? { cookie } : {} });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const setTo = (v: string) => db.updateTable("club").set({ coming_from: v }).execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  cookies.owner = await signIn("robin@example.test");
  const clerk = ((await run(db, "role.create", { name: "Bookings clerk", grants: [{ action: "booking.move", scope: "any" }] }, owner)).result as any).key;
  for (const [name, role] of [["Mia", "manager"], ["Dana", "front_desk"], ["Cora", "coach"], ["Acc", "accountant"], ["Cleo", clerk], ["Ann", null]] as const) {
    const id = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    if (role) await run(db, "role.assign", { person_id: id, role }, owner);
    cookies[name] = await signIn(`${name.toLowerCase()}@example.test`);
  }
});
after(async () => drop());

test("a club that existed before keeps Playtomic's words: the default is playtomic, and the apps are told it", async () => {
  assert.equal((await db.selectFrom("club").select("coming_from").executeTakeFirstOrThrow()).coming_from, "playtomic");
  assert.equal((await get("/club")).json.coming_from, "playtomic");
  assert.equal((await get("/staff/settings", cookies.owner)).json.club.coming_from, "playtomic");
  // A name the app doesn't know (one added later, read by an older app) reads as the default, never as nothing.
  await setTo("someday");
  assert.equal((await get("/club")).json.coming_from, "playtomic");
  await setTo("playtomic");
});

test("the setting is previewed in both languages, applied, recorded in Changes, and undone", async () => {
  const p = await plan(db, "club.update", { coming_from: "none" }, owner);
  assert.equal(p.plan.summary.en, "Change the software staff used before to none (openPadel's own words).");
  assert.equal(p.plan.summary.es, "Cambiar el programa que usaba el personal a ninguno (las palabras propias de openPadel).");
  assert.equal((await db.selectFrom("club").select("coming_from").executeTakeFirstOrThrow()).coming_from, "playtomic", "a preview changes nothing");
  const r = await run(db, "club.update", { coming_from: "none" }, owner);
  assert.equal((await get("/club")).json.coming_from, "none");
  const changes = await get("/staff/changes", cookies.owner);
  assert.equal(changes.status, 200);
  assert.ok(JSON.stringify(changes.json).includes("the software staff used before to none"), "listed in Changes");
  await run(db, "action.undo", { run_id: r.runId }, owner);
  assert.equal((await get("/club")).json.coming_from, "playtomic", "undone");
  await assert.rejects(plan(db, "club.update", { coming_from: "elsewhere" }, owner), KumiError, "only a preset the app knows");
});

test("every role reads the same pages, with the same answers, under every preset", async () => {
  const paths = ["/me", "/actions", "/staff/settings", "/staff/people", "/staff/customers", "/staff/bookings", "/staff/programs", "/staff/memberships",
    "/staff/coaches", "/staff/levels", "/staff/scores", "/staff/questions", "/staff/questions/count", "/staff/messages", "/staff/broadcasts", "/staff/templates",
    "/staff/tags", "/staff/segments", "/staff/chats", "/staff/mirror", "/staff/move-in", "/staff/payments", "/staff/reports", "/staff/receipts", "/staff/club-receipts",
    "/staff/coach-earnings", "/staff/changes", "/staff/usage", "/staff/roles", "/staff/roles/catalogue", "/staff/vault", "/staff/courts", "/staff/locations",
    "/staff/my-schedule", "/staff/students", "/staff/support", "/staff/credit", "/staff/gift-cards", "/staff/passes", "/staff/promo-codes", "/staff/weekly-courts",
    "/staff/alerts", "/staff/desk-days", "/staff/payments-found"];
  // The setting itself, and anything that moves with the clock or the run (ids, times), aren't what's compared.
  const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (k === "coming_from" || /(_at|_id|^id|resets|now)$/.test(k) ? undefined : v)));
  const seen: Record<string, Record<string, string>> = {};
  for (const preset of COMING_FROM) {
    await setTo(preset);
    for (const [who, ck] of Object.entries(cookies)) {
      for (const p of paths) {
        const r = await get(p, ck);
        (seen[`${who} ${p}`] ??= {})[preset] = `${r.status} ${JSON.stringify(plain(r.json))}`;
      }
    }
  }
  await setTo("playtomic");
  const differ = Object.entries(seen).filter(([, by]) => new Set(Object.values(by)).size !== 1).map(([k]) => k);
  assert.deepEqual(differ, []);
  // And the check sees real differences between roles: the desk reads people, the coach on their own doesn't.
  assert.notEqual(seen["Dana /staff/people"]!.none!.slice(0, 3), seen["Cora /staff/people"]!.none!.slice(0, 3));
});

test("bringing Playtomic in suggests its words in the preview, without changing the setting", async () => {
  await setTo("none");
  const p = await plan(db, "connector.map_court", { resource_id: "pt-court-1", resource_name: "Pista 1", court_id: court }, owner);
  assert.match(p.plan.summary.en, /Staff used to Playtomic can have its words in the staff app too: Settings, Staff are coming from, Playtomic\.$/);
  assert.match(p.plan.summary.es, /Configuración, El personal viene de, Playtomic\.$/);
  const csv = "Name,Email,Wallet\nPat Lane,pat@example.test,10\n";
  const up = await plan(db, "playtomic.upload", { csv, file_name: "players.csv" }, owner);
  assert.match(up.plan.summary.en, /Staff used to Playtomic can have its words/);
  assert.equal((await db.selectFrom("club").select("coming_from").executeTakeFirstOrThrow()).coming_from, "none", "only suggested");
  // A club already on Playtomic's words isn't told again.
  await setTo("playtomic");
  assert.doesNotMatch((await plan(db, "connector.map_court", { resource_id: "pt-court-1", resource_name: "Pista 1", court_id: court }, owner)).plan.summary.en, /Staff used to Playtomic/);
});

test("club.yaml sets coming_from and the brand colour, through the plan, then only when they differ", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-preset-"));
  const path = join(dir, "club.yaml");
  writeFileSync(path, `club: { name: Kestrel Padel, time_zone: America/Los_Angeles, coming_from: none, brand_colour: "#1D4ED8" }\nowner: { name: Robin Hale, email: robin@example.test }\n`);
  const f = readClubFile(path);
  const p = await setupClub(db, f, { apply: false, lang: "en" });
  assert.deepEqual(p.steps.map((s) => s.text.en), [
    "Set the software staff used before to none (openPadel's own words), for the staff app's words and menu.",
    "Set the club's brand color to #1D4ED8.",
  ]);
  assert.equal(p.steps[0]!.text.es, "Poner el programa que usaba el personal en ninguno (las palabras propias de openPadel), para las palabras y el menú de la app del personal.");
  await setupClub(db, f, { apply: true, lang: "en" });
  const c = await db.selectFrom("club").select(["coming_from", "brand_colour"]).executeTakeFirstOrThrow();
  assert.deepEqual(c, { coming_from: "none", brand_colour: "#1D4ED8" });
  assert.deepEqual((await setupClub(db, f, { apply: false, lang: "en" })).steps, [], "nothing again");
  writeFileSync(path, `club: { name: Kestrel Padel, time_zone: America/Los_Angeles, coming_from: elsewhere }\nowner: { name: Robin Hale, email: robin@example.test }\n`);
  assert.throws(() => readClubFile(path), /club\.coming_from/);
  await run(db, "club.update", { coming_from: "playtomic", brand_colour: "#0B5A55" }, owner);
});
