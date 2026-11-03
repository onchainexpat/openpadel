// Support access in Settings (support.ts): every grant, under way and past, and what each person opened and changed.
// The owner and managers read it; a person with support access never does (app.ts closes the page to them).
// Letting someone in and ending it early are actions, through the preview like every change.
import { Hono, type Context } from "hono";
import { both, type Lang } from "@kumi/i18n";
import { KumiError, SUPPORT_DEFAULT_HOURS, SUPPORT_MAX_HOURS, supportActivity, supportGrants, type Db } from "@kumi/core";

type Me = { id: string } | null;

export function supportRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang, now: () => Date) {
  const app = new Hono();
  /** The club's own owners and managers, by the roles they hold (support access holds none). */
  const boss = async (c: Context<any>) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const roles = (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager"]).execute()).map((r) => r.key);
    if (!roles.length) throw new KumiError("error.staff_only", {}, 403);
    return { owner: roles.includes("owner") };
  };
  app.get("/staff/support", async (c) => {
    const { owner } = await boss(c);
    return c.json({ owner, default_hours: SUPPORT_DEFAULT_HOURS, max_hours: SUPPORT_MAX_HOURS, grants: await supportGrants(db, now()) });
  });
  app.get("/staff/support/:id", async (c) => {
    await boss(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new KumiError("error.not_found", { thing: both("thing.support_grant") }, 404);
    return c.json(await supportActivity(db, id, lang(c)));
  });
  return app;
}
