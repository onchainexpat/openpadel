// A real restore, then the jobs: what the jobs make again, because its "already said" record was newer than the
// backup, doesn't go twice (repeats.ts, after_restore.ts). Three kinds: the owner's leaving reminder (a
// leaving_notice row), the owner's notice that support access ended (support_grant.end_told_at) and scheduled club
// news (broadcast.sent_at). Needs pg_dump and pg_restore 17, like backups.test.ts; skipped without them unless
// KUMI_REQUIRE_PG_TOOLS=1 (CI). Every time is built from today, since the outbox tells nobody about old events.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { expireSupport, localDate, messageHandlers, onDate, processOutbox, registerMessageTopics, remindLeaving, run, runAsSystem, sendBroadcasts, sendEmails,
  type Actor, type Db, type Mail } from "@kumi/core";
import { makeBackup, pgTool, safeRestore } from "../src/backups.ts";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";

const TZ = "America/Los_Angeles";
const env = { ...process.env, KUMI_BACKUP_KEY: Buffer.alloc(32, 7).toString("base64") };
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = localDate(new Date(), TZ);
const at10 = (days: number) => onDate(addDays(TODAY, days), "10:00", TZ);
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
let db: Db, drop: () => Promise<void>, url: string, dir: string, owner: Actor, ann: string;

/** Every email waiting by then goes to a mailer that keeps them: who to, and the subject. */
async function mail(now: Date): Promise<string[]> {
  const sent: Mail[] = [];
  await processOutbox(db, messageHandlers);
  await sendEmails(db, { send: async (m: Mail) => { sent.push(m); } }, now, 200);
  return sent.map((m) => `${m.to}: ${m.subject}`).sort();
}

before(async () => {
  if (skip) return;
  ({ db, drop } = await freshDb());
  url = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
  dir = mkdtempSync(join(tmpdir(), "kumi-repeats-"));
  await registerMessageTopics(db, new Date(Date.now() - 60_000));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  ann = ((await run(db, "person.create", { display_name: "Ann Avery", email: "ann@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "consent.club_news", { person_id: ann, granted: true }, { personId: ann, via: "test", lang: "en" });
});
after(async () => { if (skip) return; await drop(); rmSync(dir, { recursive: true, force: true }); });

test("after a real restore, the jobs make three notices again; none goes twice, and what's new still goes", { skip }, async () => {
  const T0 = at10(1);
  // The state the backup catches: the club's Kumi ends in 10 days, support access for a day, club news set for later.
  await runAsSystem(db, "club.leaving", { on: addDays(TODAY, 11), kept_days: 30 }, "test", { now: T0 });
  await run(db, "support.grant", { email: "ada@help.test", name: "Ada", reason: "Looking at the booking rules", level: "view", hours: 24 }, owner, { now: T0 });
  await run(db, "broadcast.send", { purpose: "club_news", filters: {}, subject_en: "Courts resurfaced", body_en: "All four courts are new.",
    subject_es: "Canchas renovadas", body_es: "Las cuatro canchas son nuevas.", send_at: at10(3).toISOString() }, owner, { now: T0 });
  await mail(hours(T0, 1));   // what had been said by then went
  const made = await makeBackup(db, { url, dir, now: hours(T0, 1), env, label: "repeats" });

  // After the backup: the week's reminder, support access ending, the club news. Each goes once.
  const T1 = at10(5);
  assert.equal(await remindLeaving(db, T1), "week");
  assert.equal(await expireSupport(db, T1), 1);
  assert.deepEqual(await sendBroadcasts(db, T1), { sent: 1 });
  const first = await mail(hours(T1, 1));
  const expected = ["ann@example.test: Courts resurfaced", "robin@example.test: Support access ended: Ada", "robin@example.test: Copy: Courts resurfaced"];
  for (const e of expected) assert.ok(first.includes(e), `went before the restore: ${e} (went: ${first.join(" | ")})`);
  assert.ok(first.some((m) => m.startsWith("robin@example.test: ") && /openPadel ends on/.test(m)), `the week's reminder went (went: ${first.join(" | ")})`);
  const sentBefore = await db.selectFrom("outbound_message").select(["kind", "person_id", "sent_at"]).where("channel", "=", "email").where("status", "=", "sent")
    .where("sent_at", ">", hours(T0, 1)).execute();

  // Restored to the backup two hours later: none of the three records is there, so the jobs make all three again.
  const T2 = hours(T1, 2);
  const sent = await readSentBefore(url);
  await safeRestore(url, made.file, { dir });
  const r = await afterRestore(url, sent, T2);
  assert.equal(r.vouched, true);
  assert.equal(r.carried.repeats, first.length, "every email sent since the backup is kept as a fingerprint");
  assert.equal(await remindLeaving(db, T2), "week", "the job makes the week's reminder again");
  assert.equal(await expireSupport(db, T2), 1, "and the ended notice");
  assert.deepEqual(await sendBroadcasts(db, T2), { sent: 1 }, "and sends the club news again");
  assert.deepEqual(await mail(hours(T2, 1)), [], "but no email goes twice");
  // Each made again took the earlier answer: sent, when it went before the restore.
  const again = await db.selectFrom("outbound_message").select(["kind", "person_id", "status", "sent_at"]).where("channel", "=", "email").where("sent_at", ">", hours(T0, 1)).execute();
  assert.equal(again.length, sentBefore.length);
  for (const m of again) {
    assert.equal(m.status, "sent");
    assert.ok(sentBefore.some((b) => b.kind === m.kind && b.person_id === m.person_id && b.sent_at!.getTime() === m.sent_at!.getTime()), `${m.kind} keeps its earlier time`);
  }
  const used = await db.selectFrom("sent_before_restore").select((e) => e.fn.count<string>("used_by").as("n")).executeTakeFirstOrThrow();
  assert.equal(Number(used.n), first.length);

  // What's new goes: club news with other words, and the reminder the day before.
  await run(db, "broadcast.send", { purpose: "club_news", filters: {}, subject_en: "Lights fixed", body_en: "Court 3's lights work again.",
    subject_es: "Luces arregladas", body_es: "Las luces de la cancha 3 funcionan otra vez." }, owner, { now: hours(T2, 2) });
  assert.equal(await remindLeaving(db, at10(10)), "day");
  const later = await mail(hours(at10(10), 1));
  assert.ok(later.includes("ann@example.test: Lights fixed"), later.join(" | "));
  assert.ok(later.some((m) => m.startsWith("robin@example.test: ") && /openPadel ends/.test(m)), later.join(" | "));
});
