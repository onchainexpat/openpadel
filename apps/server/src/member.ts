// What a signed-in member reads about themselves and the club's open programs.
import { Hono, type Context } from "hono";
import type { Lang } from "@kumi/i18n";
import { freeCourts, KumiError, paidFor, paymentProvider, runAsSystem, type Db } from "@kumi/core";

type Me = { id: string } | null;
export function memberRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang, opts: { production: boolean }) {
  const app = new Hono();
  const who = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m.id; };

  app.get("/open-programs", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("program").select(["id", "name", "kind", "format", "capacity", "price_cents", "rated", "level_min", "level_max", "refund_window_hours", "refund_inside_window"])
      .select((eb) => [
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "booked").as("booked"),
        eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first_start"),
        eb.selectFrom("enrolment").select("status").whereRef("enrolment.program_id", "=", "program.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "in", ["booked", "waitlisted"]).limit(1).as("my_status"),
        eb.selectFrom("waitlist_offer").innerJoin("enrolment", "enrolment.id", "waitlist_offer.enrolment_id").select((x) => x.fn.countAll<string>().as("n"))
          .whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "waitlisted").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", new Date()).as("offered"),
        eb.selectFrom("waitlist_offer").innerJoin("enrolment", "enrolment.id", "waitlist_offer.enrolment_id").select("waitlist_offer.expires_at")
          .whereRef("enrolment.program_id", "=", "program.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "=", "waitlisted").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", new Date()).limit(1).as("my_offer_until"),
      ]).where("status", "=", "published").where("visibility", "in", ["public", "members"]).execute();
    return c.json(rows.filter((r) => !r.first_start || new Date(r.first_start as any) > new Date()).map((r) => ({ ...r, booked: Number(r.booked ?? 0), offered: Number(r.offered ?? 0) }))
      // Soonest first, by the actual time (not the date's text, which starts with the weekday); undated ones last.
      .sort((a, b) => (a.first_start ? new Date(a.first_start as any).getTime() : Infinity) - (b.first_start ? new Date(b.first_start as any).getTime() : Infinity)));
  });

  // The in-app inbox: every message Kumi sent this person, newest first. Reading it marks it read
  // (the delivery log, like the outbox, is written by the messages code, not through an action).
  app.get("/my/inbox", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("outbound_message").select(["id", "kind", "subject", "body", "link", "created_at", "read_at"])
      .where("person_id", "=", pid).where("channel", "=", "inbox").orderBy("created_at", "desc").limit(50).execute();
    return c.json({ unread: rows.filter((r) => !r.read_at).length, messages: rows });
  });
  app.post("/my/inbox/read", async (c) => {
    const pid = who(c);
    await db.updateTable("outbound_message").set({ read_at: new Date() }).where("person_id", "=", pid).where("channel", "=", "inbox").where("read_at", "is", null).execute();
    return c.json({ ok: true });
  });

  // Free courts at a location on a day, for a length: every half-hourly start each court is free.
  app.get("/availability", async (c) => {
    who(c);
    const locationId = c.req.query("location_id") ?? "", date = c.req.query("date") ?? "", minutes = Number(c.req.query("minutes") ?? 90);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(minutes) || minutes < 30 || minutes > 480 || minutes % 30) throw new KumiError("error.invalid_input", { details: "location_id, date (YYYY-MM-DD) and minutes (30 to 480, in 30s)" }, 400);
    return c.json(await freeCourts(db, { locationId, date, minutes, now: new Date() }));
  });

  app.get("/my/places", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
      .select(["enrolment.id", "enrolment.status", "enrolment.waitlist_position", "enrolment.program_id", "program.name", "program.price_cents"])
      .select((eb) => [eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").as("first_start"),
        eb.selectFrom("waitlist_offer").select("expires_at").whereRef("waitlist_offer.enrolment_id", "=", "enrolment.id").where("outcome", "is", null).where("expires_at", ">", new Date()).limit(1).as("offer_expires_at"),
        eb.selectFrom("payment").select("id").whereRef("payment.enrolment_id", "=", "enrolment.id").where("status", "=", "pending").limit(1).as("pending_payment_id")])
      .where("enrolment.person_id", "=", pid).where("enrolment.status", "in", ["booked", "waitlisted"]).execute();
    return c.json(await Promise.all(rows.map(async (r) => ({ ...r, paid_cents: await paidFor(db, r.id) }))));
  });

  app.get("/my/level", async (c) => {
    const pid = who(c), l = lang(c);
    const rating = await db.selectFrom("rating").select(["level", "provisional", "floor", "rated_games"]).where("person_id", "=", pid).where("sport", "=", "padel").executeTakeFirst();
    const events = await db.selectFrom("rating_event").select(["at", "kind", "level_after", "explanation"]).where("person_id", "=", pid).orderBy("id", "desc").limit(30).execute();
    return c.json({ rating: rating ?? null, events: events.map((e) => ({ at: e.at, kind: e.kind, level_after: e.level_after, explanation: (e.explanation as Record<string, string>)[l] ?? "" })) });
  });

  // Development only: settle a stand-in payment, as the provider's webhook would.
  if (!opts.production) app.post("/dev/payments/:id/settle", async (c) => {
    who(c);
    if (paymentProvider().name !== "test") throw new KumiError("error.forbidden", {}, 403);
    // A stand-in card is "saved" too, so "pay my part" can be tried end to end in development.
    const pay = await db.selectFrom("payment").select("save_card").where("id", "=", c.req.param("id")).executeTakeFirst();
    return c.json(await runAsSystem(db, "payment.settle", { payment_id: c.req.param("id"), outcome: "succeeded", ...(pay?.save_card ? { saved_customer: "cus_test_dev", saved_method: "pm_test_dev" } : {}) }, "dev"));
  });
  return app;
}
