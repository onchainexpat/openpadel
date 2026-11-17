// Settings > Agents (agents.ts, webhooks.ts): every club agent and every person's own assistant connected to the club,
// what each one's role lets it do, its spending this week and its last use, and the club's webhooks. The owner and
// managers read it; making, changing and taking back an agent, disconnecting an assistant and the webhooks are actions,
// through the preview like every change. Later the Connectors page takes this list in.
import { Hono, type Context } from "hono";
import { both, type Key, type Lang } from "@kumi/i18n";
import { AGENT_MAX_WEEKLY_CAP_CENTS, NOT_FOR_AGENTS, clubAgents, clubWebhooks, KumiError, roleLabel, WEBHOOK_TOPICS, WEBHOOK_TOPIC_NAMES, type Db } from "@kumi/core";

type Me = { id: string } | null;

export function agentRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang, now: () => Date) {
  const app = new Hono();
  /** The club's own owners and managers, by the roles they hold. */
  const boss = async (c: Context<any>) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const roles = (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager"]).execute()).map((r) => r.key);
    if (!roles.length) throw new KumiError("error.staff_only", {}, 403);
    return { owner: roles.includes("owner") };
  };
  app.get("/staff/agents", async (c) => {
    const { owner } = await boss(c);
    const l = lang(c);
    // The roles an agent may be capped by: any the club has but the owner's, a member's and a coach's.
    const roles = await db.selectFrom("role").select(["key"]).where("active", "=", true).where("key", "not in", NOT_FOR_AGENTS).orderBy("system", "desc").orderBy("created_at").execute();
    const roleChoices = [];
    for (const r of roles) roleChoices.push({ key: r.key, name: (await roleLabel(db, r.key))[l] });
    const { agents, assistants } = await clubAgents(db, l, now());
    return c.json({ owner, agents, assistants, webhooks: await clubWebhooks(db), roles: roleChoices, max_cap_cents: AGENT_MAX_WEEKLY_CAP_CENTS,
      topics: WEBHOOK_TOPIC_NAMES.map((t) => ({ topic: t, area: both(`area.${WEBHOOK_TOPICS[t]}` as Key)[l] })) });
  });
  return app;
}
