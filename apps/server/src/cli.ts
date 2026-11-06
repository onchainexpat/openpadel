// kumi: the command line a club owner, or the owner's agent, runs on the server. Nothing prompts, every
// command takes --json, and none of them prints a secret.
//   kumi setup plan [club.yaml]    what setting the club up from the file would change (changes nothing)
//   kumi setup apply [club.yaml]   make those changes; run it again after editing the file
//   kumi import members <file.csv> [--apply]   members from a spreadsheet (a preview unless --apply)
//   kumi doctor                    is everything working? each check, and the next step when it isn't
//   kumi reset-sign-in <email>     start someone's second sign-in step over (a lost phone; an owner locked out)
//   kumi owner add <email> [--yes] give someone the owner role (a club left with no owner who can sign in)
//   kumi backup [--label=<name>]   tonight's backup now: the dump and its manifest, and the offsite copy if set up
//                                  (--scheduled: only when it's due, 3:17 on the club's clock; the hourly timer runs this)
//   kumi offsite                   what's kept offsite
//   kumi restore <file|offsite:latest|offsite:<key>> --yes   replace the database with a backup (server stopped), or
//                                  with a club's export (kumi-export-*.kumi, from kumi export or the staff app's
//                                  "Download everything"): asks for its passphrase, or reads it from what's piped in
//   kumi export [--out=<folder>]   the club's export: everything it needs to run somewhere else (export.ts), sealed
//                                  with a passphrase typed at the prompt (or piped in); never printed
//   kumi read-only on|off|status   the host's switch for an account that isn't paid (read_only.ts)
//   kumi moved on [--to=<url>] | off | status   the club runs elsewhere now: this server sends members nothing (club_exit.ts)
//   kumi leaving on --date=YYYY-MM-DD [--kept-days=N] [--email-domain=<domain> [--email-domain-host]] | off | status
//                                  the day the club's Kumi ends (leaving.ts): the owner is told at once, and a week and
//                                  a day before, to download everything first (and what becomes of the email domain)
//   kumi held [send|drop] --yes    after a club's export is restored here: what was still waiting to go out on the old
//                                  server, held so it isn't sent twice (held.ts); send it on, or drop it, once that one is off
//   kumi restore-test              restore the newest backup into a scratch database and check it
//                                  (--scheduled: only when it's due, the 1st at 4:17 on the club's clock)
//   kumi rotate-key                seal every secret with KUMI_SECRET_KEY (the old one in KUMI_SECRET_KEY_PREVIOUS)
//   kumi texting plan|apply|status [club.yaml]   register the club's texting with US carriers through its own
//                                  Twilio account, toll-free (texting.ts); apply --yes to buy a number or start over
//   kumi usage [--month=YYYY-MM]   what AI, texts and email cost the club in a month, by kind, against its cap
//                                  (usage.ts); --json for a host's bill
//   kumi pitr conf|tick|status|extract|test   point-in-time backups (pitr_cli.ts); `sudo kumi restore --to=
//                                  "YYYY-MM-DD HH:MM" --yes` puts the database back as it was at that minute
//   (on a one-server install, as root: kumi update <release.tar>, kumi rollback --yes, kumi releases)
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { money, t, pickLang, type Lang, type Text, formatLocale } from "@kumi/i18n";
import { connect, loadClubFormat, dayText, heldSummary, KumiError, leavingStatus, localDate, migrate, monthOf, movedAway, plan, readOnlySince, resealAll, run, runAsSystem, secretKeyStatus, setSecretKeys, textingRegistration, usageMonth, USAGE_KINDS, type Db } from "@kumi/core";
import { ExportRefused, exportHeader, importExport, isExportFile, makeExport, PASSPHRASE_MIN } from "./export.ts";
import { backupKey, fetchOffsite, makeBackup, nightlyBackup, offsiteLatest, offsitePrefix, readableDump, readOpsRecords, RestoreFailed, restoreTest, safeRestore, scheduledDue, writeOpsRecords } from "./backups.ts";
import { S3Client, s3FromEnv } from "./s3.ts";
import { readPeopleCsv } from "./csv.ts";
import { doctor, type Check } from "./doctor.ts";
import { ClubFileError, ownerActor, readClubFile, setupClub } from "./setup.ts";
import { applyTexting, refreshTexting, textingPlan, textingStatusText, twilioProblem, verificationForm, withClubLinks, type TextingDeps, type TextingPlan } from "./texting.ts";
import { twilioFromEnv } from "./twilio.ts";
import { TwilioApi } from "./twilio_admin.ts";
import { memberUrl } from "./addresses.ts";
import { pitrMain, toArg } from "./pitr_cli.ts";
import { afterRestore, readSentBefore, type AfterRestore, type KeepDeleted } from "./after_restore.ts";

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
const serverKeys = () => setSecretKeys({ current: process.env.KUMI_SECRET_KEY, previous: process.env.KUMI_SECRET_KEY_PREVIOUS });
/** A moment on the club's own clock ("Nov 3, 2026, 2:05 PM"), for the status lines. */
async function clubClock(db: Db): Promise<(d: Date) => string> {
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirst())?.time_zone ?? "UTC";
  const f = new Intl.DateTimeFormat(formatLocale(lang), { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  return (d) => f.format(d);
}

/** A passphrase: typed at a prompt that doesn't show it, or the first line of what's piped in (never an argument,
 *  which the process list and the shell's history would keep). */
async function passphrase(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) { data += String(chunk); if (data.includes("\n")) break; }
    return data.split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
  return new Promise((done) => {
    let typed = "";
    const key = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", key); process.stderr.write("\n"); done(typed); return; }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        typed = ch === "\u007f" || ch === "\b" ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on("data", key);
  });
}

/** The club's database, with its currency and formats loaded, so amounts print as the club's (¥1,500, not $15.00). */
async function clubDb(): Promise<Db> {
  const db = connect();
  await loadClubFormat(db).catch(() => {});   // a database not yet set up (or migrated): US dollars, as before
  return db;
}

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
    const db = await clubDb();
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
    const db = await clubDb();
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
  if (cmd === "texting" && (sub === "plan" || sub === "apply" || sub === "status")) {
    // Needs the club's live Twilio keys in the settings file; the business details come from club.yaml.
    let tw;
    try { tw = twilioFromEnv(process.env); } catch (e) { console.error((e as Error).message); return 2; }
    if (!tw) { if (json) out({ ok: false, error: t(lang, "texting.no_twilio") }); else console.error(t(lang, "texting.no_twilio")); return 2; }
    const path = resolve(process.env.KUMI_CALLER_DIR ?? ".", rest[0] ?? process.env.KUMI_CLUB_FILE ?? "club.yaml");
    let file;
    try { file = readClubFile(path); }
    catch (e) {
      if (!(e instanceof ClubFileError)) throw e;
      if (json) out({ ok: false, file: path, problems: e.problems });
      else { console.error(t(lang, "cli.file_problems", { file: path })); for (const p of e.problems) console.error(`  - ${p}`); }
      return 2;
    }
    const db = await clubDb();
    try {
      await migrate(db);
      const club = await db.selectFrom("club").select(["name", "time_zone", "terms_url", "privacy_policy_url"]).executeTakeFirst();
      if (!club) { console.error(t(lang, "doctor.club.missing")); return 2; }
      const publicUrl = process.env.KUMI_PUBLIC_URL ?? "http://127.0.0.1:8790";
      const deps: TextingDeps = { db, api: new TwilioApi(tw.accountSid, tw.authToken), club: club.name, details: withClubLinks(file.texting, club), publicUrl, memberUrl: memberUrl(publicUrl) };
      const show = (p: TextingPlan) => ({ needs: p.needs.map(say), steps: p.steps.map((s) => ({ step: s.id, text: say(s.text), ...(s.costs ? { costs: true } : {}) })),
        status: p.registration?.status ?? null, number: p.registration?.phone_number ?? null, said: textingStatusText(p.registration, lang, club.time_zone) });
      try {
        if (sub === "status") {
          await refreshTexting(db, deps.api);
          const reg = await textingRegistration(db), lines = textingStatusText(reg, lang, club.time_zone);
          if (json) out({ ok: true, status: reg?.status ?? null, number: reg?.phone_number ?? null, said: lines }); else for (const l of lines) console.log(l);
          return 0;
        }
        if (sub === "plan") {
          const p = await textingPlan(deps);
          // What the verification would say, for the owner to read first (or to reuse for a local number's campaign).
          const reg = p.registration, submission = deps.details && !p.needs.length ? (({ TollfreePhoneNumberSid: _n, ExternalReferenceId: _r, ...f }) => f)(
            verificationForm(deps.details, { club: club.name, memberUrl: deps.memberUrl, numberSid: reg?.phone_number_sid ?? "", reference: reg?.id ?? "" })) : null;
          if (json) { out({ ok: true, ...show(p), submission }); return 0; }
          for (const l of show(p).said) console.log(l);
          if (p.needs.length) { console.log(t(lang, "texting.needs_heading", { file: path })); for (const n of p.needs) console.log(`  - ${say(n)}`); }
          const todo = p.steps.filter((s) => s.id !== "approved");
          if (todo.length) { console.log(t(lang, "texting.plan_heading")); for (const s of todo) console.log(`  - ${say(s.text)}`); console.log(t(lang, "texting.apply_hint", { yes: p.steps.some((s) => s.costs || s.id === "restart") ? " --yes" : "" })); }
          return 0;
        }
        const r = await applyTexting(deps, { yes: args.includes("--yes"), ...(flag("reason") ? { reason: flag("reason")! } : {}) });
        if (json) { out({ ok: true, done: r.done.map(say), stopped: r.stopped, ...show(r.plan) }); return r.stopped ? 3 : 0; }
        for (const d of r.done) console.log(`  - ${say(d)}`);
        if (r.stopped === "needs_yes") console.log(t(lang, "texting.needs_yes"));
        if (r.stopped === "needs") { console.log(t(lang, "texting.needs_heading", { file: path })); for (const n of r.plan.needs) console.log(`  - ${say(n)}`); }
        for (const l of show(r.plan).said) console.log(l);
        return r.stopped ? 3 : 0;
      } catch (e) {
        const why = say(twilioProblem(e));
        if (json) out({ ok: false, error: why }); else console.error(why);
        return 1;
      }
    } finally { await db.destroy(); }
  }
  if (cmd === "usage") {
    const m = flag("month") ?? sub;
    if (m !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) { console.error(t(lang, "cli.usage_bad_month")); return 2; }
    const db = await clubDb();
    try {
      const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirst();
      if (!club) { console.error(t(lang, "doctor.club.missing")); return 2; }
      const u = await usageMonth(db, m ? `${m}-01` : monthOf(new Date(), club.time_zone));
      if (json) { out({ ok: true, club: club.name, ...u }); return 0; }
      const cents = (n: number) => money(Math.round(n), lang);
      console.log(t(lang, "cli.usage_heading", { club: club.name, month: u.month.slice(0, 7), spent: cents(u.total_cents), cap: cents(u.cap_cents ?? 0) }));
      for (const k of USAGE_KINDS) {
        const x = u.kinds[k];
        console.log(`  ${t(lang, `cli.usage_${k}`, { count: k === "texts" ? x.segments : x.count })}: ${cents(x.cents)}`);
      }
      for (const g of u.gaps) console.log(t(lang, "cli.usage_gap", { date: dayText(localDate(new Date(g.restored_at), club.time_zone)) }));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "export") {
    serverKeys();
    const typed = await passphrase(t(lang, "cli.export_ask", { min: PASSPHRASE_MIN }));
    if (process.stdin.isTTY && typed !== await passphrase(t(lang, "cli.export_ask_again"))) { console.error(t(lang, "cli.export_differ")); return 2; }
    const db = await clubDb();
    try {
      const r = await makeExport(db, { url: dbUrl(), passphrase: typed });
      const file = join(resolve(process.env.KUMI_CALLER_DIR ?? ".", flag("out") ?? backupDir), r.name);
      writeFileSync(file, r.file, { mode: 0o600 });
      if (json) { out({ ok: true, file, bytes: r.file.length, tables: Object.keys(r.manifest.database.tables).length }); return 0; }
      console.log(t(lang, "cli.export_done", { file, mb: (r.file.length / 1048576).toFixed(1) }));
      return 0;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message }); else console.error(t(lang, "cli.export_failed", { error: (e as Error).message }));
      return e instanceof ExportRefused ? 2 : 1;
    } finally { await db.destroy(); }
  }
  if (cmd === "moved" && (sub === "on" || sub === "off" || sub === "status")) {
    const db = await clubDb();
    try {
      const to = flag("to");
      if (sub !== "status") await runAsSystem(db, "club.moved_host", { on: sub === "on", ...(sub === "on" && to ? { to } : {}) }, "cli");
      const m = await movedAway(db);
      if (json) { out({ ok: true, moved: Boolean(m), since: m?.at ?? null, to: m?.to ?? null }); return 0; }
      const when = await clubClock(db);
      console.log(sub === "off" ? t(lang, "cli.moved_off") : m ? t(lang, m.to ? "cli.moved_since_to" : "cli.moved_since", { since: when(m.at), to: m.to ?? "" }) : t(lang, "cli.moved_not"));
      return 0;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message);
      return 1;
    } finally { await db.destroy(); }
  }
  if (cmd === "read-only" && (sub === "on" || sub === "off" || sub === "status")) {
    const db = await clubDb();
    try {
      if (sub !== "status") await runAsSystem(db, "club.read_only", { on: sub === "on" }, "cli");
      const since = await readOnlySince(db);
      if (json) { out({ ok: true, read_only: Boolean(since), since }); return 0; }
      const when = await clubClock(db);
      console.log(sub === "on" ? t(lang, "cli.read_only_on") : sub === "off" ? t(lang, "cli.read_only_off") : since ? t(lang, "cli.read_only_since", { since: when(since) }) : t(lang, "cli.read_only_not"));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "leaving" && (sub === "on" || sub === "off" || sub === "status")) {
    const db = await clubDb();
    try {
      const date = flag("date") ?? rest.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
      const keptFlag = flag("kept-days"), kept = keptFlag === undefined ? undefined : Number(keptFlag);
      const mailFlag = flag("email-domain"), mail = mailFlag === undefined ? {} : { email_domain: mailFlag.trim().toLowerCase() || null, email_domain_host: args.includes("--email-domain-host") };
      if (sub === "on" && !date) { if (json) out({ ok: false, error: t(lang, "cli.leaving_bad_date") }); else console.error(t(lang, "cli.leaving_bad_date")); return 2; }
      if (kept !== undefined && !(Number.isInteger(kept) && kept >= 0)) { console.error(t(lang, "cli.usage")); return 2; }
      let changed: boolean | null = null;
      if (sub !== "status") {
        try {
          const r = await runAsSystem(db, "club.leaving", { on: sub === "on" ? date! : null, ...(kept !== undefined ? { kept_days: kept } : {}), ...(sub === "on" ? mail : {}) }, "cli");
          changed = (r.result as { changed: boolean }).changed;
        } catch (e) {
          if (!(e instanceof KumiError)) throw e;
          const why = e.text[lang];
          if (json) out({ ok: false, error: why }); else console.error(why);
          return 2;
        }
      }
      const s = await leavingStatus(db);
      if (json) { out({ ok: true, ...(changed === null ? {} : { changed }), ...s }); return 0; }
      const day = (d: string) => dayText(d)[lang];
      const stamp = await clubClock(db);
      if (sub === "on") console.log(t(lang, changed ? "cli.leaving_on" : "cli.leaving_same", { date: day(s.on!) }));
      if (sub === "off") console.log(t(lang, changed ? "cli.leaving_off" : "cli.leaving_not"));
      if (sub === "status") {
        if (!s.on) console.log(t(lang, "cli.leaving_not"));
        else {
          console.log(t(lang, "cli.leaving_status", { date: day(s.on), left: s.days_left === 0 ? t(lang, "cli.leaving_left_today") : t(lang, "cli.leaving_left", { count: s.days_left! }) }));
          if (s.notices.length) console.log(t(lang, "cli.leaving_notices"));
          for (const n of s.notices) {
            const state = !n.said_at ? t(lang, "cli.leaving_due") : n.covered ? t(lang, "cli.leaving_covered", { when: stamp(n.said_at) }) : t(lang, "cli.leaving_said", { when: stamp(n.said_at) });
            console.log(`  ${t(lang, `cli.leaving_notice_${n.kind}`, { state })}`);
          }
        }
        console.log(s.last_export ? t(lang, "cli.leaving_export", { when: stamp(s.last_export.at), by: s.last_export.by }) : t(lang, "cli.leaving_no_export"));
      }
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "held" && (sub === undefined || sub === "status" || sub === "send" || sub === "drop")) {
    const db = await clubDb();
    try {
      const yes = args.includes("--yes");
      if (sub === "send" || sub === "drop") {
        if (!yes) { if (json) out({ ok: false, error: t(lang, "cli.held_need_yes") }); else console.error(t(lang, "cli.held_need_yes")); return 2; }
        const r = (await runAsSystem(db, "club.held_release", { send: sub === "send" }, "cli")).result as { sent?: { messages: number; events: number }; dropped?: { messages: number; events: number } };
        const n = r.sent ?? r.dropped!;
        if (json) { out({ ok: true, ...r }); return 0; }
        console.log(t(lang, sub === "send" ? "cli.held_sent" : "cli.held_dropped", { count: n.messages + n.events }));
        return 0;
      }
      const h = await heldSummary(db);
      if (json) { out({ ok: true, ...h }); return 0; }
      if (!h.messages && !h.events) { console.log(t(lang, "cli.held_none")); return 0; }
      const day = (d: Date) => d.toISOString().slice(0, 10);
      console.log(t(lang, "cli.held_status", { count: h.messages + h.events }));
      for (const m of h.by_message) console.log(`  ${t(lang, "cli.held_message_line", { kind: m.kind, channel: m.channel, count: m.count, oldest: day(m.oldest) })}`);
      for (const e of h.by_event) console.log(`  ${t(lang, "cli.held_event_line", { topic: e.topic, count: e.count, oldest: day(e.oldest) })}`);
      console.log(t(lang, "cli.held_hint"));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "doctor") {
    const db = await clubDb();
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
    const db = await clubDb();
    try {
      const person = await db.selectFrom("person").select(["id", "display_name"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", sub.trim().toLowerCase())).where("status", "!=", "archived").executeTakeFirst();
      if (!person) { if (json) out({ ok: false }); else console.error(t(lang, "cli.no_person", { email: sub })); return 2; }
      const r = await runAsSystem(db, "person.reset_sign_in", { person_id: person.id }, "cli");
      if (json) { out({ ok: true, summary: say(r.plan.summary) }); return 0; }
      console.log(say(r.plan.summary));
      return 0;
    } finally { await db.destroy(); }
  }
  // The owner role, by the server's admin: for a club left with no owner who can sign in. Previewed; --yes does it.
  if (cmd === "owner" && sub === "add" && args[2]) {
    const db = await clubDb();
    try {
      const email = args[2].trim().toLowerCase();
      const person = await db.selectFrom("person").select(["id", "display_name"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).where("status", "!=", "archived").where("redacted_at", "is", null).executeTakeFirst();
      if (!person) { if (json) out({ ok: false }); else console.error(t(lang, "cli.no_person", { email })); return 2; }
      if (!args.includes("--yes")) { console.log(t(lang, "cli.owner_add_preview", { name: person.display_name, email })); return 0; }
      const r = await runAsSystem(db, "role.owner_add_by_server", { person_id: person.id }, "cli");
      if (json) { out({ ok: true, summary: say(r.plan.summary) }); return 0; }
      console.log(say(r.plan.summary));
      return 0;
    } finally { await db.destroy(); }
  }
  if (cmd === "backup") {
    const db = await clubDb();
    try {
      if (args.includes("--scheduled")) {
        const d = await scheduledDue(db, "backup");
        if (!d.due) { if (json) out({ ok: true, due: false, time_zone: d.tz }); return 0; }
      }
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
  if (cmd === "pitr") return pitrMain(sub, args, lang, json);
  // A minute, not a file. On a one-server install the root wrapper (sudo kumi restore --to=...) takes that copy from the
  // archive as the postgres user first, then restores it here as a file. Docker's pitr service is that user already
  // (KUMI_PITR_INLINE=1): it takes the copy and restores it here, with the server stopped first.
  if (cmd === "restore" && toArg(args) !== undefined) {
    if (process.env.KUMI_PITR_INLINE !== "1") { console.error(t(lang, process.env.KUMI_INSTALL === "docker" ? "cli.pitr_needs_pitr_service" : "cli.pitr_needs_root")); return 2; }
    if (!args.includes("--yes")) { console.error(t(lang, "cli.pitr_confirm", { time: toArg(args) ?? "" })); return 2; }
    const file = join(backupDir, `kumi-pitr-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.dump`);
    // With --json, the restore's answer is the one said (the minute's own line is for a person).
    const got = await pitrMain("extract", [...args, `--out=${file}`], lang, json, process.env, { quiet: json });
    if (got !== 0) { rmSync(file, { force: true }); return got; }
    const rc = await restoreFrom(file);
    // The copy taken from the archive has done its job, unless the database may be empty: then it's one of the ways back.
    if (rc === 4) console.error(t(lang, "cli.pitr_extract_kept", { file })); else rmSync(file, { force: true });
    return rc;
  }
  if (cmd === "restore" && sub) {
    if (!args.includes("--yes")) { console.error(t(lang, "cli.restore_confirm", { source: sub })); return 2; }
    return restoreFrom(sub);
  }
  if (cmd === "restore-test") {
    const db = await clubDb();
    try {
      if (args.includes("--scheduled")) {
        const d = await scheduledDue(db, "restore_test");
        if (!d.due) { if (json) out({ ok: true, due: false, time_zone: d.tz }); return 0; }
      }
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
    const db = await clubDb();
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

/** `kumi restore <file|offsite:...>` (confirmed): a backup or a club's export in place of the database. The exit code
 *  tells `sudo kumi restore` whether the server may start again: 4 only when the database may be empty. */
async function restoreFrom(source: string): Promise<number> {
  const local = source.startsWith("offsite:") ? null : resolve(process.env.KUMI_CALLER_DIR ?? ".", source);
  if (local && isExportFile(local)) return importClub(local);
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
    const kept = await readOpsRecords(dbUrl()), sent = await readSentBefore(dbUrl());
    let safetyCopy: string;
    try { ({ safetyCopy } = await safeRestore(dbUrl(), got.file, { dir: backupDir })); } finally { got.cleanup(); }
    await writeOpsRecords(dbUrl(), kept);
    // Nothing the database before it had sent goes again (after_restore.ts). The database is replaced by now: a
    // carry-over that fails says so (and the server may still start, with the copy as it was).
    let after: Awaited<ReturnType<typeof afterRestore>>;
    try { after = await afterRestore(dbUrl(), sent, new Date(), { keep: keepDeleted(), backupDir }); }
    catch (e) {
      if (json) out({ ok: false, error: (e as Error).message, changed: true, carry_failed: true, safety_copy: safetyCopy });
      else console.error(t(lang, "cli.restore_carry_failed", { error: (e as Error).message, file: safetyCopy }));
      return 1;
    }
    if (json) out({ ok: true, source, safety_copy: safetyCopy, ...after });
    else {
      console.log(t(lang, "cli.restore_done", { source })); console.log(t(lang, "cli.restore_safety_copy", { file: safetyCopy }));
      if (after.carried.messages) console.log(t(lang, "cli.restore_carried", { count: after.carried.messages }));
      if (after.carried.repeats) console.log(t(lang, "cli.restore_repeats", { count: after.carried.repeats }));
      const held = after.held.messages + after.held.events;
      if (held) console.log(t(lang, after.vouched ? "cli.restore_held_some" : "cli.restore_held_all", { count: held }));
      if (after.support_ended) console.log(t(lang, after.vouched ? "cli.restore_support_kept_ended" : "cli.restore_support_ended", { count: after.support_ended }));
      if (after.usage.months.length) console.log(t(lang, "cli.restore_usage_carried", { months: after.usage.months.map((m) => m.slice(0, 7)).join(", ") }));
      if (after.usage.gap) console.log(t(lang, "cli.restore_usage_gap"));
      sayGone(after.gone);
    }
    return 0;
  } catch (e) {
    // The exit code tells `sudo kumi restore` whether the server may start again: 4 only when the database may
    // be empty (the restore failed and the copy made before it couldn't be put back).
    if (e instanceof RestoreFailed) {
      if (json) out({ ok: false, error: e.message, safety_copy: e.safetyCopy, put_back: e.putBack });
      else console.error(t(lang, e.putBack ? "cli.restore_put_back" : "cli.restore_not_put_back", { error: e.message, file: e.safetyCopy }));
      return e.putBack ? 3 : 4;
    }
    if (json) out({ ok: false, error: (e as Error).message, changed: false }); else console.error(t(lang, "cli.restore_failed", { error: (e as Error).message }));
    return 1;
  }
}

/** `--keep-staff-deleted` (every account staff had deleted keeps its place after the restore) and `--keep=<id,...>`:
 *  accounts a deletion that the restore would repeat leaves alone. Someone who deleted their own account is deleted
 *  again whatever the flags say. */
function keepDeleted(): KeepDeleted {
  return { staff: args.includes("--keep-staff-deleted"), ids: (flag("keep") ?? "").split(",").map((x) => x.trim()).filter(Boolean) };
}
/** What a restore did with the accounts the database before it had deleted, one line each, and what's left to do. */
function sayGone(g: AfterRestore["gone"]) {
  if (g.unvouched) console.log(t(lang, g.from_backup ? "cli.restore_gone_unvouched_backup" : "cli.restore_gone_unvouched", { file: g.from_backup ?? "" }));
  for (const p of g.people) console.log(t(lang, p.kept ? "cli.restore_person_kept" : p.by === "staff" ? "cli.restore_person_staff" : "cli.restore_person_again", { name: p.name, id: p.id }));
  if (g.people.some((p) => p.by === "staff" && !p.kept)) console.log(t(lang, "cli.restore_keep_hint"));
  if (g.erased) console.log(t(lang, "cli.restore_erased_again", { count: g.erased }));
  if (g.last_owner_kept.length) console.log(t(lang, "cli.restore_last_owner_kept", { count: g.last_owner_kept.length }));
  if (g.failed) console.log(t(lang, "cli.restore_erase_failed", { count: g.failed }));
  if (g.other) console.log(t(lang, "cli.restore_gone_again", { count: g.other }));
  if (g.skipped_newer) console.log(t(lang, "cli.restore_skipped_newer"));
  for (const x of g.to_check ?? []) if (x.paid_cents) console.log(t(lang, "cli.restore_to_check", { person: plain(x.person), what: x.what, ref: plain(x.ref), amount: money(x.paid_cents, lang) }));
  for (const c of g.check ?? []) console.log(t(lang, `cli.restore_check_${c.what}`, { name: plain(c.name), ref: plain(c.ref), before: c.what === "pass" ? String(c.before_cents ?? 0) : money(c.before_cents ?? 0, lang),
    after: c.what === "pass" ? String(c.after_cents ?? 0) : money(c.after_cents ?? 0, lang), amount: money(c.cents ?? 0, lang) }));
  if (g.last_owner_kept.length) console.log(t(lang, "cli.restore_owner_cli"));
  console.log(t(lang, "cli.restore_money_next_start"));
}
/** A name or reference printed to the terminal: no control characters (they could move the cursor or hide text). */
const plain = (x: string) => x.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");

/** `kumi restore <export>`: the club's export into this server (export.ts), and what's left to set up here. */
async function importClub(path: string): Promise<number> {
  try {
    const file = readFileSync(path);
    exportHeader(file);   // a damaged or foreign file says so before the passphrase is asked for
    const typed = await passphrase(t(lang, "cli.import_ask", { file: path }));
    serverKeys();
    const r = await importExport({ url: dbUrl(), file, passphrase: typed, dir: backupDir });
    let clubFile: string | null = null;
    if (r.club_file) { clubFile = join(backupDir, "club-from-export.yaml"); writeFileSync(clubFile, r.club_file, { mode: 0o600 }); }
    const settings = Object.entries(r.settings).map(([k, v]) => `${k}=${v}`);
    if (json) {
      const { club_file: _f, ...rest } = r;
      out({ ok: true, ...rest, club_file: clubFile });
      return 0;
    }
    console.log(t(lang, "cli.import_done", { club: r.club, version: r.from.version, when: r.from.created_at.slice(0, 10), copy: r.safety_copy }));
    if (r.secrets) console.log(`  - ${t(lang, "cli.import_secrets", { count: r.secrets })}`);
    if (r.secrets_lost) console.log(`  - ${t(lang, "cli.import_lost", { count: r.secrets_lost })}`);
    if (r.passkeys_retired) console.log(`  - ${t(lang, "cli.import_passkeys", { count: r.passkeys_retired })}`);
    if (r.was_read_only) console.log(`  - ${t(lang, "cli.import_read_only")}`);
    if (r.was_leaving) console.log(`  - ${t(lang, "cli.import_leaving", { date: r.was_leaving })}`);
    if (r.was_moved) console.log(`  - ${t(lang, "cli.import_moved")}`);
    if (r.held.messages + r.held.events) console.log(`  - ${t(lang, "cli.import_held", { count: r.held.messages + r.held.events })}`);
    if (r.support_ended) console.log(`  - ${t(lang, "cli.import_support_ended", { count: r.support_ended })}`);
    if (r.usage_carried.length) console.log(`  - ${t(lang, "cli.import_usage_carried", { months: r.usage_carried.map((m) => m.slice(0, 7)).join(", ") })}`);
    if (settings.length) console.log(`  - ${t(lang, "cli.import_settings", { list: settings.join(", ") })}`);
    if (r.set_elsewhere.length) console.log(`  - ${t(lang, "cli.import_elsewhere", { list: r.set_elsewhere.join(", ") })}`);
    if (r.stripe_account && process.env.KUMI_STRIPE_CONNECT !== "1") console.log(`  - ${t(lang, "cli.import_stripe", { account: r.stripe_account })}`);
    if (r.texting_registered) console.log(`  - ${t(lang, "cli.import_texting")}`);
    if (clubFile) console.log(`  - ${t(lang, "cli.import_club_file", { file: clubFile })}`);
    return 0;
  } catch (e) {
    if (e instanceof RestoreFailed) {
      if (json) out({ ok: false, error: e.message, safety_copy: e.safetyCopy, put_back: e.putBack });
      else console.error(t(lang, e.putBack ? "cli.restore_put_back" : "cli.restore_not_put_back", { error: e.message, file: e.safetyCopy }));
      return e.putBack ? 3 : 4;
    }
    if (json) out({ ok: false, error: (e as Error).message, changed: false }); else console.error(t(lang, "cli.import_failed", { error: (e as Error).message }));
    return e instanceof ExportRefused ? 2 : 1;
  }
}

process.exitCode = await main();
