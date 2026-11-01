// A fresh database per test file, migrated, dropped afterwards.
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { connect, migrate, type Db } from "../src/db.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";

/** `twoFactor`: test databases leave two-step sign-in off (the database default, which no action can set),
 *  so tests sign staff in with an emailed code; the tests of two-step sign-in turn it on. */
export async function freshDb(o: { twoFactor?: boolean } = {}): Promise<{ db: Db; drop: () => Promise<void> }> {
  const name = `kumi_test_${randomBytes(6).toString("hex")}`;
  const adminPool = new pg.Pool({ connectionString: ADMIN, max: 1 });
  adminPool.on("error", () => {});
  const admin = new Kysely<any>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  const db = connect(ADMIN.replace(/\/[^/]*$/, `/${name}`));
  await migrate(db);
  if (!o.twoFactor) await sql`ALTER TABLE club ALTER COLUMN two_factor SET DEFAULT 'off'`.execute(db);
  return {
    db,
    async drop() { await db.destroy(); await sql.raw(`DROP DATABASE ${name} WITH (FORCE)`).execute(admin); await admin.destroy(); },
  };
}
