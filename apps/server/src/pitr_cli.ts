// `kumi pitr ...` and `kumi restore --to`: point-in-time backups from the command line (pitr.ts).
//   kumi pitr conf                 pgBackRest's settings for this server, from its own (setup and updates write them)
//   kumi pitr tick [--now]         the base backups that are due (the hourly timer, as the postgres user)
//   kumi pitr status               how far back the archive reaches, and whether it's keeping up
//   kumi pitr extract --to="YYYY-MM-DD HH:MM" --out=<file> --yes [--repo=N] [--archive=<system id>]   the club's database as it was at that
//                                  minute (club time), dumped to a file (as the postgres user; `sudo kumi restore
//                                  --to` runs it, then restores that file the usual safe way)
//   kumi pitr test [--scheduled]   the monthly test: a random recent minute restored in scratch and checked
import { readFileSync } from "node:fs";
import { t, type Lang } from "@kumi/i18n";
import { connect, heartbeat, jobFailed, jobWorked, localParts } from "@kumi/core";
import { backupKey, clubTimeZone, dbNameOf, scheduledDue } from "./backups.ts";
import {
  archiveInfo, archiverFailing, archiverState, basePlan, baseBackups, baseSlot, checkTarget, clubMinute, confOffsite, confRepos, extractAt,
  offsiteArchivePath, PITR_CONF, pitrConf, STANZA, pitrTestRun, PitrRefused, restorableFrom, scratchBase, type ArchiveInfo,
} from "./pitr.ts";

type Env = Record<string, string | undefined>;
const show = (d: Date, tz: string) => { const p = localParts(d, tz), z = (n: number) => String(n).padStart(2, "0"); return `${p.y}-${z(p.m)}-${z(p.d)} ${z(p.h)}:${z(p.min)}`; };

/** The archive's summary kept with the job's record, so doctor (as the kumi user, who can't read the archive) can
 *  say how far back it reaches. */
function summary(info: ArchiveInfo, repos: number[], offsite: string) {
  const newest = Math.max(0, ...info.backups.map((b) => b.stop.getTime()));
  return { repos, offsite, backups: info.backups.length, newest_at: newest ? new Date(newest).toISOString() : null, restorable_from: restorableFrom(info)?.toISOString() ?? null,
    by_repo: repos.map((n) => ({ repo: n, from: restorableFrom(info, n)?.toISOString() ?? null, backups: info.backups.filter((b) => b.repo === n).length })) };
}

/** Whether the last record was made with these copies (a copy added since, offsite say, needs its first backup). */
const sameRepos = (details: Record<string, unknown>, repos: number[]) => JSON.stringify(details.repos ?? []) === JSON.stringify(repos);

/** The time a person asked for: --to="2026-11-03 14:05", or --to followed by it. */
export function toArg(args: string[]): string | undefined {
  const eq = args.find((a) => a.startsWith("--to="));
  if (eq) return eq.slice(5);
  const i = args.indexOf("--to");
  return i >= 0 ? args[i + 1] ?? "" : undefined;
}

export async function pitrMain(sub: string | undefined, args: string[], lang: Lang, json: boolean, env: Env = process.env): Promise<number> {
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  // A server several clubs share (kumi-hosted) has one archive for all of them: its own stanza and settings file.
  const conf = env.KUMI_PITR_CONF ?? PITR_CONF, stanza = env.KUMI_PITR_STANZA?.trim() || STANZA, at = { conf, stanza };
  const refused = (e: PitrRefused) => { if (json) out({ ok: false, refused: e.why, ...e.values }); else console.error(t(lang, `cli.pitr_${e.why}` as any, e.values)); return 2; };

  if (sub === "conf") {
    if (env.KUMI_PITR?.trim() === "0") return 3;   // turned off on this server: setup and updates leave pgBackRest alone
    const c = pitrConf(env, { backupKey: backupKey(env), systemId: env.KUMI_PITR_SYSTEM_ID?.trim() || null });
    process.stdout.write(c.text);
    return 0;
  }

  // What these make (a scratch copy of the club's database, a dump of it) is for the postgres user's eyes only,
  // whatever umask it was started with.
  process.umask(0o077);
  const db = connect();
  try {
    const tz = await clubTimeZone(db), dbname = dbNameOf(env.DATABASE_URL ?? "");
    if (sub === "tick") {
      let text: string;
      try { text = readFileSync(conf, "utf8"); } catch { if (json) out({ ok: true, set_up: false }); else console.log(t(lang, "cli.pitr_not_set_up")); return 0; }
      const repos = confRepos(text), now = new Date(), force = args.includes("--now");
      // Tonight's are done (and worked): nothing to ask the archive, so the hourly tick costs nothing offsite.
      const last = await heartbeat(db, "pitr");
      if (!force && last?.last_ok_at && !last.last_error && last.last_ok_at >= baseSlot(now, tz) && sameRepos(last.details, repos)) { if (json) out({ ok: true, due: [] }); return 0; }
      try {
        const before = await archiveInfo(at);
        const due = force ? repos.map((n) => ({ repo: n, type: before.backups.some((b) => b.repo === n && b.type === "full") ? "diff" as const : "full" as const })) : basePlan(before, repos, now, tz);
        if (!due.length) {
          await jobWorked(db, "pitr", { ...summary(before, repos, confOffsite(text)), taken: [] });
          if (json) out({ ok: true, due: [] });
          return 0;
        }
        const taken = await baseBackups(due, at);
        const info = await archiveInfo(at);
        await jobWorked(db, "pitr", { ...summary(info, repos, confOffsite(text)), taken });
        if (json) out({ ok: true, taken, restorable_from: restorableFrom(info)?.toISOString() ?? null });
        else console.log(t(lang, "cli.pitr_taken", { taken: taken.join(", "), from: restorableFrom(info) ? show(restorableFrom(info)!, tz) : "-" }));
        return 0;
      } catch (e) {
        await jobFailed(db, "pitr", (e as Error).message);
        if (json) out({ ok: false, error: (e as Error).message }); else console.error(t(lang, "cli.pitr_failed", { error: (e as Error).message }));
        return 1;
      }
    }
    if (sub === "status") {
      const a = await archiverState(db), hb = await heartbeat(db, "pitr"), d = (hb?.details ?? {}) as { restorable_from?: string | null; newest_at?: string | null; repos?: number[]; offsite?: string };
      const st = { archive_mode: a.mode, archiving: a.mode !== "on" ? "off" : archiverFailing(a) ? "failing" : "ok", last_archived_at: a.lastArchivedAt, last_failed_at: a.lastFailedAt, last_failed_wal: a.lastFailedWal,
        restorable_from: d.restorable_from ?? null, newest_base_backup_at: d.newest_at ?? null, copies: d.repos ?? [], offsite: d.offsite ?? null, last_error: hb?.last_error ?? null };
      if (json) { out({ ok: st.archiving === "ok" && !st.last_error, ...st }); return 0; }
      if (a.mode !== "on") { console.log(t(lang, "cli.pitr_off")); return 0; }
      console.log(t(lang, st.archiving === "ok" ? "cli.pitr_archiving_ok" : "cli.pitr_archiving_failing", { when: a.lastArchivedAt ? show(a.lastArchivedAt, tz) : "-", wal: a.lastFailedWal ?? "" }));
      console.log(d.restorable_from ? t(lang, "cli.pitr_reaches", { from: show(new Date(d.restorable_from), tz), copies: t(lang, (d.repos ?? []).includes(2) ? "cli.pitr_both_copies" : "cli.pitr_local_copy") }) : t(lang, "cli.pitr_no_base_yet"));
      if (hb?.last_error) console.log(t(lang, "cli.pitr_failed", { error: hb.last_error }));
      return 0;
    }
    if (sub === "extract") {
      // --archive=<system id>: an earlier server's offsite archive (its folder under <prefix>pitr/), after losing it.
      const to = toArg(args), file = flag("out"), repo = flag("repo") ? Number(flag("repo")) : undefined, archive = flag("archive");
      const archivePath = archive ? (/^\d+$/.test(archive) ? offsiteArchivePath(env, archive) : null) : undefined;
      if (archivePath === null) { console.error(t(lang, "cli.usage")); return 2; }
      if (to === undefined || !file) { console.error(t(lang, "cli.usage")); return 2; }
      try {
        const target = clubMinute(to, tz);
        if (!args.includes("--yes")) { console.error(t(lang, "cli.pitr_confirm", { time: to })); return 2; }
        const info = await archiveInfo({ ...at, ...(archivePath ? { archivePath } : {}) });
        checkTarget(target, info, new Date(), tz, archivePath ? 2 : repo);
        const r = await extractAt(target, dbname, file, { ...at, base: scratchBase(), ...(repo ? { repo } : {}), ...(archivePath ? { archivePath } : {}) });
        if (json) out({ ok: true, file, target: target.toISOString(), last_change: r.lastChange, seconds: r.seconds });
        else console.log(t(lang, "cli.pitr_extracted", { time: to, last: r.lastChange ? show(new Date(r.lastChange), tz) : "-", seconds: r.seconds }));
        return 0;
      } catch (e) {
        if (e instanceof PitrRefused) return refused(e);
        if (json) out({ ok: false, error: (e as Error).message }); else console.error(t(lang, "cli.pitr_failed", { error: (e as Error).message }));
        return 1;
      }
    }
    if (sub === "test") {
      if (args.includes("--scheduled")) {
        const d = await scheduledDue(db, "pitr_test");
        if (!d.due) { if (json) out({ ok: true, due: false, time_zone: d.tz }); return 0; }
      }
      try {
        const info = await archiveInfo(at);
        const r = await pitrTestRun(db, dbname, info, { ...at, base: scratchBase() });
        if (r.ok) await jobWorked(db, "pitr_test", { target: r.target, seconds: r.seconds, kept: r.kept });
        else await jobFailed(db, "pitr_test", `restored to ${r.target} but: ${r.problems.slice(0, 3).join("; ")}`);
        if (json) { out(r); return r.ok ? 0 : 1; }
        if (r.ok) console.log(t(lang, "cli.pitr_test_ok", { time: show(new Date(r.target), tz), seconds: r.seconds }));
        else { console.error(t(lang, "cli.pitr_test_bad", { time: show(new Date(r.target), tz) })); for (const p of r.problems) console.error(`  - ${p}`); }
        return r.ok ? 0 : 1;
      } catch (e) {
        const msg = e instanceof PitrRefused ? t(lang, `cli.pitr_${e.why}` as any, e.values) : (e as Error).message;
        // An archive less than ten minutes old has nothing to test yet: not a failure, nothing recorded.
        if (e instanceof PitrRefused && e.why === "too_new_to_test") { if (json) out({ ok: true, skipped: e.why, why: msg }); else console.log(msg); return 0; }
        await jobFailed(db, "pitr_test", msg);
        if (json) out({ ok: false, error: msg }); else console.error(t(lang, "cli.pitr_test_failed", { error: msg }));
        return 1;
      }
    }
  } finally { await db.destroy(); }
  console.log(t(lang, "cli.usage"));
  return 2;
}
