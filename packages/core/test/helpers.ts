// A fresh database per test file, migrated, dropped afterwards.
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { connect, migrate, type Db } from "../src/db.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";

// Databases this process made and hasn't dropped yet. A test file whose after() hook never runs (the run is killed,
// a hook before the drop throws) used to leave its database behind: 61 kumi_test_* were found on 6 Nov 2026, 60 of
// them from one run stopped on 2 Nov. Now each is dropped once, by after(), on SIGINT/SIGTERM, or before the
// process exits. `npm run test:sweep` lists (and with --drop removes) any that are left from older runs.
const open = new Map<string, () => Promise<void>>();
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  const dropAll = () => Promise.allSettled([...open.values()].map((d) => d()));
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const)
    process.once(sig, () => { void dropAll().finally(() => process.exit(code)); });
  process.on("beforeExit", () => { if (open.size) void dropAll(); });
}

/** `twoFactor`: test databases leave two-step sign-in off (the database default, which no action can set),
 *  so tests sign staff in with an emailed code; the tests of two-step sign-in turn it on. */
export async function freshDb(o: { twoFactor?: boolean } = {}): Promise<{ db: Db; drop: () => Promise<void> }> {
  hookExit();
  const name = `kumi_test_${randomBytes(6).toString("hex")}`;
  const adminPool = new pg.Pool({ connectionString: ADMIN, max: 1 });
  adminPool.on("error", () => {});
  const admin = new Kysely<any>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  const db = connect(ADMIN.replace(/\/[^/]*$/, `/${name}`));
  let dropping: Promise<void> | null = null;
  const drop = () => (dropping ??= (async () => {
    open.delete(name);
    await db.destroy().catch(() => undefined);
    try { await sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).execute(admin); }
    finally { await admin.destroy().catch(() => undefined); }
  })());
  open.set(name, drop);
  try {
    await migrate(db);
    if (!o.twoFactor) await sql`ALTER TABLE club ALTER COLUMN two_factor SET DEFAULT 'off'`.execute(db);
  } catch (e) { await drop().catch(() => undefined); throw e; }   // a migration that fails leaves nothing behind
  return { db, drop };
}
