// What a database runs besides its rows: functions, triggers, rules, views, row policies, schemas, extensions,
// operators and types of its own, grants on tables, and settings for the database or Kumi's own role. A restore
// (backups.ts) replays whatever a dump holds as Kumi's role, and a dump can hold more than Kumi's tables: one made
// by someone else (an export from a host the club is leaving, say) could leave a trigger that copies members'
// messages out, or one that keeps a support grant open, and it would run unseen, outside the audit log. So after a
// restore, and the migrations, the shape must be the one Kumi's own migrations make (shape.json, kept in step by
// test/shape.test.ts); if it isn't, the database as it was goes back in and the file is refused.
//
// Only what runs or decides who sees what is compared, never tables, columns or indexes: those change with nearly
// every migration, and on their own they run nothing (a default or a check can only call a function, and functions
// are compared). Definitions are compared on the Postgres they were recorded on; on another major version only the
// names are, since Postgres may print the same definition differently.
import { readFileSync, writeFileSync } from "node:fs";
import { sql, type Kysely } from "kysely";

const userSchema = (col: string) => sql.raw(`(${col} NOT LIKE 'pg\\_%' AND ${col} <> 'information_schema')`);
/** Objects an extension brought (btree_gist's functions and operators): the extension is compared, not its parts. */
const notFromExtension = (cls: string, oid: string) => sql.raw(`NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = '${cls}'::regclass AND dep.objid = ${oid} AND dep.deptype = 'e')`);

export interface Shape { postgres: number; objects: string[] }

/** The shape of a database: one line per object, "kind name" then " | " and a digest of its definition. */
export async function schemaShape(db: Kysely<any>): Promise<Shape> {
  const lines: string[] = [];
  const add = async (q: ReturnType<typeof sql<{ line: string }>>) => { for (const r of (await q.execute(db)).rows) lines.push(r.line); };
  await add(sql<{ line: string }>`SELECT 'schema ' || nspname AS line FROM pg_namespace WHERE ${userSchema("nspname")}`);
  await add(sql<{ line: string }>`SELECT 'extension ' || extname || ' in ' || extnamespace::regnamespace::text AS line FROM pg_extension`);
  await add(sql<{ line: string }>`SELECT 'function ' || p.oid::regprocedure::text || ' | ' || md5(p.prokind::text || l.lanname::text || p.prosecdef::text || p.provolatile::text
      || coalesce(array_to_string(p.proconfig, ','), '') || coalesce(p.prosrc, '') || coalesce(p.probin, '')) AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE ${userSchema("n.nspname")} AND ${notFromExtension("pg_proc", "p.oid")}`);
  await add(sql<{ line: string }>`SELECT 'trigger ' || t.tgrelid::regclass::text || '.' || t.tgname || ' | ' || md5(t.tgenabled::text || pg_get_triggerdef(t.oid)) AS line
    FROM pg_trigger t WHERE NOT t.tgisinternal`);
  await add(sql<{ line: string }>`SELECT 'event trigger ' || evtname AS line FROM pg_event_trigger`);
  await add(sql<{ line: string }>`SELECT 'rule ' || schemaname || '.' || tablename || '.' || rulename || ' | ' || md5(definition) AS line FROM pg_rules WHERE ${userSchema("schemaname")}`);
  await add(sql<{ line: string }>`SELECT 'view ' || schemaname || '.' || viewname || ' | ' || md5(definition) AS line FROM pg_views WHERE ${userSchema("schemaname")}`);
  await add(sql<{ line: string }>`SELECT 'materialized view ' || schemaname || '.' || matviewname || ' | ' || md5(definition) AS line FROM pg_matviews WHERE ${userSchema("schemaname")}`);
  await add(sql<{ line: string }>`SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname || ' | ' || md5(row(permissive, roles, cmd, qual, with_check)::text) AS line
    FROM pg_policies WHERE ${userSchema("schemaname")}`);
  // Who may read a table besides Kumi (restores leave grants out), and tables that filter rows by policy.
  await add(sql<{ line: string }>`SELECT 'grants or row security on ' || n.nspname || '.' || c.relname || ' | ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity::text || c.relforcerowsecurity::text AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${userSchema("n.nspname")} AND (c.relacl IS NOT NULL OR c.relrowsecurity OR c.relforcerowsecurity)`);
  await add(sql<{ line: string }>`SELECT 'default grants ' || coalesce(defaclnamespace::regnamespace::text, 'everywhere') || ' ' || defaclobjtype::text || ' | ' || defaclacl::text AS line FROM pg_default_acl`);
  await add(sql<{ line: string }>`SELECT 'operator ' || o.oid::regoperator::text AS line FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
    WHERE ${userSchema("n.nspname")} AND ${notFromExtension("pg_operator", "o.oid")}`);
  await add(sql<{ line: string }>`SELECT 'type ' || t.oid::regtype::text || ' ' || t.typtype::text AS line FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE ${userSchema("n.nspname")} AND t.typrelid = 0 AND t.typcategory <> 'A' AND ${notFromExtension("pg_type", "t.oid")}`);
  await add(sql<{ line: string }>`SELECT 'cast ' || format_type(castsource, NULL) || ' as ' || format_type(casttarget, NULL) AS line FROM pg_cast WHERE oid >= 16384 AND ${notFromExtension("pg_cast", "oid")}`);
  await add(sql<{ line: string }>`SELECT 'conversion ' || n.nspname || '.' || c.conname AS line FROM pg_conversion c JOIN pg_namespace n ON n.oid = c.connamespace WHERE ${userSchema("n.nspname")}`);
  await add(sql<{ line: string }>`SELECT 'collation ' || n.nspname || '.' || c.collname AS line FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE ${userSchema("n.nspname")}`);
  await add(sql<{ line: string }>`SELECT 'publication ' || pubname AS line FROM pg_publication`);
  await add(sql<{ line: string }>`SELECT 'foreign server ' || srvname AS line FROM pg_foreign_server`);
  // Settings that ride along with every connection: for this database, or for Kumi's role (here or everywhere).
  await add(sql<{ line: string }>`SELECT 'setting for ' || CASE WHEN s.setrole = 0 THEN 'the database' WHEN s.setdatabase = 0 THEN 'the role' ELSE 'the role here' END
      || ' | ' || array_to_string(s.setconfig, ',') AS line
    FROM pg_db_role_setting s WHERE (s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
      OR (s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())))`);
  const v = (await sql<{ v: string }>`SELECT current_setting('server_version_num') AS v`.execute(db)).rows[0]!.v;
  return { postgres: Math.floor(Number(v) / 10000), objects: lines.sort() };
}

const SHAPE_FILE = new URL("./shape.json", import.meta.url);
/** The shape Kumi's own migrations make (shape.json): recorded by test/shape.test.ts with KUMI_SHAPE_WRITE=1. */
export function expectedShape(): Shape { return JSON.parse(readFileSync(SHAPE_FILE, "utf8")) as Shape; }
export function writeExpectedShape(s: Shape): void { writeFileSync(SHAPE_FILE, `${JSON.stringify(s, null, 2)}\n`); }

const nameOnly = (line: string) => line.split(" | ")[0]!;
/** What a database has that Kumi's migrations don't make, and what it lacks: empty when the shapes match. On another
 *  major version of Postgres, only the names. */
export function shapeDifferences(got: Shape, want: Shape = expectedShape()): string[] {
  const exact = got.postgres === want.postgres;
  const key = exact ? (l: string) => l : nameOnly;
  const have = new Set(got.objects.map(key)), should = new Set(want.objects.map(key));
  return [...[...have].filter((l) => !should.has(l)).map((l) => `not Kumi's: ${nameOnly(l)}`),
    ...[...should].filter((l) => !have.has(l)).map((l) => `missing: ${nameOnly(l)}`)].sort();
}

/** The settings a refused restore may have left on the role or database (they live outside it), put back as they were. */
export async function settingsNow(db: Kysely<any>): Promise<Array<{ scope: "database" | "role" | "role_here"; config: string[] }>> {
  const r = await sql<{ scope: "database" | "role" | "role_here"; config: string[] }>`SELECT CASE WHEN s.setrole = 0 THEN 'database' WHEN s.setdatabase = 0 THEN 'role' ELSE 'role_here' END AS scope,
      s.setconfig AS config
    FROM pg_db_role_setting s WHERE (s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
      OR (s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())))`.execute(db);
  return r.rows;
}
export async function putSettingsBack(db: Kysely<any>, before: Awaited<ReturnType<typeof settingsNow>>): Promise<void> {
  const dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d;
  const target = { database: sql`DATABASE ${sql.id(dbName)}`, role: sql`ROLE CURRENT_USER`, role_here: sql`ROLE CURRENT_USER IN DATABASE ${sql.id(dbName)}` };
  for (const scope of ["database", "role", "role_here"] as const) {
    // Resetting the database's needs its owner; Kumi's role usually is, and a dump couldn't set them otherwise.
    await sql`ALTER ${target[scope]} RESET ALL`.execute(db).catch(() => undefined);
    for (const kv of before.find((b) => b.scope === scope)?.config ?? []) {
      const at = kv.indexOf("=");
      if (at > 0) await sql`ALTER ${target[scope]} SET ${sql.id(kv.slice(0, at))} = ${sql.lit(kv.slice(at + 1))}`.execute(db).catch(() => undefined);
    }
  }
}
