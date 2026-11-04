// The club's own terms and privacy policy for members: set in Settings (or club.yaml), shown where people join, beside
// the yes to texts and on the public pages, and what each member agreed to kept with the time.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { exportData, KumiError, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { doctor } from "../src/doctor.ts";
import { readClubFile, setupClub } from "../src/setup.ts";
import { withClubLinks } from "../src/texting.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer();
const TERMS = "https://kestrel.example/terms", PRIVACY = "https://kestrel.example/privacy";

async function call(path: string, body?: unknown) {
  const res = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any };
}
/** A code to a new address, then the ticket that finishes joining. */
async function ticketFor(email: string): Promise<string> {
  await call("/auth/email/start", { email });
  const v = await call("/auth/email/verify", { email, code: mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]! });
  assert.equal(v.json.sign_up, true);
  return v.json.ticket;
}
const join = (ticket: string, policies?: unknown) => call("/auth/sign-up", { ticket, display_name: "New Member", locale: "es", club_news: false, ...(policies !== undefined ? { policies } : {}) });
const personOf = async (email: string) => (await db.selectFrom("person").select("id").where("email", "=", email).executeTakeFirstOrThrow()).id;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
});
after(async () => drop());

test("with no links set, nothing is shown, asked or kept", async () => {
  const club = await call("/club");
  assert.equal(club.json.terms_url, null); assert.equal(club.json.privacy_policy_url, null);
  assert.equal((await join(await ticketFor("first@example.test"))).status, 200);
  assert.equal((await db.selectFrom("policy_acceptance").selectAll().execute()).length, 0);
  assert.doesNotMatch(await (await app.request("/public/texts")).text(), /Privacy policy/);
});

test("Settings takes only web links, and an empty one takes the link off", async () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://kestrel.example/terms", "not a link"]) {
    await assert.rejects(run(db, "club.update", { terms_url: bad }, owner), (e: unknown) => e instanceof KumiError && e.code === "error.invalid_input", bad);
  }
  await run(db, "club.update", { terms_url: TERMS }, owner);
  await run(db, "club.update", { terms_url: null }, owner);
  assert.equal((await db.selectFrom("club").select("terms_url").executeTakeFirstOrThrow()).terms_url, null);
});

test("joining agrees to the links the page showed, kept with the language and time, and in Download data", async () => {
  await run(db, "club.update", { terms_url: TERMS, privacy_policy_url: PRIVACY }, owner);
  const club = await call("/club");
  assert.equal(club.json.terms_url, TERMS); assert.equal(club.json.privacy_policy_url, PRIVACY);
  const ticket = await ticketFor("nadia@example.test");
  // A page from before the club set them (or one that sends nothing) looks again; the ticket still works after.
  for (const stale of [undefined, { terms_url: null, privacy_policy_url: null }, { terms_url: TERMS, privacy_policy_url: null }]) {
    const r = await join(ticket, stale);
    assert.equal(r.status, 409); assert.equal(r.json.error, "error.policies_changed");
  }
  const ok = await join(ticket, { terms_url: TERMS, privacy_policy_url: PRIVACY });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const id = await personOf("nadia@example.test");
  const rows = await db.selectFrom("policy_acceptance").selectAll().where("person_id", "=", id).execute();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.terms_url, rows[0]!.privacy_policy_url, rows[0]!.lang, rows[0]!.source], [TERMS, PRIVACY, "es", "sign_up"]);
  const file = await exportData(db, id, new Date(), "es") as any;
  assert.deepEqual(file.policies_agreed.map((a: any) => [a.terms_url, a.privacy_policy_url, a.lang]), [[TERMS, PRIVACY, "es"]]);
  assert.match(file.policies_agreed[0].accepted_at, /^\d{4}-\d\d-\d\dT/);
  // Someone who joined before the club set them isn't asked again.
  assert.equal((await db.selectFrom("policy_acceptance").selectAll().where("person_id", "=", await personOf("first@example.test")).execute()).length, 0);
});

test("only the terms set: joining agrees to the terms alone", async () => {
  await run(db, "club.update", { privacy_policy_url: null }, owner);
  assert.equal((await join(await ticketFor("terms-only@example.test"), { terms_url: TERMS, privacy_policy_url: null })).status, 200);
  const row = await db.selectFrom("policy_acceptance").selectAll().where("person_id", "=", await personOf("terms-only@example.test")).executeTakeFirstOrThrow();
  assert.deepEqual([row.terms_url, row.privacy_policy_url], [TERMS, null]);
  await run(db, "club.update", { privacy_policy_url: PRIVACY }, owner);
});

test("the public pages link them at the foot, and the texts page beside the yes", async () => {
  await run(db, "club.update", { public_page: true }, owner);
  const page = await (await app.request("/public")).text();
  assert.match(page, new RegExp(`<footer><p><a href="${TERMS}">Terms</a> · <a href="${PRIVACY}">Privacy policy</a></p>`));
  const texts = await (await app.request("/public/texts?lang=es")).text();
  assert.match(texts, new RegExp(`</label></p><p class="meta"><a href="${TERMS}">Términos</a> · <a href="${PRIVACY}">Política de privacidad</a></p>`));
});

test("doctor: off without links, ok with them, and a warning while texts are set up with no privacy policy", async () => {
  const policies = async (env: Record<string, string>) => (await doctor(db, { KUMI_BACKUP_DIR: "/nonexistent", ...env })).find((c) => c.id === "policies")!;
  const twilio = { KUMI_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, KUMI_TWILIO_AUTH_TOKEN: "f".repeat(32) };
  assert.equal((await policies({})).state, "ok");
  assert.equal((await policies(twilio)).state, "ok");
  await run(db, "club.update", { privacy_policy_url: null }, owner);
  const warn = await policies(twilio);
  assert.equal(warn.state, "warn"); assert.match(warn.text.en, /privacy policy isn't linked/); assert.equal(warn.doc, "docs/templates/README.md");
  assert.equal((await policies({})).state, "ok");
  await run(db, "club.update", { terms_url: null }, owner);
  assert.equal((await policies({})).state, "off");
  await run(db, "club.update", { terms_url: TERMS, privacy_policy_url: PRIVACY }, owner);
});

test("Twilio's form takes the club's links first, and ones named only under texting in club.yaml still count", () => {
  const d = { business_name: "Kestrel Padel LLC", terms_url: "https://old.example/terms", privacy_policy_url: "https://old.example/privacy" };
  assert.deepEqual(withClubLinks(d, { terms_url: TERMS, privacy_policy_url: null }), { ...d, terms_url: TERMS });
  assert.deepEqual(withClubLinks(d, { terms_url: null, privacy_policy_url: null }), d);
  assert.equal(withClubLinks(undefined, { terms_url: TERMS, privacy_policy_url: PRIVACY }), undefined);
});

test("club.yaml sets the links when the club has none, and only notes a different one", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "kumi-terms-"));
  const file = (body: string) => { const p = joinPath(dir, `club-${Math.random()}.yaml`); writeFileSync(p, body); return readClubFile(p); };
  await run(db, "club.update", { terms_url: null, privacy_policy_url: null }, owner);
  const older = file(`club: { name: Kestrel Padel, time_zone: America/Los_Angeles }\nowner: { name: Robin Hale, email: robin@example.test }\ntexting: { privacy_policy_url: "${PRIVACY}" }\n`);
  const planned = await setupClub(db, older, { apply: false, lang: "en" });
  assert.deepEqual(planned.steps.map((s) => s.text.en), [`Link the club's terms and privacy policy for members: ${PRIVACY}.`]);
  await setupClub(db, older, { apply: true, lang: "en" });
  assert.deepEqual(await db.selectFrom("club").select(["terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow(), { terms_url: null, privacy_policy_url: PRIVACY });
  const other = file(`club: { name: Kestrel Padel, time_zone: America/Los_Angeles, terms_url: "${TERMS}", privacy_policy_url: "https://elsewhere.example/privacy" }\nowner: { name: Robin Hale, email: robin@example.test }\n`);
  const r = await setupClub(db, other, { apply: true, lang: "en" });
  assert.deepEqual(r.steps.map((s) => s.text.en), [`Link the club's terms and privacy policy for members: ${TERMS}.`]);
  assert.ok(r.notes.some((n) => n.en === "In club.yaml, the privacy policy link isn't the one the club has. Change it in the staff app's Settings, not from this file."), JSON.stringify(r.notes));
  assert.deepEqual(await db.selectFrom("club").select(["terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow(), { terms_url: TERMS, privacy_policy_url: PRIVACY });
});
