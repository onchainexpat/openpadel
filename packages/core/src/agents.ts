// Club agents: an agent that isn't any one person's (an n8n workflow, a bot, a desk agent running all night). Each is
// an `agent` row of kind 'club' with a name, the role that caps it (a normal role the club can edit: built-in or one it
// made, never the owner's), a weekly limit on the money its changes move (assistant_spend.ts, checkAgentSpend), and one
// connection to the door (an oauth_grant with one long-lived token, kept as a hash). It acts through a person row of
// its own (created_via 'agent', with no way to sign in) that holds that role, so it goes through the same door as
// anyone: the same permission check (and the agent's cap on top, permissions.ts), previews, asks that wait in
// Approvals like a person's, the change log (action_run.agent_id), and undo.
//
// Why a token rather than the device sign-in: the device sign-in makes a connection for the person who allows it,
// with tokens that last an hour and must be renewed; n8n, a bot or any MCP client wants one bearer token it keeps.
// The token is the door's own kind (oauth_token, a hash, revoked with its grant), so /mcp and the command line take it
// with no second way in. It's shown once, to whoever made it (ActionDef.after), and never kept in the change log.
//
// An agent can't make, change or take back an agent (it can't raise its own limits), and an assistant making one
// can't give it a limit higher than its own.
import { randomBytes, createHash } from "node:crypto";
import * as z from "zod/mini";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, readRow, type Actor, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { checkAssign, roleLabel, roleText } from "./roles.ts";
import { openText, sealText } from "./sealed.ts";
import { agentWeekSpent, weekSpent } from "./assistant_spend.ts";

/** The door's client every club agent connects as (migration 126). */
export const AGENT_CLIENT = "openpadel-agent";
/** The resource an agent's token is for: any of the club's MCP addresses (oauth.ts, bearerPerson). */
export const AGENT_RESOURCE = "agent";
/** The highest weekly limit a club can give an agent: $5,000 of money moved. */
export const AGENT_MAX_WEEKLY_CAP_CENTS = 500_000;
/** Roles an agent can't be capped by: the owner's (an agent never owns the club), a member's (nothing for an agent) and
 *  a coach's (a coach is someone who gives lessons, listed to members and staff as one). */
export const NOT_FOR_AGENTS = ["owner", "member", "coach"];
/** How long a new token waits to be shown before it's dropped (a change approved later shows it to nobody: New token). */
export const TOKEN_ONCE_MINUTES = 60;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const usd = (c: number): Text => ({ en: money(c, "en"), es: money(c, "es") });
const capText = (c: number): Text => (c ? both("plan.agent.cap_up_to", { amount: usd(c) }) : both("plan.agent.cap_none"));
const agentName = z.string().check(z.minLength(1), z.maxLength(60));
const capInput = z.number().check(z.int(), z.minimum(0), z.maximum(AGENT_MAX_WEEKLY_CAP_CENTS), z.describe("The most money its changes may move each club week (payments and refunds together), in cents; 0 for none"));
const roleInput = z.string().check(z.minLength(1), z.maxLength(40), z.describe("The role that caps it, by key: front_desk, accountant, manager, or one the club made (custom_...); never owner or coach"));

/** A new agent token: "opa_" and 43 characters, of which the last four are shown afterwards. */
export function newToken(): { token: string; hash: string; last4: string } {
  const token = `opa_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha(token), last4: token.slice(-4) };
}
/** The token's row for the door (oauth.ts reads it like any access token): it doesn't run out; it ends with its grant. */
export async function keepToken(trx: Trx, grantId: string, hash: string, now: Date) {
  await trx.insertInto("oauth_token").values({ token_hash: hash, kind: "access", grant_id: grantId, family: grantId, resource: AGENT_RESOURCE,
    expires_at: new Date("9999-12-31T00:00:00Z"), used_at: null, revoked_at: null, created_at: now }).execute();
}
/** The new token, once, to whoever made the change; then it's gone (only its last four stay). */
async function tokenOnce(db: Db, agentId: string): Promise<string | null> {
  const r = await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("agent").select("token_once").where("id", "=", agentId).where("token_once", "is not", null).forUpdate().executeTakeFirst();
    if (row) await trx.updateTable("agent").set({ token_once: null, token_once_at: null }).where("id", "=", agentId).execute();
    return row;
  });
  // Sealed under a key this server has since stopped using (it's kept for an hour at most, so it isn't resealed): gone.
  try { return r?.token_once ? openText(r.token_once) : null; } catch { return null; }
}
/** Tokens never shown (a change someone approved later): dropped after an hour. Run with the other tidy jobs. */
export async function tidyAgentTokens(db: Db, now = new Date()): Promise<number> {
  const r = await db.updateTable("agent").set({ token_once: null, token_once_at: null }).where("token_once", "is not", null)
    .where("token_once_at", "<", new Date(now.getTime() - TOKEN_ONCE_MINUTES * 60_000)).executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/** Nothing an agent does reaches its own kind: making, changing and taking back agents are people's. */
function notByAnAgent(ctx: PlanCtx) {
  if (ctx.actor.agentId) throw new KumiError("error.agent_not_for_agents", {}, 403);
}
/** A limit given through an assistant is never more than that assistant's own. */
async function capWithinAssistant(ctx: PlanCtx, cents: number) {
  if (!ctx.actor.grantId) return;
  const g = await ctx.db.selectFrom("oauth_grant").select("weekly_cap_cents").where("id", "=", ctx.actor.grantId).executeTakeFirst();
  if (g && cents > g.weekly_cap_cents) throw new KumiError("error.agent_cap_over_yours", { cap: usd(g.weekly_cap_cents) }, 403);
}
/** The role an agent may be capped by: one the club has, not the owner's or a member's, and no more than the person
 *  giving it holds (roles.ts, checkAssign). */
async function cappingRole(ctx: PlanCtx, key: string) {
  const r = await ctx.db.selectFrom("role").select(["id", "key", "version"]).where("key", "=", key).where("active", "=", true).where("for_plugin", "=", false).executeTakeFirst();
  if (!r) throw new KumiError("error.not_found", { thing: both("thing.role") }, 404);
  if (NOT_FOR_AGENTS.includes(r.key)) throw new KumiError("error.agent_role_not_allowed", { role: await roleLabel(ctx.db, r.key) });
  await checkAssign(ctx, r.id);
  return r;
}
async function nameTaken(db: Db | Trx, name: string, except?: string): Promise<boolean> {
  const rows = await db.selectFrom("agent").select(["id", "name"]).where("kind", "=", "club").where("revoked_at", "is", null).execute();
  return rows.some((r) => r.id !== except && (r.name ?? "").trim().toLowerCase() === name.trim().toLowerCase());
}
/** A club agent that's still on. */
async function liveAgent(ctx: { db: Db | Trx }, id: string) {
  const { row, read } = await readRow(ctx.db, "agent", id, "thing.agent");
  if (row.kind !== "club") throw new KumiError("error.not_found", { thing: both("thing.agent") }, 404);
  if (row.revoked_at) throw new KumiError("error.agent_revoked", {}, 409);
  // A plugin's agent changes only with its plugin (plugins.ts): its role is its manifest's, its token its own.
  const plugin = await ctx.db.selectFrom("plugin").select("name").where("agent_id", "=", id).where("status", "!=", "removed").executeTakeFirst();
  if (plugin) throw new KumiError("error.agent_is_plugin", { name: plugin.name });
  return { row, read };
}

export const agentCreate = defineAction({
  name: "agent.create", version: 1, strongAuth: true, wholeClub: "reason.whole_club_agents",
  input: z.object({ name: agentName, role: roleInput, weekly_cap_cents: z.optional(capInput), language: z.optional(z.enum(["en", "es"])) }),
  async plan(ctx, i) {
    notByAnAgent(ctx);
    const name = i.name.trim();
    if (!name) throw new KumiError("error.invalid_input", { details: both("issue.general") }, 400);
    if (await nameTaken(ctx.db, name)) throw new KumiError("error.agent_name_taken", { name });
    const role = await cappingRole(ctx, i.role), cap = i.weekly_cap_cents ?? 0;
    await capWithinAssistant(ctx, cap);
    return { title: both("action.agent.create"), summary: both("plan.agent.create", { name, role: await roleLabel(ctx.db, role.key), cap: capText(cap) }),
      reads: [{ entity: "role", id: role.id, version: role.version }], undo: { kind: "reversible" }, details: { role_id: role.id } };
  },
  async apply(ctx, i, p) {
    const roleId = (p.details as { role_id: string }).role_id, name = i.name.trim(), personId = uuidv7(), grantId = uuidv7(), agentId = uuidv7(), t = newToken();
    // The door's client for agents is made by the migration; made again here if something tidied it away.
    await ctx.trx.insertInto("oauth_client").values({ client_id: AGENT_CLIENT, kind: "agent", name: "Club agent", redirect_uris: [] }).onConflict((oc) => oc.doNothing()).execute();
    const lang = i.language ?? (await ctx.trx.selectFrom("club").select("default_language").executeTakeFirst())?.default_language ?? "en";
    await ctx.insert("person", { id: personId, display_name: name, created_via: "agent", locale: lang });
    await ctx.insert("person_role", { id: uuidv7(), person_id: personId, role_id: roleId, location_id: null });
    await ctx.insert("oauth_grant", { id: grantId, person_id: personId, client_id: AGENT_CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, powers: null, second_step: true });
    await keepToken(ctx.trx, grantId, t.hash, ctx.now);
    await ctx.insert("agent", { id: agentId, kind: "club", name, capped_role_id: roleId, acts_for_person_id: null, person_id: personId, grant_id: grantId, created_by: ctx.actor.personId,
      created_at: ctx.now, weekly_cap_cents: i.weekly_cap_cents ?? 0, token_last4: t.last4, token_once: sealText(t.token), token_once_at: ctx.now });
    await ctx.emit("agent.created", { agent_id: agentId, by: ctx.actor.personId });
    return { agent_id: agentId, name, token_last4: t.last4 };
  },
  async after(db, _i, result) {
    const r = result as { agent_id: string; name: string; token_last4: string };
    return { ...r, token: await tokenOnce(db, r.agent_id) };
  },
});

export const agentUpdate = defineAction({
  name: "agent.update", version: 1, strongAuth: true, wholeClub: "reason.whole_club_agents",
  input: z.object({ agent_id: z.uuid(), name: z.optional(agentName), role: z.optional(roleInput), weekly_cap_cents: z.optional(capInput) }),
  async plan(ctx, i) {
    notByAnAgent(ctx);
    const { row, read } = await liveAgent(ctx, i.agent_id);
    const lines: Text[] = [];
    const name = i.name?.trim();
    if (name !== undefined && name !== row.name) {
      if (!name) throw new KumiError("error.invalid_input", { details: both("issue.general") }, 400);
      if (await nameTaken(ctx.db, name, row.id)) throw new KumiError("error.agent_name_taken", { name });
      lines.push(both("plan.agent.rename", { name }));
    }
    let roleId: string | null = null;
    const now = await ctx.db.selectFrom("role").select("key").where("id", "=", row.capped_role_id).executeTakeFirst();
    if (i.role !== undefined && i.role !== now?.key) {
      const r = await cappingRole(ctx, i.role);
      roleId = r.id;
      lines.push(both("plan.agent.role", { role: await roleLabel(ctx.db, r.key) }));
    }
    if (i.weekly_cap_cents !== undefined && i.weekly_cap_cents !== row.weekly_cap_cents) {
      await capWithinAssistant(ctx, i.weekly_cap_cents);
      lines.push(both("plan.agent.cap", { cap: capText(i.weekly_cap_cents) }));
    }
    if (!lines.length) throw new KumiError("error.nothing_changed");
    const join = (l: "en" | "es") => lines.map((x) => x[l]).join(" ");
    return { title: both("action.agent.update"), summary: both("plan.agent.update", { name: row.name, changes: { en: join("en"), es: join("es") } }),
      reads: [read], undo: { kind: "reversible" }, details: { role_id: roleId, name: name !== undefined && name !== row.name ? name : null } };
  },
  async apply(ctx, i, p) {
    const d = p.details as { role_id: string | null; name: string | null };
    const a = await ctx.trx.selectFrom("agent").select(["person_id"]).where("id", "=", i.agent_id).executeTakeFirstOrThrow();
    await ctx.update("agent", i.agent_id, { ...(d.name ? { name: d.name } : {}), ...(d.role_id ? { capped_role_id: d.role_id } : {}),
      ...(i.weekly_cap_cents !== undefined ? { weekly_cap_cents: i.weekly_cap_cents } : {}) });
    if (d.name) await ctx.update("person", a.person_id!, { display_name: d.name });
    if (d.role_id) {
      for (const r of await ctx.trx.selectFrom("person_role").select("id").where("person_id", "=", a.person_id!).where("active", "=", true).execute()) await ctx.update("person_role", r.id, { active: false });
      await ctx.insert("person_role", { id: uuidv7(), person_id: a.person_id, role_id: d.role_id, location_id: null });
    }
    await ctx.emit("agent.updated", { agent_id: i.agent_id, by: ctx.actor.personId });
    return null;
  },
});

export const agentNewToken = defineAction({
  name: "agent.new_token", version: 1, strongAuth: true, wholeClub: "reason.whole_club_agents",
  input: z.object({ agent_id: z.uuid() }),
  async plan(ctx, i) {
    notByAnAgent(ctx);
    const { row, read } = await liveAgent(ctx, i.agent_id);
    return { title: both("action.agent.new_token"), summary: both("plan.agent.new_token", { name: row.name, last4: row.token_last4 ?? "" }), reads: [read],
      undo: { kind: "none", note: both("reason.agent_token_gone") } };
  },
  async apply(ctx, i) {
    const a = await ctx.trx.selectFrom("agent").select(["grant_id", "name"]).where("id", "=", i.agent_id).executeTakeFirstOrThrow();
    const t = newToken();
    await ctx.trx.updateTable("oauth_token").set({ revoked_at: ctx.now }).where("grant_id", "=", a.grant_id!).where("revoked_at", "is", null).execute();
    await keepToken(ctx.trx, a.grant_id!, t.hash, ctx.now);
    await ctx.update("agent", i.agent_id, { token_last4: t.last4, token_once: sealText(t.token), token_once_at: ctx.now });
    return { agent_id: i.agent_id, name: a.name, token_last4: t.last4 };
  },
  async after(db, _i, result) {
    const r = result as { agent_id: string; name: string; token_last4: string };
    return { ...r, token: await tokenOnce(db, r.agent_id) };
  },
});

export const agentRevoke = defineAction({
  name: "agent.revoke", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ agent_id: z.uuid() }),
  async plan(ctx, i) {
    notByAnAgent(ctx);
    const { row, read } = await liveAgent(ctx, i.agent_id);
    const hooks = Number((await ctx.db.selectFrom("webhook_subscription").select((eb) => eb.fn.countAll<string>().as("n")).where("agent_id", "=", i.agent_id).where("active", "=", true).executeTakeFirstOrThrow()).n);
    return { title: both("action.agent.revoke"), summary: both("plan.agent.revoke", { name: row.name, hooks: both("count.webhooks", { count: hooks }) }), reads: [read],
      undo: { kind: "none", note: both("reason.agent_make_again") } };
  },
  async apply(ctx, i) {
    await revokeAgentRows(ctx, i.agent_id);
    await ctx.emit("agent.revoked", { agent_id: i.agent_id, by: ctx.actor.personId });
    return null;
  },
});

/** Takes a club agent back: its token and connection, its role, its person row, and its webhooks with what's still
 *  waiting to go. agent.revoke, and plugin.remove for a plugin's agent. */
export async function revokeAgentRows(ctx: ApplyCtx, agentId: string): Promise<void> {
  const a = await ctx.trx.selectFrom("agent").select(["person_id", "grant_id"]).where("id", "=", agentId).executeTakeFirstOrThrow();
  await ctx.update("agent", agentId, { revoked_at: ctx.now, token_once: null, token_once_at: null });
  if (a.grant_id) {
    await ctx.update("oauth_grant", a.grant_id, { revoked_at: ctx.now });
    await ctx.trx.updateTable("oauth_token").set({ revoked_at: ctx.now }).where("grant_id", "=", a.grant_id).where("revoked_at", "is", null).execute();
  }
  for (const r of await ctx.trx.selectFrom("person_role").select("id").where("person_id", "=", a.person_id!).where("active", "=", true).execute()) await ctx.update("person_role", r.id, { active: false });
  await ctx.update("person", a.person_id!, { status: "archived" });
  // Its webhooks stop too, with anything still waiting to go.
  for (const s of await ctx.trx.selectFrom("webhook_subscription").select("id").where("agent_id", "=", agentId).where("active", "=", true).execute()) {
    await ctx.update("webhook_subscription", s.id, { active: false });
    await ctx.trx.updateTable("webhook_delivery").set({ status: "dropped" }).where("subscription_id", "=", s.id).where("status", "=", "waiting").execute();
  }
}

/** The agent behind a connection, for the door (oauth.ts): its id and name, or null for a person's own assistant. */
export async function agentOfGrant(db: Db | Trx, grantId: string): Promise<{ id: string; name: string } | null> {
  const a = await db.selectFrom("agent").select(["id", "name"]).where("grant_id", "=", grantId).where("kind", "=", "club").where("revoked_at", "is", null).executeTakeFirst();
  return a ? { id: a.id, name: a.name ?? "" } : null;
}
/** A club agent was used: kept to the minute, for the club's list. */
export async function agentUsed(db: Db, agentId: string, now: Date): Promise<void> {
  await db.updateTable("agent").set({ last_used_at: now }).where("id", "=", agentId)
    .where((w) => w.or([w("last_used_at", "is", null), w("last_used_at", "<", new Date(now.getTime() - 60_000))])).execute();
}
/** The actor a club agent's connection acts as (mcp.ts): its own person, the agent, and its connection. */
export function agentActor(a: { id: string; name: string }, personId: string, grantId: string, lang: "en" | "es"): Actor {
  return { personId, agentId: a.id, via: `mcp:${a.name}`.slice(0, 80), lang, auth: "oauth", grantId };
}

/** Every agent and assistant connected to the club, for the owner and managers (Settings, Agents): club agents with
 *  their role, what it lets them do, who made them, this week's money moved against their limit, last use and token's
 *  last four; and every person's own assistants with who connected them, their role, this week's spending and last use. */
export async function clubAgents(db: Db | Trx, lang: "en" | "es", now: Date) {
  const agents = await db.selectFrom("agent").leftJoin("role", "role.id", "agent.capped_role_id").leftJoin("person as by", "by.id", "agent.created_by")
    .select(["agent.id", "agent.name", "agent.weekly_cap_cents", "agent.created_at", "agent.revoked_at", "agent.last_used_at", "agent.token_last4", "role.key as role_key", "by.display_name as created_by"])
    .where("agent.kind", "=", "club")
    // A plugin's agent is listed with its plugin (plugins.ts), where it's changed.
    .where((w) => w.not(w.exists(w.selectFrom("plugin").select("plugin.id").whereRef("plugin.agent_id", "=", "agent.id"))))
    .orderBy("agent.revoked_at", "desc").orderBy("agent.created_at", "desc").execute();
  const roleWords = new Map<string, { name: string; can: string }>();
  const words = async (key: string | null) => {
    if (!key) return { name: "", can: "" };
    if (!roleWords.has(key)) roleWords.set(key, { name: (await roleLabel(db, key))[lang], can: (await roleText(db, key))[lang] });
    return roleWords.get(key)!;
  };
  const out = [];
  for (const a of agents) {
    const w = await words(a.role_key);
    const hooks = Number((await db.selectFrom("webhook_subscription").select((eb) => eb.fn.countAll<string>().as("n")).where("agent_id", "=", a.id).where("active", "=", true).executeTakeFirstOrThrow()).n);
    out.push({ id: a.id, name: a.name ?? "", role: a.role_key, role_name: w.name, can: w.can, created_by: a.created_by, created_at: a.created_at, revoked_at: a.revoked_at,
      last_used_at: a.last_used_at, token_last4: a.token_last4, weekly_cap_cents: a.weekly_cap_cents, spent_cents: a.revoked_at ? 0 : await agentWeekSpent(db, a.id, now), webhooks: hooks });
  }
  const grants = await db.selectFrom("oauth_grant").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id").innerJoin("person", "person.id", "oauth_grant.person_id")
    .select(["oauth_grant.id", "oauth_client.name", "oauth_grant.weekly_cap_cents", "oauth_grant.created_at", "person.id as person_id", "person.display_name",
      (eb) => eb.selectFrom("oauth_token").select((t) => t.fn.max("created_at").as("m")).whereRef("oauth_token.grant_id", "=", "oauth_grant.id").as("last_used")])
    .where("oauth_grant.revoked_at", "is", null).where("oauth_client.kind", "!=", "agent").where("person.created_via", "!=", "agent")
    .orderBy("person.display_name").orderBy("oauth_grant.created_at", "desc").execute();
  const assistants = [];
  for (const g of grants) {
    const keys = (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", g.person_id)
      .where("person_role.active", "=", true).where("role.active", "=", true).execute()).map((r) => r.key);
    const shown = keys.filter((k) => k !== "member");
    const roleNames = [];
    for (const k of shown.length ? shown : keys) roleNames.push((await roleLabel(db, k))[lang]);
    assistants.push({ id: g.id, name: g.name ?? "", person_id: g.person_id, person: g.display_name, roles: roleNames, weekly_cap_cents: g.weekly_cap_cents,
      spent_cents: await weekSpent(db, g.id, now), connected_at: g.created_at, last_used_at: (g.last_used as Date | null) ?? null });
  }
  return { agents: out, assistants };
}
