import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { exportData, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, tagId: string;
const TZ = "America/Los_Angeles";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const req = async (path: string, who: string | null, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { ...(who ? { cookie: cookies[who]! } : {}), "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};
async function act(who: string, action: string, input: unknown) {
  const p = await req(`/actions/${action}/plan`, who, input);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const a = await req(`/runs/${p.json.run_id}/apply`, who, {});
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { summary: p.json.summary as string, result: a.json.result };
}
async function signIn(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[name] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  for (const name of ["Ann", "Ben", "Kim", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test`, ...(name === "Ben" ? { locale: "es" } : {}) }, owner)).result as any).person_id;
    await signIn(name);
  }
  await db.updateTable("person").set({ phone: "+15035550142" }).where("id", "=", people.Ben!).execute();
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner);
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
});
after(async () => drop());

test("front desk tags members; the people list searches by phone and narrows by tag or saved group", async () => {
  assert.equal((await req("/staff/broadcast-options", "Kim")).status, 403);   // coaches don't write to members
  assert.equal((await req("/staff/broadcast-options", "Ann")).status, 403);
  tagId = (await act("Fay", "tag.create", { name: "league A" })).result.tag_id;
  await act("Fay", "person.tag", { person_id: people.Ann, tag_id: tagId });
  const byPhone = await req("/staff/people?q=(503)%20555-0142", "Fay");
  assert.deepEqual(byPhone.json.map((r: any) => r.display_name), ["Ben"]);
  const tagged = await req(`/staff/people?tag_id=${tagId}`, "Fay");
  assert.deepEqual(tagged.json.map((r: any) => [r.display_name, r.tags]), [["Ann", ["league A"]]]);
  const seg = (await act("Fay", "segment.save", { name: "League", filters: { tag_ids: [tagId] } })).result.segment_id;
  assert.deepEqual((await req(`/staff/people?segment_id=${seg}`, "Fay")).json.map((r: any) => r.display_name), ["Ann"]);
  const page = await req(`/staff/people/${people.Ann}`, "Fay");
  assert.deepEqual(page.json.tags, [{ id: tagId, name: "league A" }]);
  const segs = await req("/staff/segments", "Ben");
  assert.equal(segs.status, 403);
  assert.deepEqual((await req("/staff/segments", "Fay")).json.map((s: any) => [s.name, s.what, s.people]), [["League", "tagged league A", 1]]);
});

test("the live count: who a group means, who it would reach, and who's left out", async () => {
  await act("Ann", "consent.club_news", { person_id: people.Ann, granted: true });
  assert.deepEqual((await req("/my/club-news", "Ann")).json, { granted: true });
  assert.deepEqual((await req("/my/club-news", "Ben")).json, { granted: null });
  const c = await req("/staff/segments/count", "Fay", { filters: {}, purpose: "club_news" });
  assert.equal(c.status, 200);
  assert.equal(c.json.recipients, 1);
  assert.equal(c.json.left_out, c.json.matched - 1);
  assert.equal(c.json.what, "everyone at the club");
  assert.deepEqual(c.json.sample, ["Ann"]);   // a message's "for example" names only people it reaches
  assert.ok((await req("/staff/segments/count", "Fay", { filters: {} })).json.sample.length > 1);   // a group on its own: who's in it
  const es = await req("/staff/segments/count", "Fay", { filters: { lang: "es" } }, { "accept-language": "es" });
  assert.equal(es.json.matched, 1);
  assert.equal((await req("/staff/segments/count", "Fay", { filters: { level_min: 9 } })).status, 400);
});

test("a message to a group: the preview, the list with what came of it, and the sender's copy", async () => {
  const r = await act("Fay", "broadcast.send", { purpose: "club_news", segment_id: (await req("/staff/segments", "Fay")).json[0].id,
    subject_en: "League night", body_en: "Hi {first_name}, league night is Thursday.", subject_es: "Noche de liga", body_es: "Hola {first_name}, la noche de liga es el jueves." });
  assert.match(r.summary, /^Send "League night" as club news to 1 person: "League" \(tagged league A\)\./);
  const list = await req("/staff/broadcasts", "Fay");
  assert.equal(list.json.length, 1);
  assert.deepEqual([list.json[0].subject, list.json[0].status, list.json[0].recipients, list.json[0].group, list.json[0].sender], ["League night", "sent", 1, "League", "Fay"]);
  assert.equal(list.json[0].counts.inbox.sent, 1);
  const inbox = await req("/my/inbox", "Ann");
  assert.equal(inbox.json.messages[0].subject, "League night");
  assert.equal(inbox.json.messages[0].body, "Hi Ann, league night is Thursday.");
  const copy = await req("/my/inbox", "Fay");
  assert.equal(copy.json.messages[0].subject, "Copy: League night");
});

test("the unsubscribe link: opening it changes nothing; the button (or a mail app's one-click) stops club news, no sign-in", async () => {
  const token = (await db.selectFrom("person").select("news_token").where("id", "=", people.Ann!).executeTakeFirstOrThrow()).news_token;
  const page = await req(`/unsubscribe/${token}`, null);
  assert.equal(page.status, 200);
  assert.match(page.text, /Stop getting club news from Kestrel Padel by email\?/);
  assert.match(page.text, /<form method="post">/);
  assert.deepEqual((await req("/my/club-news", "Ann")).json, { granted: true });
  // A mail app posts from nowhere in particular, as a form: allowed here, and only here.
  const r = await app.request(`/unsubscribe/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /You won&#39;t get club news from Kestrel Padel by email any more/);
  assert.deepEqual((await req("/my/club-news", "Ann")).json, { granted: false });
  assert.match((await req(`/unsubscribe/${token}`, null)).text, /You&#39;re not getting club news from Kestrel Padel by email\./);
  assert.equal((await req("/unsubscribe/not-a-real-token-at-all-0000", null)).status, 404);
  // Everywhere else, a cross-site form post is still refused.
  const other = await app.request("/actions/tag.create/plan", { method: "POST", headers: { cookie: cookies.Fay!, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, body: "name=x" });
  assert.equal(other.status, 403);
  // Back on from the app.
  await act("Ann", "consent.club_news", { person_id: people.Ann, granted: true });
  assert.deepEqual((await req("/my/club-news", "Ann")).json, { granted: true });
});

test("a Spanish reader's page is in Spanish", async () => {
  await act("Ben", "consent.club_news", { person_id: people.Ben, granted: true });
  const token = (await db.selectFrom("person").select("news_token").where("id", "=", people.Ben!).executeTakeFirstOrThrow()).news_token;
  assert.match((await req(`/unsubscribe/${token}`, null)).text, /¿Dejar de recibir por email las novedades de Kestrel Padel\?/);
});

test("export lists a member's tags; deleting the account takes them off and kills the old unsubscribe link", async () => {
  const file = await exportData(db, people.Ann!, new Date(), "en");
  assert.deepEqual((file as any).tags.map((x: any) => x.tag), ["league A"]);
  const staff = await exportData(db, people.Fay!, new Date(), "en");
  assert.deepEqual((staff as any).made_for_the_club.groups.map((g: any) => g.name), ["League"]);
  assert.equal((staff as any).made_for_the_club.messages_to_members[0].subject, "League night");
  const old = (await db.selectFrom("person").select("news_token").where("id", "=", people.Ann!).executeTakeFirstOrThrow()).news_token;
  await run(db, "privacy.erase", { person_id: people.Ann }, { ...owner, auth: "passkey" });
  assert.equal((await req(`/unsubscribe/${old}`, null)).status, 404);
  assert.equal((await db.selectFrom("person_tag").select("id").where("person_id", "=", people.Ann!).where("removed_at", "is", null).execute()).length, 0);
});
