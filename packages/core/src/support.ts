// Support access (hosted.md item 7): someone outside the club's staff (the host's support, or a contractor) whom
// the owner lets in for a set time: to look only, or to work like a manager. A manager can ask for it; the owner
// says yes. The person signs in with their own account and always with two steps. What they may do is decided in
// permissions.ts (never the club's money, roles, everyone's details in one file, deleting people or data, the
// club's secrets, the usage cap or the host's switches, and never through an assistant); every page they open is
// recorded here and every change they make is marked in the change log. The owner hears when they first sign in
// and when the access ends, which it does by itself, mid-session too.
import * as z from "zod/mini";
import { both, t, type Key, type Lang } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { activeSupport } from "./permissions.ts";
import { nameInput } from "./plain_text.ts";

/** How long support access lasts unless the owner says otherwise, and the longest it can. */
export const SUPPORT_DEFAULT_HOURS = 24;
export const SUPPORT_MAX_HOURS = 7 * 24;
/** The staff pages a person with support access never opens: the owner's vault, everyone's details in one file,
 *  and the support access page itself. */
export const SUPPORT_CLOSED_PATHS = /^\/staff\/(vault|export|support)(\/|$)/;

const level = z.enum(["view", "manager"]);
const lower = (e: string) => e.trim().toLowerCase();

export const supportGrant = defineAction({
  name: "support.grant", version: 1, strongAuth: true,
  input: z.object({
    email: z.email(), name: nameInput(80), reason: z.string().check(z.trim(), z.minLength(3), z.maxLength(300)),
    level: z.optional(level), hours: z.optional(z.number().check(z.int(), z.gte(1), z.lte(SUPPORT_MAX_HOURS))),
  }),
  async plan(ctx, i) {
    const email = lower(i.email), hours = i.hours ?? SUPPORT_DEFAULT_HOURS, lvl = i.level ?? "view";
    const person = await ctx.db.selectFrom("person").select(["id", "display_name"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst();
    if (person) {
      // Someone already on the club's staff works under their own role, not support access.
      const staff = await ctx.db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
        .where("person_role.person_id", "=", person.id).where("person_role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
      if (staff) throw new KumiError("error.support_is_staff", { name: person.display_name });
      if (await openGrant(ctx.db, person.id, ctx.now)) throw new KumiError("error.support_already", { name: person.display_name });
    }
    return {
      title: both("action.support.grant"),
      summary: both(lvl === "view" ? "plan.support.grant_view" : "plan.support.grant_manager", { name: i.name, email, count: hours, reason: i.reason }),
      reads: [], undo: { kind: "none", note: both("reason.support_end_instead") },
    };
  },
  async apply(ctx, i) {
    const email = lower(i.email), hours = i.hours ?? SUPPORT_DEFAULT_HOURS;
    let person = await ctx.trx.selectFrom("person").select(["id"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst();
    if (person && await openGrant(ctx.trx, person.id, ctx.now)) throw new KumiError("error.support_already", { name: i.name });
    if (!person) {
      // A person of their own here, marked as support's, named so wherever staff names show; no member role.
      const club = await ctx.trx.selectFrom("club").select("default_language").executeTakeFirstOrThrow();
      const lang = (club.default_language === "es" ? "es" : "en") as Lang, id = uuidv7(ctx.now.getTime());
      await ctx.insert("person", { id, display_name: t(lang, "msg.support_display_name", { name: i.name }), email, locale: lang, created_via: "support" });
      await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: "email", value: email, verified_at: null }).execute();
      person = { id };
    }
    const id = uuidv7(ctx.now.getTime());
    await ctx.insert("support_grant", { id, person_id: person.id, name: i.name, email, reason: i.reason, level: i.level ?? "view", starts_at: ctx.now,
      ends_at: new Date(ctx.now.getTime() + hours * 3600_000), granted_by: ctx.approvedBy ?? ctx.actor.personId });   // the owner who said yes to a manager's request
    await ctx.emit("support.granted", { grant_id: id });
    return { grant_id: id, person_id: person.id };
  },
});

/** Support access that hasn't ended: under way, or the person's next. */
async function openGrant(db: Db | Trx, personId: string, now: Date) {
  return db.selectFrom("support_grant").select("id").where("person_id", "=", personId).where("ended_at", "is", null).where("ends_at", ">", now).executeTakeFirst();
}

export const supportEnd = defineAction({
  name: "support.end", version: 1,
  input: z.object({ grant_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "support_grant", i.grant_id, "thing.support_grant");
    if (row.ended_at || new Date(row.ends_at) <= ctx.now) throw new KumiError("error.support_over");
    return { title: both("action.support.end"), summary: both("plan.support.end", { name: row.name }), reads: [read], undo: { kind: "none", note: both("reason.support_grant_again") } };
  },
  async apply(ctx, i) {
    await ctx.update("support_grant", i.grant_id, { ended_at: ctx.now, ended_by: ctx.actor.personId, end_told_at: ctx.now });
    await ctx.emit("support.ended", { grant_id: i.grant_id, how: "ended", by: ctx.actor.personId });
    return null;
  },
});

/** Their first use of it: recorded once, and the owner hears. */
export const supportSeen = defineAction({
  name: "support.seen", version: 1, system: true, internal: true,
  input: z.object({ grant_id: z.uuid() }),
  async plan(_ctx) { return { title: both("action.support.seen"), summary: both("plan.support.seen"), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } }; },
  async apply(ctx, i) {
    const g = await ctx.trx.selectFrom("support_grant").select("first_seen_at").where("id", "=", i.grant_id).forUpdate().executeTakeFirstOrThrow();
    if (g.first_seen_at) return { already: true };
    await ctx.update("support_grant", i.grant_id, { first_seen_at: ctx.now });
    await ctx.emit("support.first_seen", { grant_id: i.grant_id, at: ctx.now.toISOString() });
    return null;
  },
});

/** Its time ran out: the owner hears, once. */
export const supportExpire = defineAction({
  name: "support.expire", version: 1, system: true, internal: true,
  input: z.object({ grant_id: z.uuid() }),
  async plan(_ctx) { return { title: both("action.support.expire"), summary: both("plan.support.expire"), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } }; },
  async apply(ctx, i) {
    const g = await ctx.trx.selectFrom("support_grant").select(["ended_at", "ends_at", "end_told_at"]).where("id", "=", i.grant_id).forUpdate().executeTakeFirstOrThrow();
    if (g.ended_at || g.end_told_at || new Date(g.ends_at) > ctx.now) return { already: true };
    await ctx.update("support_grant", i.grant_id, { end_told_at: ctx.now });
    await ctx.emit("support.ended", { grant_id: i.grant_id, how: "expired", by: null });
    return null;
  },
});

/** A move or a restore: support access still open in the database is ended, and the owners hear. Access given on
 *  the old server is the old server's, and a copy made before the owner ended a grant mustn't bring it back. */
export const supportEndAll = defineAction({
  name: "support.end_all", version: 1, system: true, internal: true,
  input: z.object({ why: z.enum(["moved", "restored"]) }),
  async plan(_ctx) { return { title: both("action.support.end_all"), summary: both("plan.support.end_all"), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } }; },
  async apply(ctx, i) {
    const open = await ctx.trx.selectFrom("support_grant").select("id").where("ended_at", "is", null).where("ends_at", ">", ctx.now).forUpdate().execute();
    for (const g of open) {
      await ctx.update("support_grant", g.id, { ended_at: ctx.now, ended_by: null, end_told_at: ctx.now });
      await ctx.emit("support.ended", { grant_id: g.id, how: i.why, by: null });
    }
    return { ended: open.length };
  },
});

/** Support access still open (and not yet run out): what a move or a restore ends. */
export async function openSupportCount(db: Db | Trx, now = new Date()): Promise<number> {
  const r = await db.selectFrom("support_grant").select((e) => e.fn.countAll<string>().as("n")).where("ended_at", "is", null).where("ends_at", ">", now).executeTakeFirstOrThrow();
  return Number(r.n);
}

/** The job: support access whose time ran out, told to the owner. Access itself ended on time without it. */
export async function expireSupport(db: Db, now = new Date()): Promise<number> {
  const due = await db.selectFrom("support_grant").select("id").where("ended_at", "is", null).where("end_told_at", "is", null).where("ends_at", "<=", now).limit(50).execute();
  for (const g of due) await runAsSystem(db, "support.expire", { grant_id: g.id }, "job:support", { now });
  return due.length;
}

/** The roles a person with support access reads the staff screens as: a manager's, for as long as it lasts. */
export async function supportRoleKeys(db: Db | Trx, personId: string, now = new Date()): Promise<string[]> {
  return (await activeSupport(db, personId, now)) ? ["manager"] : [];
}

/** An account Kumi made for support access (they had no account here) and nothing more: no role at the club. It
 *  can't connect an assistant: there's nothing of its own to act on, and support access is never for assistants. */
export async function supportOnly(db: Db | Trx, personId: string): Promise<boolean> {
  const p = await db.selectFrom("person").select("created_via").where("id", "=", personId).executeTakeFirst();
  if (p?.created_via !== "support") return false;
  return !(await db.selectFrom("person_role").select("person_role.person_id").where("person_id", "=", personId).where("active", "=", true).executeTakeFirst());
}

/** A page they opened, for the owner. */
export async function logSupportRead(db: Db, grantId: string, method: string, path: string, status: number | null): Promise<void> {
  await db.insertInto("support_access_log").values({ grant_id: grantId, method, path: path.slice(0, 500), status }).execute();
}

/** Every grant, newest first, with how much each person opened and changed: the owner's list in Settings. */
export async function supportGrants(db: Db | Trx, now = new Date()) {
  const rows = await db.selectFrom("support_grant").leftJoin("person as by", "by.id", "support_grant.granted_by").leftJoin("person as ender", "ender.id", "support_grant.ended_by")
    .select(["support_grant.id", "support_grant.name", "support_grant.email", "support_grant.reason", "support_grant.level", "support_grant.starts_at", "support_grant.ends_at",
      "support_grant.ended_at", "support_grant.first_seen_at", "by.display_name as granted_by", "ender.display_name as ended_by"])
    .select((eb) => [
      eb.selectFrom("support_access_log").select((x) => x.fn.countAll<string>().as("n")).whereRef("support_access_log.grant_id", "=", "support_grant.id").as("reads"),
      eb.selectFrom("action_run").select((x) => x.fn.countAll<string>().as("n")).whereRef("action_run.support_grant_id", "=", "support_grant.id").where("action_run.status", "=", "applied").as("changes"),
    ])
    .orderBy("support_grant.starts_at", "desc").limit(100).execute();
  return rows.map((r) => ({ ...r, reads: Number(r.reads ?? 0), changes: Number(r.changes ?? 0),
    active: !r.ended_at && new Date(r.starts_at) <= now && new Date(r.ends_at) > now }));
}

/** What one person with support access opened and changed, newest first. */
export async function supportActivity(db: Db | Trx, grantId: string, lang: Lang) {
  const grant = await db.selectFrom("support_grant").select(["id", "name", "level"]).where("id", "=", grantId).executeTakeFirst();
  if (!grant) throw new KumiError("error.not_found", { thing: both("thing.support_grant") }, 404);
  const reads = await db.selectFrom("support_access_log").select(["at", "method", "path", "status"]).where("grant_id", "=", grantId).orderBy("id", "desc").limit(300).execute();
  const changes = await db.selectFrom("action_run").select(["id", "action", "status", "plan", "created_at", "applied_at"]).where("support_grant_id", "=", grantId).orderBy("id", "desc").limit(200).execute();
  return { grant, reads: reads.map((r) => ({ ...r, what: pageWords(r.method, r.path, lang) })), changes: changes.map((c) => ({ id: c.id, action: c.action, status: c.status, summary: (c.plan as { summary?: Record<Lang, string> } | null)?.summary?.[lang] ?? null, at: c.applied_at ?? c.created_at })) };
}

/** The staff app's areas, by the address the data came from: what the owner reads in the record of support access,
 *  in the words of the staff app's menu (support_access_log keeps the exact address). */
const AREAS: [RegExp, Key][] = [
  [/^(people|person|tags|segments|students|households?)$/, "ui.nav_people"], [/^(grid|block-series|locations|courts|alerts|quote)$/, "ui.courts"],
  [/^(programs|sessions|roster)$/, "ui.nav_programs"], [/^memberships$/, "ui.nav_memberships"], [/^(coaches|coach-earnings|my-schedule|calendar-link)$/, "ui.nav_coaches"],
  [/^scores$/, "ui.nav_scores"], [/^levels$/, "ui.nav_levels"], [/^(questions|facts)$/, "ui.nav_questions"], [/^(broadcasts|broadcast-options|templates|translate)$/, "ui.nav_messages"],
  [/^mirror$/, "ui.nav_playtomic"], [/^(payments|receipts|club-receipts)$/, "ui.nav_payments"], [/^reports$/, "ui.nav_reports"],
  [/^(settings|roles)$/, "ui.nav_settings"], [/^usage$/, "ui.nav_usage"], [/^changes$/, "ui.nav_changes"],
];
export function pageWords(method: string, path: string, lang: Lang): string {
  const action = /^\/actions\/([a-z_.]+)\/plan$/.exec(path)?.[1];
  const title = action ? t(lang, `action.${action}` as Key) : null;
  if (title && title !== `action.${action}`) return t(lang, "ui.support_read_preview", { what: title });
  const run = /^\/runs\/[^/]+\/(apply|approve|decline)$/.exec(path)?.[1];
  if (run) return t(lang, run === "apply" ? "ui.support_read_confirm" : run === "approve" ? "ui.support_read_approve" : "ui.support_read_decline");
  const area = /^\/staff\/([a-z-]+)/.exec(path)?.[1];
  const key = area ? AREAS.find(([re]) => re.test(area))?.[1] : undefined;
  return key ? t(lang, method === "GET" ? "ui.support_read_page" : "ui.support_read_sent", { area: t(lang, key) }) : t(lang, "ui.support_read_other");
}

/** The support access under way, for the banner the owner and managers see. */
export async function supportUnderWay(db: Db | Trx, now = new Date()) {
  return db.selectFrom("support_grant").select(["name", "level", "ends_at"]).where("ended_at", "is", null).where("starts_at", "<=", now).where("ends_at", ">", now).orderBy("ends_at").execute();
}
