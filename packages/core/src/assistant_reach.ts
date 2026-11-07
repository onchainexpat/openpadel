// How far an assistant connection reaches: never further than its person allowed when they connected it. With each
// connection is kept what they held then (their roles and grants) and whether they had given a second step. At each
// use, if they now hold more (a staff role given, a removal undone, the server's `owner add`, a role the club made
// widened) or the club now asks a second step they hadn't given, the connection works as a member's until they
// connect it again, and they hear it once. Less than they held (a role taken away) is checked as always: the person's
// own permissions still decide every preview and confirm.
import type { Db } from "./db.ts";
import { actions } from "./actions.ts";
import { grantsFor, specificity, type GrantRow } from "./permissions.ts";
import { needsTwoFactor } from "./two_factor.ts";

export interface Powers { roles: { key: string; system: boolean; location_id: string | null }[]; grants: GrantRow[] }
export type Limited = "widened" | "second_step";

export async function powersOf(db: Db, personId: string): Promise<Powers> {
  const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "role.system", "person_role.location_id"])
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true).execute();
  return { roles: roles.map((r) => ({ key: r.key, system: r.system, location_id: r.location_id })), grants: await grantsFor(db, personId) };
}

type Cap = { mode: number; location: string | null; rows: "any" | "own"; time: "any_time" | "on_shift" };
const RANK = { no: 0, ask: 1, allow: 2 } as const;
/** What each role (at its location) gives for one action: its most specific grant, as permissions.ts reads it. */
function capsFor(grants: GrantRow[], action: string): Cap[] {
  const byRole = new Map<string, GrantRow[]>();
  for (const g of grants) byRole.set(`${g.role_id}:${g.location_id ?? "*"}`, [...(byRole.get(`${g.role_id}:${g.location_id ?? "*"}`) ?? []), g]);
  const caps: Cap[] = [];
  for (const rows of byRole.values()) {
    const g = rows.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
    if (g && g.mode !== "no") caps.push({ mode: RANK[g.mode], location: g.location_id, rows: g.rows_scope, time: g.time_scope });
  }
  return caps;
}
const covers = (a: Cap, b: Cap) => a.mode >= b.mode && (a.location === null || a.location === b.location) && (a.rows === "any" || b.rows === "own") && (a.time === "any_time" || b.time === "on_shift");

/** Whether `now` reaches anything `then` didn't: an action in more places, on more rows, at more times or without
 *  asking; or a built-in staff role's screens they didn't hold (an owner held them all, a manager all but the owner's). */
export function widens(now: Powers, then: Powers, names: string[] = actions().map((a) => a.name)): boolean {
  for (const a of names) {
    const was = capsFor(then.grants, a);
    if (capsFor(now.grants, a).some((c) => !was.some((w) => covers(w, c)))) return true;
  }
  const held = then.roles.filter((r) => r.system);
  return now.roles.filter((r) => r.system && r.key !== "member").some((r) => !held.some((o) =>
    o.key === "owner" || (o.key === "manager" && r.key !== "owner") || (o.key === r.key && (o.location_id === null || o.location_id === r.location_id))));
}

/** Null when the connection reaches all its person may; otherwise why it works as a member's. Said to them once. */
export async function connectionReach(db: Db, grantId: string, personId: string, now: Date): Promise<Limited | null> {
  const g = await db.selectFrom("oauth_grant").select(["powers", "second_step", "limited_told_at"]).where("id", "=", grantId).executeTakeFirst();
  if (!g) return null;
  const current = await powersOf(db, personId);
  if (!g.powers) {   // made before this was kept: the first use takes what they hold now
    await db.updateTable("oauth_grant").set({ powers: JSON.stringify(current) }).where("id", "=", grantId).where("powers", "is", null).execute();
    g.powers = current;
  }
  if (!current.roles.some((r) => r.key !== "member")) return null;   // a member's reach is all they have
  const why: Limited | null = widens(current, g.powers as Powers) ? "widened" : !g.second_step && await needsTwoFactor(db, personId, { support: false }) ? "second_step" : null;
  if (why && !g.limited_told_at) {
    const told = await db.updateTable("oauth_grant").set({ limited_told_at: now }).where("id", "=", grantId).where("limited_told_at", "is", null).returning("id").executeTakeFirst();
    if (told) await db.insertInto("event_outbox").values({ action_run_id: null, topic: "assistant.limited", payload: JSON.stringify({ grant_id: grantId, why }) }).execute();
  }
  return why;
}
