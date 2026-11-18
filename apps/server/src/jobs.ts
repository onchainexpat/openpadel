// The 30-second jobs, one by one and each on its own: one that throws is logged and the rest still run (on 5 Nov
// 2026 a weekly court on an archived court threw on every run, and with one try around them all, the deadline
// charges, renewals, reminders, reconciliation and receipts after it stopped for the whole club). A job that fails
// three runs in a row tells the owner and managers once (ops job "jobs", like the backups); once every job works
// again they hear that once too. Before the club exists (a new server, between server-setup.sh and `setup apply`) they
// don't run at all: most read the club's settings and would only fail ("no result"), so the first doctor after setup
// would show a failure and the new owner's first email would be "working again".
import { jobFailed, jobWorked, type Db } from "@kumi/core";

export type JobStep = readonly [name: string, run: () => Promise<unknown>];
export interface JobsState { failing: Map<string, number>; clear: boolean }
export const newJobsState = (): JobsState => ({ failing: new Map(), clear: false });
/** Runs in a row before a failing job is said to the staff: one bad run (a deadlock tried again, a provider blip) isn't news. */
export const TELL_AFTER = 3;

export async function runJobs(db: Db, steps: readonly JobStep[], state: JobsState, o: { now?: Date; log?: (line: string) => void } = {}): Promise<{ failed: string[]; waiting?: true }> {
  const log = o.log ?? ((line: string) => console.error(line)), failed: string[] = [];
  // No club yet: nothing to do, and nothing to count as failing. A missing table (a database not migrated yet) is the same.
  const club = await db.selectFrom("club").select("name").limit(1).executeTakeFirst().catch((e) => { if (e?.code === "42P01") return undefined; throw e; });
  // A failure an older release counted then is cleared once, quietly (with no club, jobWorked tells nobody).
  if (!club) {
    state.failing.clear();
    if (!state.clear) await jobWorked(db, "jobs", {}, o.now).then(() => { state.clear = true; }).catch((x) => log(`jobs: ${(x as Error).message}`));
    return { failed, waiting: true };
  }
  for (const [name, step] of steps) {
    try { await step(); state.failing.delete(name); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`jobs: ${name}: ${error}`);
      failed.push(name);
      const runs = (state.failing.get(name) ?? 0) + 1;
      state.failing.set(name, runs);
      if (runs === TELL_AFTER) {
        await jobFailed(db, "jobs", `${name}: ${error}`, o.now).catch((x) => log(`jobs: telling the staff: ${(x as Error).message}`));
        state.clear = false;
      }
    }
  }
  // Every job worked this run and nothing is still counting: say so once (jobWorked tells the staff only after a failure).
  if (!failed.length && !state.failing.size && !state.clear) {
    await jobWorked(db, "jobs", {}, o.now).then(() => { state.clear = true; }).catch((x) => log(`jobs: ${(x as Error).message}`));
  }
  return { failed };
}
