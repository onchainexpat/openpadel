import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { plan, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { parseCsv, readPeopleCsv } from "../src/csv.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
});
after(async () => drop());

test("spreadsheets: quotes, semicolons, a byte-order mark, and names split in two", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3'), [["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv("﻿x;y\n1;2\n"), [["x", "y"], ["1", "2"]]);
  const r = readPeopleCsv("Nombre;Apellido;Correo electrónico;Idioma\nAna;Ruiz;ANA@example.test;Español\nLee;Chen;;English\n");
  assert.deepEqual(r.rows, [{ display_name: "Ana Ruiz", email: "ana@example.test", locale: "es" }, { display_name: "Lee Chen", locale: "en" }]);
  const bad = readPeopleCsv("Full name,Email\nSam,sam@example.test\n,x@example.test\nSam2,sam@example.test\nKim,not-mail\n");
  assert.deepEqual(bad.rows.map((x) => x.display_name), ["Sam"]);
  assert.deepEqual(bad.problems.map((p) => p.text.en), ["Line 3: no name.", "Line 4: sam@example.test is also on line 2.", 'Line 5: "not-mail" isn\'t an email address.']);
  assert.equal(readPeopleCsv("Email,Phone\na@example.test,1\n").fatal?.en, "There's no Name column (or First name and Last name).");
  assert.equal(readPeopleCsv("").fatal?.en, "The first line should name the columns, such as Name, Email and Language.");
});

test("importing leaves people already here alone, and emails nobody", async () => {
  await run(db, "person.create", { display_name: "Dana Ortiz", email: "dana@example.test" }, owner);
  const rows = readPeopleCsv("Name,Email\nDana O,DANA@example.test\nMia Park,mia@example.test\nNo Email\n").rows;
  const p = await plan(db, "person.import", { rows }, owner);
  assert.equal(p.plan.summary.en, "Add 2 people as members; 1 is already here and stays as it is. Nobody is emailed.");
  const before = mailer.sent.length;
  const r = await run(db, "person.import", { rows }, owner);
  assert.deepEqual(r.result, { added: 2 });
  const mia = await db.selectFrom("person").selectAll().where("email", "=", "mia@example.test").executeTakeFirstOrThrow();
  assert.equal(mia.created_via, "import");
  assert.equal((await db.selectFrom("person").select("display_name").where("email", "=", "dana@example.test").executeTakeFirstOrThrow()).display_name, "Dana Ortiz");
  assert.equal(mailer.sent.length, before);
});

test("staff screens: search with roles, the staff filter, a person's page, and the import preview", async () => {
  const pid = (await run(db, "person.create", { display_name: "Lee Chen", email: "lee@example.test", locale: "es" }, owner)).result as { person_id: string };
  await run(db, "role.assign", { person_id: pid.person_id, role: "front_desk" }, owner);
  const cookie = await signIn("robin@example.test");
  const staff = (await call("/staff/people?role=staff", cookie)).json;
  assert.deepEqual(staff.map((p: any) => p.display_name), ["Lee Chen", "Robin Hale"]);
  assert.deepEqual(staff.find((p: any) => p.display_name === "Lee Chen").roles.sort(), ["front_desk", "member"]);
  const page = (await call(`/staff/people/${pid.person_id}`, cookie)).json;
  assert.equal(page.locale, "es"); assert.equal(page.created_via, "desk");
  assert.deepEqual(page.roles.map((r: any) => r.key), ["front_desk", "member"]);
  const prev = (await call("/staff/people/import-preview", cookie, { csv: "Name,Email\nZoe,zoe@example.test\nZed,bad\n" })).json;
  assert.equal(prev.rows.length, 1); assert.equal(prev.problems[0].line, 3);
  // A member can't read any of it.
  const mia = await signIn("mia@example.test");
  assert.equal((await call("/staff/people", mia)).status, 403);
});
