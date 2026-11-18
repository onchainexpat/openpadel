import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { plan, KumiError, type Db } from "@kumi/core";
import { ClubFileError, readClubFile, setupClub } from "../src/setup.ts";
import { doctor } from "../src/doctor.ts";

let db: Db, drop: () => Promise<void>;
const dir = mkdtempSync(join(tmpdir(), "kumi-setup-"));
const file = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
const CLUB = `
club: { name: Kestrel Padel, time_zone: America/Los_Angeles }
owner: { name: Robin Hale, email: Robin@Kestrel.example }
locations:
  - name: Eastside
    courts: [Court 1, { name: Court 2, kind: outdoor }]
staff:
  - { name: Dana Ortiz, email: dana@kestrel.example, role: manager }
  - { name: Lee Chen, email: lee@kestrel.example, role: front_desk, location: Eastside }
`;
const en = (r: { steps: { text: { en: string } }[] }) => r.steps.map((s) => s.text.en);

before(async () => ({ db, drop } = await freshDb()));
after(async () => drop());

test("a plan lists every change and makes none", async () => {
  const r = await setupClub(db, readClubFile(file("club.yaml", CLUB)), { apply: false, lang: "en" });
  assert.deepEqual(en(r), [
    "Set up Kestrel Padel (time zone America/Los_Angeles), with Robin Hale (Robin@Kestrel.example) as the owner.",
    "Add the location Eastside (America/Los_Angeles).", "Add Court 1 at Eastside.", "Add Court 2 at Eastside.",
    "Add Dana Ortiz (dana@kestrel.example) as a member.", "Make Dana Ortiz Manager.",
    "Add Lee Chen (lee@kestrel.example) as a member.", "Make Lee Chen Front desk at Eastside.",
  ]);
  assert.equal(await db.selectFrom("club").select("name").executeTakeFirst(), undefined);
});

test("apply makes the club; running it again only adds what's new", async () => {
  const r = await setupClub(db, readClubFile(file("club.yaml", CLUB)), { apply: true, lang: "en" });
  assert.equal(r.steps.length, 8);
  const lee = await db.selectFrom("person").innerJoin("person_role", "person_role.person_id", "person.id").innerJoin("role", "role.id", "person_role.role_id")
    .select(["role.key", "person_role.location_id"]).where("person.email", "=", "lee@kestrel.example").execute();
  assert.deepEqual(lee.map((x) => x.key).sort(), ["front_desk", "member"]);
  assert.ok(lee.find((x) => x.key === "front_desk")!.location_id, "front desk at Eastside, not everywhere");
  // Every change went through an action, so it's in the audit log.
  const runs = await db.selectFrom("action_run").select("action").where("via", "=", "setup").execute();
  assert.ok(runs.length >= 7);

  assert.deepEqual(en(await setupClub(db, readClubFile(file("club.yaml", CLUB)), { apply: false, lang: "en" })), []);
  const more = CLUB.replace("courts: [Court 1,", "courts: [Court 1, Court 3,").replace("club: { name: Kestrel Padel", "club: { name: Kestrel Padel Club");
  const again = await setupClub(db, readClubFile(file("club.yaml", more)), { apply: false, lang: "es" });
  assert.deepEqual(en(again), ["Add Court 3 at Eastside."]);
  assert.match(again.notes[0]!.es, /^El club ya está configurado como Kestrel Padel\./);   // renaming is for the staff app
});

test("club.yaml carries the currency, each location's opening hours and one court price, through the same actions", async () => {
  const { db: d2, drop: drop2 } = await freshDb();
  try {
    const body = `
club: { name: Alcazar Padel, time_zone: Europe/Madrid, currency: eur, default_language: es }
owner: { name: Lucia Mar, email: lucia@alcazar.example }
locations:
  - name: Centro
    courts: [Pista 1]
    hours:
      - { days: [mon, tue, wed, thu, fri], opens: "07:00", closes: "22:00" }
      - { days: [sat, sun], opens: "08:00", closes: "20:00" }
    price_per_hour: 24.5
`;
    const planned = await setupClub(d2, readClubFile(file("eur.yaml", body)), { apply: false, lang: "en" });
    const lines = en(planned);
    assert.ok(lines.includes("Set the club's currency to EUR."), lines.join(" | "));
    assert.ok(lines.includes("Set the opening hours at Centro: Mon to Fri 07:00 to 22:00; Sat, Sun 08:00 to 20:00."), lines.join(" | "));
    assert.ok(lines.some((l) => l.startsWith("Price every court at Centro at €24.50 an hour")), lines.join(" | "));
    assert.ok(planned.steps.every((s) => !/\u2014/.test(s.text.en + s.text.es)));
    assert.match(planned.steps.find((s) => s.action === "hours.set")!.text.es, /^Poner el horario de Centro: lun a vie 07:00 a 22:00/);
    await setupClub(d2, readClubFile(file("eur.yaml", body)), { apply: true, lang: "en" });
    assert.equal((await d2.selectFrom("club").select("currency").executeTakeFirstOrThrow()).currency, "EUR");
    const hours = await d2.selectFrom("opening_hours").select(["weekday", "opens", "closes"]).orderBy("weekday").execute();
    assert.equal(hours.length, 7);
    assert.deepEqual([hours[0]!.weekday, hours[0]!.opens?.slice(0, 5), hours[1]!.opens?.slice(0, 5), hours[1]!.closes?.slice(0, 5)], [0, "08:00", "07:00", "22:00"]);   // 0 is Sunday
    const rule = await d2.selectFrom("price_rule").select(["name", "cents_per_hour", "weekdays", "starts", "translations"]).executeTakeFirstOrThrow();
    assert.deepEqual([rule.name, rule.cents_per_hour, rule.weekdays, rule.starts], ["Tiempo de cancha", 2450, null, null]);
    assert.equal((rule.translations as { en?: { name?: string } }).en?.name, "Court time");
    // Through the actions, so each is in the audit log.
    const runs = (await d2.selectFrom("action_run").select("action").where("via", "=", "setup").execute()).map((r) => r.action);
    for (const a of ["club.update", "hours.set", "price.rule_set"]) assert.ok(runs.includes(a), a);
    // Again: nothing new. Changed in the file: a note to change it in Settings, never a second rule or new hours.
    assert.deepEqual(en(await setupClub(d2, readClubFile(file("eur.yaml", body)), { apply: false, lang: "en" })), []);
    const changed = await setupClub(d2, readClubFile(file("eur2.yaml", body.replace("price_per_hour: 24.5", "price_per_hour: 30").replace('closes: "20:00"', 'closes: "21:00"'))), { apply: false, lang: "en" });
    assert.deepEqual(en(changed), []);
    assert.equal(changed.notes.length, 2);
    assert.match(changed.notes[0]!.en, /opening hours at Centro aren't the ones it has/); assert.match(changed.notes[1]!.es, /precio de las canchas de Centro/);
  } finally { await drop2(); }
});

test("club.example.yaml reads as a club file, and its plan is what the docs say step 4 does", async () => {
  const f = readClubFile(new URL("../../../club.example.yaml", import.meta.url).pathname);
  assert.equal(f.club.currency, "USD"); assert.equal(f.locations![0]!.price_per_hour, 32); assert.equal(f.locations![0]!.hours!.length, 2);
  const { db: d3, drop: drop3 } = await freshDb();
  try {
    const lines = en(await setupClub(d3, f, { apply: false, lang: "en" }));
    assert.ok(lines.includes("Set the opening hours at Eastside: Mon to Fri 07:00 to 22:00; Sat, Sun 08:00 to 20:00."), lines.join(" | "));
    assert.ok(lines.some((l) => l.startsWith("Price every court at Eastside at $32.00 an hour")), lines.join(" | "));
    assert.ok(!lines.some((l) => l.includes("currency")), "USD is the default: nothing to change");
  } finally { await drop3(); }
});

test("club.yaml's hours and currency are checked before anything runs", () => {
  const base = "club: { name: X, time_zone: America/Chicago }\nowner: { name: Y, email: y@example.test }\n";
  assert.throws(() => readClubFile(file("cur.yaml", base.replace("America/Chicago }", "America/Chicago, currency: XYZ }"))), /club.currency: XYZ isn't a currency/);
  assert.throws(() => readClubFile(file("h1.yaml", base + 'locations:\n  - { name: A, hours: [{ days: [mon], opens: "22:00", closes: "07:00" }] }\n')), /closes \(07:00\) must be after opens/);
  assert.throws(() => readClubFile(file("h2.yaml", base + 'locations:\n  - { name: A, hours: [{ days: [mon, tue], opens: "07:00", closes: "22:00" }, { days: [tue], opens: "08:00", closes: "20:00" }] }\n')), /tue is in two lines/);
  assert.throws(() => readClubFile(file("h3.yaml", base + 'locations:\n  - { name: A, hours: [{ days: [monday], opens: "07:00", closes: "22:00" }] }\n')), ClubFileError);
});

test("a file with mistakes says where each one is", () => {
  assert.throws(() => readClubFile(file("bad.yaml", "club: { name: X, time_zone: Mars/Base }\nowner: { name: Y, email: nope }\n")), (e: unknown) => {
    assert.ok(e instanceof ClubFileError);
    assert.ok(e.problems.some((p) => p.startsWith("owner.email:")), e.problems.join("; "));
    return true;
  });
  assert.throws(() => readClubFile(file("tz.yaml", "club: { name: X, time_zone: Mars/Base }\nowner: { name: Y, email: y@example.test }\n")), /isn't a time zone/);
  assert.throws(() => readClubFile(file("broken.yaml", "club: [")), ClubFileError);
});

test("staff can't add a second person with the same email", async () => {
  const owner = (await db.selectFrom("person").select("id").where("email", "=", "Robin@Kestrel.example").executeTakeFirstOrThrow()).id;
  await assert.rejects(plan(db, "person.create", { display_name: "Dana again", email: "DANA@kestrel.example" }, { personId: owner, via: "test", lang: "en" }),
    (e: unknown) => e instanceof KumiError && e.code === "error.duplicate_email");
});

test("doctor: each check, and what's wrong in production", async () => {
  const state = async (env: Record<string, string>, fetch?: any) => Object.fromEntries((await doctor(db, { KUMI_BACKUP_DIR: dir, ...env }, { fetch })).map((c) => [c.id, c.state]));
  const dev = await state({});
  assert.equal(dev.database, "ok"); assert.equal(dev.club, "ok"); assert.equal(dev.owner, "ok"); assert.equal(dev.courts, "ok");
  assert.equal(dev.email, "off"); assert.equal(dev.payments, "off"); assert.equal(dev.backups, "off");
  assert.equal((await state({ KUMI_STRIPE_SECRET_KEY: "sk_live_x", KUMI_STRIPE_PUBLISHABLE_KEY: "pk_live_x" })).payments, "fail");   // a live key outside production
  const prod = await state({ NODE_ENV: "production", KUMI_PUBLIC_URL: "http://club.example" });
  assert.equal(prod.address, "fail"); assert.equal(prod.email, "fail"); assert.equal(prod.backups, "warn");   // live with no email: see below
  const up = async () => new Response("{}", { status: 200 });
  writeFileSync(join(dir, "kumi-2026-10-29.dump"), "x");
  const live = await state({ NODE_ENV: "production", KUMI_PUBLIC_URL: "https://club.example", KUMI_RESEND_API_KEY: "re_x", KUMI_MAIL_FROM: "a@b.example" }, up);
  assert.equal(live.address, "ok"); assert.equal(live.email, "ok"); assert.equal(live.backups, "ok");
  assert.equal(live.members_address, undefined);   // one address for both: nothing more to check
  // The members' app on its own address: checked too, since the links members are sent use it.
  const asked: string[] = [];
  const two = await state({ NODE_ENV: "production", KUMI_PUBLIC_URL: "https://staff.club.example" },
    async (u: string) => { asked.push(u); return new Response("{}", { status: u.startsWith("https://club.example/") ? 502 : 200 }); });
  assert.equal(two.address, "ok"); assert.equal(two.members_address, "fail");
  assert.deepEqual(asked, ["https://staff.club.example/health", "https://club.example/health"]);
  utimesSync(join(dir, "kumi-2026-10-29.dump"), new Date(Date.now() - 50 * 3600_000), new Date(Date.now() - 50 * 3600_000));
  assert.equal((await state({ NODE_ENV: "production" })).backups, "warn");   // two days without a backup
  // In Docker there are no timers: the hint names the backup service, and the docs are Docker's own.
  const checks = async (env: Record<string, string>) => Object.fromEntries((await doctor(db, { KUMI_BACKUP_DIR: dir, NODE_ENV: "production", ...env })).map((c) => [c.id, c]));
  const one = await checks({}), dock = await checks({ KUMI_INSTALL: "docker" });
  assert.match(one.backups!.text.en, /kumi-backup timer/); assert.match(dock.backups!.text.en, /docker compose logs backup/);
  assert.equal(one.restore_test!.doc, "deploy/README.md"); assert.equal(dock.restore_test!.doc, "deploy/docker/README.md");
  // Point-in-time backups off (this database doesn't archive): each says how to turn them on its own way.
  assert.match(one.pitr!.text.en, /server-setup\.sh/); assert.match(dock.pitr!.text.en, /deploy\/docker\/update\.sh/);
  assert.equal(dock.pitr!.doc, "deploy/docker/README.md");
  for (const install of [{}, { KUMI_INSTALL: "docker" }] as Array<Record<string, string>>) assert.match((await checks({ ...install, KUMI_PITR: "0" })).pitr!.text.en, /as KUMI_PITR=0 in the settings says/);
  // Live without email, sign-in codes would only reach the log: the server refuses to start, and doctor fails.
  assert.equal(one.email!.state, "fail"); assert.match(one.email!.text.en, /won't start/);
  assert.equal((await checks({ KUMI_PRACTICE: "1" })).email!.state, "warn");
});

test("doctor: practice mode is said while it's on, in both languages, and ok once the club is live", async () => {
  const practice = async (env: Record<string, string>) => (await doctor(db, { KUMI_BACKUP_DIR: dir, ...env })).find((c) => c.id === "practice")!;
  const fresh = await practice({ NODE_ENV: "production", KUMI_PRACTICE: "1" });   // a new server: no email service yet
  assert.equal(fresh.state, "warn"); assert.equal(fresh.doc, "docs/setup/README.md");
  assert.match(fresh.text.en, /^Practice mode: on, with no email service yet/); assert.match(fresh.text.es, /^Modo de práctica: activado/);
  const mail = { NODE_ENV: "production", KUMI_PRACTICE: "1", KUMI_RESEND_API_KEY: "re_x", KUMI_MAIL_FROM: "a@b.example" };
  const one = await practice({ ...mail, KUMI_MAIL_TEST_TO: "robin@kestrel.example" }), two = await practice({ ...mail, KUMI_MAIL_TEST_TO: "robin@kestrel.example, dana@kestrel.example" });
  assert.equal(one.state, "warn"); assert.match(one.text.en, /only to the 1 address in KUMI_MAIL_TEST_TO/); assert.match(two.text.en, /only to the 2 addresses/);
  assert.match(two.text.es, /solo llega a las 2 direcciones de KUMI_MAIL_TEST_TO/);
  assert.match((await practice(mail)).text.en, /lists nobody/);
  assert.equal((await practice({})).state, "warn", "outside production it's always practice");
  const live = await practice({ NODE_ENV: "production", KUMI_RESEND_API_KEY: "re_x", KUMI_MAIL_FROM: "a@b.example" });
  assert.equal(live.state, "ok"); assert.match(live.text.en, /^Practice mode: off/);
  for (const c of [fresh, one, two, live]) assert.ok(!/\u2014/.test(c.text.en + c.text.es), "no em dashes");
});

test("doctor: Apple Pay and Google Pay need the members' domain registered with Stripe", async () => {
  const keys = { KUMI_STRIPE_SECRET_KEY: "sk_test_x", KUMI_STRIPE_PUBLISHABLE_KEY: "pk_test_x", KUMI_PUBLIC_URL: "https://staff.kestrelpadel.com" };
  let domains: any[] = [];
  const asked: string[] = [];
  const fetch = async (u: string) => {
    asked.push(u);
    if (u.startsWith("https://api.stripe.com/")) return new Response(JSON.stringify({ data: domains }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const wallets = async (env: Record<string, string>) => (await doctor(db, { KUMI_BACKUP_DIR: dir, ...env }, { fetch })).find((c) => c.id === "wallets");
  assert.equal((await wallets(keys))!.state, "warn");   // not registered yet
  assert.ok(asked.includes("https://api.stripe.com/v1/payment_method_domains?domain_name=kestrelpadel.com&limit=1"), asked.join(" "));
  domains = [{ id: "pmd_1", domain_name: "kestrelpadel.com", enabled: true, apple_pay: { status: "inactive", status_details: { error_message: "the domain didn't answer" } }, google_pay: { status: "active" } }];
  assert.match((await wallets(keys))!.text.en, /Apple Pay isn't on there yet: the domain didn't answer/);
  domains[0].apple_pay = { status: "active" };
  const ok = (await wallets(keys))!;
  assert.deepEqual([ok.state, ok.text.en], ["ok", "Apple Pay and Google Pay: on for kestrelpadel.com."]);
  assert.equal((await wallets({ ...keys, KUMI_PUBLIC_URL: "http://127.0.0.1:8790" }))!.state, "off");   // a laptop: nothing to register
  assert.equal(await wallets({ KUMI_PUBLIC_URL: "https://staff.kestrelpadel.com" }), undefined);   // no Stripe, no check
});
