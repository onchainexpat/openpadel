// The guided move-in: a Playbypoint users list read by its preset (its level as NPRP, never a DUPR column), the steps'
// read for the owner and managers only, and the practice run's comparison of the old records with what came over.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { readPeopleCsv } from "../src/csv.ts";
import { commands } from "../src/cli_commands.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, who: string, body?: unknown) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie: cookies[who]!, "content-type": "application/json", "accept-language": "en" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
const PBP = "First Name,Last Name,Email,Phone,NPRP Rating,DUPR,User Type\nAna,Ruiz,ana@example.test,612345678,3.75,4.10,Player\nLee,Chen,lee@example.test,,9,,Player\nMo,Diaz,mo@example.test,,,5.2,Player\n";

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const fay = ((await run(db, "person.create", { display_name: "Fay", email: "fay@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: fay, role: "front_desk" }, owner);
  cookies.Robin = await signIn("robin@example.test");
  cookies.Fay = await signIn("fay@example.test");
});
after(async () => drop());

test("a Playbypoint list: names, email, phone and its NPRP level; a level out of range is a skipped line; DUPR is never read", () => {
  const r = readPeopleCsv(PBP, "playbypoint");
  assert.deepEqual(r.rows.map((x) => [x.display_name, x.email, x.phone ?? null, x.level ?? null]), [
    ["Ana Ruiz", "ana@example.test", "612345678", { value: 3.75, platform: "playbypoint" }],
    ["Lee Chen", "lee@example.test", null, null],
    ["Mo Diaz", "mo@example.test", null, null],
  ]);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0]!.line, 3);
  // The same file as any spreadsheet: a rating column isn't a Playtomic level, so no level at all.
  assert.ok(readPeopleCsv(PBP).rows.every((x) => !x.level));
});

test("the import preview takes the Playbypoint preset, and its level lands as Playbypoint's, provisional", async () => {
  const prev = (await call("/staff/people/import-preview", "Robin", { csv: PBP, from: "playbypoint" })).json;
  assert.equal(prev.rows.length, 3);
  const done = await run(db, "person.import", { rows: prev.rows, file: { name: "pbp-users.csv", lines: 3, unread: 1 } }, owner);
  assert.deepEqual(done.result, { added: 3, levels: 1, skipped: 0 });
  const ana = await db.selectFrom("person").select("id").where("email", "=", "ana@example.test").executeTakeFirstOrThrow();
  const ev = await db.selectFrom("rating_event").select(["kind", "explanation"]).where("person_id", "=", ana.id).executeTakeFirstOrThrow();
  assert.equal(ev.kind, "import_seed");
  assert.match((ev.explanation as { en: string }).en, /Playbypoint/);
  assert.match((ev.explanation as { en: string }).en, /From the club's own Playbypoint records/);
});

test("the steps' read: the owner's, not the front desk's; members counted, and each step's items for its source", async () => {
  assert.equal((await call("/staff/move-in/steps", "Fay")).status, 403);
  let s = (await call("/staff/move-in/steps", "Robin")).json;
  assert.equal(s.step, "connect");
  assert.equal(s.source, null);
  assert.equal(s.connect.imports, 1);
  assert.equal(s.review.people, 3);
  assert.equal(s.review.levels, 1);
  assert.deepEqual(s.practice_run.compare.map((r: any) => [r.what, r.theirs, r.ours, r.result]), [["members", null, 3, "only_ours"]]);
  assert.equal(s.wrap_up.signed_in, 0);
  await run(db, "move.source", { source: "playbypoint" }, owner);
  s = (await call("/staff/move-in/steps", "Robin")).json;
  assert.equal(s.checks.find((c: any) => c.key === "close_bookings").text, "Close new bookings in Playbypoint");
  // Without Playtomic, openPadel sees only its own settings at the switch-over: members booking here, practice mode.
  assert.deepEqual(s.seen.map((x: any) => x.key), ["court_bookings", "practice_off"]);
});

test("Playtomic's practice run: its export's members, memberships and wallets beside what came over", async () => {
  await run(db, "move.source", { source: "playtomic" }, owner);
  const up = (await run(db, "playtomic.upload", { csv: "Name,Email,Wallet,Benefit name,Expiry date\nAna Ruiz,ana@example.test,12.50,Gold,2030-12-31\nZed,zed@example.test,7,,\n", file_name: "export.csv" }, owner)).result as { upload_id: string; sha256: string };
  let s = (await call("/staff/move-in/steps", "Robin")).json;
  const rows = () => Object.fromEntries(s.practice_run.compare.map((r: any) => [r.what, [r.theirs, r.ours, r.result]]));
  assert.deepEqual(rows(), { members: [2, 1, "differs"], memberships: [1, 0, "not_yet"], credit: [1950, 0, "not_yet"] });
  assert.equal(s.practice_run.totals_from, "file");
  await run(db, "credit.bring_in", { source: "file", ...up }, owner);
  s = (await call("/staff/move-in/steps", "Robin")).json;
  // Zed isn't a member here, so 7.00 of the 19.50 stays behind: the difference is the staff's to settle.
  assert.deepEqual(rows().credit, [1950, 1250, "differs"]);
  assert.ok(s.seen.some((x: any) => x.key === "wallets_zeroed" && !x.done));
  assert.ok(s.seen.some((x: any) => x.key === "keys_removed" && x.done));
});

test("the move is a command and an assistant's read: `openpadel move step`, `openpadel moving-in`", () => {
  const words = commands().map((c) => c.words.join(" "));
  for (const w of ["move source", "move step", "move switch-at", "move check", "move finish", "moving-in"]) assert.ok(words.includes(w), w);
});
