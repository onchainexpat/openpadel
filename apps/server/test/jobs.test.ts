// The 30-second jobs run each on its own (jobs.ts): one that throws doesn't stop the ones after it, and one that
// keeps failing is said to the staff once, and once more when every job works again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { heartbeat, messageHandlers, processOutbox, runAsSystem, type Db } from "@kumi/core";
import { newJobsState, runJobs, TELL_AFTER, type JobStep } from "../src/jobs.ts";

let db: Db, drop: () => Promise<void>;
const NOW = new Date("2026-11-05T19:00:00Z");
before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
});
after(async () => drop());

test("a job that throws doesn't stop the next; one that keeps failing is said once; working again is said once", async () => {
  const ran: string[] = [], logged: string[] = [];
  let broken = true;
  const steps: JobStep[] = [
    ["weekly courts", async () => { ran.push("weekly courts"); if (broken) throw new Error("error.not_found"); }],
    ["shared bookings", async () => { ran.push("shared bookings"); }],
    ["receipts", async () => { ran.push("receipts"); }],
  ];
  const state = newJobsState(), log = (l: string) => logged.push(l);
  for (let i = 0; i < TELL_AFTER + 2; i++) {
    const r = await runJobs(db, steps, state, { now: new Date(NOW.getTime() + i * 30_000), log });
    assert.deepEqual(r.failed, ["weekly courts"]);
  }
  assert.equal(ran.filter((n) => n === "receipts").length, TELL_AFTER + 2, "the jobs after the broken one ran every time");
  assert.equal(logged.filter((l) => l === "jobs: weekly courts: error.not_found").length, TELL_AFTER + 2, "each failure is in the log");
  assert.equal((await heartbeat(db, "jobs"))!.last_error, "weekly courts: error.not_found");
  await processOutbox(db, messageHandlers);
  const failed = await db.selectFrom("outbound_message").select(["subject", "body"]).where("kind", "=", "ops_failed_staff").where("channel", "=", "email").execute();
  assert.equal(failed.length, 1, "the owner told once, not every run");
  assert.match(failed[0]!.body!, /the server's regular jobs \(reminders, charges at their deadlines, renewals, receipts\) failed: weekly courts: error\.not_found/);

  broken = false;
  await runJobs(db, steps, state, { now: new Date(NOW.getTime() + 10 * 30_000), log });
  await runJobs(db, steps, state, { now: new Date(NOW.getTime() + 11 * 30_000), log });
  assert.equal((await heartbeat(db, "jobs"))!.last_error, null);
  await processOutbox(db, messageHandlers);
  const cleared = await db.selectFrom("outbound_message").select("subject").where("kind", "=", "ops_cleared_staff").where("channel", "=", "email").execute();
  assert.equal(cleared.length, 1, "working again said once");
});

test("a single bad run isn't news: nothing is said before it fails three runs in a row", async () => {
  await db.deleteFrom("outbound_message").execute(); await db.deleteFrom("ops_heartbeat").execute();
  let fail = 0;
  const steps: JobStep[] = [["payments", async () => { if (fail-- > 0) throw new Error("deadlock detected"); }]];
  const state = newJobsState();
  fail = TELL_AFTER - 1;
  for (let i = 0; i < TELL_AFTER + 1; i++) await runJobs(db, steps, state, { now: new Date(NOW.getTime() + i * 30_000), log: () => {} });
  assert.equal((await heartbeat(db, "jobs"))?.last_error ?? null, null);
  await processOutbox(db, messageHandlers);
  assert.equal((await db.selectFrom("outbound_message").select("id").where("kind", "in", ["ops_failed_staff", "ops_cleared_staff"]).execute()).length, 0);
});

test("before the club exists the jobs don't run, fail or say anything; the first round after setup is clean", async () => {
  const { db: empty, drop: dropEmpty } = await freshDb();
  try {
    const logged: string[] = [];
    let ran = 0;
    // As the real jobs do before there's a club: they read its settings and find none.
    const steps: JobStep[] = [["questions", async () => { ran++; await empty.selectFrom("club").select("question_alert_hours").executeTakeFirstOrThrow(); }]];
    const state = newJobsState();
    // An older release's failure from before the club existed is cleared, quietly.
    await empty.insertInto("ops_heartbeat").values({ name: "jobs", last_run_at: NOW, last_ok_at: null, last_error: "questions: no result" }).execute();
    for (let i = 0; i < TELL_AFTER + 2; i++) {
      const r = await runJobs(empty, steps, state, { now: new Date(NOW.getTime() + i * 30_000), log: (l) => logged.push(l) });
      assert.deepEqual(r.failed, []); assert.equal(r.waiting, true);
    }
    assert.equal(ran, 0, "nothing ran without a club");
    assert.equal(logged.length, 0, "nothing in the log every 30 seconds");
    assert.equal((await heartbeat(empty, "jobs"))?.last_error ?? null, null);

    await runAsSystem(empty, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
    const r = await runJobs(empty, steps, state, { now: new Date(NOW.getTime() + 10 * 30_000), log: (l) => logged.push(l) });
    assert.deepEqual(r.failed, []); assert.equal(ran, 1);
    assert.equal((await heartbeat(empty, "jobs"))?.last_error ?? null, null);
    await processOutbox(empty, messageHandlers);
    const told = await empty.selectFrom("outbound_message").select("kind").where("kind", "in", ["ops_failed_staff", "ops_cleared_staff"]).execute();
    assert.equal(told.length, 0, "no 'working again' email for the new owner");
  } finally { await dropEmpty(); }
});
