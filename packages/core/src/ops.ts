// The server looking after itself: when its own jobs (the nightly backup, the offsite copy, the monthly restore
// test) last ran and last worked, and telling the owner and managers once when one starts failing. Not again
// each night it keeps failing; again only after it has worked in between.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import type { Db } from "./db.ts";

export type OpsJob = "backup" | "offsite" | "restore_test";
export const OPS_JOBS: OpsJob[] = ["backup", "offsite", "restore_test"];

export async function heartbeat(db: Db, name: OpsJob) {
  const r = await db.selectFrom("ops_heartbeat").selectAll().where("name", "=", name).executeTakeFirst();
  return r ? { ...r, details: (r.details ?? {}) as Record<string, unknown> } : null;
}
export async function heartbeats(db: Db) {
  const rows = await db.selectFrom("ops_heartbeat").selectAll().execute();
  return Object.fromEntries(rows.map((r) => [r.name, { ...r, details: (r.details ?? {}) as Record<string, unknown> }])) as Partial<Record<OpsJob, NonNullable<Awaited<ReturnType<typeof heartbeat>>>>>;
}

/** A job worked: when, and what to remember about it (the file it made, how big, the counts it checked). */
export async function jobWorked(db: Db, name: OpsJob, details: Record<string, unknown> = {}, now = new Date()) {
  await db.insertInto("ops_heartbeat").values({ name, last_run_at: now, last_ok_at: now, last_error: null, details: JSON.stringify(details) })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_run_at: now, last_ok_at: now, last_error: null, details: JSON.stringify(details) })).execute();
}

/** A job failed. The owner and managers hear about it once: when it was working before (or had never run). */
export async function jobFailed(db: Db, name: OpsJob, error: string, now = new Date()): Promise<{ told: boolean }> {
  const before = await heartbeat(db, name), text = error.split("\n")[0]!.slice(0, 300);
  await db.insertInto("ops_heartbeat").values({ name, last_run_at: now, last_ok_at: null, last_error: text })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_run_at: now, last_error: text })).execute();
  if (before?.last_error) return { told: false };
  // The club may not be set up yet (a fresh install backing up an empty database): nobody to tell.
  if (!(await db.selectFrom("club").select("name").executeTakeFirst())) return { told: false };
  await runAsSystem(db, "ops.report_failure", { job: name, error: text }, "jobs", { now });
  return { told: true };
}

export const opsReportFailure = defineAction({
  name: "ops.report_failure", version: 1, system: true, internal: true,
  input: z.object({ job: z.enum(["backup", "offsite", "restore_test"]), error: z.string().check(z.maxLength(300)) }),
  async plan(_ctx, i) {
    return { title: both("action.ops.report_failure"), summary: both("plan.ops.report_failure", { job: both(`ops.job_${i.job}`) }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.emit("ops.failed", { job: i.job, error: i.error }); return null; },
});
