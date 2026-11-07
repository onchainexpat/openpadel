// A coach's calendar link: the page their phone's calendar subscribes to (no sign-in, the long random token
// in the address is the key), and the staff app's way to see it or make a new one, which ends the old.
import { Hono, type Context } from "hono";
import { calendarToken, coachCalendar, KumiError, newCalendarToken, type Db } from "@kumi/core";
import { clubFileStem } from "./file_names.ts";

type Me = { id: string } | null;
export function calendarRoutes(db: Db, me: (c: Context<any>) => Me) {
  const app = new Hono();
  const coachOnly = async (c: Context<any>) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const coach = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.key", "=", "coach").executeTakeFirst();
    if (!coach) throw new KumiError("error.staff_only", {}, 403);
    return m.id;
  };
  const path = (token: string) => `/calendar/${token}.ics`;

  app.get("/staff/calendar-link", async (c) => {
    const t = await calendarToken(db, await coachOnly(c));
    return c.json(t ? { path: path(t.token), created_at: t.created_at } : { path: null, created_at: null });
  });
  app.post("/staff/calendar-link", async (c) => {
    const id = await coachOnly(c), token = await newCalendarToken(db, id);
    return c.json({ path: path(token), created_at: new Date() });
  });

  app.get("/calendar/:file", async (c) => {
    const body = await coachCalendar(db, c.req.param("file").replace(/\.ics$/, ""));
    if (body === null) return c.text("Not found", 404);
    c.header("content-type", "text/calendar; charset=utf-8");
    c.header("content-disposition", `inline; filename="${await clubFileStem(db)}.ics"`);
    c.header("cache-control", "private, max-age=300");
    c.header("x-robots-tag", "noindex");
    return c.body(body);
  });
  return app;
}
