// kumi: the command line a club owner, or the owner's agent, runs on the server. Nothing prompts, every
// command takes --json, and none of them prints a secret.
//   kumi setup plan [club.yaml]    what setting the club up from the file would change (changes nothing)
//   kumi setup apply [club.yaml]   make those changes; run it again after editing the file
//   kumi doctor                    is everything working? each check, and the next step when it isn't
import { resolve } from "node:path";
import { t, pickLang, type Lang, type Text } from "@kumi/i18n";
import { connect, migrate } from "@kumi/core";
import { doctor, type Check } from "./doctor.ts";
import { ClubFileError, readClubFile, setupClub } from "./setup.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const langArg = args.find((a) => a.startsWith("--lang="))?.slice(7);
const [cmd, sub, ...rest] = args.filter((a) => !a.startsWith("--"));
const lang: Lang = pickLang(langArg ?? process.env.KUMI_LANG ?? process.env.LANG?.slice(0, 2), "en");
const say = (x: Text) => x[lang];
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
  console.log(t(lang, "cli.usage"));
  return cmd ? 2 : 0;
}

process.exitCode = await main();
