// Leaving (leaving.ts): the day this club's Kumi ends, set by whoever runs its server. Every owner is told at once,
// in their language, to download everything before then, and reminded a week and a day before, each said once for
// that date, in the club's daytime, whatever state the club is in (read-only, past its monthly cap).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { countUsage, KumiError, leavingStatus, messageHandlers, processOutbox, remindLeaving, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, ana: string, mia: string;
const TZ = "America/Los_Angeles";
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const NOW = at("2026-11-17", "10:00");
const leave = (on: string | null, o: { kept_days?: number | null; tell?: boolean } = {}, now = NOW) => runAsSystem(db, "club.leaving", { on, ...o }, "test", { now });
async function told(personId: string) {
  await processOutbox(db, messageHandlers);
  return db.selectFrom("outbound_message").select(["kind", "subject", "body", "link", "lang"]).where("person_id", "=", personId).where("channel", "=", "email")
    .where("kind", "like", "club_leaving%").orderBy("created_at").orderBy("id").execute();
}
const kinds = async (personId: string) => (await told(personId)).map((m) => m.kind);
const notices = async () => (await leavingStatus(db)).notices.map((n) => [n.kind, n.said_at ? (n.covered ? "covered" : "said") : "due"]);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  ana = ((await run(db, "person.create", { display_name: "Ana Ruiz", email: "ana@example.test", locale: "es" }, owner, { now: NOW })).result as { person_id: string }).person_id;
  mia = ((await run(db, "person.create", { display_name: "Mia Chen", email: "mia@example.test" }, owner, { now: NOW })).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: ana, role: "owner" }, owner, { now: NOW });
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner, { now: NOW });
});
after(async () => drop());

test("a day in the past, or one that doesn't exist, is refused", async () => {
  await assert.rejects(leave("2026-11-16"), (e: unknown) => e instanceof KumiError && e.code === "error.leaving_past");
  await assert.rejects(leave("2026-02-30"), (e: unknown) => e instanceof KumiError && e.code === "error.invalid_input");
  assert.equal((await leavingStatus(db)).on, null);
});

test("every owner is told at once, in their language, to download everything; managers see it in the app, not by email", async () => {
  const r = await leave("2026-12-01", { kept_days: 30 });
  assert.equal(r.plan.summary.en, "The club's openPadel ends on December 1, 2026. The owner is told now, and again a week and a day before, to download everything before then.");
  const [en] = await told(owner.personId!), [es] = await told(ana);
  assert.equal(en!.subject, "Kestrel Padel's openPadel ends on December 1, 2026: download everything before then");
  assert.equal(en!.body, "openPadel for Kestrel Padel ends on December 1, 2026. Before then, download everything: in the staff app, go to Settings, Download everything. "
    + "You get one file with all of the club's data and settings, which another openPadel can run. It opens with a passphrase that's shown once, only to you, and openPadel "
    + "doesn't keep it, so save it in a password manager straight away. After December 1, 2026, a copy of the club's data is kept for 30 days, then deleted.");
  assert.equal(en!.link, "/settings#download-everything");
  assert.deepEqual([es!.lang, es!.subject], ["es", "El openPadel de Kestrel Padel termina el 1 de diciembre de 2026: descarga todo antes"]);
  assert.match(es!.body, /se guarda una copia de los datos del club durante 30 días y luego se borra\.$/);
  assert.deepEqual(await kinds(mia), []);
  assert.deepEqual(await notices(), [["set", "said"], ["week", "due"], ["day", "due"]]);
  assert.equal((await leavingStatus(db, NOW)).days_left, 14);
  // The same day again changes nothing and tells nobody twice.
  assert.equal(((await leave("2026-12-01")).result as { changed: boolean }).changed, false);
  assert.deepEqual(await kinds(owner.personId!), ["club_leaving_staff"]);
});

test("a week before and a day before, in the club's daytime, each once; still said read-only and past the cap", async () => {
  assert.equal(await remindLeaving(db, at("2026-11-23", "10:00")), null, "8 days ahead: nothing yet");
  assert.equal(await remindLeaving(db, at("2026-11-24", "06:30")), null, "a week ahead, but before 8 am");
  assert.equal(await remindLeaving(db, at("2026-11-24", "10:00")), "week");
  assert.equal(await remindLeaving(db, at("2026-11-24", "10:01")), null, "said once");
  const week = (await told(owner.personId!)).at(-1)!;
  assert.deepEqual([week.kind, week.subject], ["club_leaving_week_staff", "A week to go: Kestrel Padel's openPadel ends on December 1, 2026"]);
  assert.match(week.body, /^A reminder: openPadel for Kestrel Padel ends on December 1, 2026\. Nobody has downloaded everything yet\. /);
  // The owner downloads everything; then the club goes read-only and over its cap.
  await run(db, "club.export", {}, owner, { now: at("2026-11-25", "09:15") });
  await run(db, "club.usage_cap_set", { cap_cents: 100, over_cents: 0 }, owner, { now: NOW });
  await countUsage(db, "texts", { segments: 1, cents: 500 }, at("2026-11-29", "12:00"));
  await runAsSystem(db, "club.read_only", { on: true }, "test");
  assert.equal(await remindLeaving(db, at("2026-11-30", "09:00")), "day");
  const day = (await told(owner.personId!)).at(-1)!;
  assert.deepEqual([day.kind, day.subject], ["club_leaving_day_staff", "Last reminder: Kestrel Padel's openPadel ends on December 1, 2026"]);
  assert.match(day.body, /Everything was last downloaded on Wed, Nov 25, 9:15\sAM, by Robin Hale\./);
  assert.equal(await remindLeaving(db, at("2026-12-01", "12:00")), null, "the last one went already");
  assert.equal(await remindLeaving(db, at("2026-12-02", "12:00")), null, "the day has passed");
  assert.deepEqual(await notices(), [["set", "said"], ["week", "said"], ["day", "said"]]);
  const s = await leavingStatus(db);
  assert.deepEqual([s.last_export?.by, s.last_export?.at.toISOString()], ["Robin Hale", at("2026-11-25", "09:15").toISOString()]);
  assert.deepEqual(await kinds(ana), ["club_leaving_staff", "club_leaving_week_staff", "club_leaving_day_staff"]);
  await runAsSystem(db, "club.read_only", { on: false }, "test");
});

test("set less than a week ahead: the first email says the week's reminder; the last one still comes", async () => {
  // Moved to a new day: told again, and what's kept stays as it was said.
  await leave("2026-12-05", {}, at("2026-11-30", "12:00"));
  const moved = (await told(owner.personId!)).at(-1)!;
  assert.match(moved.body, /^openPadel for Kestrel Padel ends on December 5, 2026\. .* After December 5, 2026, a copy of the club's data is kept for 30 days, then deleted\.$/);
  assert.deepEqual(await notices(), [["set", "said"], ["week", "covered"], ["day", "due"]]);
  assert.equal(await remindLeaving(db, at("2026-12-01", "12:00")), null);
  assert.equal(await remindLeaving(db, at("2026-12-04", "12:00")), "day");
});

test("a server that was off on the week's day sends only the last one; kept days not said, or none", async () => {
  await leave("2026-12-20", { kept_days: null }, at("2026-12-02", "12:00"));
  assert.match((await told(owner.personId!)).at(-1)!.body, /After December 20, 2026, the club's openPadel stops, so download everything you want to keep before then\.$/);
  assert.equal(await remindLeaving(db, at("2026-12-19", "12:00")), "day");
  assert.deepEqual(await notices(), [["set", "said"], ["week", "covered"], ["day", "said"]]);
  await leave("2026-12-21", { kept_days: 0 }, at("2026-12-02", "12:00"));
  assert.match((await told(owner.personId!)).at(-1)!.body, /After December 21, 2026, the club's data is deleted\.$/);
});

test("taken away: the owners hear once, no more reminders; taken away quietly, nobody hears", async () => {
  await leave(null, {}, at("2026-12-03", "12:00"));
  const off = (await told(owner.personId!)).at(-1)!;
  assert.deepEqual([off.kind, off.body], ["club_leaving_off_staff", "openPadel for Kestrel Padel was set to end on December 21, 2026. That's off now: the club's openPadel carries on as before."]);
  assert.equal(((await leave(null, {}, at("2026-12-03", "12:00"))).result as { changed: boolean }).changed, false);
  assert.equal(await remindLeaving(db, at("2026-12-20", "12:00")), null);
  const before = (await told(owner.personId!)).length;
  await leave("2027-01-15", { tell: false }, at("2026-12-03", "12:00"));
  await leave(null, { tell: false }, at("2026-12-03", "12:00"));
  assert.equal((await told(owner.personId!)).length, before);
  assert.deepEqual([(await leavingStatus(db)).on, await kinds(mia)], [null, []]);
});

test("moved again before the first email went: only the day that stands is said", async () => {
  const before = (await told(owner.personId!)).length;
  await leave("2027-01-10", {}, at("2026-12-03", "12:00"));
  await leave("2027-01-12", {}, at("2026-12-03", "12:01"));
  const now = await told(owner.personId!);
  assert.equal(now.length, before + 1);
  assert.match(now.at(-1)!.subject, /ends on January 12, 2027/);
});
