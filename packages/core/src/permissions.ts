// How Kumi decides (permissions.md): find the most specific grant per role, combine roles
// generously, apply the location, rows and time scopes, then cap agents.
import { sql } from "kysely";
import type { Key } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";

export type Mode = "allow" | "ask" | "no";
export interface Decision { mode: Mode; reason?: Key }
export interface Subject { personId: string | null; agentId?: string | null; locationId?: string | null; ownerIds?: string[]; at: Date }

const rank: Record<Mode, number> = { no: 0, ask: 1, allow: 2 };

/** How well a grant pattern matches an action: -1 for no match, higher is more specific. */
export function specificity(pattern: string, action: string): number {
  if (pattern === action) return 1000;
  if (pattern === "*") return 0;
  // "booking.*", and "person.passkey_*" (a family of actions): any action the pattern starts.
  if (pattern.endsWith("*") && action.startsWith(pattern.slice(0, -1))) return pattern.length;
  return -1;
}

interface GrantRow { role_id: string; location_id: string | null; pattern: string; mode: Mode; rows_scope: "any" | "own"; time_scope: "any_time" | "on_shift" }

async function grantsFor(db: Db | Trx, personId: string): Promise<GrantRow[]> {
  return db.selectFrom("person_role").innerJoin("role_grant", "role_grant.role_id", "person_role.role_id")
    .select(["person_role.role_id", "person_role.location_id", "role_grant.pattern", "role_grant.mode", "role_grant.rows_scope", "role_grant.time_scope"])
    .innerJoin("role", "role.id", "person_role.role_id").where("role.active", "=", true).where("role_grant.active", "=", true)
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).execute() as Promise<GrantRow[]>;
}

async function onShift(db: Db | Trx, personId: string, locationId: string | null | undefined, at: Date): Promise<boolean> {
  const r = await db.selectFrom("staff_shift").innerJoin("staff_member", "staff_member.id", "staff_shift.staff_member_id")
    .select("staff_shift.id").where("staff_member.person_id", "=", personId)
    .$if(Boolean(locationId), (q) => q.where("staff_shift.location_id", "=", locationId!))
    .where(sql<boolean>`staff_shift.during @> ${at}::timestamptz`).executeTakeFirst();
  return Boolean(r);
}

/** The answer for one person, ignoring agents: the most generous of their roles. */
async function decidePerson(db: Db | Trx, action: string, s: Subject & { personId: string }): Promise<Decision> {
  const rows = await grantsFor(db, s.personId);
  if (!rows.length) return { mode: "no", reason: "reason.no_role" };
  const byRole = new Map<string, GrantRow[]>();
  for (const r of rows) byRole.set(`${r.role_id}:${r.location_id ?? "*"}`, [...(byRole.get(`${r.role_id}:${r.location_id ?? "*"}`) ?? []), r]);
  let best: Decision = { mode: "no", reason: "reason.no_role" };
  for (const grants of byRole.values()) {
    const g = grants.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
    if (!g) continue;
    let d: Decision = { mode: g.mode, ...(g.mode === "no" ? { reason: "reason.owner_only" as Key } : {}) };
    if (g.location_id && s.locationId && g.location_id !== s.locationId) d = { mode: "no", reason: "reason.other_location" };
    else if (g.location_id && !s.locationId) d = { mode: "no", reason: "reason.other_location" };
    if (d.mode !== "no" && g.rows_scope === "own" && !(s.ownerIds ?? []).includes(s.personId)) d = { mode: "no", reason: "reason.own_only" };
    if (d.mode !== "no" && g.time_scope === "on_shift" && !(await onShift(db, s.personId, s.locationId, s.at))) d = { mode: "no", reason: "reason.off_shift" };
    if (rank[d.mode] > rank[best.mode] || (best.mode === "no" && d.mode === "no" && best.reason === "reason.no_role")) best = d;
  }
  return best;
}

export async function decide(db: Db | Trx, action: string, s: Subject): Promise<Decision> {
  if (!s.personId) return { mode: "no", reason: "reason.no_role" };
  const person = await decidePerson(db, action, { ...s, personId: s.personId });
  if (!s.agentId) return person;
  // An agent gets the answer for the person it acts for, then its own cap: the lower wins.
  const agent = await db.selectFrom("agent").select(["capped_role_id"]).where("id", "=", s.agentId).executeTakeFirst();
  if (!agent?.capped_role_id) return { mode: "no", reason: "reason.agent_cap" };
  const cap = await db.selectFrom("role_grant").select(["pattern", "mode"]).where("role_id", "=", agent.capped_role_id).where("active", "=", true).execute();
  const g = cap.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
  const capMode: Mode = g?.mode ?? "no";
  return rank[capMode] < rank[person.mode] ? { mode: capMode, reason: "reason.agent_cap" } : person;
}

/** For listing what a person might do (MCP tools, menus): any role grants it in some scope.
 *  The full check, with rows, location and time, still runs on every preview. */
export async function mayEverDo(db: Db | Trx, personId: string, action: string): Promise<boolean> {
  const rows = await grantsFor(db, personId);
  const byRole = new Map<string, GrantRow[]>();
  for (const r of rows) byRole.set(r.role_id, [...(byRole.get(r.role_id) ?? []), r]);
  for (const grants of byRole.values()) {
    const g = grants.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
    if (g && g.mode !== "no") return true;
  }
  return false;
}
