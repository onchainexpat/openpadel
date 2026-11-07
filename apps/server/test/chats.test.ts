// Players' chats over the API (chats.ts): a player posts and the others read and see it unread; someone outside the
// game gets nothing; the staff's view is front desk and up only (not a coach on their own, not a member, not support
// access); and an assistant reads chats but has no way to post or report.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { base32Decode, checkPayment, openPayment, run, runAsSystem, setPaymentProvider, totp, uuidv7, TestProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, booking: string;
const mailer = new MemoryMailer(), stripe = new TestProvider();
const TZ = "America/Los_Angeles";
const people: Record<string, string> = {};
const cookies = new Map<string, string>();
async function signIn(email: string) {
  if (cookies.has(email)) return cookies.get(email)!;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  cookies.set(email, r.headers.get("set-cookie")!.split(";")[0]!);
  return cookies.get(email)!;
}
/** Signed in with both steps (support access always needs two): the emailed code, then an authenticator set up now. */
async function twoStep(email: string) {
  const cookie = await signIn(email);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const s = await (await post("/auth/totp/setup", {})).json() as { key: string; challenge_id: string };
  const c = await post("/auth/totp/confirm", { challenge_id: s.challenge_id, code: totp(base32Decode(s.key.replaceAll(" ", "")), new Date()) });
  assert.equal(c.status, 200, await c.text());
  return cookie;
}
async function call(name: string, path: string, body?: unknown) {
  const cookie = await signIn(`${name.toLowerCase()}@example.test`);
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  for (const name of ["Hal", "Ann", "Out", "Fay", "Cole", "Sue"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
  await run(db, "role.assign", { person_id: people.Cole, role: "coach" }, owner);
  // Sue is someone the owner let in to help, at manager level, with no role of her own.
  const now = new Date();
  await db.insertInto("support_grant").values({ id: uuidv7(), person_id: people.Sue!, name: "Sue", email: "sue@example.test", reason: "helping", level: "manager",
    starts_at: new Date(now.getTime() - 60_000), ends_at: new Date(now.getTime() + 86400_000) }).execute();
  const starts = new Date(now.getTime() + 2 * 86400_000);
  starts.setUTCMinutes(0, 0, 0); starts.setUTCHours(18);
  const r = await run(db, "booking.request", { court_id: court, starts_at: starts.toISOString(), minutes: 60, pay: "whole", person_id: people.Hal }, { personId: people.Hal!, via: "test", lang: "en" });
  booking = (r.result as any).booking_id;
  await openPayment(db, (r.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (r.result as any).payment_id, "test");
  const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", booking).executeTakeFirstOrThrow()).invite_code!;
  await run(db, "booking.join_players", { invite_code: code, person_id: people.Ann }, { personId: people.Ann!, via: "test", lang: "en" });
});
after(async () => drop());

test("a player posts; another reads it, sees it unread, and reads it; someone outside the game gets nothing", async () => {
  assert.equal((await call("Hal", "/club")).json.players_chat, true);
  const p = await call("Hal", `/my/chats/booking/${booking}`, { body: "See you Wednesday" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await call("Ann", "/my/chats/unread")).json.unread, 1);
  const list = await call("Ann", "/my/chats");
  assert.deepEqual(list.json.chats.map((c: any) => [c.kind, c.id, c.unread]), [["booking", booking, 1]]);
  const th = await call("Ann", `/my/chats/booking/${booking}`);
  assert.deepEqual(th.json.messages.map((m: any) => [m.author, m.body]), [["Hal", "See you Wednesday"]]);
  assert.equal((await call("Ann", "/my/chats/unread")).json.unread, 1, "reading through the API alone doesn't mark it read");
  await call("Ann", `/my/chats/booking/${booking}/seen`, {});
  assert.equal((await call("Ann", "/my/chats/unread")).json.unread, 0);
  assert.equal((await call("Out", `/my/chats/booking/${booking}`)).status, 404);
  assert.equal((await call("Out", `/my/chats/booking/${booking}`, { body: "hi" })).status, 404);
  assert.equal((await call("Out", "/my/chats/nonsense/abc")).status, 404);
  // Changing and taking back one's own.
  const mid = th.json.messages[0].id;
  assert.equal((await call("Ann", `/my/chats/messages/${mid}/remove`, {})).status, 404, "only its author");
  assert.equal((await call("Hal", `/my/chats/messages/${mid}/edit`, { body: "See you Wednesday at 6" })).status, 200);
  assert.equal((await call("Hal", `/my/chats/messages/${mid}/remove`, {})).status, 200);
  assert.equal((await call("Ann", `/my/chats/booking/${booking}`)).json.messages[0].state, "removed");
});

test("the staff's view: front desk and up; not a coach on their own, a member or support access", async () => {
  await call("Ann", `/my/chats/booking/${booking}`, { body: "Bring water" });
  const desk = await call("Fay", "/staff/chats");
  assert.equal(desk.status, 200);
  assert.equal(desk.json.length, 1);
  const one = await call("Fay", `/staff/chats/${desk.json[0].id}`);
  assert.equal(one.status, 200);
  assert.ok(one.json.messages.some((m: any) => m.body === "Bring water"));
  // Sue with both steps done, so the no below is seesChats's, not the second step's.
  await twoStep("sue@example.test");
  assert.equal((await call("Sue", "/staff/people")).status, 200, "Sue is signed in with both steps: the staff screens open");
  for (const name of ["Cole", "Ann", "Sue"]) assert.equal((await call(name, "/staff/chats")).status, 403, name);
  const sue = await call("Sue", `/staff/chats/${desk.json[0].id}`);
  assert.deepEqual([sue.status, sue.json.error], [403, "error.staff_only"]);
  // Support access never moderates players' chats.
  const plan = await call("Sue", "/actions/chat.hide/plan", { message_id: one.json.messages.at(-1).id, hidden: true });
  assert.equal(plan.status, 403);
});

// The 0.3.0 security review: support access read who reported whom, and who was stopped posting, in Changes.
test("Changes leaves chat moderation out for anyone who can't read chats (support access on its own)", async () => {
  const fay = await call("Fay", "/staff/chats"), one = await call("Fay", `/staff/chats/${fay.json[0].id}`);
  const p = await call("Fay", "/actions/chat.hide/plan", { message_id: one.json.messages.at(-1).id, hidden: true });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await call("Fay", `/runs/${p.json.run_id}/apply`, {})).status, 200);
  const theirs = await call("Robin", "/staff/changes");
  assert.equal(theirs.status, 200, JSON.stringify(theirs.json));
  assert.ok(theirs.json.some((r: any) => r.action === "chat.hide"), "the owner, who reads chats, sees it");
  const sue = await call("Sue", "/staff/changes");
  assert.equal(sue.status, 200);
  assert.ok(sue.json.length > 0, "Sue still reads the club's other changes");
  assert.ok(sue.json.every((r: any) => !String(r.action).startsWith("chat.")), JSON.stringify(sue.json.map((r: any) => r.action)));
});
