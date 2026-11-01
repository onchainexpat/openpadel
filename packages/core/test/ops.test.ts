import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { heartbeat, jobFailed, jobWorked, messageHandlers, processOutbox, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const NOW = new Date("2026-11-30T11:17:00Z");

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "two_factor" };
  const mia = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test", locale: "es" }, owner, { now: NOW })).result as any).person_id;
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner, { now: NOW });
});
after(async () => drop());

test("a job that starts failing tells the owner and managers once, not every night it fails again", async () => {
  await jobWorked(db, "offsite", { key: "kumi/daily/kumi-2026-11-29.dump.enc" }, NOW);
  assert.equal((await heartbeat(db, "offsite"))!.last_error, null);
  assert.deepEqual(await jobFailed(db, "offsite", "upload kumi/daily/kumi-2026-11-30.dump.enc: HTTP 403 AccessDenied: Access Denied\nmore", NOW), { told: true });
  assert.deepEqual(await jobFailed(db, "offsite", "the same again", new Date(NOW.getTime() + 86400_000)), { told: false });
  const h = (await heartbeat(db, "offsite"))!;
  assert.equal(h.last_error, "the same again");
  assert.equal(new Date(h.last_ok_at!).toISOString(), NOW.toISOString());   // when it last worked stays
  // Worked in between: the next failure is news again.
  await jobWorked(db, "offsite", {}, new Date(NOW.getTime() + 2 * 86400_000));
  assert.deepEqual(await jobFailed(db, "offsite", "HTTP 500", new Date(NOW.getTime() + 3 * 86400_000)), { told: true });
  await processOutbox(db, messageHandlers);
  const mail = await db.selectFrom("outbound_message").select(["person_id", "subject", "body", "lang"]).where("kind", "=", "ops_failed_staff").where("channel", "=", "email").orderBy("id").execute();
  assert.equal(mail.length, 4);   // owner and manager, twice
  const en = mail.find((m) => m.lang === "en")!, es = mail.find((m) => m.lang === "es")!;
  assert.equal(en.subject, "Needs a look: the offsite copy of the backup failed");
  assert.equal(en.body, "On the club's server, the offsite copy of the backup failed: upload kumi/daily/kumi-2026-11-30.dump.enc: HTTP 403 AccessDenied: Access Denied. You're told once, not every time it fails again. Run kumi doctor on the server for the next step.");
  assert.equal(es.subject, "Hay que revisarlo: falló la copia externa de la copia de seguridad");
});
