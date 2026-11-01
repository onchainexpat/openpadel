// /health/deep: how the server is really doing, for the owner and whoever looks after the server. The database,
// how far behind the outbox is, the last backup, its offsite copy and the last restore test, and disk space.
// Only from the server itself (no proxy in between) or for an owner or manager signed in: it says where the
// backups are and what failed, which is nobody else's business. /health stays cheap and open.
import { statfsSync } from "node:fs";
import type { Context } from "hono";
import { sql } from "kysely";
import { heartbeats, KumiError, MAX_ATTEMPTS, type Db } from "@kumi/core";
import { newestLocalAge } from "./backups.ts";
import { handledTopics } from "./outbox.ts";
import { s3FromEnv } from "./s3.ts";
import { REVISION, VERSION } from "./version.ts";

type Env = Record<string, string | undefined>;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** A request straight from this machine: a loopback address and no proxy's forwarding header. */
export function fromThisServer(c: Context<any>): boolean {
  const remote: string | undefined = c.env?.incoming?.socket?.remoteAddress;
  return Boolean(remote && LOOPBACK.has(remote) && !c.req.header("x-forwarded-for") && !c.req.header("x-forwarded-host"));
}

function disk(path: string) {
  try { const s = statfsSync(path); return { path, free_mb: Math.round((s.bavail * s.bsize) / 1048576), total_mb: Math.round((s.blocks * s.bsize) / 1048576) }; }
  catch { return { path, free_mb: null, total_mb: null }; }
}

export async function deepHealth(db: Db, o: { env?: Env; now?: Date; backupDir?: string } = {}) {
  const env = o.env ?? process.env, now = o.now ?? new Date(), dir = o.backupDir ?? env.KUMI_BACKUP_DIR ?? "/var/backups/kumi";
  const problems: string[] = [];
  let database: { ok: boolean; ms: number | null; error?: string };
  const t0 = Date.now();
  try { await sql`SELECT 1`.execute(db); database = { ok: true, ms: Date.now() - t0 }; }
  catch (e) { database = { ok: false, ms: null, error: (e as Error).message.split("\n")[0] }; problems.push("database"); }
  if (!database.ok) return { ok: false, version: VERSION, revision: REVISION, database, problems };

  // Only events the worker picks up: one nobody handles (club.set_up, say) waits forever and is no sign of
  // trouble. One it gave up on after every retry is, for a week.
  const waiting = db.selectFrom("event_outbox").where("delivered_at", "is", null).where("topic", "in", handledTopics);
  const oldestEvent = (await waiting.select((e) => e.fn.min("created_at").as("at")).where("attempts", "<", MAX_ATTEMPTS).executeTakeFirst())?.at ?? null;
  const givenUp = Number((await waiting.select((e) => e.fn.countAll().as("n")).where("attempts", ">=", MAX_ATTEMPTS)
    .where("created_at", ">", new Date(now.getTime() - 7 * 86_400_000)).executeTakeFirst())?.n ?? 0);
  const oldestMessage = (await sql<{ at: Date | null }>`SELECT min(send_after) AS at FROM outbound_message WHERE status = 'waiting' AND send_after <= ${now}`.execute(db)).rows[0]?.at ?? null;
  const lag = (d: Date | string | null) => (d ? Math.round((now.getTime() - new Date(d).getTime()) / 1000) : 0);
  const outbox = { events_behind_s: lag(oldestEvent), events_given_up: givenUp, messages_behind_s: lag(oldestMessage) };
  if (outbox.events_behind_s > 600 || givenUp > 0 || outbox.messages_behind_s > 900) problems.push("outbox");

  const hb = await heartbeats(db), hours = (d: Date | null | undefined) => (d ? Math.round((now.getTime() - new Date(d).getTime()) / 360_000) / 10 : null);
  const job = (name: "backup" | "offsite" | "restore_test") => {
    const h = hb[name];
    return { last_run_hours: hours(h?.last_run_at), last_ok_hours: hours(h?.last_ok_at), error: h?.last_error ?? null, details: h?.details ?? null };
  };
  const localAge = newestLocalAge(dir, now);
  const backup = { ...job("backup"), newest_file_hours: localAge === null ? null : Math.round(localAge * 10) / 10, dir };
  if (backup.error || localAge === null || localAge > 36) problems.push("backup");
  const offsiteOn = Boolean(s3FromEnv(env));
  const offsite = { on: offsiteOn, ...job("offsite") };
  if (offsiteOn && (offsite.error || offsite.last_ok_hours === null || offsite.last_ok_hours > 36)) problems.push("offsite");
  const restore = job("restore_test");
  if (restore.error || (restore.last_ok_hours !== null && restore.last_ok_hours > 40 * 24)) problems.push("restore_test");

  const disks = [disk(dir), disk(process.cwd())];
  if (disks.some((d) => d.free_mb !== null && d.total_mb !== null && d.free_mb < Math.max(1024, d.total_mb * 0.1))) problems.push("disk");
  return { ok: problems.length === 0, version: VERSION, revision: REVISION, database, outbox, backup, offsite, restore_test: restore, disks, problems };
}

/** Who may read /health/deep: this machine itself, or a signed-in owner or manager. */
export async function mayReadDeepHealth(db: Db, c: Context<any>, personId: string | null): Promise<void> {
  if (fromThisServer(c)) return;
  if (!personId) throw new KumiError("error.signed_out", {}, 401);
  const r = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager"]).executeTakeFirst();
  if (!r) throw new KumiError("error.staff_only", {}, 403);
}
