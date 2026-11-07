// What staff reads through the assistant door (mcp.ts) give away about people's contacts and the club's money: the
// people search takes names only, previews and free text come back with contacts shortened, and support access never
// counts there (from the independent review of 012eb4e, its findings 1 and 4).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { givenContacts, shortenContacts, shortenInText } from "../src/mcp.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, CLIENT = "test-client", TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const people: Record<string, string> = {};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** A bearer token for this person's own assistant connection. */
async function tokenFor(personId: string) {
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: personId, client_id: CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0 }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  return access;
}
/** One tools/call through the door; the parsed JSON answer, or { error } with the door's error key. */
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  await db.insertInto("oauth_client").values({ client_id: CLIENT, kind: "registered", name: "An assistant", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  for (const [name, email] of [["Ann Lee", "ann.lee@example.test"], ["Kim", "kim@example.test"]] as const) people[name] = ((await run(db, "person.create", { display_name: name, email }, owner)).result as any).person_id;
  await db.updateTable("person").set({ phone: "+14155550142" }).where("id", "=", people["Ann Lee"]!).execute();
  // Kim coaches a clinic Ann is booked into: Ann is one of Kim's students.
  const clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley Clinic", capacity: 8, price_cents: 0 }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 2 * 864e5);
  // Kim gets support access while still only a member (support.grant refuses existing staff), then the coach role.
  await run(db, "support.grant", { email: "kim@example.test", name: "Kim", reason: "Helping with setup", level: "manager", hours: 4 }, owner);
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner);
  await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court], coach_id: people.Kim }, owner);
  await run(db, "program.publish", { program_id: clinic }, owner);
  await run(db, "enrolment.join", { program_id: clinic, person_id: people["Ann Lee"] }, { personId: people["Ann Lee"]!, via: "test", lang: "en" });
});
after(async () => drop());

test("support access doesn't count through the door: a coach who also holds it sees no money on a student's page", async () => {
  const kim = await tokenFor(people.Kim!);
  assert.equal((await call(kim, "people")).error, "error.staff_only", "a coach gets no member list through the door");
  const page = await call(kim, "person_page", { person_id: people["Ann Lee"] });
  assert.equal(page.display_name, "Ann Lee", "Ann is Kim's student, so the page opens");
  assert.equal(page.credit_cents, null, "with support access held: still a coach's page, no money on it");
  await db.updateTable("support_grant").set({ ended_at: new Date() }).where("person_id", "=", people.Kim!).execute();
  assert.equal((await call(kim, "person_page", { person_id: people["Ann Lee"] })).credit_cents, null, "and without it, the same");
  await db.updateTable("support_grant").set({ ended_at: null }).where("person_id", "=", people.Kim!).execute();
});

test("the people search through the door takes names only, so a shortened email or phone can't be rebuilt from its answers", async () => {
  const robin = await tokenFor(people.Robin!);
  const shown = await call(robin, "people", { q: "Ann" });
  assert.equal(shown[0].email, "a...@example.test", "found by name, the email shortened");
  const hit = async (q: string) => (await call(robin, "people", { q, limit: 200 }) as any[]).some((p) => p.id === people["Ann Lee"]);
  assert.equal(await hit("ann.lee@example.test"), false, "a whole email matches nothing");
  assert.equal(await hit("@example.test"), false, "nor a part of one");
  assert.equal(await hit("4155550142"), false, "nor a phone number");
  assert.equal(await hit("0142"), false, "nor a part of one");
  // The reviewer's way in: one letter at a time from the domain the answer shows. Nothing grows.
  const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789._-+";
  let tail = "@example.test";
  for (const ch of ALPHA) if (await hit(ch + tail)) { tail = ch + tail; break; }
  assert.equal(tail, "@example.test");
  // The staff app itself still searches emails and phones (its own screen shows them whole).
  const cookieless = await app.request(`${BASE}/staff/people?q=ann.lee`, {});
  assert.equal(cookieless.status, 401, "the staff screen needs a staff sign-in, as before");
});

test("a preview's words and free text come back with contacts shortened, except what the asker typed", async () => {
  const robin = await tokenFor(people.Robin!);
  await db.insertInto("email_suppression").values({ address: "ann.lee@example.test", reason: "bounce", detail: "550 5.1.1 <ann.lee@example.test> mailbox full", first_at: new Date(), last_at: new Date() } as any).execute();
  const page = await call(robin, "person_page", { person_id: people["Ann Lee"] });
  assert.equal(page.email, "a...@example.test");
  assert.ok(page.email_problem, "the page says her email is held back");
  assert.doesNotMatch(JSON.stringify(page), /ann\.lee@example\.test|4155550142/, "nowhere on the page, the problem's detail included");
  const p = await call(robin, "person_email_unsuppress_preview", { person_id: people["Ann Lee"] });
  assert.ok(p.summary, JSON.stringify(p));
  assert.doesNotMatch(p.summary, /ann\.lee@example\.test/, `the preview names her address shortened: "${p.summary}"`);
  // What the asker typed comes back as typed: a new person's email in the preview of adding them.
  const add = await call(robin, "person_create_preview", { display_name: "Zed Walk-in", email: "zed@example.test" });
  assert.equal(add.error, undefined, JSON.stringify(add));
  assert.match(add.summary, /zed@example\.test/, add.summary);
  assert.match(p.summary, /a\.\.\.@example\.test/, p.summary);
});

test("shortening inside text: emails and phones written any usual way, never ids, dates or amounts", () => {
  assert.equal(shortenInText("Call ann.lee@example.test, +1 415 555 0142, (415) 555-0142 or 4155550142."), "Call a...@example.test, ...42, ...42 or ...42.");
  const keep = "0193f2a1-7b3c-7d4e-8a1b-123456789012 12345678-1234-7123-8123-123456789012 2026-11-07T10:00:00.000Z 2026-11-07 $1,234.56 10:30 pi_3N12345678901234 20261107";
  assert.equal(shortenInText(keep), keep);
  assert.equal(shortenInText("Add zed@example.test", givenContacts({ email: "Zed@Example.test" })), "Add zed@example.test", "typed by the asker: kept");
  assert.deepEqual(shortenContacts({ email: "ann.lee@example.test", phone: "+14155550142", notes: [{ text: "her other is ann@work.example.test" }] }),
    { email: "a...@example.test", phone: "...42", notes: [{ text: "her other is a...@work.example.test" }] });
});
