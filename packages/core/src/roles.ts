// Roles the owner makes. A role is a name and a list of what it may do: actions, each for the person's own
// rows or everyone's, and optionally with someone's approval. It can only hold what a manager may do
// without asking (anything a manager has to ask for, or can't do, is the owner's), and nobody can make or
// give a role that does more than they can themselves.
import { randomBytes } from "node:crypto";
import * as z from "zod/mini";
import { both, type Key, type Text } from "@kumi/i18n";
import { actions, defineAction, readRow, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { specificity, type Asker, type Mode } from "./permissions.ts";

/** An action in words ("Undo a change"), for a refusal staff read; its name only if the catalogs have no words for it. */
const actionWords = (name: string): Text => {
  const w = both(`action.${name}` as Key);
  return w.en === `action.${name}` ? { en: name, es: name } : w;
};

/** The areas actions fall in, by the first part of their name. */
export const AREAS: { key: string; prefixes: string[] }[] = [
  { key: "bookings", prefixes: ["booking", "lesson", "alert"] },
  { key: "courts", prefixes: ["court", "hours", "location", "connector", "mirror"] },
  { key: "programs", prefixes: ["program", "session", "series", "enrolment", "waitlist", "draw", "attendance"] },
  { key: "members", prefixes: ["person", "household", "kid", "waiver", "tag", "privacy", "friend", "consent", "family_card", "email", "chat"] },
  { key: "memberships", prefixes: ["membership"] },
  { key: "money", prefixes: ["payment", "refund", "price", "policy", "receipt"] },
  { key: "messages", prefixes: ["broadcast", "segment", "template", "question", "fact"] },
  { key: "levels", prefixes: ["level", "result", "game"] },
  { key: "coaches", prefixes: ["coach"] },
  { key: "settings", prefixes: ["club", "role", "action"] },
];
export function areaOf(action: string): string {
  const head = action.split(".")[0]!;
  return AREAS.find((a) => a.prefixes.includes(head))?.key ?? "settings";
}

export type Scope = "own" | "any";
export interface Held { mode: Mode; scope: Scope }
const rank: Record<Mode, number> = { no: 0, ask: 1, allow: 2 };
type Grant = { pattern: string; mode: Mode; rows_scope: Scope };
function bestGrant(grants: Grant[], action: string): Grant | null {
  return grants.filter((g) => specificity(g.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0] ?? null;
}
async function grantsOfRole(db: Db | Trx, roleId: string): Promise<Grant[]> {
  return db.selectFrom("role_grant").select(["pattern", "mode", "rows_scope"]).where("role_id", "=", roleId).where("active", "=", true).execute() as Promise<Grant[]>;
}
/** What one role allows for an action, or null. */
export function roleAllows(grants: Grant[], action: string): Held | null {
  const g = bestGrant(grants, action);
  return g && g.mode !== "no" ? { mode: g.mode, scope: g.rows_scope } : null;
}
/** The most a person holds for an action across their roles (place and shift aside). */
export async function heldBy(db: Db | Trx, asker: Asker, action: string): Promise<Held | null> {
  if (!asker.personId) return null;
  const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.id")
    .where("person_role.person_id", "=", asker.personId).where("person_role.active", "=", true).where("role.active", "=", true)
    .$if(Boolean(asker.memberOnly), (q) => q.where("role.key", "=", "member")).execute();
  let best: Held | null = null;
  for (const r of roles) {
    const h = roleAllows(await grantsOfRole(db, r.id), action);
    if (h && (!best || rank[h.mode] > rank[best.mode] || (rank[h.mode] === rank[best.mode] && h.scope === "any"))) best = h;
  }
  return best;
}
/** Whether `want` goes beyond `have`. */
export const exceeds = (want: Held, have: Held | null) => !have || rank[want.mode] > rank[have.mode] || (want.scope === "any" && have.scope === "own");

/** What a role the club makes may hold: anything people can be asked to do, that a manager may do without asking. */
export async function grantableActions(db: Db | Trx): Promise<string[]> {
  const manager = await db.selectFrom("role").select("id").where("key", "=", "manager").executeTakeFirstOrThrow();
  const grants = await grantsOfRole(db, manager.id);
  return actions().filter((a) => !a.system && !a.internal && !a.name.startsWith("test.") && !a.name.startsWith("role.") && roleAllows(grants, a.name)?.mode === "allow")
    .map((a) => a.name).sort();
}

const roleName = z.string().check(z.minLength(1), z.maxLength(60));
const grantInput = z.object({ action: z.string(), scope: z.enum(["own", "any"]), approval: z.optional(z.boolean()) });
type GrantIn = z.infer<typeof grantInput>;

/** A role's name to show: the built-in ones in each language, the club's own as written. */
export async function roleLabel(db: Db | Trx, key: string): Promise<Text> {
  const r = await db.selectFrom("role").select(["key", "system", "name"]).where("key", "=", key).executeTakeFirst();
  if (!r || r.system) return both(`role.${key}` as Key);
  return { en: r.name ?? key, es: r.name ?? key };
}

/** The grants checked: real, allowed in a club's role, within what the person making it holds, no repeats. */
async function checkGrants(ctx: PlanCtx, grants: GrantIn[]): Promise<void> {
  const allowed = new Set(await grantableActions(ctx.db));
  const seen = new Set<string>();
  for (const g of grants) {
    if (seen.has(g.action)) throw new KumiError("error.role_grant_twice", { action: actionWords(g.action) });
    seen.add(g.action);
    if (!allowed.has(g.action)) throw new KumiError("error.role_owner_only", { action: actionWords(g.action) });
    if (ctx.actor.personId && exceeds({ mode: g.approval ? "ask" : "allow", scope: g.scope }, await heldBy(ctx.db, ctx.actor, g.action)))
      throw new KumiError("error.role_more_than_you", { action: actionWords(g.action) });
  }
}

/** "It can: book a court (everyone's), ... It can't do anything in: money, settings." */
async function describe(db: Db | Trx, grants: GrantIn[]): Promise<Text> {
  const out: Text = { en: "", es: "" };
  for (const lang of ["en", "es"] as const) {
    const parts: string[] = [];
    for (const area of AREAS) {
      const mine = grants.filter((g) => areaOf(g.action) === area.key);
      if (!mine.length) continue;
      const items = mine.map((g) => `${both(`action.${g.action}` as Key)[lang]} (${both(g.scope === "any" ? "roledesc.scope_any" : "roledesc.scope_own")[lang]}${g.approval ? `, ${both("roledesc.with_approval")[lang]}` : ""})`);
      parts.push(`${both(`area.${area.key}` as Key)[lang]}: ${items.join("; ")}`);
    }
    const none = AREAS.filter((a) => !grants.some((g) => areaOf(g.action) === a.key)).map((a) => both(`area.${a.key}` as Key)[lang].toLowerCase());
    out[lang] = [parts.length ? both("roledesc.can", { list: parts.join(". ") })[lang] : both("roledesc.can_nothing")[lang], none.length ? both("roledesc.cannot", { areas: none.join(", ") })[lang] : ""].filter(Boolean).join(" ");
  }
  return out;
}
async function nameTaken(db: Db | Trx, name: string, except?: string): Promise<boolean> {
  const rows = await db.selectFrom("role").select(["id", "key", "name", "system"]).where("active", "=", true).execute();
  const n = name.trim().toLowerCase();
  return rows.some((r) => r.id !== except && ((r.name ?? "").trim().toLowerCase() === n || (r.system && [both(`role.${r.key}` as Key).en, both(`role.${r.key}` as Key).es].some((x) => x.toLowerCase() === n))));
}
async function customRole(db: Db | Trx, key: string) {
  const r = await db.selectFrom("role").selectAll().where("key", "=", key).executeTakeFirst();
  if (!r || !r.active) throw new KumiError("error.not_found", { thing: both("thing.role") }, 404);
  if (r.system) throw new KumiError("error.role_built_in");
  return r;
}

export const roleCreate = defineAction({
  name: "role.create", version: 1, strongAuth: true,
  input: z.object({ name: roleName, based_on: z.optional(z.string()), grants: z.array(grantInput).check(z.maxLength(400)) }),
  async plan(ctx, i) {
    if (await nameTaken(ctx.db, i.name)) throw new KumiError("error.role_name_taken");
    await checkGrants(ctx, i.grants);
    return { title: both("action.role.create"), summary: both("plan.role.create", { name: i.name.trim(), what: await describe(ctx.db, i.grants) }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7(), key = `custom_${randomBytes(4).toString("hex")}`;
    await ctx.insert("role", { id, key, system: false, name: i.name.trim(), based_on: i.based_on ?? null });
    for (const g of i.grants) await ctx.insert("role_grant", { id: uuidv7(), role_id: id, pattern: g.action, mode: g.approval ? "ask" : "allow", rows_scope: g.scope });
    return { role_id: id, key };
  },
});

export const roleUpdate = defineAction({
  name: "role.update", version: 1, strongAuth: true,
  input: z.object({ role: z.string(), name: z.optional(roleName), grants: z.array(grantInput).check(z.maxLength(400)) }),
  async plan(ctx, i) {
    const r = await customRole(ctx.db, i.role);
    if (i.name && await nameTaken(ctx.db, i.name, r.id)) throw new KumiError("error.role_name_taken");
    await checkGrants(ctx, i.grants);
    const holders = Number((await ctx.db.selectFrom("person_role").select((eb) => eb.fn.countAll<string>().as("n")).where("role_id", "=", r.id).where("active", "=", true).executeTakeFirstOrThrow()).n);
    return { title: both("action.role.update"), reads: [{ entity: "role", id: r.id, version: r.version }], undo: { kind: "compensating" },
      summary: both("plan.role.update", { name: (i.name ?? r.name ?? r.key).trim(), what: await describe(ctx.db, i.grants), holders: both("count.people", { count: holders }) }), details: { role_id: r.id } };
  },
  async apply(ctx, i, p) {
    const roleId = (p.details as { role_id: string }).role_id;
    await ctx.update("role", roleId, { ...(i.name ? { name: i.name.trim() } : {}) });
    const old = await ctx.trx.selectFrom("role_grant").select(["id", "pattern", "mode", "rows_scope"]).where("role_id", "=", roleId).where("active", "=", true).execute();
    const want = new Map(i.grants.map((g) => [g.action, { mode: g.approval ? "ask" : "allow", scope: g.scope }]));
    for (const g of old) {
      const w = want.get(g.pattern);
      if (w && w.mode === g.mode && w.scope === g.rows_scope) { want.delete(g.pattern); continue; }
      await ctx.update("role_grant", g.id, { active: false });
    }
    for (const [action, w] of want) await ctx.insert("role_grant", { id: uuidv7(), role_id: roleId, pattern: action, mode: w.mode, rows_scope: w.scope });
    return null;
  },
});

export const roleRetire = defineAction({
  name: "role.retire", version: 1, strongAuth: true,
  input: z.object({ role: z.string() }),
  async plan(ctx, i) {
    const r = await customRole(ctx.db, i.role);
    const holders = await ctx.db.selectFrom("person_role").innerJoin("person", "person.id", "person_role.person_id").select(["person_role.id", "person.display_name"])
      .where("person_role.role_id", "=", r.id).where("person_role.active", "=", true).execute();
    return { title: both("action.role.retire"), reads: [{ entity: "role", id: r.id, version: r.version }], undo: { kind: "compensating" },
      summary: both("plan.role.retire", { name: r.name ?? r.key, holders: holders.length ? { en: holders.map((h) => h.display_name).join(", "), es: holders.map((h) => h.display_name).join(", ") } : both("plan.role.retire_nobody") }),
      details: { role_id: r.id, holders: holders.map((h) => h.id) } };
  },
  async apply(ctx, _i, p) {
    const d = p.details as { role_id: string; holders: string[] };
    for (const id of d.holders) await ctx.update("person_role", id, { active: false });
    await ctx.update("role", d.role_id, { active: false });
    return null;
  },
});

/** Before giving someone a role: it mustn't do more than the person giving it can. */
export async function checkAssign(ctx: PlanCtx, roleId: string): Promise<void> {
  if (!ctx.actor.personId) return;   // Kumi itself (setup)
  const grants = await grantsOfRole(ctx.db, roleId);
  for (const a of actions()) {
    if (a.internal) continue;
    const want = roleAllows(grants, a.name);
    if (want && exceeds(want, await heldBy(ctx.db, ctx.actor, a.name))) throw new KumiError("error.role_more_than_you", { action: actionWords(a.name) });
  }
}

/** For the staff screens: each area with the actions a club's role may hold, in the reader's language. */
export async function roleCatalogue(db: Db | Trx, lang: "en" | "es") {
  const names = await grantableActions(db);
  return AREAS.map((a) => ({ key: a.key, title: both(`area.${a.key}` as Key)[lang],
    actions: names.filter((n) => areaOf(n) === a.key).map((n) => ({ name: n, title: both(`action.${n}` as Key)[lang] })) })).filter((a) => a.actions.length);
}

/** A role's grants as the editor shows them (a built-in one, worked out action by action, as a starting point). */
export async function roleGrantsView(db: Db | Trx, key: string): Promise<{ action: string; scope: Scope; approval: boolean }[]> {
  const r = await db.selectFrom("role").select(["id", "system"]).where("key", "=", key).where("active", "=", true).executeTakeFirst();
  if (!r) throw new KumiError("error.not_found", { thing: both("thing.role") }, 404);
  const grants = await grantsOfRole(db, r.id), names = await grantableActions(db);
  return names.map((n) => ({ n, h: roleAllows(grants, n) })).filter((x) => x.h).map((x) => ({ action: x.n, scope: x.h!.scope, approval: x.h!.mode === "ask" }));
}

/** The staff screens' areas a coach's role reads: their own work (lessons and court time, programs, levels, coaches). */
export const COACH_AREAS = ["bookings", "programs", "levels", "coaches"];
/** The built-in roles that read every area: front desk and up, and the accountant. Support access reads as a manager. */
const ALL_AREAS_ROLES = ["owner", "manager", "front_desk", "accountant"];
/** What a person's staff roles let them read, all of them together: `all` for a role reading every area (front desk
 *  and up, the accountant, and `extraKeys`: support access's manager), else `coach` (the coach role, COACH_AREAS) and
 *  `custom`, the areas the roles the club made cover (null when they hold none). */
export async function staffReach(db: Db | Trx, personId: string, extraKeys: string[] = []): Promise<{ all: boolean; coach: boolean; custom: string[] | null }> {
  const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.id", "role.key", "role.system"])
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true).execute();
  const all = [...roles.filter((r) => r.system).map((r) => r.key), ...extraKeys].some((k) => ALL_AREAS_ROLES.includes(k));
  const coach = roles.some((r) => r.system && r.key === "coach"), mine = roles.filter((x) => !x.system);
  if (!mine.length) return { all, coach, custom: null };
  const areas = new Set<string>();
  for (const r of mine) for (const g of await grantsOfRole(db, r.id)) if (g.mode !== "no") areas.add(areaOf(g.pattern));
  return { all, coach, custom: AREAS.map((a) => a.key).filter((k) => areas.has(k)) };
}
/** The areas a person reads: the union of what each of their roles gives (a coach COACH_AREAS, each role the club made
 *  its own areas), or null for every area (front desk and up, the accountant, support access through `extraKeys`).
 *  [] for someone with no staff role. */
export async function readAreas(db: Db | Trx, personId: string, extraKeys: string[] = []): Promise<string[] | null> {
  const r = await staffReach(db, personId, extraKeys);
  if (r.all) return null;
  const areas = new Set([...(r.coach ? COACH_AREAS : []), ...(r.custom ?? [])]);
  return AREAS.map((a) => a.key).filter((k) => areas.has(k));
}

/** The areas someone holding a role the club made reads (for their menus and reads), with a coach's own areas too when
 *  they also coach: null when they hold none, or hold a built-in role that reads every area. */
export async function customAreas(db: Db | Trx, personId: string): Promise<string[] | null> {
  const r = await staffReach(db, personId);
  return r.all || !r.custom ? null : readAreas(db, personId);
}

/** Of `actions`, the ones the roles the club made, or the coach role, give this person (for their buttons; the member
 *  role's own-scope grants, such as cancelling one's own booking, aren't staff work). */
export async function customCan(db: Db | Trx, personId: string, actions: string[]): Promise<string[]> {
  const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.id")
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true)
    .where((w) => w.or([w("role.system", "=", false), w("role.key", "=", "coach")])).execute();
  const grants = await Promise.all(roles.map((r) => grantsOfRole(db, r.id)));
  return actions.filter((a) => grants.some((g) => roleAllows(g, a)));
}
