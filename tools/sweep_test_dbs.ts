// Lists the test databases left on the development Postgres by runs that didn't finish (a killed run never reaches
// its after() hooks), and with --drop removes the ones that look abandoned: older than --hours (6 by default) and
// with nobody connected. Only names starting with kumi_test_ are ever looked at or dropped.
//   npm run test:sweep                 list them
//   npm run test:sweep -- --drop       drop the abandoned ones
import pg from "pg";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const args = process.argv.slice(2);
const doDrop = args.includes("--drop");
const hours = Number(args[args.indexOf("--hours") + 1] ?? 6) || 6;

const client = new pg.Client({ connectionString: ADMIN });
await client.connect();
try {
  // The database folder's PG_VERSION is written when the database is made, so its time is the creation time (the
  // superuser can read it; otherwise the time is unknown and the database is never dropped).
  const { rows } = await client.query<{ name: string; made: Date | null; connected: number }>(
    `SELECT d.datname AS name,
            (SELECT (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification) AS made,
            (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS connected
       FROM pg_database d WHERE d.datname LIKE 'kumi\\_test\\_%' ORDER BY 2 NULLS FIRST, 1`);
  const cutoff = Date.now() - hours * 3600e3;
  const abandoned = rows.filter((r) => r.made && r.made.getTime() < cutoff && r.connected === 0);
  for (const r of rows) console.log(`${r.name}\t${r.made?.toISOString() ?? "unknown"}\t${r.connected} connected${abandoned.includes(r) ? "\tabandoned" : ""}`);
  console.log(`${rows.length} test database${rows.length === 1 ? "" : "s"}, ${abandoned.length} abandoned (older than ${hours} h, nobody connected)`);
  if (doDrop) {
    for (const r of abandoned) {
      if (!/^kumi_test_[a-z0-9_]+$/.test(r.name)) continue;
      await client.query(`DROP DATABASE IF EXISTS "${r.name}" WITH (FORCE)`);
      console.log(`dropped ${r.name}`);
    }
  } else if (abandoned.length) console.log("Run again with --drop to remove the abandoned ones.");
} finally { await client.end(); }
