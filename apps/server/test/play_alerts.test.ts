// The member's reads for "tell me when" alerts and categories: /my/alerts lists their own alerts that are on (and a
// junior's, for the parent who asks), and Play's lists carry the category a match or event is marked with.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court: string, loc: string;
const mailer = new MemoryMailer(), TZ = "America/Los_Angeles", cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json() as any }; };
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner);
    await signIn(`${name.toLowerCase()}@example.test`);
  }
});
after(async () => drop());

test("my alerts: only mine, only those on", async () => {
  const day = new Date(Date.now() + 2 * 86400_000), date = localDate(day, TZ);
  await run(db, "play_alert.set", { person_id: people.Ann, kind: "court", location_id: loc, date, from: "18:00", until: "21:00" }, as("Ann"));
  const m = (await run(db, "play_alert.set", { person_id: people.Ann, kind: "match" }, as("Ann"))).result as { alert_id: string };
  await run(db, "play_alert.set", { person_id: people.Hal, kind: "match" }, as("Hal"));
  const ann = (await get("/my/alerts", "ann@example.test")).json;
  assert.deepEqual(ann.map((a: any) => [a.kind, a.date, a.from, a.until, a.location]).sort(), [["court", date, "18:00", "21:00", "Eastside"], ["match", null, null, null, null]]);
  await run(db, "play_alert.end", { alert_id: m.alert_id }, as("Ann"));
  assert.deepEqual((await get("/my/alerts", "ann@example.test")).json.map((a: any) => a.kind), ["court"]);
  assert.equal((await get(`/my/alerts?for=${people.Hal}`, "ann@example.test")).status, 404);   // not someone else's
});

test("Play's matches and events carry their category; one without is open to all", async () => {
  const start = new Date(Date.now() + 3 * 86400_000); start.setUTCHours(18, 0, 0, 0);
  const r = (await run(db, "booking.request", { court_id: court, starts_at: start.toISOString(), minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 4, gender: "women" } }, as("Hal"))).result as any;
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  const [m] = (await get("/open-matches", "ann@example.test")).json;
  assert.equal(m.gender, "women");
  assert.equal((await get(`/matches/${r.booking_id}`, "ann@example.test")).json.gender, "women");
  for (const [name, gender] of [["Mixed night", "mixed_pairs"], ["Open social", undefined]] as const) {
    const p = ((await run(db, "program.create", { location_id: loc, kind: "social", name, capacity: 8, price_cents: 0, ...(gender ? { gender } : {}) }, owner)).result as any).program_id;
    await run(db, "program.publish", { program_id: p }, owner);
  }
  const progs = (await get("/open-programs", "ann@example.test")).json;
  assert.deepEqual(progs.map((p: any) => [p.name, p.gender]).sort(), [["Mixed night", "mixed_pairs"], ["Open social", null]]);
});
