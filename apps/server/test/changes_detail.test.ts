// Changes, round staff-14 (15 Nov 2026): the list says how each change came in, narrows by who made it and its area,
// and goes past the first 50; one change opens with its plan line by line, exactly what it changed and its reference;
// a change that can't be undone says why. Approvals shows the plan's consequences a line each and the asker's words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { fieldChanges, planLines, saidIn } from "../src/changes.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const cookies: Record<string, string> = {};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const req = async (path: string, who: string, body?: unknown, headers: Record<string, string> = {}) => {
  const cookie = cookies[who]!;
  const r = await app.request(path, body === undefined ? { headers: { cookie, ...headers } } : { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function session(who: string, personId: string) {
  await db.insertInto("web_session").values({ token_hash: sha(who), person_id: personId, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[who] = `kumi_session=${who}`;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  const owner: Actor = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const mia = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner);
  const lee = ((await run(db, "person.create", { display_name: "Lee", email: "lee@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: lee, role: "front_desk" }, owner);
  await session("owner", owner.personId!);
  await session("mia", mia);
  await session("lee", lee);
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false });
});
after(async () => drop());

const rename = async (name: string) => {
  const p = await req("/actions/club.update/plan", "owner", { name });
  assert.equal((await req(`/runs/${p.json.run_id}/apply`, "owner", {}, { "idempotency-key": uuidv7() })).status, 200);
  return p.json.run_id as string;
};

test("each change says how it came in and its area; a change that can't be undone says why", async () => {
  const id = await rename("Kestrel Padel Club");
  const rows = (await req("/staff/changes", "owner")).json as any[];
  const r = rows.find((x) => x.id === id), setup = rows.find((x) => x.action === "club.setup");
  assert.deepEqual([r.via, r.area, r.can_undo, r.undo_why], ["web", "settings", true, null]);
  assert.deepEqual([setup.via, setup.can_undo], ["setup", false]);
  assert.equal(setup.undo_why, "This can't be undone: openPadel has no way to put this one back by itself; make the opposite change instead.");
  // In Spanish too (the owner reads it in their own language).
  await db.updateTable("person").set({ locale: "es" }).where("email", "=", "robin@example.test").execute();
  try {
    const es = (await req("/staff/changes", "owner")).json.find((x: any) => x.action === "club.setup");
    assert.match(es.undo_why, /^No se puede deshacer: /);
  } finally { await db.updateTable("person").set({ locale: "en" }).where("email", "=", "robin@example.test").execute(); }
});

test("one change opened: its plan, exactly what it changed, its reference; ids, versions and keys left out", async () => {
  const id = await rename("Kestrel Padel Co");
  const d = await req(`/staff/changes/${id}`, "owner");
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.id, id);
  assert.equal(typeof d.json.title, "string");
  assert.ok(d.json.lines.length >= 1);
  const name = d.json.fields.find((f: any) => f.field === "name");
  assert.deepEqual([name.op, name.before, name.after], ["update", "Kestrel Padel Club", "Kestrel Padel Co"]);
  assert.ok(!d.json.fields.some((f: any) => /^(id|version)$|_id$/.test(f.field)), "no ids or versions");
  assert.equal(d.json.said, null);
  // Not found, and not for someone who can't read the change log.
  assert.equal((await req(`/staff/changes/${uuidv7()}`, "owner")).status, 404);
  assert.equal((await req("/staff/changes/not-an-id", "owner")).status, 404);
  assert.equal((await req(`/staff/changes/${id}`, "lee")).status, 403);
});

test("Who and Type narrow the list, and the next page starts after the last one shown", async () => {
  const ids = (xs: any[]) => xs.map((x) => x.action);
  const club = (await req("/staff/changes?who=club", "owner")).json as any[];
  assert.ok(club.length > 0 && club.every((x) => x.via !== "web"), "the club's own: setup, no person");
  assert.ok(ids(club).includes("club.setup"));
  const people = (await req("/staff/changes?who=people", "owner")).json as any[];
  assert.ok(!ids(people).includes("club.setup") && ids(people).includes("club.update"));
  assert.equal(((await req("/staff/changes?who=assistants", "owner")).json as any[]).length, 0);
  const settings = (await req("/staff/changes?type=settings", "owner")).json as any[];
  assert.ok(settings.length > 0 && settings.every((x) => x.area === "settings"));
  const members = (await req("/staff/changes?type=members", "owner")).json as any[];
  assert.ok(members.length > 0 && members.every((x) => x.area === "members"), "person.create is the members'");
  assert.equal((await req("/staff/changes?who=robots", "owner")).status, 400);
  assert.equal((await req("/staff/changes?type=nothing", "owner")).status, 400);

  // Pages: two at a time, each after the last, none twice, newest first.
  const all = ((await req("/staff/changes?limit=200", "owner")).json as any[]).map((x) => x.id);
  const first = ((await req("/staff/changes?limit=2", "owner")).json as any[]).map((x) => x.id);
  const next = ((await req(`/staff/changes?limit=2&before=${first[1]}`, "owner")).json as any[]).map((x) => x.id);
  assert.deepEqual([...first, ...next], all.slice(0, 4));
  assert.equal((await req("/staff/changes?before=nope", "owner")).status, 400);
});

test("an undo says it's final; Approvals shows how an ask came in and its plan a line each", async () => {
  const id = await rename("Kestrel Padel");
  const u = await req("/actions/action.undo/plan", "owner", { run_id: id });
  assert.equal((await req(`/runs/${u.json.run_id}/apply`, "owner", {}, { "idempotency-key": uuidv7() })).status, 200);
  const undo = (await req(`/staff/changes/${u.json.run_id}`, "owner")).json;
  assert.equal(undo.undo_why, "This can't be undone: an undo is final; make the change again instead.");
  assert.equal(undo.can_undo, false);

  const asked = await req("/actions/club.usage_cap_set/plan", "mia", { cap_cents: 9000 });
  assert.equal(asked.json.status, "awaiting_approval");
  const ask = (await req("/staff/approvals", "owner")).json.waiting.find((a: any) => a.id === asked.json.run_id);
  assert.equal(ask.via, "web");
  assert.ok(Array.isArray(ask.lines) && ask.lines.length >= 1);
  assert.equal(ask.said, null);
});

test("the plan's lines, the asker's words and what a change wrote, as the screens get them", () => {
  assert.deepEqual(planLines({ summary: { en: "Mia leaves Monday clinic. $20.00 goes back to her card.", es: "x" } }, "en"), ["Mia leaves Monday clinic.", "$20.00 goes back to her card."]);
  assert.deepEqual(planLines({ summary: { en: "Add the court.", es: "Agregar la cancha." }, tells: [{ en: "Players are told.", es: "Se avisa." }] }, "es"), ["Agregar la cancha.", "Se avisa."]);
  assert.deepEqual(planLines(null, "en"), []);
  assert.equal(saidIn({ note: "  sick, can't do 6pm " }), "sick, can't do 6pm");
  assert.equal(saidIn({ reason: 3 }), null);
  const w = fieldChanges([
    { entity: "booking", op: "update", before: { id: "b", version: 1, status: "active", court_id: "c1", note: null }, after: { id: "b", version: 2, status: "cancelled", court_id: "c2", note: null } },
    { entity: "payment", op: "insert", before: null, after: { id: "p", amount_cents: 2000, token_hash: "x", created_at: "2026-11-15T10:00:00Z", refunded_at: null } },
  ]);
  assert.deepEqual(w.fields, [{ entity: "booking", op: "update", field: "status", before: "active", after: "cancelled" }, { entity: "payment", op: "insert", field: "amount_cents", before: null, after: 2000 }]);
  assert.equal(w.more, 0);
  const many = fieldChanges([{ entity: "club", op: "insert", before: null, after: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`f${i}`, i])) }]);
  assert.deepEqual([many.fields.length, many.more], [40, 5]);
});
