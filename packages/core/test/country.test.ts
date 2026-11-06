// A club's country (club.ts, texts.ts, connect.ts): numbers typed without a + are read in it and kept as E.164,
// texts still reach only US and Canadian numbers, and a location's address has its own postal code and region.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { clubFormat, setClubFormat } from "@kumi/i18n";
import { anyPhone, loadClubFormat, run, runAsSystem, usPhone, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const opts = { now: new Date("2026-11-05T10:00:00Z") };

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: "Europe/Madrid", owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
});
after(async () => { setClubFormat({ currency: "USD", locale: "en-US", country: "US" }); await drop(); });

test("numbers from anywhere are read as E.164; only US and Canadian ones can be texted", () => {
  setClubFormat({ country: "US" });
  assert.equal(anyPhone("(503) 555-0123"), "+15035550123");
  assert.equal(anyPhone("+34 612 34 56 78"), "+34612345678");
  assert.equal(anyPhone("not a number"), null);
  assert.equal(usPhone("+34 612 34 56 78"), null);
  assert.equal(usPhone("+15035550123"), "+15035550123");
});

test("the club's country reads numbers without a +, and a location keeps its postal code and region", async () => {
  await run(db, "club.update", { country: "es" }, owner, opts);
  setClubFormat({ country: "US" }); await loadClubFormat(db);
  assert.equal(clubFormat().country, "ES");
  assert.equal(anyPhone("612 34 56 78"), "+34612345678");
  const loc = ((await run(db, "location.create", { name: "Centro", time_zone: "Europe/Madrid", address: "Calle Mayor 1", postal_code: "28013", region: "Madrid", country: "es" }, owner, opts)).result as any).location_id;
  const row = await db.selectFrom("location").select(["address", "postal_code", "region", "country"]).where("id", "=", loc).executeTakeFirstOrThrow();
  assert.deepEqual(row, { address: "Calle Mayor 1", postal_code: "28013", region: "Madrid", country: "ES" });
});
