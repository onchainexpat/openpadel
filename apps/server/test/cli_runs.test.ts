// What the command line does when a change, or a --key, is asked again (cli_remote.ts run(), runs.json in
// cli_store.ts), whose previews it keeps, and where it agrees to sign in (from the independent review of 012eb4e,
// its findings 2, 5, 6 and 7, and what it suspected about opening the browser and the sign-in addresses).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { apply, plan, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { browserCommand, clubsOwn, remoteMain, EXIT, type RemoteDeps } from "../src/cli_remote.ts";
import { Store } from "../src/cli_store.ts";

const BASE = "https://club.example.test", TZ = "America/Los_Angeles", OWNER = "robin@example.test", DESK = "dana@example.test";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court = "", danaId = "", ann = "", tag = "";
const mailer = new MemoryMailer(), dirs: string[] = [], sessions = new Map<string, string>();
const req = (path: string, init: RequestInit = {}) => app.request(path.startsWith("http") ? path : `${BASE}${path}`, init);
const form = (o: Record<string, string>, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(o).toString() });

async function signInAt(link: string, email: string): Promise<string> {
  const kept = sessions.get(email);
  if (kept) return kept;
  await req("/oauth/sign-in", form({ back: link, email }));
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const cookie = (await req("/oauth/sign-in", form({ back: link, email, code }))).headers.get("set-cookie")!.split(";")[0]!;
  sessions.set(email, cookie);
  return cookie;
}
async function allowDevice(link: string, typed: string, email: string) {
  const cookie = await signInAt(link, email);
  const page = await (await req("/oauth/device", form({ code: typed }, cookie))).text();
  const code = page.match(/name="code" value="([^"]+)"/)![1]!, id = page.match(/name="req" value="([^"]+)"/)![1]!;
  await req("/oauth/device/decide", form({ code, req: id, decision: "allow", cap: "0" }, cookie));
}
/** One computer (one config folder); `as(email)` signs it in to the club as that person, by the device code. */
function computer() {
  const dir = mkdtempSync(join(tmpdir(), "kumi-runs-")); dirs.push(dir);
  const store = new Store(dir, false), seen: { url: string; signal: boolean }[] = [];
  const kumi = async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const deps: RemoteDeps = { fetch: async (u, init) => { seen.push({ url: String(u), signal: Boolean((init as RequestInit | undefined)?.signal) }); return req(String(u), init as RequestInit); },
      store, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {}, now: () => Date.now(), hostname: "desk-pc", env: {}, openBrowser: null };
    const code = await remoteMain(argv, deps);
    return { code, text: [...out, ...err].join("\n"), json: () => JSON.parse(out.filter((l) => l.startsWith("{")).at(-1)!) };
  };
  const as = async (email: string) => {
    const start = await kumi("login", BASE, "--device", "--no-wait", "--json");
    await allowDevice(start.json().link, start.json().code, email);
    const done = await kumi("login", BASE, "--device", "--json");
    assert.equal(done.code, EXIT.done, done.text);
  };
  return { kumi, as, store, seen };
}
const courtName = async () => (await db.selectFrom("court").select("name").where("id", "=", court).executeTakeFirstOrThrow()).name;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: OWNER, owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  danaId = ((await run(db, "person.create", { display_name: "Dana Desk", email: DESK }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: danaId, role: "front_desk" }, owner);
  ann = ((await run(db, "person.create", { display_name: "Ann Lee", email: "ann@example.test" }, owner)).result as any).person_id;
  tag = ((await run(db, "tag.create", { name: "Juniors coach" }, owner)).result as any).tag_id;
  app = makeApp({ db, mailer, publicUrl: BASE, secureCookies: false });
});
after(async () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); await drop(); });

test("a retry straight after comes back done once; the same change asked again after a different one is made", async () => {
  const c = computer(); await c.as(OWNER);
  assert.equal((await c.kumi("court", "update", "--court", court, "--name", "Centre", "--yes", "--json")).code, EXIT.done);
  const retry = await c.kumi("court", "update", "--court", court, "--name", "Centre", "--yes", "--json");
  assert.equal(retry.code, EXIT.done);
  assert.equal(retry.json().already, true, "a lost answer asked for again: done, not made twice");
  assert.equal((await c.kumi("court", "update", "--court", court, "--name", "Court 1", "--yes", "--json")).code, EXIT.done);
  assert.equal(await courtName(), "Court 1");
  // "Centre" again, after "Court 1": a new change to the same court, made.
  const again = await c.kumi("court", "update", "--court", court, "--name", "Centre", "--yes", "--json");
  assert.equal(again.code, EXIT.done, again.text);
  assert.notEqual(again.json().already, true);
  assert.equal(await courtName(), "Centre");
  await run(db, "court.update", { court_id: court, name: "Court 1" }, owner);
});

test("the change in between made in the staff app, not here: the same command again is made, not 'already done'", async () => {
  const c = computer(); await c.as(OWNER);
  assert.equal((await c.kumi("court", "update", "--court", court, "--name", "Centre", "--yes", "--json")).code, EXIT.done);
  await run(db, "court.update", { court_id: court, name: "Court 1" }, owner);   // the desk renames it back, in the app
  const again = await c.kumi("court", "update", "--court", court, "--name", "Centre", "--yes", "--json");
  assert.equal(again.code, EXIT.done, again.text);
  assert.notEqual(again.json().already, true);
  assert.equal(await courtName(), "Centre");
  await run(db, "court.update", { court_id: court, name: "Court 1" }, owner);
});

test("the change in between is another command (untag): tagging again is made", async () => {
  const tagged = async () => Boolean(await db.selectFrom("person_tag").select("id").where("person_id", "=", ann).where("tag_id", "=", tag).where("removed_at", "is", null).executeTakeFirst());
  const c = computer(); await c.as(OWNER);
  assert.equal((await c.kumi("person", "tag", "--person", ann, "--tag-id", tag, "--yes", "--json")).code, EXIT.done);
  assert.equal((await c.kumi("person", "untag", "--person", ann, "--tag-id", tag, "--yes", "--json")).code, EXIT.done);
  assert.equal(await tagged(), false);
  const again = await c.kumi("person", "tag", "--person", ann, "--tag-id", tag, "--yes", "--json");
  assert.equal(again.code, EXIT.done, again.text);
  assert.equal(await tagged(), true);
});

test("a --key is kept for its day, however many other previews come after", async () => {
  const c = computer(); await c.as(OWNER);
  const first = await c.kumi("court", "update", "--court", court, "--name", "West", "--key", "nightly-rename", "--yes", "--json");
  assert.equal(first.code, EXIT.done, first.text);
  for (let n = 0; n < 205; n++) await c.kumi("location", "create", "--name", `L${n}`, "--time-zone", TZ, "--json");   // previews only
  await run(db, "court.update", { court_id: court, name: "Court 1" }, owner);
  const retry = await c.kumi("court", "update", "--court", court, "--name", "West", "--key", "nightly-rename", "--yes", "--json");
  assert.equal(retry.code, EXIT.done, retry.text);
  assert.equal(retry.json().already, true, "the same --key the same day: the same change, not a second one");
  assert.equal(c.store.runs().filter((r) => !r.key.startsWith("key:")).length, 200, "200 kept of the others");
});

test("a confirm refused (the person may no longer do it) forgets its preview, as a conflict does", async () => {
  const c = computer(); await c.as(DESK);
  const p = await c.kumi("person", "create", "--display-name", "Yan Walk-in", "--email", "yan@example.test", "--json");
  assert.equal(p.code, EXIT.preview, p.text);
  await run(db, "role.remove", { person_id: danaId, role: "front_desk" }, owner);
  try {
    const y = await c.kumi("person", "create", "--display-name", "Yan Walk-in", "--email", "yan@example.test", "--yes", "--json");
    assert.equal(y.code, EXIT.refused, y.text);
    assert.equal(c.store.runs().some((r) => r.run_id === p.json().run_id), false, "the refused preview isn't kept to confirm again");
  } finally { await run(db, "role.assign", { person_id: danaId, role: "front_desk" }, owner); }
});

test("a --key used again for a different change is refused, and nothing is made", async () => {
  const c = computer(); await c.as(OWNER);
  const p = await c.kumi("court", "update", "--court", court, "--name", "North", "--key", "rename-court", "--json");
  assert.equal(p.code, EXIT.preview);
  const y = await c.kumi("court", "update", "--court", court, "--name", "South", "--key", "rename-court", "--yes", "--json");
  assert.equal(y.code, EXIT.conflict, y.text);
  assert.equal(y.json().code, "cli.key_reused");
  assert.equal(await courtName(), "Court 1", "neither North nor South");
  const same = await c.kumi("court", "update", "--court", court, "--name", "North", "--key", "rename-court", "--yes", "--json");
  assert.equal(same.code, EXIT.done, "the same input under its key: the preview it made is done");
  assert.equal(await courtName(), "North");
  await run(db, "court.update", { court_id: court, name: "Court 1" }, owner);
});

test("after a conflict, the same command again with --yes previews afresh and does it", async () => {
  const c = computer(); await c.as(OWNER);
  assert.equal((await c.kumi("court", "update", "--court", court, "--name", "East", "--json")).code, EXIT.preview);
  await run(db, "court.update", { court_id: court, sort: 7 }, owner);   // someone changes the court meanwhile
  const first = await c.kumi("court", "update", "--court", court, "--name", "East", "--yes", "--json");
  assert.equal(first.code, EXIT.conflict, first.text);
  const second = await c.kumi("court", "update", "--court", court, "--name", "East", "--yes", "--json");
  assert.equal(second.code, EXIT.done, second.text);
  assert.equal(await courtName(), "East");
  await run(db, "court.update", { court_id: court, name: "Court 1" }, owner);
});

test("previews are kept per person: after someone else signs in on the same computer, their --yes is their own", async () => {
  const c = computer(); await c.as(DESK);
  const p = await c.kumi("person", "create", "--display-name", "Zed Walk-in", "--email", "zed@example.test", "--json");
  assert.equal(p.code, EXIT.preview, p.text);
  await c.as(OWNER);   // the owner signs in at the desk computer, without Dana logging out
  assert.equal(c.store.runs().filter((r) => r.club === BASE).length, 0, "Dana's preview isn't kept for the owner");
  const y = await c.kumi("person", "create", "--display-name", "Zed Walk-in", "--email", "zed@example.test", "--yes", "--json");
  assert.equal(y.code, EXIT.done, y.text);
  const runEntry = c.store.runs().find((r) => r.club === BASE)!;
  assert.equal(runEntry.person, owner.personId, "kept as the owner's");
  assert.ok(runEntry.connection, "with the owner's connection");
  assert.equal(await c.kumi("confirm", p.json().run_id, "--json").then((r) => r.code), EXIT.not_found, "Dana's run id isn't confirmable as the owner here");
});

test("an earlier result is given again only to whoever made the change", async () => {
  const p = await plan(db, "court.update", { court_id: court, sort: 3 }, owner);
  await apply(db, p.runId, owner, { idempotencyKey: `mcp:${p.runId}` });
  const dana: Actor = { personId: danaId, via: "test", lang: "en" };
  await assert.rejects(apply(db, p.runId, dana, { idempotencyKey: `mcp:${p.runId}` }), (e: any) => e.code === "error.plan_not_yours");
  assert.equal(await apply(db, p.runId, owner, { idempotencyKey: `mcp:${p.runId}` }), null, "the owner's own retry: the same answer");
});

test("sign-in requests carry a time limit (shorter than the refresh lock's takeover), and the browser opens without a shell", async () => {
  const c = computer(); await c.as(OWNER);
  const posts = c.seen.filter((s) => s.url.includes("/oauth/token") || s.url.includes("/oauth/device_authorization"));
  assert.ok(posts.length && posts.every((s) => s.signal), "every sign-in request has its time limit");
  assert.deepEqual(browserCommand("win32", "https://club.example.test/oauth/authorize?a=1&b=2"), ["rundll32", ["url.dll,FileProtocolHandler", "https://club.example.test/oauth/authorize?a=1&b=2"]]);
  assert.deepEqual(browserCommand("linux", "https://x.example.test/a"), ["xdg-open", ["https://x.example.test/a"]]);
  assert.equal(browserCommand("win32", "file:///C:/Windows/system32/calc.exe"), null, "only a web page");
  assert.equal(browserCommand("win32", "https://x.example.test/\" & calc"), null);
});

test("the command line signs in only at the club's own addresses", () => {
  const as = (o: string) => ({ authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`, device_authorization_endpoint: `${o}/oauth/device_authorization` });
  assert.equal(clubsOwn("https://app.club.example", "https://staff.app.club.example", "https://app.club.example/mcp", as("https://staff.app.club.example")), null, "the members' app and its staff app");
  assert.equal(clubsOwn("https://club.example.test", "https://club.example.test", "https://club.example.test/mcp", as("https://club.example.test")), null);
  assert.equal(clubsOwn("http://localhost:8790", "http://localhost:8790", "http://localhost:8790/mcp", as("http://localhost:8790")), null, "http on this computer");
  assert.equal(clubsOwn("https://club.example.test", "https://evil.example.org", "https://club.example.test/mcp", as("https://evil.example.org")), "https://evil.example.org");
  assert.equal(clubsOwn("https://club.example.test", "http://club.example.test", "https://club.example.test/mcp", as("http://club.example.test")), "http://club.example.test", "never plain http elsewhere");
  assert.equal(clubsOwn("https://club.example.test", "https://club.example.test", "https://club.example.test/mcp", { ...as("https://club.example.test"), authorization_endpoint: "https://evil.example.org/a" }), "https://evil.example.org/a");
});
