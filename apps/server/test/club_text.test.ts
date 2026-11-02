import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { exportData, inLang, issueReceipts, mergeTranslations, messageHandlers, processOutbox, run, runAsSystem, textOf, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { setTranslator } from "../src/translate.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, clinic: string, plan: string, plain: string, loc: string;
const mailer = new MemoryMailer(), people: Record<string, string> = {}, cookies: Record<string, string> = {};
const TZ = "America/Los_Angeles";
const as = (name: string, lang: "en" | "es" = "en"): Actor => ({ personId: people[name]!, via: "test", lang });
const get = async (path: string, who: string) => {
  const r = await app.request(path, { headers: { cookie: cookies[who]! } });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const post = async (path: string, who: string, body: unknown) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const page = async (path: string, lang: string) => (await app.request(path, { headers: { "accept-language": lang } })).text();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  people.Robin = owner.personId!;
  for (const name of ["Ana", "Ben", "Sam"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Ana!).execute();   // reads in Spanish
  await run(db, "role.assign", { person_id: people.Sam, role: "coach" }, owner);
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "club.update", { public_page: true, about: "Six courts by the river.", translations: { es: { about: "Seis pistas junto al río." } } }, owner);
  plan = ((await run(db, "membership.plan_set", { name: "Monthly", description: "Book three weeks ahead", price_cents: 8000, period: "month",
    translations: { es: { name: "Mensual", description: "Reserva con tres semanas de antelación" } } }, owner)).result as any).plan_id;
  plain = ((await run(db, "membership.plan_set", { name: "Annual", price_cents: 80000, period: "year" }, owner)).result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000, translations: { es: { name: "Normal" } } }, owner);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginner clinic", capacity: 8, price_cents: 0,
    translations: { es: { name: "Clínica de iniciación" } } }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 5 * 86400_000); start.setUTCHours(17, 0, 0, 0);
  await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: clinic }, owner);
  await run(db, "waiver.set", { body: "I play at my own risk and follow the club's rules.", translations: { es: { body: "Juego bajo mi propio riesgo y sigo las reglas del club." } } }, owner);
  await run(db, "coach.set_profile", { person_id: people.Sam, bio: "Ten years coaching beginners.", level_min: null, level_max: null, languages: ["en", "es"],
    rates: [{ minutes: 60, cents: 6000 }], lessons: true, max_players: 4, translations: { es: { bio: "Diez años enseñando a principiantes." } } }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
  for (const name of ["Robin", "Ana", "Ben"]) cookies[name] = await signIn(`${name.toLowerCase()}@example.test`);
});
after(async () => { setTranslator(null); await drop(); });

test("one field in a language: its own version, or the club's own words; a blank version is dropped", () => {
  const tr = { es: { name: "Mensual", description: "  " } };
  assert.equal(inLang("Monthly", tr, "name", "es"), "Mensual");
  assert.equal(inLang("Monthly", tr, "name", "en"), "Monthly");
  assert.equal(inLang("Book ahead", tr, "description", "es"), "Book ahead");   // blank: the club's own words
  assert.equal(inLang(null, {}, "about", "es"), null);
  assert.deepEqual(textOf("Monthly", tr, "name"), { en: "Monthly", es: "Mensual" });
  assert.deepEqual(mergeTranslations(tr, undefined), tr, "left out: kept as it was");
  assert.deepEqual(mergeTranslations({ es: { name: "Mensual", description: "Reserva" } }, { es: { description: "" } }), { es: { name: "Mensual" } }, "a blank one clears that version only");
  assert.deepEqual(mergeTranslations({ es: { name: "Mensual" } }, { es: { name: "" } }), {});
});

test("members read the club's words in their language, and the club's own where there's no version", async () => {
  const es = await get("/membership-plans", "Ana"), en = await get("/membership-plans", "Ben");
  const by = (rows: any[], id: string) => rows.find((p) => p.id === id);
  assert.deepEqual([by(es.json, plan).name, by(es.json, plan).description], ["Mensual", "Reserva con tres semanas de antelación"]);
  assert.deepEqual([by(en.json, plan).name, by(en.json, plan).description], ["Monthly", "Book three weeks ahead"]);
  assert.equal(by(es.json, plain).name, "Annual", "no Spanish version: the club's own name, with no marker");
  assert.equal((await get("/open-programs", "Ana")).json.find((p: any) => p.id === clinic).name, "Clínica de iniciación");
  assert.equal((await get("/open-programs", "Ben")).json.find((p: any) => p.id === clinic).name, "Beginner clinic");
  assert.equal((await get("/my/waiver", "Ana")).json.waiver.body, "Juego bajo mi propio riesgo y sigo las reglas del club.");
  assert.equal((await get("/my/waiver", "Ben")).json.waiver.body, "I play at my own risk and follow the club's rules.");
  assert.equal((await get("/my/lessons/coaches", "Ana")).json.coaches[0].bio, "Diez años enseñando a principiantes.");
  assert.equal((await get("/my/lessons/coaches", "Ana")).json.coaches[0].translations, undefined, "the member gets one language, not the store");
});

test("the public page in Spanish uses the club's Spanish words; in English its own", async () => {
  const es = await page("/public?lang=es", "es"), en = await page("/public", "en-US");
  for (const s of ["Seis pistas junto al río.", "<strong>Mensual</strong>", "Normal:", "Clínica de iniciación", "Diez años enseñando a principiantes."]) assert.ok(es.includes(s), s);
  for (const s of ["Six courts by the river.", "<strong>Monthly</strong>", "Standard:", "Beginner clinic", "Ten years coaching beginners."]) assert.ok(en.includes(s), s);
  assert.ok((await page(`/public/events/${clinic}?lang=es`, "es")).includes("<h1>Clínica de iniciación</h1>"));
});

test("messages and the waiver: each person in their own language", async () => {
  await run(db, "waiver.accept", { person_id: people.Ana }, as("Ana", "es"));
  assert.equal((await db.selectFrom("waiver_acceptance").select("lang").where("person_id", "=", people.Ana!).executeTakeFirstOrThrow()).lang, "es");
  await run(db, "enrolment.join", { program_id: clinic, person_id: people.Ana }, as("Ana", "es"));
  await processOutbox(db, messageHandlers);
  const m = await db.selectFrom("outbound_message").select(["subject", "lang"]).where("person_id", "=", people.Ana!).where("kind", "=", "booked").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.deepEqual([m.lang, m.subject], ["es", "Ya tienes tu lugar: Clínica de iniciación"]);
  // A receipt is written once, in both languages: each names the program in its own.
  const enrolment = (await db.selectFrom("enrolment").select("id").where("person_id", "=", people.Ana!).executeTakeFirstOrThrow()).id;
  await db.insertInto("payment").values({ id: uuidv7(), person_id: people.Ana!, enrolment_id: enrolment, amount_cents: 1000, method: "cash", provider: "none", provider_ref: null, status: "succeeded" } as any).execute();
  await issueReceipts(db);
  const what = ((await db.selectFrom("receipt").select("lines").where("person_id", "=", people.Ana!).executeTakeFirstOrThrow()).lines as any)[0].what;
  assert.match(what.es, /Clínica de iniciación/); assert.match(what.en, /Beginner clinic/);
});

test("renaming a program: its name and its Spanish name, a blank Spanish name goes back to the club's own", async () => {
  const r = await run(db, "program.set_name", { program_id: clinic, name: "Starter clinic", translations: { es: { name: "Clínica para empezar" } } }, owner);
  assert.equal(r.plan.summary.en, 'Call Beginner clinic "Starter clinic" from now on. Its places, dates and people stay as they are.');
  assert.equal(r.plan.summary.es, 'Llamar a Clínica de iniciación "Clínica para empezar" desde ahora. Sus lugares, fechas y personas no cambian.');
  await run(db, "program.set_name", { program_id: clinic, name: "Starter clinic", translations: { es: { name: "" } } }, owner);
  assert.equal((await get("/open-programs", "Ana")).json.find((p: any) => p.id === clinic).name, "Starter clinic");
  assert.equal((await run(db, "program.set_name", { program_id: clinic, name: "Starter clinic" }, as("Ana", "es")).catch((e) => e)).code, "error.forbidden_reason");
});

test("a draft in the other language: staff only, only with a translator, never saved by itself", async () => {
  assert.equal((await post("/staff/translate", "Robin", { text: "Six courts", from: "en", to: "es" })).status, 404, "no key: no drafts");
  assert.equal((await get("/club", "Robin")).json.drafts, false);
  const sent: string[] = [];
  setTranslator(async (text, from, to) => { sent.push(text); return `[${from}>${to}] ${text}`; });
  assert.equal((await get("/club", "Robin")).json.drafts, true);
  const r = await post("/staff/translate", "Robin", { text: "Six courts by the river.", from: "en", to: "es" });
  assert.deepEqual([r.status, r.json.draft], [200, "[en>es] Six courts by the river."]);
  assert.deepEqual(sent, ["Six courts by the river."], "only the text goes out");
  assert.equal((await post("/staff/translate", "Ana", { text: "Hola", from: "es", to: "en" })).status, 403);
  assert.equal((await post("/staff/translate", "Robin", { text: "x", from: "en", to: "en" })).status, 400);
  assert.equal((await db.selectFrom("club").select("about").executeTakeFirstOrThrow()).about, "Six courts by the river.", "nothing saved");
  setTranslator(async () => { throw new Error("down"); });
  assert.equal((await post("/staff/translate", "Robin", { text: "Six courts", from: "en", to: "es" })).status, 502);
  setTranslator(null);
});

test("the staff screens get both versions to edit, and a data download keeps both", async () => {
  const s = (await get("/staff/settings", "Robin")).json;
  assert.deepEqual(s.club.translations, { es: { about: "Seis pistas junto al río." } });
  assert.deepEqual(s.waiver.translations, { es: { body: "Juego bajo mi propio riesgo y sigo las reglas del club." } });
  const x = await exportData(db, people.Ana!, new Date(), "es") as any;
  assert.ok(JSON.stringify(x).includes("name_in_other_languages"));
});
