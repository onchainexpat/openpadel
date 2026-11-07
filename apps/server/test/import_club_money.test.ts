// Importing a club's export (`kumi restore <export>`, export.ts) writes amounts as the club does, like `kumi restore`
// (intl review L6): back on a server the club ran on before, what the import does again (an account deleted there
// since the file was made, deleted again in the copy) is said to the staff in the club's currency, not in the dollars a
// fresh CLI process starts with. A club in Spain: euros, es-ES formats. Needs pg_dump and pg_restore 17.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { clubFormat, money, setClubFormat } from "@kumi/i18n";
import { checkPayment, localDate, onDate, openPayment, run, runAsSystem, setPaymentProvider, setSecretKeys, TestProvider, uuidv7, type Actor, type Db } from "@kumi/core";
import { pgTool } from "../src/backups.ts";
import { importExport, makeExport } from "../src/export.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";
const TZ = "Europe/Madrid", KEY = Buffer.alloc(32, 5).toString("base64");
const DAY = localDate(new Date(Date.now() + 3 * 86400_000), TZ);
const stripe = new TestProvider();
let db: Db, drop: () => Promise<void>, url: string, dir: string, owner: Actor, ann: string;
const urlOf = async (d: Db) => ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(d)).rows[0]!.d}`);

before(async () => {
  if (skip) return;
  ({ db, drop } = await freshDb());
  url = await urlOf(db);
  dir = mkdtempSync(join(tmpdir(), "kumi-import-money-test-"));
  setSecretKeys({ current: KEY });
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: TZ, owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  ann = ((await run(db, "person.create", { display_name: "Ann Sol", email: "ann@example.test" }, owner)).result as { person_id: string }).person_id;
  const loc = ((await run(db, "location.create", { name: "Centro", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Pista 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: loc, name: "Tarifa", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true, currency: "EUR", format_locale: "es-ES", country: "ES" }, owner);
  // Ann books a court three days ahead and pays 40,00 € for it.
  const b = (await run(db, "booking.request", { court_id: court, starts_at: onDate(DAY, "12:00", TZ).toISOString(), minutes: 60, person_id: ann, pay: "whole" },
    { personId: ann, via: "test", lang: "en" })).result as { payment_id: string };
  await openPayment(db, b.payment_id, ann);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", b.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, b.payment_id, "test"), "succeeded");
});
after(async () => { if (skip) return; setPaymentProvider(new TestProvider()); setSecretKeys({}); setClubFormat({ currency: "USD", locale: "en-US", country: "US" }); rmSync(dir, { recursive: true, force: true }); await drop(); });

test("an export brought back to a server the club ran on before: what it deletes again is said in euros", { skip }, async () => {
  const made = await makeExport(db, { url, env: { KUMI_PUBLIC_URL: "https://staff.sol.example", KUMI_PG_BIN: process.env.KUMI_PG_BIN }, passphrase: "correct horse battery staple" });
  // After the file is made, on this server: Ann deletes her own account (as privacy.erase records it).
  await db.updateTable("person").set({ redacted_at: new Date(), display_name: "Former member", email: null }).where("id", "=", ann).execute();
  await sql`INSERT INTO action_run (id, action, action_version, actor_person_id, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${uuidv7()}, 'privacy.erase', 1, ${ann}, 'app', ${JSON.stringify({ person_id: ann })}::jsonb, '{}'::jsonb, 'applied', 'none', '{}'::jsonb, now(), now())`.execute(db);
  // The import runs as a fresh `kumi restore <export>` does: this process in US dollars until it reads the club.
  setClubFormat({ currency: "USD", locale: "en-US", country: "US" });
  const r = await importExport({ url, file: made.file, passphrase: "correct horse battery staple", dir, env: { KUMI_PUBLIC_URL: "https://staff.sol.example", KUMI_PG_BIN: process.env.KUMI_PG_BIN } });
  assert.equal(r.gone_carried.erased, 1, "Ann's own deletion done again in the copy");
  assert.deepEqual((r.gone_carried as { to_check?: Array<{ paid_cents: number }> }).to_check?.map((x) => x.paid_cents), [4000], "her paid court freed, nothing refunded");
  const [a] = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "ops.failed").where(sql<string>`payload->>'job'`, "=", "restore_erase").execute();
  assert.ok(a, "the staff are told what to check");
  const words = (a!.payload as { words: { en: string; es: string } }).words;
  assert.ok(words.en.includes(`(${money(4000, "en")} had been paid)`), words.en);
  assert.match(words.en, /Freed with nothing refunded after the restore: booking [A-Z0-9]+-[A-Z0-9]+ /, "which one, by its code");
  assert.doesNotMatch(`${words.en} ${words.es}`, /Ann/, "never the deleted person's name");
  assert.match(words.en, /40,00\s€/, "euros, written the Spanish way");
  assert.match(words.es, /40,00\s€/);
  assert.doesNotMatch(`${words.en} ${words.es}`, /\$/, "no dollar amounts");
  assert.equal(clubFormat().currency, "EUR", "the imported club's currency, for whatever this process writes next");
});
