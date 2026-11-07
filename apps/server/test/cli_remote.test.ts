// The club's commands from another computer (cli_remote.ts), against a club served in-process: signing in (in the
// browser, and by a code from a device with none), that each command is the assistant door's own tool, and what
// the command line adds (names for ids, the club's clock, a change done once however often it's asked).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { remoteMain, EXIT, type RemoteDeps } from "../src/cli_remote.ts";
import { Store } from "../src/cli_store.ts";
import { clubTime } from "../src/cli_commands.ts";

const BASE = "https://club.example.test", TZ = "America/Los_Angeles";
const OWNER = "robin@example.test", DESK = "dana@example.test", MEMBER = "ann@example.test";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court: string;
const mailer = new MemoryMailer();
const dirs: string[] = [];
const req = (path: string, init: RequestInit = {}) => app.request(path.startsWith("http") ? path : `${BASE}${path}`, init);
const form = (o: Record<string, string>, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(o).toString() });

/** The person at the browser: signs in on the club's page by an emailed code (once: the club limits the codes one
 *  address gets, so the browser keeps its session for the next consent), and allows (or not) at the consent. */
const sessions = new Map<string, string>();
async function signInAt(link: string, email: string): Promise<string> {
  const kept = sessions.get(email);
  if (kept) return kept;
  const back = new URL(link);
  assert.equal((await req(`${back.pathname}${back.search}`)).status, 200);
  assert.equal((await req("/oauth/sign-in", form({ back: link, email }))).status, 303);
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await req("/oauth/sign-in", form({ back: link, email, code }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  sessions.set(email, cookie);
  return cookie;
}
async function allowInBrowser(link: string, email: string, cap = "0", decision = "allow") {
  const cookie = await signInAt(link, email);
  const u = new URL(link);
  const consent = await (await req(`${u.pathname}${u.search}`, { headers: { cookie } })).text();
  const id = consent.match(/name="req" value="([^"]+)"/)![1]!;
  const r = await req("/oauth/decide", form({ req: id, decision, cap }, cookie));
  await fetch(r.headers.get("location")!);   // the browser follows the redirect to the command line's own page
}
async function allowDevice(link: string, email: string, cap = "0") {
  const cookie = await signInAt(link, email);
  const u = new URL(link);
  const page = await (await req(`${u.pathname}${u.search}`, { headers: { cookie } })).text();
  assert.match(page, /your agent showed you this same code/);
  const code = page.match(/name="code" value="([^"]+)"/)![1]!, id = page.match(/name="req" value="([^"]+)"/)![1]!;
  const forged = await req("/oauth/device/decide", form({ code, decision: "allow", cap }, cookie));
  assert.equal(forged.status, 400, "an answer without the consent screen's own id is refused");
  const done = await (await req("/oauth/device/decide", form({ code, req: id, decision: "allow", cap }, cookie))).text();
  assert.match(done, /is connected/);
}

/** One computer: its own config folder, and kumi run there. */
function computer(o: { browserAs?: { email: string; cap?: string; decision?: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kumi-cli-")); dirs.push(dir);
  const store = new Store(dir, false);
  let waiting: Promise<void> | null = null;
  const kumi = async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const deps: RemoteDeps = {
      fetch: async (u, init) => (String(u).startsWith(BASE) ? req(String(u), init as RequestInit) : fetch(u, init)), store,
      out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {}, now: () => Date.now(), hostname: "test-laptop", env: {},
      openBrowser: o.browserAs ? (link) => { if (link.includes("/oauth/authorize")) waiting = allowInBrowser(link, o.browserAs!.email, o.browserAs!.cap, o.browserAs!.decision); } : null,
    };
    const code = await remoteMain(argv, deps);
    if (waiting) await waiting;
    const json = () => JSON.parse(out.filter((l) => l.startsWith("{")).at(-1)!);
    return { code, out, err, json, text: [...out, ...err].join("\n") };
  };
  return { kumi, store, dir };
}
/** A computer signed in to the club as someone, by the device code (the agent's way). */
async function signedIn(email: string, cap = "0") {
  const c = computer();
  const start = await c.kumi("login", BASE, "--device", "--no-wait", "--json");
  assert.equal(start.code, EXIT.sign_in_waiting, start.text);
  await allowDevice(start.json().link, email, cap);
  const done = await c.kumi("login", BASE, "--device", "--json");
  assert.equal(done.code, EXIT.done, done.text);
  return c;
}
/** The door's own preview for the same input, asked directly with the same connection's token. */
async function doorPreview(store: Store, tool: string, args: Record<string, unknown>) {
  const e = store.pick(BASE)!, tok = store.tokens(e)!;
  const r = await req("/mcp", { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: `${tool}_preview`, arguments: args } }) });
  return JSON.parse(((await r.json()) as any).result.content[0].text);
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: OWNER, owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  const dana = ((await run(db, "person.create", { display_name: "Dana Desk", email: DESK }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: dana, role: "front_desk" }, owner);
  for (const [name, email] of [["Ann Lee", MEMBER], ["Maria Lopez", "maria@example.test"], ["Maria Gomez", "mgomez@example.test"]]) await run(db, "person.create", { display_name: name, email }, owner);
  app = makeApp({ db, mailer, publicUrl: BASE, secureCookies: false });
});
after(async () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); await drop(); });

test("sign in in the browser: the connection is an assistant's, named for this computer, and whoami reads the door's answer", async () => {
  const c = computer({ browserAs: { email: OWNER } });
  const r = await c.kumi("login", BASE);
  assert.equal(r.code, EXIT.done, r.text);
  assert.match(r.text, /Signed in to Kestrel Padel as Robin Hale/);
  assert.match(r.text, /readable by you only/);
  assert.equal(statSync(join(c.dir, "secrets.json")).mode & 0o777, 0o600, "the tokens' file is the user's alone");
  const g = await db.selectFrom("oauth_grant").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id").select(["oauth_client.name", "oauth_grant.weekly_cap_cents"])
    .where("oauth_grant.person_id", "=", owner.personId!).execute();
  assert.deepEqual(g, [{ name: "kumi (test-laptop)", weekly_cap_cents: 0 }], "Profile, Assistants lists it, with the limit chosen at the consent");
  const w = await c.kumi("whoami", "--json");
  assert.equal(w.code, EXIT.done);
  assert.equal(w.json().data.person, "Robin Hale");
  assert.ok(w.json().data.roles.some((x: any) => x.key === "owner"));
});

test("saying no in the browser connects nothing", async () => {
  const c = computer({ browserAs: { email: OWNER, decision: "deny" } });
  const r = await c.kumi("login", BASE);
  assert.equal(r.code, EXIT.refused, r.text);
  assert.equal(c.store.pick(BASE), null);
});

test("a device with no browser: a link and a code, allowed from a phone; --no-wait, then the same command again finishes", async () => {
  const c = computer();
  const start = await c.kumi("login", BASE, "--device", "--no-wait", "--json");
  assert.equal(start.code, EXIT.sign_in_waiting);
  const s = start.json();
  assert.match(s.code, /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
  assert.equal(s.link, `${BASE}/oauth/device?code=${s.code}`);
  const early = await c.kumi("login", BASE, "--device", "--no-wait", "--json");
  assert.equal(early.code, EXIT.sign_in_waiting, "not allowed yet: still waiting, the same code");
  assert.equal(early.json().code, s.code);
  await allowDevice(s.link, DESK, "2500");
  const done = await c.kumi("login", BASE, "--device", "--json");
  assert.equal(done.code, EXIT.done, done.text);
  assert.equal(done.json().person, "Dana Desk");
  const g = await db.selectFrom("oauth_grant").innerJoin("person", "person.id", "oauth_grant.person_id").select("weekly_cap_cents").where("person.email", "=", DESK).executeTakeFirstOrThrow();
  assert.equal(g.weekly_cap_cents, 2500);
  const twice = await req("/oauth/device/decide", form({ code: s.code.replace("-", ""), decision: "allow" }));
  assert.equal(twice.status, 400, "a code is used once");
});

test("a change previews first, exactly as the door's preview says, and changes nothing until it's confirmed", async () => {
  const c = await signedIn(OWNER);
  const p = await c.kumi("location", "create", "--name", "Westside", "--time-zone", TZ, "--json");
  assert.equal(p.code, EXIT.preview, p.text);
  const v = p.json();
  assert.equal(v.status, "preview");
  assert.equal(v.summary, "Add the location Westside (America/Los_Angeles).");
  assert.equal(v.summary, (await doorPreview(c.store, "location_create", { name: "Westside", time_zone: TZ })).summary, "the same words as the assistant door");
  assert.equal(v.confirm, `kumi confirm ${v.run_id}`);
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Westside").execute()).length, 0);
  const done = await c.kumi("confirm", v.run_id, "--json");
  assert.equal(done.code, EXIT.done, done.text);
  assert.ok(done.json().result.location_id);
  const again = await c.kumi("confirm", v.run_id, "--json");
  assert.equal(again.code, EXIT.done);
  assert.equal(again.json().already, true);
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Westside").execute()).length, 1, "confirmed twice, done once");
});

test("--yes does it at once; the same command again is done once, unless --again says so; --key names the change", async () => {
  const c = await signedIn(OWNER);
  const first = await c.kumi("location", "create", "--name", "Eastside", "--time-zone", TZ, "--yes", "--json");
  assert.equal(first.code, EXIT.done, first.text);
  const second = await c.kumi("location", "create", "--time-zone", TZ, "--name", "Eastside", "--yes", "--json");
  assert.equal(second.code, EXIT.done);
  assert.equal(second.json().already, true, "the same input, in another order, is the same change");
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Eastside").execute()).length, 1);
  const third = await c.kumi("location", "create", "--name", "Eastside", "--time-zone", TZ, "--yes", "--again", "--json");
  assert.equal(third.code, EXIT.done);
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Eastside").execute()).length, 2);
  const k1 = await c.kumi("location", "create", "--name", "North", "--time-zone", TZ, "--yes", "--key", "north-1", "--json");
  const k2 = await c.kumi("location", "create", "--name", "North", "--time-zone", TZ, "--yes", "--key", "north-1", "--json");
  assert.equal(k1.code, EXIT.done); assert.equal(k2.json().already, true);
  // A preview first, then --yes: what's done is that preview.
  const p = await c.kumi("location", "create", "--name", "South", "--time-zone", TZ, "--json");
  const y = await c.kumi("location", "create", "--name", "South", "--time-zone", TZ, "--yes", "--json");
  assert.equal(y.json().run_id, p.json().run_id);
});

test("names where ids go, for staff; a name that fits two people lists them; a time without a zone is the club's", async () => {
  const c = await signedIn(OWNER);
  const r = await c.kumi("court", "create", "--location", "main", "--name", "Court 2", "--json");
  assert.equal(r.code, EXIT.preview, r.text);
  assert.match(r.json().summary, /Court 2/);
  const two = await c.kumi("level", "set", "--person", "Maria", "--level", "3.5", "--reason", "Played here", "--json");
  assert.equal(two.code, EXIT.ambiguous, two.text);
  assert.deepEqual(two.json().choices.map((x: any) => x.name).sort(), ["Maria Gomez", "Maria Lopez"]);
  assert.match(two.json().choices[0].hint, /^m\.\.\.@example\.test$/, "emails come shortened through the door");
  const one = await c.kumi("level", "set", "--person", "Maria Lopez", "--level", "3.5", "--reason", "Played here", "--json");
  assert.equal(one.code, EXIT.preview, one.text);
  assert.match(one.json().summary, /Maria Lopez/);
  const none = await c.kumi("level", "set", "--person", "Zed", "--level", "3.5", "--reason", "Played here", "--json");
  assert.equal(none.code, EXIT.not_found);
  assert.equal(clubTime("2026-11-20 18:00", TZ), "2026-11-21T02:00:00.000Z");
  assert.equal(clubTime("2026-07-20 18:00", TZ), "2026-07-21T01:00:00.000Z", "summer time");
  assert.equal(clubTime("2026-11-20T18:00:00Z", TZ), "2026-11-20T18:00:00Z", "a time with its zone is left as it is");
  const people = await c.kumi("people", "Maria", "--json");
  assert.equal(people.code, EXIT.done);
  assert.ok(people.json().data.every((p: any) => /^m\.\.\.@/.test(p.email)));
});

test("front desk is refused what only a manager may do; a member gets no staff reads", async () => {
  const desk = await signedIn(DESK);
  const r = await desk.kumi("location", "create", "--name", "Desk's", "--time-zone", TZ, "--json");
  assert.equal(r.code, EXIT.refused, r.text);
  assert.equal(r.json().code, "cli.not_offered");
  const member = await signedIn(MEMBER);
  const p = await member.kumi("people", "--json");
  assert.equal(p.code, EXIT.refused);
  const named = await member.kumi("court", "update", "--court", "Court 1", "--name", "X", "--json");
  assert.equal(named.code, EXIT.usage, "names are looked up for staff; a member gives ids");
});

test("what's only done in the app is refused before anything, pointing to the app", async () => {
  const c = computer();   // not even signed in
  for (const argv of [["waiver", "accept"], ["do", "waiver.accept"], ["family-card", "start"], ["booking", "record-payment"]]) {
    const r = await c.kumi(...argv, "--json");
    assert.equal(r.code, EXIT.app_only, `${argv.join(" ")}: ${r.text}`);
    assert.match(r.json().message, /only ever done in the club's app/);
  }
  const unknown = await c.kumi("frobnicate", "--json");
  assert.equal(unknown.code, EXIT.usage);
  const bad = await c.kumi("program", "create", "--kind", "clinik", "--json");
  assert.equal(bad.code, EXIT.usage);
  assert.equal(bad.json().code, "cli.flag_one_of");
  const es = await c.kumi("program", "create", "--lang=es", "--json");
  assert.match(es.json().message, /necesita --location/);
});

test("the weekly spending limit counts what the command line books, as it does an assistant's", async () => {
  const c = await signedIn(MEMBER, "0");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + 2 * 864e5));
  const r = await c.kumi("booking", "request", "--court", court, "--starts-at", `${day} 10:00`, "--minutes", "90", "--pay", "whole", "--person", "me", "--json");
  assert.equal(r.code, EXIT.refused, r.text);
  assert.equal(r.json().code, "error.assistant_over_cap");
  assert.match(r.json().message, /This costs \$60\.00, and kumi \(test-laptop\) has \$0\.00 left/);
  const rich = await signedIn(MEMBER, "10000");
  const ok = await rich.kumi("booking", "request", "--court", court, "--starts-at", `${day} 10:00`, "--minutes", "90", "--pay", "whole", "--person", "me", "--json");
  assert.equal(ok.code, EXIT.preview, ok.text);
});

test("two commands at once share one refresh of the sign-in; logout ends the connection at the club", async () => {
  const c = await signedIn(OWNER);
  const e = c.store.pick(BASE)!, tok = c.store.tokens(e)!;
  c.store.setTokens(e, { ...tok, expires_at: Date.now() - 1000 });   // the access token ran out
  const [a, b, d] = await Promise.all([c.kumi("whoami", "--json"), c.kumi("whoami", "--json"), c.kumi("locations", "--json")]);
  assert.deepEqual([a.code, b.code, d.code], [EXIT.done, EXIT.done, EXIT.done], [a.text, b.text, d.text].join("\n"));
  const grantId = a.json().data.connection.id;
  const revoked = await db.selectFrom("oauth_token").select("revoked_at").where("grant_id", "=", grantId).where("revoked_at", "is not", null).execute();
  assert.equal(revoked.length, 0, "no refresh token was used twice");
  const out = await c.kumi("logout", "--json");
  assert.equal(out.code, EXIT.done);
  assert.equal(out.json().ended_at_club, true);
  assert.ok((await db.selectFrom("oauth_grant").select("revoked_at").where("id", "=", grantId).executeTakeFirstOrThrow()).revoked_at);
  const after = await c.kumi("whoami", "--json");
  assert.equal(after.code, EXIT.signed_out);
});
