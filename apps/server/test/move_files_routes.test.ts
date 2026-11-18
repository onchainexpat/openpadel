// Moving in from CourtReserve (move_files.ts) through the staff app's reads: the files page names what to map and what
// came over without sending a file's rows back, an Excel workbook is read on the server, the steps' read compares the
// files with what came over, and none of the import actions is offered at the assistants' door.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { actions, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { doorAction } from "../src/mcp.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {};
const fixture = (name: string) => readFileSync(new URL(`../../../packages/core/test/fixtures/move/${name}`, import.meta.url), "utf8");
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, who: string, body?: unknown, l = "en") => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie: cookies[who]!, "content-type": "application/json", "accept-language": l }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any, text: "" };
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const fay = ((await run(db, "person.create", { display_name: "Fay", email: "fay@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: fay, role: "front_desk" }, owner);
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner);
  cookies.Robin = await signIn("robin@example.test");
  cookies.Fay = await signIn("fay@example.test");
});
after(async () => drop());

test("the import steps are the app's and the server's, never offered at the assistants' door", () => {
  const door = actions().filter(doorAction).map((a) => a.name);
  for (const name of ["move.upload", "move.members", "move.memberships", "move.credit", "move.bookings", "move.programs"]) assert.ok(!door.includes(name), name);
  assert.ok(door.includes("move.source"));
});

test("CourtReserve is a source; its files page names what to map and what came over, never the rows", async () => {
  await run(db, "move.source", { source: "courtreserve" }, owner);
  assert.equal((await call("/staff/move-in/files?from=courtreserve", "Fay")).status, 403);
  const people = (await call("/actions/move.upload/plan", "Robin", { from: "courtreserve", kind: "people", csv: fixture("courtreserve-members.csv"), file_name: "members.csv" })).json;
  assert.match(people.summary, /^Read members\.csv from CourtReserve as a people list/);
  assert.equal((await call(`/runs/${people.run_id}/apply`, "Robin", {})).status, 200);
  await run(db, "move.upload", { from: "courtreserve", kind: "bookings", csv: fixture("courtreserve-reservations.csv"), file_name: "reservations.csv" }, owner);
  const r = await call("/staff/move-in/files?from=courtreserve", "Robin");
  assert.equal(r.status, 200);
  const f = r.json;
  assert.equal(f.uploads.people?.rows, 5);
  assert.deepEqual(f.memberships.map((m: any) => [m.name, m.count]), [["Gold Monthly", 3], ["Junior Annual", 1]]);
  assert.equal(f.has_credit, true);
  assert.deepEqual(f.courts.map((c: any) => [c.name, Boolean(c.court_id)]), [["Court 1", true], ["Court 2", false], ["Court 9", false]]);
  assert.ok(!JSON.stringify(f).includes("ann@example.test"), "a file's rows stay on the server");
  // The steps' read: the files beside what came over.
  const s = (await call("/staff/move-in/steps", "Robin")).json;
  assert.equal(s.source, "courtreserve");
  assert.equal(s.files.uploads.people.rows, 5);
  const rows = Object.fromEntries(s.practice_run.compare.map((x: any) => [x.what, [x.theirs, x.ours]]));
  assert.deepEqual(rows.members, [5, 0]);
  assert.deepEqual(rows.credit, [124050, 0]);
  assert.equal(rows.bookings[1], 0);
});

test("an Excel workbook is read on the server into cells; anything else isn't one", async () => {
  const bad = await call("/staff/move-in/cells", "Robin", { xlsx: Buffer.from("not a workbook").toString("base64") });
  assert.match(bad.json.fatal, /can't be read as an Excel workbook/);
  assert.equal((await call("/staff/move-in/cells", "Fay", { xlsx: "" })).status, 403);
});
