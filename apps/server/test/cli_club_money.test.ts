// The CLI (cli.ts) writes amounts as the club does (intl review L6): a restore's "to check" lines are in the club's
// currency, read from the database just restored, and `kumi usage` stays in US dollars, as the meter is counted and
// billed (usage.ts, doctor.ts), whatever the club's currency. A club in Spain: euros, es-ES formats. Each command is
// run as the server's admin runs it: node apps/server/src/cli.ts, with DATABASE_URL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { money, setClubFormat } from "@kumi/i18n";
import { countUsage, monthOf, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeBackup, pgTool } from "../src/backups.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";
const CLI = join(import.meta.dirname, "../src/cli.ts"), TZ = "Europe/Madrid";
const made: Array<() => Promise<void>> = [];
let dir: string | null = null;
const scratch = () => (dir ??= mkdtempSync(join(tmpdir(), "kumi-cli-money-test-")));
after(async () => { setClubFormat({ currency: "USD", locale: "en-US", country: "US" }); if (dir) rmSync(dir, { recursive: true, force: true }); for (const d of made) await d(); });

const urlOf = async (db: Db) => ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
async function kumi(url: string, ...args: string[]) {
  const env = { ...process.env, DATABASE_URL: url, KUMI_BACKUP_DIR: scratch(), KUMI_LANG: "en" };
  const r = await promisify(execFile)(process.execPath, [CLI, ...args, "--lang=en"], { env, timeout: 60_000 }).catch((e) => e as { stdout: string; stderr: string; code: number });
  return `${r.stdout}${r.stderr}`;
}
/** A club in Spain, set up and priced in euros; Ann a member. */
async function spanishClub() {
  const { db, drop } = await freshDb();
  made.push(drop);
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: TZ, owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  const owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  await run(db, "club.update", { currency: "EUR", format_locale: "es-ES", country: "ES" }, owner);
  const ann = ((await run(db, "person.create", { display_name: "Ann Sol", email: "ann@example.test" }, owner)).result as { person_id: string }).person_id;
  setClubFormat({ currency: "USD", locale: "en-US", country: "US" });   // this process as a fresh CLI starts: dollars until it reads the club
  return { db, url: await urlOf(db), ann };
}
/** 25,00 € of club credit for a person (a refund given as credit), straight into the books. */
async function credit(db: Db, personId: string, cents: number) {
  const acct = async (kind: string, person: string | null) => {
    const got = await db.selectFrom("ledger_account").select("id").where("kind", "=", kind as any).where("person_id", person === null ? "is" : "=", person as any).where("revenue_type", "is", null).executeTakeFirst();
    if (got) return got.id;
    const id = uuidv7(); await db.insertInto("ledger_account").values({ id, kind: kind as any, person_id: person }).execute(); return id;
  };
  const runId = uuidv7(), txn = uuidv7(), mine = await acct("member_credit", personId), adj = await acct("adjustment", null);
  await sql`INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at)
    VALUES (${runId}, 'test.money', 1, 'test', '{}', '{}', 'applied', 'none', '{}', now(), now())`.execute(db);
  await db.insertInto("ledger_txn").values({ id: txn, kind: "refund", action_run_id: runId, memo: "refund" }).execute();
  await db.insertInto("ledger_entry").values([{ txn_id: txn, account_id: mine, amount_cents: String(-cents) }, { txn_id: txn, account_id: adj, amount_cents: String(cents) }]).execute();
}

test("kumi restore in a euro club: what's to check is written in euros, the club's way", { skip }, async () => {
  const { db, url, ann } = await spanishClub();
  const backup = await makeBackup(db, { url, dir: scratch(), label: `cli-money-${Date.now()}` });
  // After the backup: Ann is given 25,00 € of credit, which the backup doesn't have.
  await credit(db, ann, 2500);
  const out = await kumi(url, "restore", backup.file, "--yes");
  assert.match(out, /Restored/i, out);
  setClubFormat({ currency: "EUR", locale: "es-ES", country: "ES" });
  const line = out.split("\n").find((l) => l.includes("club credit was"));
  assert.ok(line, out);
  assert.equal(line, `To check: Ann Sol's club credit was ${money(2500, "en")} before the restore and is ${money(0, "en")} now (spent or earned on things this copy doesn't have).`);
  assert.match(line!, /25,00\s€/, "euros, written the Spanish way");
  assert.doesNotMatch(out, /\$/, "no dollar amounts");
});

test("kumi usage in a euro club: the meter is in US dollars, as it's counted and billed", async () => {
  const { db, url } = await spanishClub();
  await countUsage(db, "texts", { segments: 8, cents: 1234 });
  const out = await kumi(url, "usage");
  const month = monthOf(new Date(), TZ).slice(0, 7);
  setClubFormat({ currency: "EUR", locale: "es-ES", country: "ES" });
  const first = out.split("\n")[0]!;
  assert.match(first, new RegExp(`^Club Pádel Sol, ${month}: `), out);
  assert.ok(first.includes(money(1234, "en", "USD")), `${first} has ${money(1234, "en", "USD")}`);
  assert.doesNotMatch(out, /€/, "never in euros: the services bill in dollars");
  // kumi doctor says the same, in the same dollars.
  const doc = (await kumi(url, "doctor")).split("\n").find((l) => l.includes("Usage this month"));
  assert.ok(doc?.includes(`${money(1234, "en", "USD")} of the club's ${money(5000, "en", "USD")} cap`), doc);
});
