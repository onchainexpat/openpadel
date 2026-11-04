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
