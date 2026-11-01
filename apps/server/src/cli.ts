// kumi: the command line a club owner, or the owner's agent, runs on the server. Nothing prompts, every
// command takes --json, and none of them prints a secret.
//   kumi setup plan [club.yaml]    what setting the club up from the file would change (changes nothing)
//   kumi setup apply [club.yaml]   make those changes; run it again after editing the file
//   kumi import members <file.csv> [--apply]   members from a spreadsheet (a preview unless --apply)
//   kumi doctor                    is everything working? each check, and the next step when it isn't
//   kumi reset-sign-in <email>     start someone's second sign-in step over (a lost phone; an owner locked out)
//   kumi backup [--label=<name>]   tonight's backup now: the dump and its manifest, and the offsite copy if set up
//   kumi offsite                   what's kept offsite
//   kumi restore <file|offsite:latest|offsite:<key>> --yes   replace the database with a backup (server stopped)
//   kumi restore-test              restore the newest backup into a scratch database and check it
//   kumi rotate-key                seal every secret with KUMI_SECRET_KEY (the old one in KUMI_SECRET_KEY_PREVIOUS)
//   (on a one-server install, as root: kumi update <release.tar>, kumi rollback --yes, kumi releases)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t, pickLang, type Lang, type Text } from "@kumi/i18n";
import { connect, migrate, plan, resealAll, run, runAsSystem, secretKeyStatus, setSecretKeys } from "@kumi/core";
import { backupKey, fetchOffsite, makeBackup, nightlyBackup, offsiteLatest, offsitePrefix, readableDump, restoreInto, restoreTest } from "./backups.ts";
import { S3Client, s3FromEnv } from "./s3.ts";
import { readPeopleCsv } from "./csv.ts";
import { doctor, type Check } from "./doctor.ts";
import { ClubFileError, ownerActor, readClubFile, setupClub } from "./setup.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const langArg = args.find((a) => a.startsWith("--lang="))?.slice(7);
const [cmd, sub, ...rest] = args.filter((a) => !a.startsWith("--"));
const lang: Lang = pickLang(langArg ?? process.env.KUMI_LANG ?? process.env.LANG?.slice(0, 2), "en");
const say = (x: Text) => x[lang];
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const backupDir = process.env.KUMI_BACKUP_DIR ?? "/var/backups/kumi";
const dbUrl = () => { const u = process.env.DATABASE_URL; if (!u) throw new Error("DATABASE_URL isn't set"); return u; };
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main(): Promise<number> {
  if (cmd === "setup" && (sub === "plan" || sub === "apply")) {
    // A relative path is from where the person ran kumi (the server's wrapper runs it from the app's folder).
    const path = resolve(process.env.KUMI_CALLER_DIR ?? ".", rest[0] ?? process.env.KUMI_CLUB_FILE ?? "club.yaml");
    let file;
    try { file = readClubFile(path); }
    catch (e) {
      if (!(e instanceof ClubFileError)) throw e;
      if (json) out({ ok: false, file: path, problems: e.problems });
      else { console.error(t(lang, "cli.file_problems", { file: path })); for (const p of e.problems) console.error(`  - ${p}`); }
      return 2;
    }
    const db = connect();
    try {
      await migrate(db);
      const r = await setupClub(db, file, { apply: sub === "apply", lang });
      if (json) { out({ ok: true, applied: r.applied, steps: r.steps.map((s) => ({ action: s.action, text: say(s.text) })), notes: r.notes.map(say) }); return 0; }
      for (const n of r.notes) console.log(`! ${say(n)}`);
      if (!r.steps.length) { console.log(t(lang, "cli.nothing_to_do", { file: path })); return 0; }
      console.log(t(lang, r.applied ? "cli.applied_heading" : "cli.plan_heading", { file: path }));
      for (const s of r.steps) console.log(`  - ${say(s.text)}`);
      console.log(r.applied ? t(lang, "cli.applied", { changes: t(lang, "count.changes", { count: r.steps.length }) }) : t(lang, "cli.apply_hint", { file: path }));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "import" && sub === "members" && rest[0]) {
    const path = resolve(process.env.KUMI_CALLER_DIR ?? ".", rest[0]);
    const r = readPeopleCsv(readFileSync(path, "utf8"));
    const problems = r.problems.map((p) => say(p.text));
    if (r.fatal) { if (json) out({ ok: false, problems: [say(r.fatal), ...problems] }); else { console.error(say(r.fatal)); for (const p of problems) console.error(`  - ${p}`); } return 2; }
    const db = connect();
    try {
      const owner = await ownerActor(db, lang);
      if (!owner) { console.error(t(lang, "doctor.club.missing")); return 2; }
      const apply = args.includes("--apply");
      const res = apply ? await run(db, "person.import", { rows: r.rows }, owner) : await plan(db, "person.import", { rows: r.rows }, owner);
      if (json) { out({ ok: true, applied: apply, summary: say(res.plan.summary), problems }); return 0; }
      for (const p of problems) console.log(`! ${p}`);
      console.log(say(res.plan.summary));
      const added = (res as { result?: { added?: number } }).result?.added ?? 0;
      console.log(apply ? t(lang, "cli.imported", { people: t(lang, "count.people", { count: added }) }) : t(lang, "cli.import_hint", { file: rest[0] }));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "doctor") {
    const db = connect();
    try {
      const checks: Check[] = await doctor(db);
      const bad = checks.filter((c) => c.state === "fail").length;
      if (json) { out({ ok: bad === 0, checks: checks.map((c) => ({ id: c.id, state: c.state, text: say(c.text), ...(c.doc ? { doc: c.doc } : {}) })) }); return bad ? 1 : 0; }
      const mark = { ok: "ok  ", warn: "WARN", fail: "FAIL", off: "off " } as const;
      for (const c of checks) console.log(`${mark[c.state]}  ${say(c.text)}${c.doc && c.state !== "ok" ? `  (${c.doc})` : ""}`);
      console.log(t(lang, bad ? "cli.doctor_bad" : "cli.doctor_good", { count: bad }));
      return bad ? 1 : 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "reset-sign-in" && sub) {
    const db = connect();
    try {
      const person = await db.selectFrom("person").select(["id", "display_name"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", sub.trim().toLowerCase())).where("status", "!=", "archived").executeTakeFirst();
      if (!person) { if (json) out({ ok: false }); else console.error(t(lang, "cli.no_person", { email: sub })); return 2; }
      const r = await runAsSystem(db, "person.reset_sign_in", { person_id: person.id }, "cli");
      if (json) { out({ ok: true, summary: say(r.plan.summary) }); return 0; }
      console.log(say(r.plan.summary));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "backup") {
    const db = connect();
    try {
      const label = flag("label");
      if (label && !/^[A-Za-z0-9._-]+$/.test(label)) { console.error(t(lang, "cli.bad_label")); return 2; }
      // A labelled dump (before an update, say) stays here: it isn't tonight's backup and doesn't go offsite.
      const r = label ? { file: (await makeBackup(db, { url: dbUrl(), dir: backupDir, label })).file, offsite: null }
        : await nightlyBackup(db, { url: dbUrl(), dir: backupDir, s3: s3FromEnv(process.env) });
      if (json) { out({ ok: true, file: r.file, offsite: r.offsite }); return 0; }
      console.log(t(lang, "cli.backup_done", { file: r.file }));
      console.log(r.offsite ? t(lang, "cli.backup_offsite", { key: r.offsite.key }) : t(lang, "cli.backup_no_offsite"));
      return 0;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message }); else console.error(t(lang, "cli.backup_failed", { error: (e as Error).message }));
      return 1;
    } finally { await db.destroy(); }
  }
  if (cmd === "offsite") {
    const cfg = s3FromEnv(process.env);
    if (!cfg) { if (json) out({ ok: false, on: false }); else console.log(t(lang, "cli.offsite_off")); return 0; }
    const objects = (await new S3Client(cfg).list(offsitePrefix())).sort((a, b) => a.key.localeCompare(b.key));
    if (json) { out({ ok: true, bucket: cfg.bucket, objects }); return 0; }
    console.log(t(lang, "cli.offsite_list", { count: objects.length, bucket: cfg.bucket }));
    for (const o of objects) console.log(`  ${o.key}  ${(o.size / 1048576).toFixed(1)} MB  ${o.lastModified}`);
    return 0;
  }
  if (cmd === "restore" && sub) {
    const source = sub;
    if (!args.includes("--yes")) { console.error(t(lang, "cli.restore_confirm", { source })); return 2; }
    let got: { file: string; cleanup: () => void };
    try {
      if (source.startsWith("offsite:")) {
        const cfg = s3FromEnv(process.env), key = backupKey();
        if (!cfg) { console.error(t(lang, "cli.offsite_off")); return 2; }
        if (!key) { console.error(t(lang, "cli.restore_no_backup_key")); return 2; }
        const s3 = new S3Client(cfg);
        let objectKey = source.slice("offsite:".length);
        if (objectKey === "latest") {
          const latest = await offsiteLatest(s3, offsitePrefix());
          if (!latest) { console.error(t(lang, "cli.restore_none_offsite")); return 2; }
          objectKey = latest.dump;
        }
        got = await fetchOffsite(s3, objectKey, key);
      } else got = readableDump(resolve(process.env.KUMI_CALLER_DIR ?? ".", source));
      try { await restoreInto(dbUrl(), got.file); } finally { got.cleanup(); }
      if (json) out({ ok: true, source }); else console.log(t(lang, "cli.restore_done", { source }));
      return 0;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message }); else console.error(t(lang, "cli.restore_failed", { error: (e as Error).message }));
      return 1;
    }
  }
  if (cmd === "restore-test") {
    const db = connect();
    try {
      const cfg = s3FromEnv(process.env);
      const r = await restoreTest(db, { liveUrl: dbUrl(), dir: backupDir, s3: cfg ? new S3Client(cfg) : null, key: backupKey(), prefix: offsitePrefix() });
      if (json) { out(r); return r.ok ? 0 : 1; }
      if (r.ok) console.log(t(lang, "cli.restore_test_ok", { source: r.source, tables: r.tables, rows: r.rows, against: t(lang, r.compared === "manifest" ? "cli.against_manifest" : "cli.against_live") }));
      else { console.error(t(lang, "cli.restore_test_bad", { source: r.source })); for (const p of r.problems) console.error(`  - ${p}`); }
      return r.ok ? 0 : 1;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message }); else console.error(t(lang, "cli.restore_test_failed", { error: (e as Error).message }));
      return 1;
    } finally { await db.destroy(); }
  }
  if (cmd === "rotate-key") {
    if (!process.env.KUMI_SECRET_KEY?.trim()) { console.error(t(lang, "cli.rotate_no_key")); return 2; }
    setSecretKeys({ current: process.env.KUMI_SECRET_KEY, previous: process.env.KUMI_SECRET_KEY_PREVIOUS });
    const db = connect();
    try {
      const r = await resealAll(db);
      if (json) { out({ ok: r.unreadable === 0, ...r, key: secretKeyStatus().current }); return r.unreadable ? 1 : 0; }
      console.log(t(lang, "cli.rotate_done", { sealed: r.sealed, resealed: r.resealed, current: r.current }));
      if (r.unreadable) { console.error(t(lang, "cli.rotate_unreadable", { count: r.unreadable })); return 1; }
      return 0;
    } finally { await db.destroy(); }
  }
  console.log(t(lang, "cli.usage"));
  return cmd ? 2 : 0;
}

process.exitCode = await main();
