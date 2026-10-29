// A fresh database per test file, migrated, dropped afterwards.
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { connect, migrate, type Db } from "../src/db.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";

export async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const name = `kumi_test_${randomBytes(6).toString("hex")}`;
  const adminPool = new pg.Pool({ connectionString: ADMIN, max: 1 });
  adminPool.on("error", () => {});
  const admin = new Kysely<any>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  const db = connect(ADMIN.replace(/\/[^/]*$/, `/${name}`));
  await migrate(db);
  return {
    db,
    async drop() { await db.destroy(); await sql.raw(`DROP DATABASE ${name} WITH (FORCE)`).execute(admin); await admin.destroy(); },
  };
}
