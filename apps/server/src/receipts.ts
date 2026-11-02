// Receipts to read (receipts.ts in core writes them): a member's own, in the members' app, each a page that
// prints; and someone's, on their page in the staff app, for whoever takes or sees the club's money.
import { Hono, type Context } from "hono";
import type { Lang } from "@kumi/i18n";
import { customAreas, KumiError, receiptsOf, receiptView, type Db } from "@kumi/core";

type Me = { id: string } | null;
const MONEY_ROLES = ["owner", "manager", "front_desk", "accountant"];
/** Each { en, es } in a receipt, in the reader's language. */
function said(v: Record<string, unknown>, lang: Lang): Record<string, unknown> {
  const one = (x: unknown): unknown => x && typeof x === "object" && "en" in x && "es" in x ? (x as Record<Lang, string>)[lang]
    : Array.isArray(x) ? x.map((y) => said(y as Record<string, unknown>, lang)) : x;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]));
}

export function receiptRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang) {
  const app = new Hono();
  const who = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m.id; };
  const notFound = () => new KumiError("error.not_found", { thing: { en: "receipt", es: "el recibo" } }, 404);
  /** The club's money people: owners, managers, front desk and accountants, or a role the club made that covers money. */
  const staffWithMoney = async (c: Context<any>) => {
    const id = who(c);
    const areas = await customAreas(db, id);
    if (areas) { if (!areas.includes("money")) throw new KumiError("error.staff_only", {}, 403); return; }
    const roles = (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", id).where("person_role.active", "=", true).where("role.active", "=", true).execute()).map((r) => r.key);
    if (!roles.some((r) => MONEY_ROLES.includes(r))) throw new KumiError("error.staff_only", {}, 403);
  };

  app.get("/my/receipts", async (c) => c.json((await receiptsOf(db, who(c))).map((r) => said(r, lang(c)))));
  app.get("/my/receipts/:id", async (c) => {
    const v = await receiptView(db, c.req.param("id"));
    if (!v || v.person_id !== who(c)) throw notFound();
    return c.json(said(v, lang(c)));
  });

  app.get("/staff/receipts", async (c) => {
    await staffWithMoney(c);
    const pid = c.req.query("person_id") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(pid)) throw new KumiError("error.invalid_input", { details: "person_id" }, 400);
    return c.json((await receiptsOf(db, pid, { asStaff: true })).map((r) => said(r, lang(c))));
  });
  app.get("/staff/receipts/:id", async (c) => {
    await staffWithMoney(c);
    const v = await receiptView(db, c.req.param("id"));
    if (!v) throw notFound();
    return c.json(said(v, lang(c)));
  });
  return app;
}
