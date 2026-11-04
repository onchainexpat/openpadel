// Receipts to read (receipts.ts in core writes them): a member's own, in the members' app, each a page that
// prints; someone's, on their page in the staff app; and the club's, by dates, with a spreadsheet file, for
// whoever takes or sees the club's money.
import { Hono, type Context } from "hono";
import type { Lang } from "@kumi/i18n";
import { clubReceipts, customAreas, deskDays, deskLines, KumiError, supportRoleKeys, receiptsOf, receiptView, type Db } from "@kumi/core";
import { csvCell } from "./csv.ts";

type Me = { id: string } | null;
const MONEY_ROLES = ["owner", "manager", "front_desk", "accountant"];
/** The club's money people: owners, managers, front desk and accountants, or a role the club made that covers money.
 *  Support access reads as a manager would (support.ts). */
export async function seesMoney(db: Db, personId: string): Promise<boolean> {
  const areas = await customAreas(db, personId);
  if (areas) return areas.includes("money");
  const roles = (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true).execute()).map((r) => r.key);
  roles.push(...await supportRoleKeys(db, personId));
  return roles.some((r) => MONEY_ROLES.includes(r));
}
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
  const staffWithMoney = async (c: Context<any>) => { if (!(await seesMoney(db, who(c)))) throw new KumiError("error.staff_only", {}, 403); };

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
  // The club's receipts between two dates (the club's calendar, up to a year): the newest 500 to read, and
  // every one in the file. A refund's amounts are negative in the file, so a column adds up to what came in.
  const range = (c: Context<any>) => {
    const from = c.req.query("from") ?? "", to = c.req.query("to") ?? "", ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(`${d}T12:00:00Z`));
    if (!ok(from) || !ok(to) || to < from || Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`) > 366 * 864e5) throw new KumiError("error.invalid_input", { details: "from and to (at most a year apart)" }, 400);
    return { from, to };
  };
  app.get("/staff/club-receipts", async (c) => {
    await staffWithMoney(c);
    const { from, to } = range(c);
    return c.json((await clubReceipts(db, from, to, { limit: 500 })).map((r) => said(r, lang(c))));
  });
  app.get("/staff/club-receipts.csv", async (c) => {
    await staffWithMoney(c);
    const { from, to } = range(c), l = lang(c), rows = await clubReceipts(db, from, to);
    const money = (cents: number, kind: string) => ((kind === "refund" ? -cents : cents) / 100).toFixed(2);
    // What was bought in the reader's language, and in the other one: a club's own names can differ between them.
    const other = l === "es" ? "en" : "es", more = (r: { more: number }) => (r.more ? ` (+${r.more})` : "");
    const head = ["receipt", "kind", "date", "paid by", "for", "what", `what (${other})`, "subtotal", "tax", "total", "method", "card"];
    const lines = rows.slice().reverse().map((r) => [r.number, r.kind, r.local, r.paid_by, r.for ?? "", r.what[l] + more(r), r.what[other] + more(r),
      money(r.subtotal_cents, r.kind), money(r.tax_cents, r.kind), money(r.total_cents, r.kind), r.method, r.card ?? ""].map(csvCell).join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="kumi-receipts-${from}-to-${to}.csv"`);
    return c.body([head.join(","), ...lines].join("\r\n") + "\r\n");
  });
  // The desk's day, for the drawer at closing: what was paid at the desk and what was handed back there, a line a
  // day; one day's lines (who, for what, how, and who recorded it); and every line in a file, given back as negative.
  app.get("/staff/desk-days", async (c) => {
    await staffWithMoney(c);
    const { from, to } = range(c);
    return c.json(await deskDays(db, from, to));
  });
  app.get("/staff/desk-days/:date", async (c) => {
    await staffWithMoney(c);
    const day = c.req.param("date"), l = lang(c);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(`${day}T12:00:00Z`))) throw new KumiError("error.invalid_input", { details: "date (YYYY-MM-DD)" }, 400);
    return c.json((await deskLines(db, day, day, { what: true })).map((x) => ({ time: x.time, kind: x.kind, method: x.method, cents: x.cents, person_id: x.person_id, person: x.person, what: x.what[l], by: x.by })));
  });
  app.get("/staff/desk.csv", async (c) => {
    await staffWithMoney(c);
    const { from, to } = range(c), l = lang(c);
    const head = ["date", "time", "kind", "method", "amount", "person", "what", "recorded by"];
    const lines = (await deskLines(db, from, to, { what: true })).map((x) => [x.date, x.time, x.kind === "in" ? "paid" : "given back", x.method,
      ((x.kind === "in" ? x.cents : -x.cents) / 100).toFixed(2), x.person, x.what[l], x.by ?? ""].map(csvCell).join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="kumi-desk-${from}-to-${to}.csv"`);
    return c.body([head.join(","), ...lines].join("\r\n") + "\r\n");
  });
  app.get("/staff/receipts/:id", async (c) => {
    await staffWithMoney(c);
    const v = await receiptView(db, c.req.param("id"));
    if (!v) throw notFound();
    return c.json(said(v, lang(c)));
  });
  return app;
}
