// The Customers page: an Excel workbook read on the server like a CSV, the Imports tab's list of past imports, and the
// Membership filter.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { readPeopleRows } from "../src/csv.ts";
import { readXlsx, XLSX_MAX_UNPACKED } from "../src/xlsx.ts";

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

/** A small workbook as Excel writes one: shared strings, an inline string, numbers, a yes as TRUE, a blank row, and its
 *  first sheet stored under another name than sheet1.xml. */
function workbook(rows: string, shared: string[]): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Members" sheetId="1" r:id="rId7"/><sheet name="Other" sheetId="2" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst ${ns}>${shared.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join("")}</sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Wrong sheet</t></is></c></row></sheetData></worksheet>`),
    "xl/worksheets/sheet2.xml": strToU8(`<?xml version="1.0"?><worksheet ${ns}><sheetData>${rows}</sheetData></worksheet>`),
  });
}
const members = () => workbook(
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="inlineStr"><is><r><t>ana@</t></r><r><t>example.test</t></r></is></c><c r="C2"><v>612345678</v></c><c r="D2" t="b"><v>1</v></c></row>'
  + '<row r="4"><c r="A4" t="s"><v>5</v></c><c r="C4"><v>0.30000000000000004</v></c></row>'
  + '<row r="5"><c r="B5" t="inlineStr"><is><t>noname@example.test</t></is></c></row>',
  ["Name", "Email", "Phone", "Club news", "Ana Ruiz &amp; Co", "Lee Chen"]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
});
after(async () => drop());

test("an Excel workbook's first sheet reads as rows, its line numbers Excel's, never sheet1.xml by name alone", () => {
  const rows = readXlsx(members())!;
  assert.deepEqual(rows, [["Name", "Email", "Phone", "Club news"], ["Ana Ruiz & Co", "ana@example.test", "612345678", "TRUE"], [], ["Lee Chen", "", "0.3"], ["", "noname@example.test"]]);
  const r = readPeopleRows(rows);
  assert.deepEqual(r.rows, [{ display_name: "Ana Ruiz & Co", email: "ana@example.test", phone: "612345678", club_news: true }, { display_name: "Lee Chen", phone: "0.3" }]);
  assert.equal(r.problems.length, 1);
  // Not a workbook, a zip that isn't one, and one that would unpack to more than a member list ever needs.
  assert.equal(readXlsx(strToU8("Name,Email\n")), null);
  assert.equal(readXlsx(zipSync({ "a.txt": strToU8("hello") })), null);
  const big = zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/worksheets/sheet1.xml": new Uint8Array(XLSX_MAX_UNPACKED + 1) });
  assert.ok(big.length < 200_000, "it packs small");
  assert.equal(readXlsx(big), null);
});

test("the import preview reads an .xlsx; the Imports tab lists each import with its file, lines and what came of it", async () => {
  const cookie = await signIn("robin@example.test");
  const prev = (await call("/staff/people/import-preview", cookie, { xlsx: b64(members()) })).json;
  assert.deepEqual(prev.rows.map((r: any) => r.display_name), ["Ana Ruiz & Co", "Lee Chen"]);
  assert.equal(prev.problems.length, 1);
  assert.equal((await call("/staff/people/import-preview", cookie, { xlsx: b64(strToU8("not a workbook")) })).json.fatal, "That file can't be read as an Excel workbook (.xlsx). Save it as .xlsx or CSV and try again.");
  assert.equal((await call("/staff/people/import-preview", cookie, { xlsx: "A".repeat(2_900_000) })).status, 413);

  await run(db, "person.create", { display_name: "Ana Ruiz", email: "ana@example.test" }, owner);
  const first = await run(db, "person.import", { rows: [...prev.rows, { display_name: "Mia Park", email: "mia@example.test" }], file: { name: "juniors-autumn.xlsx", lines: 4, unread: 1 } }, owner);
  assert.deepEqual(first.result, { added: 2, updated: 1, skipped: 0 });   // Ana gets her phone and club news; Lee and Mia are new
  const second = await run(db, "person.import", { rows: [{ display_name: "Mia Park", email: "mia@example.test" }] }, owner);   // an older caller: no file
  assert.deepEqual(second.result, { added: 0, skipped: 1 });
  const list = (await call("/staff/people/imports", cookie)).json;
  assert.deepEqual(list.map((x: any) => [x.file, x.lines, x.added, x.updated, x.skipped, x.by, x.status]), [
    [null, 1, 0, 0, 1, "Robin Hale", "applied"],
    ["juniors-autumn.xlsx", 4, 2, 1, 1, "Robin Hale", "applied"],
  ]);
  // Only the counts and the name are kept: the run holds the rows it imported, as every import's always has, and no file.
  await run(db, "action.undo", { run_id: second.runId }, owner);
  assert.equal((await call("/staff/people/imports", cookie)).json[0].status, "undone");
  // A member can't read it.
  const mia = await signIn("mia@example.test");
  assert.equal((await call("/staff/people/imports", mia)).status, 403);
});

test("the Membership filter: one plan (theirs or a family plan covering them), any membership, or none", async () => {
  const cookie = await signIn("robin@example.test");
  const gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner)).result as any).plan_id;
  const silver = ((await run(db, "membership.plan_set", { name: "Silver", price_cents: 3000, period: "month", join_in_app: true }, owner)).result as any).plan_id;
  const id = async (email: string) => (await db.selectFrom("person").select("id").where("email", "=", email).executeTakeFirstOrThrow()).id;
  const live = async (person: string, plan: string, status = "active") => {
    const m = uuidv7();
    await db.insertInto("membership").values({ id: m, person_id: person, plan_id: plan, status, source: "app", started_at: new Date(Date.now() - 5 * 864e5),
      current_period_end: new Date(Date.now() + 20 * 864e5), price_cents: 6000, period: "month" } as any).execute();
    return m;
  };
  const fam = await live(await id("ana@example.test"), gold);
  await db.insertInto("membership_member").values({ id: uuidv7(), membership_id: fam, person_id: await id("mia@example.test") } as any).execute();
  await live(await id("robin@example.test"), silver, "ended");   // over: not a member now
  const names = async (m: string) => (await call(`/staff/customers?membership=${m}`, cookie)).json.rows.map((r: any) => r.display_name);
  assert.deepEqual(await names(gold), ["Ana Ruiz", "Mia Park"]);
  assert.deepEqual(await names(silver), []);
  assert.deepEqual(await names("any"), ["Ana Ruiz", "Mia Park"]);
  assert.deepEqual(await names("none"), ["Lee Chen", "Robin Hale"]);
  const all = (await call("/staff/customers", cookie)).json;
  assert.equal(all.total, 4);
  assert.deepEqual(all.plans.map((p: any) => p.name), ["Gold", "Silver"]);
  assert.equal((await call("/staff/customers?membership=nonsense", cookie)).json.total, 4);   // not a plan: no filter
});

test("a small workbook can't ask for a huge sheet: a cell far to the right is left out, too many cells refuse it; odd input never throws", () => {
  // XFD1 is column 16,384: read as is, every such row would be 16,384 cells wide.
  const wide = readXlsx(workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="XFD1" t="inlineStr"><is><t>far</t></is></c></row>', []))!;
  assert.deepEqual(wide, [["Name"]]);
  const many = readXlsx(workbook(Array.from({ length: 3000 }, (_, n) => `<row r="${n + 1}">${'<c t="inlineStr"><is><t>x</t></is></c>'.repeat(70)}</row>`).join(""), []));
  assert.ok(many === null, "210,000 cells: refused");   // not assert.equal: printing a 3,000-row miss takes gigabytes
  // A character that doesn't exist is left as written, not an error; prefixed tags (some exporters write x:row) still read.
  assert.deepEqual(readXlsx(workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>a&#99999999;b</t></is></c></row>', [])), [["a&#99999999;b"]]);
  const prefixed = zipSync({ "xl/workbook.xml": strToU8('<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="S" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8('<x:sst xmlns:x="m"><x:si><x:t>Name</x:t></x:si></x:sst>'),
    "xl/worksheets/sheet1.xml": strToU8('<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>') });
  assert.deepEqual(readXlsx(prefixed), [["Name"]]);
});
