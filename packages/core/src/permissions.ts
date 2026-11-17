// How Kumi decides (permissions.md): find the most specific grant per role, combine roles
// generously, apply the location, rows and time scopes, then cap agents.
import { sql } from "kysely";
import type { Key } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";

export type Mode = "allow" | "ask" | "no";
/** `support`: the support access (support.ts) the answer came from. */
export interface Decision { mode: Mode; reason?: Key; support?: string }
/** `assistant`: asked through an assistant (MCP), where support access never reaches. `strongAuth`: the action
 *  needs a strong sign-in (actions.ts), which support access never stretches to. `clubWide`: the action's things
 *  belong to no location when they have none of their own (a membership), so a role kept to one location does
 *  them too; one with a location (a booking's refund) is still that location's. `wholeClub`: the action is the whole
 *  club's (a message to everyone, the club's facts), so a role kept to one location never does it, and this says why. */
export interface Subject { personId: string | null; agentId?: string | null; locationId?: string | null; ownerIds?: string[]; at: Date; assistant?: boolean; strongAuth?: boolean; clubWide?: boolean; wholeClub?: Key;
  /** Only the member role counts: an assistant connection held to a member's reach (assistant_reach.ts). */
  memberOnly?: boolean }

const rank: Record<Mode, number> = { no: 0, ask: 1, allow: 2 };

/** How well a grant pattern matches an action: -1 for no match, higher is more specific. */
export function specificity(pattern: string, action: string): number {
  if (pattern === action) return 1000;
  if (pattern === "*") return 0;
  // "booking.*", and "person.passkey_*" (a family of actions): any action the pattern starts.
  if (pattern.endsWith("*") && action.startsWith(pattern.slice(0, -1))) return pattern.length;
  return -1;
}

export interface GrantRow { role_id: string; role_key: string; location_id: string | null; pattern: string; mode: Mode; rows_scope: "any" | "own"; time_scope: "any_time" | "on_shift" }

/** Who is asking, as far as their roles go: an action's actor (or a person id with how they're asking). */
export interface Asker { personId: string | null; memberOnly?: boolean }
/** The role keys that count for an asker: their active roles, or the member role alone when they ask through a
 *  connection held to a member's reach (assistant_reach.ts). Every check an action, its plan or a read the door runs
 *  makes of the asker's own roles goes through here (or holdsRole), so a held-back connection is a member everywhere. */
export async function roleKeysOf(db: Db | Trx, asker: Asker): Promise<string[]> {
  if (!asker.personId) return [];
  const rows = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", asker.personId).where("person_role.active", "=", true).where("role.active", "=", true).execute();
  const keys = [...new Set(rows.map((r) => r.key))];
  return asker.memberOnly ? keys.filter((k) => k === "member") : keys;
}
export async function holdsRole(db: Db | Trx, asker: Asker, keys: readonly string[]): Promise<boolean> {
  return (await roleKeysOf(db, asker)).some((k) => keys.includes(k));
}

/** Every grant the person holds through their roles; `memberOnly`, the member role's alone. */
export async function grantsFor(db: Db | Trx, personId: string, memberOnly = false): Promise<GrantRow[]> {
  const rows = await db.selectFrom("person_role").innerJoin("role_grant", "role_grant.role_id", "person_role.role_id").innerJoin("role", "role.id", "person_role.role_id")
    .select(["person_role.role_id", "role.key as role_key", "person_role.location_id", "role_grant.pattern", "role_grant.mode", "role_grant.rows_scope", "role_grant.time_scope"])
    .where("role.active", "=", true).where("role_grant.active", "=", true)
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).execute() as GrantRow[];
  return memberOnly ? rows.filter((r) => r.role_key === "member") : rows;
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
  const rows = await grantsFor(db, s.personId, Boolean(s.memberOnly));
  if (!rows.length) return { mode: "no", reason: "reason.no_role" };
  const byRole = new Map<string, GrantRow[]>();
  for (const r of rows) byRole.set(`${r.role_id}:${r.location_id ?? "*"}`, [...(byRole.get(`${r.role_id}:${r.location_id ?? "*"}`) ?? []), r]);
  let best: Decision = { mode: "no", reason: "reason.no_role" };
  for (const grants of byRole.values()) {
    const g = grants.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
    if (!g) continue;
    let d: Decision = { mode: g.mode, ...(g.mode === "no" ? { reason: "reason.owner_only" as Key } : {}) };
    if (g.location_id && s.locationId && g.location_id !== s.locationId) d = { mode: "no", reason: "reason.other_location" };
    else if (g.location_id && !s.locationId && !s.clubWide) d = { mode: "no", reason: s.wholeClub ?? "reason.other_location" };
    if (d.mode !== "no" && g.rows_scope === "own" && !(s.ownerIds ?? []).includes(s.personId)) d = { mode: "no", reason: "reason.own_only" };
    if (d.mode !== "no" && g.time_scope === "on_shift" && !(await onShift(db, s.personId, s.locationId, s.at))) d = { mode: "no", reason: "reason.off_shift" };
    if (rank[d.mode] > rank[best.mode] || (best.mode === "no" && d.mode === "no" && best.reason === "reason.no_role")) best = d;
  }
  return best;
}

// ---- Support access (support.ts): the owner let someone in for a while, to look or to work like a manager ----

/** Money that changes hands at the desk: taken there, or handed back there. Only someone standing at the desk with
 *  the money says it happened, so never support access (nobody from outside is holding the cash) and never an
 *  assistant (it can't see money change hands, and words it reads could tell it to mark something paid). */
export const DESK_MONEY = ["booking.record_payment", "enrolment.record_payment", "membership.sell", "membership.record_payment", "refund.give_back", "gift_card.sell", "pass.sell"];

/** Players' chats (chat.ts): reporting a message, and the club hiding one or stopping someone posting. Never through an
 *  assistant (what it reads in a chat could tell it to report or hide someone) and never through support access
 *  (players' conversations are theirs and the club's, not the host's). */
/** Club credit that leaves the club (credit.ts): paid out at the desk. Like the desk's money, never support access
 *  and never an assistant; and a member spends their own credit only in the app (an assistant can't). */
export const CREDIT_MONEY = ["credit.pay_out", "gift_card.void", "pass.refund", "payment_found.refund", "payment_found.paid_elsewhere"];
export const CHAT_ACTIONS = ["chat.report", "chat.hide", "chat.stop", "chat.allow"];

/** Never through support access, at any level: where the club's money goes, who holds which role (and who owns
 *  the club), every member's details in one file, deleting people or data, a person's sign-in, the club's secrets,
 *  the usage cap, the host's read-only and leaving switches, and support access itself. */
export const SUPPORT_NEVER = ["support.*", "role.*", "club.payment_*", "club.export", "club.setup", "club.read_only", "club.moved*", "club.leaving*", "club.usage_cap_set",
  "privacy.erase", "privacy.export", "person.reset_sign_in", "person.import", "vault.*", "assistant.*", "agent.*", "webhook.*", ...DESK_MONEY, ...CREDIT_MONEY, "pass_product.set", "promo_code.set", "chat.*", "weekly.end_all", "fixture.reopen",
  // A member's own credit and gift cards are theirs to spend and redeem, in the app (credit.ts, gift_cards.ts).
  "payment.use_credit", "gift_card.redeem",
  // A member's passes and the codes they use are theirs too (passes.ts, promo_codes.ts).
  "payment.use_pass", "payment.use_promo",
  // Moving in from Playtomic (brought_in.ts): money owed and memberships in bulk from the club's own data, and saying
  // its wallets are at zero, are the club's own, like a members' import.
  "playtomic.upload", "credit.bring_in", "membership.bring_in", "credit.brought_zeroing", "credit.brought_zeroed"];
/** Their own account, which they look after like anyone (their second sign-in step first of all). */
const SUPPORT_OWN = ["person.factor_*", "person.passkey_*", "person.update_profile"];

/** The support access a person holds right now, if any. */
export async function activeSupport(db: Db | Trx, personId: string, at: Date) {
  return (await db.selectFrom("support_grant").selectAll().where("person_id", "=", personId).where("ended_at", "is", null)
    .where("starts_at", "<=", at).where("ends_at", ">", at).orderBy("ends_at", "desc").executeTakeFirst()) ?? null;
}

/** What support access gives for an action, or null when the person holds none. */
async function decideSupport(db: Db | Trx, action: string, s: Subject & { personId: string }): Promise<Decision | null> {
  const g = await activeSupport(db, s.personId, s.at);
  if (!g) return null;
  const hit = (patterns: string[]) => patterns.some((p) => specificity(p, action) >= 0);
  if (s.assistant || s.agentId) return { mode: "no", reason: "reason.support_no_assistant", support: g.id };
  // Reading the change log is a manager's read, at either level.
  if (action === "changes.view") return { mode: "allow", support: g.id };
  if (hit(SUPPORT_OWN)) return (s.ownerIds ?? []).includes(s.personId) ? { mode: "allow", support: g.id } : { mode: "no", reason: "reason.own_only", support: g.id };
  if (s.strongAuth || hit(SUPPORT_NEVER)) return { mode: "no", reason: "reason.support_never", support: g.id };
  if (g.level === "view") return { mode: "no", reason: "reason.support_view_only", support: g.id };
  // Like a manager: the manager role's grants as the club has them, asking the owner where a manager asks.
  const grants = await db.selectFrom("role_grant").innerJoin("role", "role.id", "role_grant.role_id").select(["role_grant.pattern", "role_grant.mode"])
    .where("role.key", "=", "manager").where("role.active", "=", true).where("role_grant.active", "=", true).execute();
  const best = grants.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
  if (!best || best.mode === "no") return { mode: "no", reason: "reason.owner_only", support: g.id };
  return { mode: best.mode as Mode, support: g.id };
}

/** What a club agent (agents.ts) may always do for itself, whatever its role: its own webhooks (webhooks.ts). Nobody's
 *  role holds these for an agent, since a role the club makes holds only what a manager does without asking. */
export const AGENT_OWN = ["webhook.subscribe", "webhook.update", "webhook.remove", "webhook.test"];
/** The club agent a person row stands for (agents.ts), while it's not taken back: null for everyone else. */
export async function clubAgentOf(db: Db | Trx, personId: string | null | undefined): Promise<{ id: string; capped_role_id: string | null } | null> {
  if (!personId) return null;
  return (await db.selectFrom("agent").select(["id", "capped_role_id"]).where("person_id", "=", personId).where("kind", "=", "club").where("revoked_at", "is", null).executeTakeFirst()) ?? null;
}

/** What only a plugin's own token may do (plugin_cards.ts): put and clear its own cards. Nobody's role holds these, not
 *  even the owner's "*": a person, an assistant or another agent is refused, and the door never lists them for one. */
export const PLUGIN_OWN = ["plugin.card_put", "plugin.card_clear"];
/** Whether a person row is a live plugin's agent (not paused or removed, its agent not revoked). */
async function isLivePlugin(db: Db | Trx, personId: string): Promise<boolean> {
  return Boolean(await db.selectFrom("plugin").innerJoin("agent", "agent.id", "plugin.agent_id").select("plugin.id").where("agent.person_id", "=", personId)
    .where("agent.revoked_at", "is", null).where("plugin.status", "in", ["waiting", "on"]).executeTakeFirst());
}

export async function decide(db: Db | Trx, action: string, s: Subject): Promise<Decision> {
  if (!s.personId) return { mode: "no", reason: "reason.no_role" };
  // A plugin's own cards: its token alone, on its own rows, whatever any role says.
  if (PLUGIN_OWN.includes(action)) return (s.ownerIds ?? []).includes(s.personId) && await isLivePlugin(db, s.personId) ? { mode: "allow" } : { mode: "no", reason: "reason.plugin_own" };
  // A club agent looks after its own webhooks (its own rows only), whatever its role says.
  if (AGENT_OWN.includes(action) && (s.ownerIds ?? []).includes(s.personId) && await clubAgentOf(db, s.personId)) return { mode: "allow" };
  const own = await decidePerson(db, action, { ...s, personId: s.personId });
  // Support access adds to what the person holds themselves; it never takes anything away.
  const support = await decideSupport(db, action, { ...s, personId: s.personId });
  const chosen = support && (rank[support.mode] > rank[own.mode] || (own.mode === "no" && own.reason === "reason.no_role")) ? support : own;
  // Whatever answered, a change made while holding support access is marked as support's in the change log.
  const person: Decision = support ? { ...chosen, support: support.support } : chosen;
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
  return (await everDoable(db, personId))(action);
}
/** mayEverDo for many actions from one read of the person's grants (the assistant door lists every action). */
export async function everDoable(db: Db | Trx, personId: string, opts: { memberOnly?: boolean } = {}): Promise<(action: string) => boolean> {
  const rows = await grantsFor(db, personId, Boolean(opts.memberOnly));
  const byRole = new Map<string, GrantRow[]>();
  for (const r of rows) byRole.set(r.role_id, [...(byRole.get(r.role_id) ?? []), r]);
  return (action) => {
    for (const grants of byRole.values()) {
      const g = grants.filter((x) => specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
      if (g && g.mode !== "no") return true;
    }
    return false;
  };
}
