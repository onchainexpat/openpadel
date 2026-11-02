// `kumi doctor`: is this Kumi set up and working? Each check says what it found and, when it isn't fine,
// the next step. An agent setting up a club runs it first and after every step, and works on the first
// check that isn't fine. It only reads: nothing here changes the club or sends anything.
import { readdirSync, statSync } from "node:fs";
import { both, type Key, type Text } from "@kumi/i18n";
import { answerCounts, heartbeats, parseSecretKey, pendingMigrations, textCounts, type Db } from "@kumi/core";
import { s3FromEnv } from "./s3.ts";
import { checkTwilio, twilioFromEnv } from "./twilio.ts";
import { answerModels, checkAnswerKeys } from "./answerer.ts";
import { memberUrl } from "./addresses.ts";
import { VERSION } from "./version.ts";

export type CheckState = "ok" | "warn" | "fail" | "off";
export interface Check { id: string; state: CheckState; text: Text; doc?: string }
type Env = Record<string, string | undefined>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function doctor(db: Db, env: Env = process.env, deps: { fetch?: Fetch; now?: Date } = {}): Promise<Check[]> {
  const checks: Check[] = [], now = deps.now ?? new Date(), production = env.NODE_ENV === "production";
  // Docker installs (the image sets KUMI_INSTALL=docker) run backups from a service, not systemd timers.
  const docker = env.KUMI_INSTALL === "docker", opsDoc = docker ? "deploy/docker/README.md" : "deploy/README.md", d = docker ? "_docker" : "";
  const add = (id: string, state: CheckState, key: string, params: Record<string, string | number> = {}, doc?: string) =>
    checks.push({ id, state, text: both(`doctor.${key}` as Key, params), ...(doc ? { doc } : {}) });
  add("version", "ok", "version", { version: VERSION });

  // A missing table (42P01) only means a new database: connected, nothing set up yet.
  try { await db.selectFrom("club").select("name").limit(1).execute().catch(async (e) => { if (e?.code === "42P01") return []; throw e; }); add("database", "ok", "database.ok"); }
  catch (e) { add("database", "fail", "database.fail", { error: (e as Error).message.split("\n")[0]! }, "docs/setup/accounts/server.md"); return checks; }

  const m = await pendingMigrations(db);
  add("migrations", m.pending.length ? "warn" : "ok", m.pending.length ? "migrations.pending" : "migrations.ok", { count: m.pending.length || m.applied });
  if (m.applied === 0) { add("club", "fail", "club.missing", {}, "docs/setup/README.md"); return checks; }

  const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirst();
  if (!club) { add("club", "fail", "club.missing", {}, "docs/setup/README.md"); return checks; }
  add("club", "ok", "club.ok", { name: club.name, tz: club.time_zone });
  const owner = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").innerJoin("person", "person.id", "person_role.person_id")
    .select(["person.display_name", "person.email"]).where("role.key", "=", "owner").where("person_role.active", "=", true).where("person.email", "is not", null).executeTakeFirst();
  add("owner", owner ? "ok" : "fail", owner ? "owner.ok" : "owner.missing", owner ? { name: owner.display_name, email: owner.email! } : {});
  const courts = Number((await db.selectFrom("court").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
  add("courts", courts ? "ok" : "warn", courts ? "courts.ok" : "courts.none", { count: courts }, courts ? undefined : "docs/setup/README.md");

  // The address people use. In production it must be HTTPS and answer from outside.
  const reach = async (id: string, url: string) => {
    if (production && !url.startsWith("https://")) return add(id, "fail", `${id}.not_https`, { url }, "docs/setup/accounts/server.md");
    if (!production) return add(id, "ok", `${id}.dev`, { url });
    try {
      const r = await (deps.fetch ?? fetch)(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(8000) });
      add(id, r.ok ? "ok" : "fail", r.ok ? `${id}.ok` : `${id}.down`, { url, error: `HTTP ${r.status}` }, r.ok ? undefined : "docs/setup/accounts/server.md");
    } catch (e) { add(id, "fail", `${id}.down`, { url, error: (e as Error).message }, "docs/setup/accounts/server.md"); }
  };
  const url = env.KUMI_PUBLIC_URL;
  if (!url) add("address", production ? "fail" : "warn", "address.unset", {}, "docs/setup/accounts/server.md");
  else {
    await reach("address", url);
    // The members' app's address, which the links members are sent use: checked too, when it isn't the same one.
    let members: string | null = null;
    try { members = memberUrl(url, env); } catch { /* KUMI_PUBLIC_URL isn't an address: the check above says so */ }
    if (members && members !== url.replace(/\/$/, "")) await reach("members_address", members);
  }

  // Email: without it, sign-in codes and messages only reach the server's log.
  if (!env.KUMI_RESEND_API_KEY) add("email", production ? "warn" : "off", "email.off", {}, "docs/setup/accounts/resend.md");
  else if (!env.KUMI_MAIL_FROM) add("email", "fail", "email.no_from", {}, "docs/setup/accounts/resend.md");
  else if (!production || env.KUMI_PRACTICE === "1") add("email", "warn", "email.practice", { from: env.KUMI_MAIL_FROM, count: (env.KUMI_MAIL_TEST_TO ?? "").split(",").filter((a) => a.trim()).length });
  else add("email", "ok", "email.ok", { from: env.KUMI_MAIL_FROM });

  // Texts: optional. Set up, Twilio is asked whether it takes the account and token (reading only), and the
  // last day's texts say whether they're getting through (an unapproved registration shows up as failures).
  const twDoc = "docs/setup/accounts/twilio.md";
  let tw: ReturnType<typeof twilioFromEnv> = null, twErr: string | null = null;
  try { tw = twilioFromEnv(env); } catch (e) { twErr = (e as Error).message; }
  if (twErr) add("texts", "fail", twErr.includes("who they're from") ? "texts.half" : "texts.bad", { error: twErr }, twDoc);
  else if (!tw) add("texts", "off", "texts.off", {}, twDoc);
  else {
    const answer = await checkTwilio(tw, deps.fetch);
    const sent = await textCounts(db, now), total = sent.sent + sent.failed;
    if (typeof answer === "object") add("texts", "fail", "texts.refused", { error: answer.error }, twDoc);
    else if (answer === "test") add("texts", production ? "warn" : "ok", "texts.test");
    else if (total >= 5 && sent.failed / total > 0.2) add("texts", "warn", "texts.failing", { failed: sent.failed, total }, twDoc);
    else if (!production || env.KUMI_PRACTICE === "1") add("texts", "warn", "texts.practice", { count: (env.KUMI_SMS_TEST_TO ?? "").split(",").filter((n) => n.trim()).length });
    else add("texts", "ok", "texts.ok", { sent: sent.sent, failed: sent.failed });
  }

  // Ask the club: optional. Each model is asked whether it takes its key (listing models, which costs nothing), and
  // the last day's questions say whether decisions are coming back. Nothing is sent to a model from here.
  const atcDoc = "docs/setup/accounts/ask-the-club.md", models = answerModels(env);
  const named = (m: string) => (m === "jev" ? "Jev" : "Claude Haiku");
  if (!models.length) add("answers", "off", "answers.off", {}, atcDoc);
  else {
    const refused = (await checkAnswerKeys(env, deps.fetch)).find((k) => k.error);
    const on = (await db.selectFrom("club").select("auto_answers").executeTakeFirst())?.auto_answers ?? true;
    const n = await answerCounts(db, now), list = models.map(named).join(" + ");
    if (refused) add("answers", "fail", "answers.refused", { model: named(refused.model), error: refused.error! }, atcDoc);
    else if (!on) add("answers", "off", "answers.club_off", { models: list });
    else if (n.total >= 5 && n.errors / n.total > 0.2) add("answers", "warn", "answers.failing", { errors: n.errors, total: n.total }, atcDoc);
    else add("answers", "ok", "answers.ok", { models: list, total: n.total, answered: n.answered });
  }

  // Card payments.
  const sk = env.KUMI_STRIPE_SECRET_KEY;
  if (!sk) add("payments", production ? "warn" : "off", "payments.off", {}, "docs/setup/accounts/stripe.md");
  else if (sk.includes("_live_") && !production) add("payments", "fail", "payments.live_outside", {}, "docs/setup/accounts/stripe.md");
  else if (!env.KUMI_STRIPE_PUBLISHABLE_KEY) add("payments", "fail", "payments.no_publishable", {}, "docs/setup/accounts/stripe.md");
  else if (!env.KUMI_STRIPE_WEBHOOK_SECRET) add("payments", "warn", "payments.no_webhook", {}, "docs/setup/accounts/stripe.md");
  else add("payments", sk.includes("_live_") ? "ok" : production ? "warn" : "ok", sk.includes("_live_") ? "payments.live" : "payments.test");

  // Playtomic, only for a club that also runs on it.
  if (!env.KUMI_PLAYTOMIC_CLIENT_ID) add("playtomic", "off", "playtomic.off");
  else {
    const s = await db.selectFrom("connector_status").selectAll().where("system", "=", "playtomic").executeTakeFirst();
    if (!s?.last_sync_at) add("playtomic", "warn", "playtomic.waiting", {}, "docs/setup/accounts/playtomic.md");
    else if (s.last_error && (!s.last_ok_at || s.last_ok_at < s.last_sync_at)) add("playtomic", "fail", "playtomic.failing", { error: s.last_error }, "docs/setup/accounts/playtomic.md");
    else add("playtomic", "ok", "playtomic.ok", { minutes: Math.round((now.getTime() - s.last_ok_at!.getTime()) / 60_000) });
  }

  // Backups, where the one-server setup keeps them.
  const dir = env.KUMI_BACKUP_DIR ?? "/var/backups/kumi";
  let newest: number | null = null;
  try { for (const f of readdirSync(dir)) if (/^kumi-.*\.dump$/.test(f)) newest = Math.max(newest ?? 0, statSync(`${dir}/${f}`).mtimeMs); } catch { /* no folder: no backups here */ }
  if (newest === null) add("backups", production ? "warn" : "off", "backups.none", { dir }, "docs/setup/accounts/server.md");
  else { const hours = Math.round((now.getTime() - newest) / 3600_000); add("backups", hours > 36 ? "warn" : "ok", hours > 36 ? `backups.old${d}` : "backups.ok", { hours, dir }); }
  // The server's key for the secrets it keeps (sealed.ts): production won't start without it.
  if (!env.KUMI_SECRET_KEY?.trim()) add("secret_key", production ? "fail" : "warn", "secret_key.missing", {}, opsDoc);
  else { try { parseSecretKey(env.KUMI_SECRET_KEY); add("secret_key", "ok", "secret_key.ok"); } catch { add("secret_key", "fail", "secret_key.bad", {}, opsDoc); } }

  // The offsite copy and the monthly restore test, as their last runs recorded them.
  const hb = await heartbeats(db).catch(() => ({} as Awaited<ReturnType<typeof heartbeats>>));
  const ago = (d: Date | null | undefined) => (d ? (now.getTime() - new Date(d).getTime()) / 3600_000 : null);
  const off = hb.offsite, offDoc = "docs/setup/accounts/offsite-backups.md";
  if (!s3FromEnv(env)) add("offsite", production ? "warn" : "off", "offsite.off", {}, offDoc);
  else if (!env.KUMI_BACKUP_KEY?.trim()) add("offsite", "fail", "offsite.no_key", {}, offDoc);
  else if (off?.last_error) add("offsite", "fail", "offsite.failing", { error: off.last_error }, offDoc);
  else if (!off?.last_ok_at) add("offsite", "warn", "offsite.waiting", {}, offDoc);
  else { const h = Math.round(ago(off.last_ok_at)!); add("offsite", h > 36 ? "warn" : "ok", h > 36 ? `offsite.old${d}` : "offsite.ok", { hours: h }, h > 36 ? offDoc : undefined); }
  const rt = hb.restore_test;
  if (rt?.last_error) add("restore_test", "fail", "restore_test.failing", { error: rt.last_error }, opsDoc);
  else if (!rt?.last_ok_at) add("restore_test", production ? "warn" : "off", "restore_test.never", {}, opsDoc);
  else { const days = Math.round(ago(rt.last_ok_at)! / 24); add("restore_test", days > 40 ? "warn" : "ok", days > 40 ? `restore_test.old${d}` : "restore_test.ok", { days }); }
  return checks;
}
