import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, loc: string, photo: string;
const TZ = "America/Los_Angeles";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const get = async (path: string, who: string) => { const r = await app.request(path, { headers: { cookie: cookies[who]! } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
/** A club date a few days out that's a Wednesday, so the coach's hours apply. */
function nextWednesday() {
  const d = new Date(Date.now() + 3 * 864e5);
  while (new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d) !== "Wed") d.setTime(d.getTime() + 864e5);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  for (const name of ["Ann", "Kim", "Lou", "Fay", "Acc"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(`${name.toLowerCase()}@example.test`);
  }
  for (const [who, role] of [["Kim", "coach"], ["Lou", "coach"], ["Fay", "front_desk"], ["Acc", "accountant"]] as const) await run(db, "role.assign", { person_id: people[who], role }, owner);
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Ten years <b>coaching</b> & drills.", level_min: 1.5, level_max: 4, languages: ["en", "es"], rates: [{ minutes: 60, cents: 9000 }], lessons: true, max_players: 4 }, as("Kim"));
  photo = ((await run(db, "coach.set_photo", { person_id: people.Kim, photo: png.toString("base64") }, as("Kim"))).result as any).photo_id;
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 3, starts: "09:00", ends: "11:00" }] }, as("Kim"));
});
after(async () => drop());

test("members see the coaches who take lessons, with a photo link and never a coach's email", async () => {
  assert.equal((await get("/club", "ann@example.test")).json.lessons, true);
  const r = await get("/my/lessons/coaches", "ann@example.test");
  assert.deepEqual(r.json.coaches.map((c: any) => [c.name, c.rates, c.photo]), [["Kim", { 60: 9000 }, `/public/photos/${photo}`]]);
  assert.ok(!JSON.stringify(r.json).includes("@example.test"));
  const day = nextWednesday();
  const times = await get(`/my/lessons/times?coach_id=${people.Kim}&date=${day}&minutes=60`, "ann@example.test");
  assert.deepEqual(times.json.times.map((x: any) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(x.start))), ["09:00", "09:30", "10:00"]);
  assert.equal((await get(`/my/lessons/times?coach_id=nope&date=${day}&minutes=60`, "ann@example.test")).status, 400);
  assert.equal((await app.request("/my/lessons/coaches")).status, 401);
});

test("a coach's photo is served with the type checked when it was added, and nothing else is", async () => {
  const r = await app.request(`/public/photos/${photo}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.headers.get("content-type"), r.headers.get("x-content-type-options")], ["image/png", "nosniff"]);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal((await app.request(`/public/photos/${uuidv7()}`)).status, 404);
  assert.equal((await app.request("/public/photos/..%2Fsecret")).status, 404);
  // A photo no coach's profile shows (here, an old one replaced) isn't served.
  await run(db, "coach.set_photo", { person_id: people.Kim, photo: png.toString("base64") }, as("Kim"));
  assert.equal((await app.request(`/public/photos/${photo}`)).status, 404);
  photo = (await db.selectFrom("coach").select("photo_id").where("person_id", "=", people.Kim!).executeTakeFirstOrThrow()).photo_id!;
});

test("the public page lists coaches, escaped, with their rates and no contact details", async () => {
  await run(db, "club.update", { public_page: true }, owner);
  const html = await (await app.request("/public")).text();
  assert.match(html, /<h2>Coaches<\/h2>/);
  assert.match(html, /Ten years &lt;b&gt;coaching&lt;\/b&gt; &amp; drills\./);
  assert.match(html, /levels 1\.50 to 4\.00 · English, Español · private lessons: 60 minutes \$90\.00, court included/);
  assert.ok(html.includes(`/public/photos/${photo}`));
  assert.ok(!html.includes("kim@example.test"));
  const es = await (await app.request("/public?lang=es")).text();
  assert.match(es, /<h2>Entrenadores<\/h2>/);
});

test("staff screens: front desk sees every coach, a coach their own; earnings for owners, the accountant, and a coach's own", async () => {
  assert.deepEqual((await get("/staff/coaches", "fay@example.test")).json.coaches.map((c: any) => [c.name, Boolean(c.profile)]), [["Kim", true], ["Lou", false]]);
  const own = (await get("/staff/coaches", "lou@example.test")).json;
  assert.deepEqual([own.can_edit_all, own.coaches.map((c: any) => c.name)], [false, ["Lou"]]);
  assert.equal((await get("/staff/coaches", "acc@example.test")).status, 403);
  assert.equal((await get("/staff/coaches", "ann@example.test")).status, 403);   // members aren't staff
  assert.deepEqual((await get("/staff/coaches", "kim@example.test")).json.coaches[0].hours, [{ location_id: loc, weekday: 3, starts: "09:00", ends: "11:00" }]);
  const from = "2026-01-01", to = "2026-12-31";
  assert.equal((await get(`/staff/coach-earnings?from=${from}&to=${to}`, "acc@example.test")).status, 200);
  assert.equal((await get(`/staff/coach-earnings?from=${from}&to=${to}`, "fay@example.test")).status, 403);
  assert.equal((await get(`/staff/coach-earnings?from=${to}&to=${from}`, "kim@example.test")).status, 400);
  const csv = await (await app.request(`/staff/coach-earnings.csv?from=${from}&to=${to}`, { headers: { cookie: cookies["kim@example.test"]! } })).text();
  assert.equal(csv, "coach,kind,when,minutes,what,status,paid,refunded,net\r\n");
  assert.deepEqual((await get("/staff/my-schedule", "kim@example.test")).json.items, []);
});
