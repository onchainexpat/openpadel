// An assistant connection never reaches further than its person allowed when they connected it (assistant_reach.ts),
// whichever way they come to hold more: a staff role, a removal undone, the server's `owner add`, a role the club made
// widened, or the club now asking a second step. And what the door doesn't give away about whose an email is (from
// the independent re-check of c1a9ff8).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { decide, messageHandlers, processOutbox, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { clubsOwn } from "../src/cli_remote.ts";
import { shortenInText } from "../src/mcp.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, CLIENT = "reach-client", TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const people: Record<string, string> = {};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** An assistant connection made before anything was kept with it: its first use takes what the person holds then. */
async function tokenFor(personId: string) {
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: personId, client_id: CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0 }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  return { access, grant };
}
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status === 401) return { error: "signed_out" };
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}
const noTool = (r: any) => typeof r.error === "string" && /not found/.test(r.error);
const toldOnce = async (grant: string) => (await db.selectFrom("event_outbox").select("payload").where("topic", "=", "assistant.limited").execute())
  .filter((e) => (e.payload as any).grant_id === grant).length;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  await db.insertInto("oauth_client").values({ client_id: CLIENT, kind: "registered", name: "Claude", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  for (const [name, email] of [["Ann Lee", "ann.lee@example.test"], ["Bob Marsh", "bob@example.test"], ["Cal Ruiz", "cal@example.test"], ["Dee Park", "dee@example.test"], ["Eve Sol", "eve@example.test"]] as const)
    people[name] = ((await run(db, "person.create", { display_name: name, email }, owner)).result as any).person_id;
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
});
after(async () => drop());

test("a removal undone gives the role back, but not to an assistant connected meanwhile as a member: it reads and acts as a member's, told once", async () => {
  await run(db, "role.assign", { person_id: people["Bob Marsh"], role: "manager" }, owner);
  const removed = await run(db, "role.remove", { person_id: people["Bob Marsh"], role: "manager" }, owner);
  const bob = await tokenFor(people["Bob Marsh"]!);
  assert.ok(noTool(await call(bob.access, "people")), "as a member: no staff reads");
  await run(db, "action.undo", { run_id: removed.runId }, owner);   // the owner undoes the removal from Changes
  const who = await call(bob.access, "whoami");
  assert.equal(who.limited?.why, "widened", JSON.stringify(who));
  assert.match(who.limited.note, /works as a member's for now/);
  assert.ok(noTool(await call(bob.access, "people")), "still no staff reads");
  assert.ok(noTool(await call(bob.access, "person_tag_preview", { person_id: people["Ann Lee"], tag_id: uuidv7() })), "nor a manager's changes");
  await call(bob.access, "whoami");
  assert.equal(await toldOnce(bob.grant), 1, "said once, however often it's used");
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["subject", "body", "channel"]).where("person_id", "=", people["Bob Marsh"]!).where("kind", "=", "assistant_limited").execute();
  assert.ok(told.some((m) => m.channel === "inbox"), "in the app's inbox");
  assert.match(told[0]!.subject, /Claude works as a member's at Kestrel Padel for now/);
  assert.match(told[0]!.body, /given more at the club/);
  // The permission check itself, held to the member role: a manager's change is a no.
  assert.equal((await decide(db, "tag.create", { personId: people["Bob Marsh"]!, at: new Date(), memberOnly: true })).mode, "no");
  assert.equal((await decide(db, "tag.create", { personId: people["Bob Marsh"]!, at: new Date() })).mode, "allow", "in the app, Bob is a manager again");
  // Connected again (what they hold now is what they allow), it reaches all of it.
  const again = await tokenFor(people["Bob Marsh"]!);
  assert.equal((await call(again.access, "whoami")).limited, undefined);
  assert.ok(Array.isArray(await call(again.access, "people")));
});

test("the server's `owner add` doesn't reach through an assistant connected as a member", async () => {
  const cal = await tokenFor(people["Cal Ruiz"]!);
  assert.equal((await call(cal.access, "whoami")).limited, undefined);
  await runAsSystem(db, "role.owner_add_by_server", { person_id: people["Cal Ruiz"] }, "cli");
  assert.equal((await call(cal.access, "whoami")).limited?.why, "widened");
  assert.ok(noTool(await call(cal.access, "people")));
});

test("a role the club made, widened later, doesn't widen what an assistant connected under it reaches", async () => {
  const made = await run(db, "role.create", { name: "Tagger", grants: [{ action: "tag.create", scope: "any" }] }, owner);
  const key = (made.result as any).key as string;
  await run(db, "role.assign", { person_id: people["Dee Park"], role: key }, owner);
  const dee = await tokenFor(people["Dee Park"]!);
  assert.equal((await call(dee.access, "whoami")).limited, undefined, "connected with the role as it was");
  await run(db, "role.update", { role: key, grants: [{ action: "tag.create", scope: "any" }, { action: "person.tag", scope: "any" }] }, owner);
  assert.equal((await call(dee.access, "whoami")).limited?.why, "widened");
});

test("an owner giving themselves another role in the app keeps their assistant: it reaches nothing new", async () => {
  const robin = await tokenFor(people.Robin!);
  assert.equal((await call(robin.access, "whoami")).limited, undefined);
  await run(db, "role.assign", { person_id: people.Robin, role: "coach" }, owner);
  const who = await call(robin.access, "whoami");
  assert.equal(who.limited, undefined, JSON.stringify(who.limited));
  assert.ok(Array.isArray(await call(robin.access, "people")));
  await run(db, "role.remove", { person_id: people.Robin, role: "coach" }, owner);
});

test("the club turning on a second step: a staff connection allowed without one works as a member's until connected again", async () => {
  await run(db, "role.assign", { person_id: people["Eve Sol"], role: "manager" }, owner);
  const eve = await tokenFor(people["Eve Sol"]!);
  assert.equal((await call(eve.access, "whoami")).limited, undefined, "the club asks no second step yet");
  await db.updateTable("club").set({ two_factor: "owner_manager" } as any).execute();
  try {
    const who = await call(eve.access, "whoami");
    assert.equal(who.limited?.why, "second_step");
    assert.ok(noTool(await call(eve.access, "people")));
    // One allowed with a second step isn't held back.
    const grant = uuidv7(), access = randomBytes(24).toString("hex");
    await db.insertInto("oauth_grant").values({ id: grant, person_id: people["Eve Sol"]!, client_id: CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, second_step: true }).execute();
    await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
    assert.equal((await call(access, "whoami")).limited, undefined);
  } finally { await db.updateTable("club").set({ two_factor: "off" } as any).execute(); }
});

test("a members' list isn't imported through the door (its preview would say whose an email is), and a taken email gets a plain refusal", async () => {
  const robin = await tokenFor(people.Robin!);
  assert.ok(noTool(await call(robin.access, "person_import_preview", { rows: [{ display_name: "Guess", email: "ann.lee@example.test" }] })), "the import is the app's");
  const dup = await call(robin.access, "person_create_preview", { display_name: "Guess", email: "ann.lee@example.test" });
  assert.equal(dup.error, "error.door_not_here");
  const fresh = await call(robin.access, "person_create_preview", { display_name: "Zed", email: "zed@example.test" });
  assert.ok(fresh.run_id, JSON.stringify(fresh));
});

test("an alert's event id with 10 or more digits comes through whole, and handling it through the door works", async () => {
  const robin = await tokenFor(people.Robin!);
  await db.insertInto("event_outbox").values({ id: "12345678901", action_run_id: null, topic: "test.alert", payload: "{}" } as any).execute();
  await db.insertInto("outbound_message").values({ id: uuidv7(), event_id: "12345678901", person_id: people.Robin!, kind: "question_unanswered_staff", channel: "inbox", purpose: "staff", essential: true, lang: "en",
    subject: "A question waits (call 415-555-0142)", body: "Ann asks: ring me on 4155550142 or ann.lee@example.test", link: "/questions", status: "sent", send_after: new Date(), stale_at: null, sent_at: new Date(), read_at: null } as any).execute();
  const alerts = await call(robin.access, "alerts");
  const a = JSON.stringify(alerts);
  assert.match(a, /"event_id":"12345678901"/, "the id whole");
  assert.doesNotMatch(a, /4155550142|415-555-0142|ann\.lee@/, "the contacts in its words shortened");
  const p = await call(robin.access, "alert_handle_preview", { event_id: "12345678901", kind: "question_unanswered_staff" });
  assert.ok(p.run_id, JSON.stringify(p));
  assert.equal((await call(robin.access, "alert_handle_confirm", { run_id: p.run_id })).done, true);
});

test("free text: phones and emails as people write them come back shortened", () => {
  for (const [given, want] of [["Call me on 415-5550142", "Call me on ...42"], ["UK mobile 07700 900123", "UK mobile ...23"], ["London 020 7946 0958", "London ...58"],
    ["write to josé@example.test", "write to j...@example.test"], ["+44 20 7946 0958 or +34 612 345 678", "...58 or ...78"]] as const)
    assert.equal(shortenInText(given), want);
  const kept = "from 2026-11-07 to 2026-11-08, 12:30-14:00, Courts 1 2 3 4 5 6 7 8 9, 10 11 12, booking 1234567, 1.234.567,89, $1,234.56";
  assert.equal(shortenInText(kept), kept);
});

test("the command line signs in only at the club's own host or its staff app beside it, never a neighbour", () => {
  const as = (o: string) => ({ authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`, device_authorization_endpoint: `${o}/oauth/device_authorization` });
  assert.equal(clubsOwn("https://kestrelpadel.co.uk", "https://someone-else.co.uk", "https://someone-else.co.uk/mcp", as("https://someone-else.co.uk")), "https://someone-else.co.uk");
  assert.equal(clubsOwn("https://kestrel.kumi.club", "https://another-club.kumi.club", "https://another-club.kumi.club/mcp", as("https://another-club.kumi.club")), "https://another-club.kumi.club");
  assert.equal(clubsOwn("https://padel.com.es", "https://otro.com.es", "https://otro.com.es/mcp", as("https://otro.com.es")), "https://otro.com.es");
  assert.equal(clubsOwn("https://app.kestrel.co.uk", "https://staff.app.kestrel.co.uk", "https://app.kestrel.co.uk/mcp", as("https://staff.app.kestrel.co.uk")), null, "the members' app and its staff app");
  assert.equal(clubsOwn("https://staff.app.kestrel.co.uk", "https://staff.app.kestrel.co.uk", "https://staff.app.kestrel.co.uk/mcp", as("https://staff.app.kestrel.co.uk")), null);
});
