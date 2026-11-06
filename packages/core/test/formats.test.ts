// A club's own formats (format.ts, club.ts): its locale writes dates, times and amounts, picks the 12- or 24-hour
// clock and the first day of the week; each reader keeps their own language.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { clock24, dateTime, firstDayOfWeek, formatLocale, money, parseAmount, setClubFormat, weekOrder } from "@kumi/i18n";
import { run, runAsSystem, KumiError, loadClubFormat, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const opts = { now: new Date("2026-11-05T10:00:00Z") }, at = new Date("2026-11-12T16:00:00Z");

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: "Europe/Madrid", owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
});
after(async () => { setClubFormat({ currency: "USD", locale: "en-US" }); await drop(); });

test("a US club reads exactly as before: 12-hour clock, month first, Sunday starts the week", () => {
  setClubFormat({ currency: "USD", locale: "en-US" });
  assert.equal(dateTime(at, "en", "America/Los_Angeles"), "Thu, Nov 12, 8:00 AM");
  assert.equal(money(4050, "es"), "$40.50");
  assert.equal(firstDayOfWeek(), 7);
  assert.deepEqual(weekOrder(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(clock24(), false);
});

test("a club in Spain: 24 hours, day first, Monday first, the reader's language kept", async () => {
  await assert.rejects(run(db, "club.update", { format_locale: "not a locale!" }, owner, opts), (e: unknown) => e instanceof KumiError && e.code === "error.invalid_input");
  await run(db, "club.update", { currency: "EUR", format_locale: "es-es" }, owner, opts);
  assert.equal((await db.selectFrom("club").select("format_locale").executeTakeFirstOrThrow()).format_locale, "es-ES");
  setClubFormat({ currency: "USD", locale: "en-US" }); await loadClubFormat(db);
  assert.match(formatLocale("en"), /^en-ES/);
  assert.equal(dateTime(at, "en", "Europe/Madrid"), "Thu, 12 Nov, 17:00");
  assert.equal(dateTime(at, "es", "Europe/Madrid"), "jue, 12 nov, 17:00");
  assert.match(money(120050, "es"), /^1200,50\s€$/);
  assert.equal(parseAmount("1.200,50"), 120050);
  assert.deepEqual(weekOrder(), [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(clock24(), true);
});
