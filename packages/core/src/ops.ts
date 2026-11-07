// The server looking after itself: when its own jobs (the nightly backup, the offsite copy, the monthly restore
// test, the point-in-time archive's base backups and its monthly test) last ran and last worked, and what it watches (texts getting through, ask the club's model answering, the
// club's registered texting number). The owner and managers hear once when one starts failing, not again each
// time it keeps failing, and once more when it works again (its alert on Today closes by itself then).
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import type { Db } from "./db.ts";
import { uuidv7 } from "./ids.ts";

export type OpsJob = "backup" | "offsite" | "restore_test" | "pitr" | "pitr_test" | "texts" | "answers" | "texting_number" | "jobs" | "weekly_courts" | "restore_erase" | "restore_money" | "restore_unchecked" | "restore_disputed";
/** The scheduled jobs (backups); the rest are watched. */
export const OPS_JOBS: OpsJob[] = ["backup", "offsite", "restore_test", "pitr", "pitr_test"];
/** "restore_erase": accounts deleted again after a restore left something for a person to do (the last owner's role
 *  kept, money to give back at the desk): said once each time, nothing to clear. "restore_unchecked": a restore's look at
 *  the payment provider was cut short (payments_after_restore.ts): said once, until someone marks it handled.
 *  "restore_disputed": a card payment found after a restore and kept is disputed at the provider: said once each, likewise. "jobs": the server's 30-second jobs (apps/server/src/jobs.ts), one of which keeps failing. "weekly_courts": members'
 *  weekly courts (booking_series.ts), some of which keep failing while the job itself runs. */
const ALL_JOBS = ["backup", "offsite", "restore_test", "pitr", "pitr_test", "texts", "answers", "texting_number", "jobs", "weekly_courts", "restore_erase", "restore_money", "restore_unchecked", "restore_disputed"] as const;
/** What a restore left for a person to look at: nothing failed, so their alert says "after a restore", with what to do,
 *  not "failed" and kumi doctor (messages.ts, kind ops_restore_staff). */
export const RESTORE_JOBS: readonly OpsJob[] = ["restore_erase", "restore_money", "restore_unchecked", "restore_disputed"];
export const isRestoreJob = (job: string) => (RESTORE_JOBS as readonly string[]).includes(job);
/** Sentences joined while they fit (an alert's words are at most 300 characters): whole ones, never a word cut in half;
 *  a first one too long on its own is cut at a space, with an ellipsis. */
export function fitWords(parts: Text[], max = 300): Text {
  const fit = (lang: "en" | "es") => {
    let out = "";
    for (const part of parts.map((x) => x[lang].trim()).filter(Boolean)) {
      const next = out ? `${out} ${part}` : part;
      if (next.length <= max) { out = next; continue; }
      if (!out) { const cut = part.slice(0, max - 1), at = cut.lastIndexOf(" "); out = `${at > 0 ? cut.slice(0, at) : cut}…`; }
      break;
    }
    return out;
  };
  return { en: fit("en"), es: fit("es") };
}

export async function heartbeat(db: Db, name: OpsJob) {
  const r = await db.selectFrom("ops_heartbeat").selectAll().where("name", "=", name).executeTakeFirst();
  return r ? { ...r, details: (r.details ?? {}) as Record<string, unknown> } : null;
}
export async function heartbeats(db: Db) {
  const rows = await db.selectFrom("ops_heartbeat").selectAll().execute();
  return Object.fromEntries(rows.map((r) => [r.name, { ...r, details: (r.details ?? {}) as Record<string, unknown> }])) as Partial<Record<OpsJob, NonNullable<Awaited<ReturnType<typeof heartbeat>>>>>;
}

/** A job worked: when, and what to remember about it (the file it made, how big, the counts it checked). After
 *  a failure the owner and managers hear once that it works again. */
export async function jobWorked(db: Db, name: OpsJob, details: Record<string, unknown> = {}, now = new Date()): Promise<{ told: boolean }> {
  const before = await heartbeat(db, name);
  await db.insertInto("ops_heartbeat").values({ name, last_run_at: now, last_ok_at: now, last_error: null, details: JSON.stringify(details) })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_run_at: now, last_ok_at: now, last_error: null, details: JSON.stringify(details) })).execute();
  if (!before?.last_error || !(await db.selectFrom("club").select("name").executeTakeFirst())) return { told: false };
  await runAsSystem(db, "ops.report_cleared", { job: name }, "jobs", { now });
  return { told: true };
}

/** A job failed. The owner and managers hear about it once: when it was working before (or had never run).
 *  `words` is what went wrong in the staff's own language, when the server can say it better than an error. */
export async function jobFailed(db: Db, name: OpsJob, error: string, now = new Date(), words?: Text): Promise<{ told: boolean }> {
  const before = await heartbeat(db, name), text = error.split("\n")[0]!.slice(0, 300);
  await db.insertInto("ops_heartbeat").values({ name, last_run_at: now, last_ok_at: null, last_error: text })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_run_at: now, last_error: text })).execute();
  if (before?.last_error) return { told: false };
  // The club may not be set up yet (a fresh install backing up an empty database): nobody to tell.
  if (!(await db.selectFrom("club").select("name").executeTakeFirst())) return { told: false };
  await runAsSystem(db, "ops.report_failure", { job: name, error: text, ...(words ? { words } : {}) }, "jobs", { now });
  return { told: true };
}

const words = z.object({ en: z.string().check(z.maxLength(300)), es: z.string().check(z.maxLength(300)) });
export const opsReportFailure = defineAction({
  name: "ops.report_failure", version: 1, system: true, internal: true,
  input: z.object({ job: z.enum(ALL_JOBS), error: z.string().check(z.maxLength(300)), words: z.optional(words) }),
  async plan(_ctx, i) {
    return { title: both("action.ops.report_failure"), summary: both("plan.ops.report_failure", { job: both(`ops.job_${i.job}`) }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.emit("ops.failed", { job: i.job, error: i.error, ...(i.words ? { words: i.words } : {}) }); return null; },
});

/** It works again: its open alert on Today needs nobody now (closed with no one's name), and staff hear so once. */
export const opsReportCleared = defineAction({
  name: "ops.report_cleared", version: 1, system: true, internal: true,
  input: z.object({ job: z.enum(ALL_JOBS) }),
  async plan(_ctx, i) {
    return { title: both("action.ops.report_cleared"), summary: both("plan.ops.report_cleared", { job: both(`ops.job_${i.job}`) }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const kind = isRestoreJob(i.job) ? "ops_restore_staff" : "ops_failed_staff";
    const open = await ctx.trx.selectFrom("event_outbox").select("event_outbox.id").where("event_outbox.topic", "=", "ops.failed")
      .where(sql<string>`event_outbox.payload->>'job'`, "=", i.job)
      .where((eb) => eb.not(eb.exists(eb.selectFrom("staff_alert").select("staff_alert.id").whereRef("staff_alert.event_id", "=", "event_outbox.id").where("staff_alert.kind", "=", kind))))
      .execute();
    for (const e of open) await ctx.insert("staff_alert", { id: uuidv7(), event_id: e.id, kind, handled_by: null, handled_at: ctx.now });
    await ctx.emit("ops.cleared", { job: i.job });
    return null;
  },
});
