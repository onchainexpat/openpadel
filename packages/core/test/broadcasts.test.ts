import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { audience, clubNewsAnswer, plan, run, runAsSystem, segmentMembers, sendBroadcasts, sendEmails, unsubscribe, uuidv7, KumiError, type Actor, type Db, type Mail } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, monthly: string, drills: string, leagueA: string, mia: string, kai: string;
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-30T17:00:00Z");          // Mon 9:00 AM in the club
const NIGHT = new Date("2026-12-01T06:00:00Z");        // Mon 10:00 PM: quiet hours
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const names = (rows: { display_name: string }[]) => rows.map((r) => r.display_name).filter((n) => n !== "Robin Hale").sort();
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const rows = (broadcastId: string, channel?: string) => db.selectFrom("outbound_message").selectAll().where("broadcast_id", "=", broadcastId).where("kind", "=", "broadcast")
  .$if(Boolean(channel), (q) => q.where("channel", "=", channel as "email")).orderBy("person_id").execute();
const whose = (id: string) => Object.entries(people).find(([, v]) => v === id)?.[0] ?? (id === mia ? "Mia" : id === kai ? "Kai" : id);

before(async () => {
  ({ db, drop } = await freshDb());
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  for (const [name, locale] of [["Ann", "en"], ["Ben", "es"], ["Cat", "en"], ["Dan", "en"], ["Pat", "en"], ["Sue", "en"]] as const)
    people[name] = ((await run(db, "person.create", { display_name: `${name} ${name === "Ann" ? "Avery" : "Smith"}`, email: `${name.toLowerCase()}@example.test`, locale }, owner, opts)).result as any).person_id;
  // Club news: Ann, Ben, Pat and Sue said yes; Dan said yes, then no; Cat was never asked.
  for (const n of ["Ann", "Ben", "Dan", "Pat", "Sue"]) await run(db, "consent.club_news", { person_id: people[n], granted: true }, as(n), opts);
  await run(db, "consent.club_news", { person_id: people.Dan, granted: false }, as("Dan"), opts);
  monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, opts)).result as any).plan_id;
  for (const n of ["Ann", "Cat"]) await run(db, "membership.grant", { person_id: people[n], plan_id: monthly }, owner, opts);
  await run(db, "level.set", { person_id: people.Ann, level: 3.5, reason: "Starting level" }, owner, opts);
  await run(db, "level.set", { person_id: people.Ben, level: 2.5, reason: "Starting level" }, owner, opts);
  leagueA = ((await run(db, "tag.create", { name: "league A" }, owner, opts)).result as any).tag_id;
  await run(db, "person.tag", { person_id: people.Ann, tag_id: leagueA }, owner, opts);
  // Pat's family: Mia (no login) and Kai (a login of their own).
  mia = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2016 }, as("Pat"), opts)).result as any).person_id;
  kai = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Kai", birth_year: 2012 }, as("Pat"), opts)).result as any).person_id;
  await run(db, "kid.give_login", { person_id: kai, email: "kai@example.test" }, as("Pat"), opts);
  // Sue joined early in the year.
  await db.updateTable("person").set({ created_at: new Date("2026-01-15T20:00:00Z") }).where("id", "=", people.Sue!).execute();
  // A clinic tomorrow at 10 AM: Ben, Cat, Mia and Kai are in it.
  drills = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Drills", capacity: 8, price_cents: 0 }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: drills, starts_at: "2026-12-01T18:00:00Z", ends_at: "2026-12-01T19:00:00Z", court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: drills }, owner, opts);
  for (const n of ["Ben", "Cat"]) await run(db, "enrolment.join", { program_id: drills, person_id: people[n] }, as(n), opts);
  for (const j of [mia, kai]) await run(db, "enrolment.join", { program_id: drills, person_id: j }, as("Pat"), opts);
  // Ann played a clinic ten days ago.
  const old = uuidv7(), date = uuidv7();
  await db.insertInto("program").values({ id: old, location_id: loc, kind: "clinic", name: "Old clinic", capacity: 8, price_cents: 0, status: "published" } as any).execute();
  await db.insertInto("session").values({ id: date, program_id: old, starts_at: new Date("2026-11-20T18:00:00Z"), ends_at: new Date("2026-11-20T19:00:00Z") } as any).execute();
  await db.insertInto("enrolment").values({ id: uuidv7(), program_id: old, session_id: date, person_id: people.Ann!, status: "attended" } as any).execute();
});
after(async () => drop());

test("a group's filters: each narrows who's in it, whoever matches now", async () => {
  const m = (f: object) => segmentMembers(db, f, NOW).then(names);
  assert.deepEqual(await m({ membership: "member" }), ["Ann Avery", "Cat Smith"]);
  assert.deepEqual(await m({ plan_ids: [monthly] }), ["Ann Avery", "Cat Smith"]);
  assert.ok(!(await m({ membership: "not_member" })).includes("Ann Avery"));
  assert.deepEqual(await m({ level_min: 3 }), ["Ann Avery"]);
  assert.deepEqual(await m({ level_max: 3 }), ["Ben Smith"]);
  assert.deepEqual(await m({ tag_ids: [leagueA] }), ["Ann Avery"]);
  assert.deepEqual(await m({ played_within_days: 30 }), ["Ann Avery"]);
  assert.ok(!(await m({ not_played_days: 30 })).includes("Ann Avery"));
  assert.deepEqual(await m({ age: "junior" }), ["Kai", "Mia"]);
  assert.ok(!(await m({ age: "adult" })).includes("Mia"));
  assert.deepEqual(await m({ lang: "es" }), ["Ben Smith"]);
  assert.deepEqual(await m({ program_id: drills }), ["Ben Smith", "Cat Smith", "Kai", "Mia"]);
  assert.deepEqual(await m({ on_date: "2026-12-01" }), ["Ben Smith", "Cat Smith", "Kai", "Mia"]);
  assert.deepEqual(await m({ on_date: "2026-12-02" }), []);
  assert.deepEqual(await m({ joined_from: "2026-01-01", joined_to: "2026-01-31" }), ["Sue Smith"]);
  // A paused membership: no longer "members", but "on a pause".
  await db.updateTable("membership").set({ paused_from: new Date("2026-11-01T00:00:00Z"), paused_until: new Date("2026-12-31T00:00:00Z") }).where("person_id", "=", people.Cat!).execute();
  assert.deepEqual(await m({ membership: "paused" }), ["Cat Smith"]);
  assert.deepEqual(await m({ membership: "member" }), ["Ann Avery"]);
  await db.updateTable("membership").set({ paused_from: null, paused_until: null }).where("person_id", "=", people.Cat!).execute();
});

test("club news: only people who said yes; juniors through their parents; a kid with a login hears it themselves", async () => {
  const a = await audience(db, { age: "junior" }, "club_news", NOW);
  assert.equal(a.matched, 2);
  assert.deepEqual(a.recipients.map((r) => [whose(r.person_id), r.juniors]), [["Pat", ["Mia"]]]);
  assert.equal(a.leftOut, 1);                        // Kai: never said yes to club news
  assert.equal(a.viaParents, 1);
  const all = await audience(db, { membership: "member" }, "club_news", NOW);
  assert.deepEqual(all.recipients.map((r) => whose(r.person_id)), ["Ann"]);
  assert.equal(all.leftOut, 1);                      // Cat was never asked
  // Nobody would get it: said plainly, before anything goes.
  await rejects(plan(db, "broadcast.send", { purpose: "club_news", filters: { lang: "en", tag_ids: [], membership: "past_due" }, subject_en: "x", body_en: "y", subject_es: "x", body_es: "y" }, owner, { now: NOW }), "error.broadcast_nobody");
  await rejects(plan(db, "broadcast.send", { purpose: "club_news", filters: { age: "junior", lang: "es" }, subject_en: "x", body_en: "y", subject_es: "x", body_es: "y" }, owner, { now: NOW }), "error.broadcast_nobody");
});

test("a club news message: each person's language and name, the inbox now, email and phones after quiet hours, and a copy for the sender", async () => {
  const words = { subject_en: "Hi {first_name}", body_en: "News from {club}: a social on Friday.", subject_es: "Hola {first_name}", body_es: "Novedades de {club}: un social el viernes." };
  await rejects(plan(db, "broadcast.send", { purpose: "club_news", filters: { level_min: 2 }, ...words, subject_es: null, body_es: null }, owner, { now: NIGHT }), "error.words_need_lang");
  await rejects(plan(db, "broadcast.send", { purpose: "club_news", filters: { level_min: 2 }, ...words, body_en: "Hello {name}" }, owner, { now: NIGHT }), "error.unknown_placeholder");
  const p = await plan(db, "broadcast.send", { purpose: "club_news", filters: { level_min: 2 }, ...words }, owner, { now: NIGHT });
  assert.equal(p.plan.summary.en, "Send \"Hi {first_name}\" as club news to 2 people: level 2.00 and up. It's quiet hours, so the email and phone notifications go out on Tue, Dec 1, 8:00 AM. The copy in the app is there now.");
  const r = await run(db, "broadcast.send", { purpose: "club_news", filters: { level_min: 2 }, ...words }, owner, { now: NIGHT });
  const id = (r.result as any).broadcast_id;
  const inbox = await rows(id, "inbox");
  assert.deepEqual(inbox.map((m) => [whose(m.person_id), m.subject, m.body, m.status, m.purpose]), [
    ["Ann", "Hi Ann", "News from Kestrel Padel: a social on Friday.", "sent", "club_news"],
    ["Ben", "Hola Ben", "Novedades de Kestrel Padel: un social el viernes.", "sent", "club_news"]].sort((x, y) => people[x[0] as string]!.localeCompare(people[y[0] as string]!)));
  for (const m of await rows(id, "email")) assert.equal(m.send_after.toISOString(), "2026-12-01T16:00:00.000Z");   // 8:00 AM, after quiet hours
  const copy = await db.selectFrom("outbound_message").selectAll().where("broadcast_id", "=", id).where("kind", "=", "broadcast_copy").where("channel", "=", "inbox").execute();
  assert.deepEqual(copy.map((c) => [c.person_id, c.subject, c.purpose]), [[owner.personId, "Copy: Hi {first_name}", "staff"]]);
  assert.match(copy[0]!.body, /^Your message went to 2 people \(level 2\.00 and up\), as club news\./);
  const b = await db.selectFrom("broadcast").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([b.status, b.recipients, b.left_out_consent, b.matched], ["sent", 2, 0, 2]);
});

test("a service notice: only about a date or a program, no consent needed, and within a day it ignores quiet hours; parents of a kid with a login get a copy", async () => {
  const words = { subject_en: "Clinic moved", body_en: "Drills is on Court 2 tomorrow.", subject_es: "Cambio de pista", body_es: "Drills es en la pista 2 mañana." };
  await rejects(plan(db, "broadcast.send", { purpose: "service", filters: { membership: "member" }, ...words }, owner, { now: NIGHT }), "error.service_needs_place");
  const p = await plan(db, "broadcast.send", { purpose: "service", filters: { program_id: drills }, ...words }, owner, { now: NIGHT });
  assert.match(p.plan.summary.en, /^Send "Clinic moved" as a service notice to 4 people: in Drills\. 1 junior is reached through their parents\. A service notice needs no yes to club news/);
  assert.match(p.plan.summary.en, /It's about something within 24 hours, so it goes now, even in quiet hours\.$/);
  const id = ((await run(db, "broadcast.send", { purpose: "service", filters: { program_id: drills }, ...words }, owner, { now: NIGHT })).result as any).broadcast_id;
  const inbox = await rows(id, "inbox");
  // Cat never said yes to club news and still hears it; Pat hears once, about both children.
  assert.deepEqual(inbox.map((m) => [whose(m.person_id), m.subject]).sort(), [["Ben", "Cambio de pista"], ["Cat", "Clinic moved"], ["Kai", "Clinic moved"], ["Pat", "Kai and Mia: Clinic moved"]]);
  assert.ok(inbox.every((m) => m.purpose === "account" && m.essential));
  for (const m of await rows(id, "email")) assert.equal(m.send_after.getTime(), NIGHT.getTime());
});

test("email is spread over days under the club's daily cap; what's still to go can be stopped", async () => {
  await run(db, "club.update", { broadcast_daily_cap: 2 }, { ...owner, auth: "system" }, { now: NOW });
  const words = { subject_en: "Open day", body_en: "Come and play.", subject_es: "Jornada abierta", body_es: "Ven a jugar." };
  const later = new Date("2026-12-07T17:00:00Z");     // a week on: nothing else is set for those days
  const p = await plan(db, "broadcast.send", { purpose: "club_news", filters: {}, ...words }, owner, { now: later });
  // Ann, Ben, Pat (also for Mia) and Sue said yes; Robin (the owner) and Cat weren't asked, Dan said no, Kai has no yes.
  assert.match(p.plan.summary.en, /to 4 people: everyone at the club\. 4 people in the group haven't said yes to club news, so they're left out\. 1 junior is reached through their parents\. The 4 emails go out over 2 days, 2 a day \(the club's setting\)/);
  const id = ((await run(db, "broadcast.send", { purpose: "club_news", filters: {}, ...words }, owner, { now: later })).result as any).broadcast_id;
  const sends = (await rows(id, "email")).map((m) => m.send_after.toISOString()).sort();
  assert.deepEqual(sends, [later.toISOString(), later.toISOString(), "2026-12-08T16:00:00.000Z", "2026-12-08T16:00:00.000Z"]);
  // The day already holds two; a second message that day waits for the next free room.
  const p2 = await plan(db, "broadcast.send", { purpose: "club_news", filters: { lang: "es" }, ...words }, owner, { now: later });
  assert.ok(!p2.plan.summary.en.includes("over"), p2.plan.summary.en);
  const id2 = ((await run(db, "broadcast.send", { purpose: "club_news", filters: { lang: "es" }, ...words }, owner, { now: later })).result as any).broadcast_id;
  assert.deepEqual((await rows(id2, "email")).map((m) => m.send_after.toISOString()), ["2026-12-09T16:00:00.000Z"]);
  // Stop the rest of the first: what's waiting is dropped, what went stays.
  await db.updateTable("outbound_message").set({ status: "sent", sent_at: later }).where("broadcast_id", "=", id).where("channel", "=", "email").where("send_after", "=", later).execute();
  const stop = await plan(db, "broadcast.cancel", { broadcast_id: id }, owner, { now: later });
  assert.equal(stop.plan.summary.en, "Stop the 2 emails still to go for \"Open day\". What has already gone stays sent.");
  await run(db, "broadcast.cancel", { broadcast_id: id }, owner, { now: later });
  assert.deepEqual((await rows(id, "email")).map((m) => m.status).sort(), ["dropped", "dropped", "sent", "sent"]);
  assert.equal((await db.selectFrom("broadcast").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status, "stopped");
  await rejects(plan(db, "broadcast.cancel", { broadcast_id: id }, owner, { now: later }), "error.broadcast_gone");
  // A service notice about something within a day isn't held back by the cap: it would come too late.
  const urgent = ((await run(db, "broadcast.send", { purpose: "service", filters: { program_id: drills }, subject_en: "Rain", body_en: "Indoors today.", subject_es: "Lluvia", body_es: "Hoy dentro." }, owner, { now: NIGHT })).result as any).broadcast_id;
  assert.ok((await rows(urgent, "email")).every((m) => m.send_after.getTime() === NIGHT.getTime()));
  assert.equal((await rows(urgent, "email")).length, 4);
  await run(db, "club.update", { broadcast_daily_cap: 80 }, { ...owner, auth: "system" }, { now: NOW });
});

test("scheduled: it goes when its time comes, to whoever matches then, and can be called off before", async () => {
  const words = { subject_en: "League signups", body_en: "Sign up by Friday.", subject_es: "Inscripciones", body_es: "Inscríbete antes del viernes." };
  const at = "2026-12-02T18:00:00.000Z";
  const r = await run(db, "broadcast.send", { purpose: "club_news", filters: { tag_ids: [leagueA] }, ...words, send_at: at }, owner, { now: NOW });
  const id = (r.result as any).broadcast_id;
  assert.equal((r.result as any).scheduled, true);
  assert.equal((await rows(id)).length, 0);
  await run(db, "person.tag", { person_id: people.Ben, tag_id: leagueA }, owner, { now: NOW });   // joins the group before it goes
  assert.deepEqual(await sendBroadcasts(db, new Date("2026-12-02T17:59:00Z")), { sent: 0 });
  assert.deepEqual(await sendBroadcasts(db, new Date(at)), { sent: 1 });
  assert.deepEqual((await rows(id, "inbox")).map((m) => whose(m.person_id)).sort(), ["Ann", "Ben"]);
  assert.deepEqual(await sendBroadcasts(db, new Date("2026-12-02T19:00:00Z")), { sent: 0 });   // once
  const off = ((await run(db, "broadcast.send", { purpose: "club_news", filters: { tag_ids: [leagueA] }, ...words, send_at: at }, owner, { now: NOW })).result as any).broadcast_id;
  const p = await plan(db, "broadcast.cancel", { broadcast_id: off }, owner, { now: NOW });
  assert.equal(p.plan.summary.en, "Call off \"League signups\", set for Wed, Dec 2, 10:00 AM. Nothing has gone yet.");
  await run(db, "broadcast.cancel", { broadcast_id: off }, owner, { now: NOW });
  assert.deepEqual(await sendBroadcasts(db, new Date("2026-12-03T00:00:00Z")), { sent: 0 });
  assert.equal((await rows(off)).length, 0);
});

test("unsubscribe: club news emails carry the link and one-click headers; the link stops club news, and nothing else", async () => {
  const sent: Mail[] = [], mailer = { send: async (m: Mail) => { sent.push(m); } };
  const url = (token: string) => `https://play.kestrel.test/unsubscribe/${token}`;
  await sendEmails(db, mailer, new Date("2026-12-10T00:00:00Z"), 200, { unsubscribeUrl: url });
  const ann = await db.selectFrom("person").select(["email", "news_token"]).where("id", "=", people.Ann!).executeTakeFirstOrThrow();
  const news = sent.find((m) => m.to === ann.email && m.subject === "Hi Ann")!;
  assert.equal(news.headers?.["List-Unsubscribe"], `<${url(ann.news_token)}>`);
  assert.equal(news.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(news.text.endsWith(`You get this because you said yes to club news from Kestrel Padel. To stop it: ${url(ann.news_token)}`), news.text);
  const service = sent.find((m) => m.subject === "Clinic moved")!;
  assert.equal(service.headers, undefined);
  assert.ok(!service.text.includes("unsubscribe"));
  await unsubscribe(db, ann.news_token, "one_click", new Date("2026-12-10T01:00:00Z"));
  assert.equal(await clubNewsAnswer(db, people.Ann!), false);
  const row = await db.selectFrom("channel_consent").select(["source", "granted"]).where("person_id", "=", people.Ann!).orderBy("at", "desc").limit(1).executeTakeFirstOrThrow();
  assert.deepEqual(row, { source: "unsubscribe_link", granted: false });
  assert.equal((await unsubscribe(db, ann.news_token, "page")).already, true);   // a second time changes nothing
  await rejects(unsubscribe(db, "x".repeat(32), "page"), "error.not_found");
  // The next club news leaves Ann out; a service notice still reaches her.
  assert.ok(!(await audience(db, { tag_ids: [leagueA] }, "club_news", NOW)).recipients.some((r) => r.person_id === people.Ann));
  // The key never lands in the change log.
  const logged = await db.selectFrom("entity_change").select("after").where("entity", "=", "person").where("entity_id", "=", people.Ann!).execute();
  assert.ok(logged.every((l) => !JSON.stringify(l.after).includes(ann.news_token)));
});

test("tags, groups and templates: the club's own words, checked", async () => {
  await rejects(plan(db, "tag.create", { name: "League a" }, owner, { now: NOW }), "error.tag_exists");
  await rejects(plan(db, "person.tag", { person_id: people.Ann, tag_id: leagueA }, owner, { now: NOW }), "error.already_tagged");
  const t = await run(db, "person.tag", { person_id: people.Sue, name: "beginner 2025" }, owner, { now: NOW });
  assert.equal(t.plan.summary.en, "Make the tag \"beginner 2025\" and put it on Sue Smith.");
  await run(db, "person.untag", { person_id: people.Ben, tag_id: leagueA }, owner, { now: NOW });
  const g = await run(db, "segment.save", { name: "League", filters: { tag_ids: [leagueA], level_min: 3 } }, owner, { now: NOW });
  assert.equal(g.plan.summary.en, "Save the group \"League\": level 3.00 and up, tagged league A. It means whoever matches when it's used (1 person now).");
  await rejects(plan(db, "segment.update", { segment_id: (g.result as any).segment_id, filters: { level_min: 3, tag_ids: [leagueA] } }, owner, { now: NOW }), "error.nothing_changed");
  const retire = await plan(db, "tag.update", { tag_id: leagueA, active: false }, owner, { now: NOW });
  assert.equal(retire.plan.summary.en, "Stop using the tag \"league A\": it comes off 1 person, and groups that use it no longer match on it.");
  await rejects(plan(db, "template.save", { name: "Hello", subject_en: "Hi {first_name}", body_en: "x" }, owner, { now: NOW }), "error.words_need_lang");
  await rejects(plan(db, "template.save", { name: "Hello", subject_en: "Hi", body_en: null, subject_es: "Hola", body_es: "x" }, owner, { now: NOW }), "error.words_half");
  await run(db, "template.save", { name: "Hello", subject_en: "Hi {first_name}", body_en: "See you at {club}.", subject_es: "Hola {first_name}", body_es: "Nos vemos en {club}." }, owner, { now: NOW });
  // Members can't do any of it; front desk can.
  await rejects(plan(db, "tag.create", { name: "x" }, as("Ann"), { now: NOW }), "error.forbidden_reason");
  await rejects(plan(db, "broadcast.send", { purpose: "club_news", filters: {}, subject_en: "x", body_en: "y", subject_es: "x", body_es: "y" }, as("Ann"), { now: NOW }), "error.forbidden_reason");
  await run(db, "role.assign", { person_id: people.Sue, role: "front_desk" }, owner, { now: NOW });
  await run(db, "tag.create", { name: "Thursday group" }, as("Sue"), { now: NOW });
  // A member says yes or no for themselves only.
  await rejects(plan(db, "consent.club_news", { person_id: people.Ben, granted: false }, as("Cat"), { now: NOW }), "error.forbidden_reason");
});
