import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, clinic: string;
const TZ = "America/Los_Angeles";
const page = async (path: string, lang = "en-US") => { const r = await app.request(path, { headers: { "accept-language": lang } }); return { status: r.status, type: r.headers.get("content-type"), text: await r.text() }; };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false, publicUrl: "https://play.kestrel.test" });
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ, address: "100 Court St, Portland, OR" }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "court.create", { location_id: loc, name: "Court 2", kind: "outdoor" }, owner);
  await run(db, "hours.set", { location_id: loc, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })) }, owner);
  const monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month", days_ahead: 21 }, owner)).result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Members", cents_per_hour: 3000, plan_ids: [monthly] }, owner);
  // A clinic whose name tries to break out of the page.
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Drills <script>alert(1)</script> & lobs", capacity: 8, price_cents: 3500, member_price_cents: 3000, refund_window_hours: 24 }, owner)).result as any).program_id;
  const start = new Date(Date.now() + 5 * 86400_000); start.setUTCHours(17, 0, 0, 0);
  await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: clinic }, owner);
});
after(async () => drop());

test("off until the club switches it on", async () => {
  assert.equal((await page("/public")).status, 404);
  assert.equal((await page(`/public/events/${clinic}`)).status, 404);
  await run(db, "club.update", { public_page: true, about: "Six courts by the river. Everyone welcome." }, owner);
});

test("the page: where, when, courts, prices, memberships and what's coming up, all as plain HTML", async () => {
  const p = await page("/public");
  assert.equal(p.status, 200); assert.match(p.type!, /^text\/html/);
  for (const s of ["<h1>Kestrel Padel</h1>", "Six courts by the river. Everyone welcome.", "100 Court St, Portland, OR", "2 courts: Indoor, Outdoor", "<td>Monday</td><td>07:00 - 22:00</td>",
    "<td>Sunday</td><td>Closed</td>", "Standard: $40.00 an hour, every day", "Members: $30.00 an hour, every day <span class=\"meta\">(members of Monthly)</span>",
    "<strong>Monthly</strong>: $80.00 a month. Book courts up to 21 days ahead.</li>", "Drills &lt;script&gt;alert(1)&lt;/script&gt; &amp; lobs", "8 places left", "$35.00 (members $30.00)", "Join the club"]) assert.ok(p.text.includes(s), s);
  assert.ok(!p.text.includes("<script>alert(1)"));
  const blocks = [...p.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
  assert.equal(blocks[0]["@type"], "SportsActivityLocation");
  assert.equal(blocks[1].name, "Drills <script>alert(1)</script> & lobs");   // intact once parsed, harmless in the page
  assert.equal(blocks[1].offers.price, "35.00");
  const es = await page("/public?lang=es");
  assert.ok(es.text.includes("Próximamente") && es.text.includes('<html lang="es">'));
});

test("each public event has its own page with schema.org markup, and the sitemap lists them", async () => {
  const p = await page(`/public/events/${clinic}`);
  assert.equal(p.status, 200);
  const [ld] = [...p.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
  assert.deepEqual([ld["@type"], ld.offers.availability, ld.location.address, ld.url], ["SportsEvent", "https://schema.org/InStock", "100 Court St, Portland, OR", `https://play.kestrel.test/public/events/${clinic}`]);
  assert.equal((await page("/public/events/not-an-id")).status, 404);
  const map = await page("/public/sitemap.xml");
  assert.ok(map.text.includes(`<loc>https://play.kestrel.test/public/events/${clinic}</loc>`));
});
