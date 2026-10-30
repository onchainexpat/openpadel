// What a signed-in member reads about themselves and the club's open programs.
import { Hono, type Context } from "hono";
import type { Lang } from "@kumi/i18n";
import { currentPolicy, daysAhead, freeCourts, KumiError, paidFor, paymentProvider, quote, runAsSystem, shares, type Db } from "@kumi/core";
import { sql } from "kysely";

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

  // ---- Court bookings ----
  // What the booking screen needs: where, which lengths, how far ahead, and when sharing the cost must be set up.
  app.get("/booking-options", async (c) => {
    const pid = who(c);
    const p = await currentPolicy(db);
    const locations = await db.selectFrom("location").select(["id", "name", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute();
    return c.json({ locations, lengths: p.lengths, days_ahead: await daysAhead(db, pid), split_deadline_hours: p.split_deadline_hours, free_cancel_hours: p.free_cancel_hours, late_refund_percent: p.late_refund_percent });
  });
  app.get("/quote", async (c) => {
    const pid = who(c);
    const start = new Date(c.req.query("starts_at") ?? ""), minutes = Number(c.req.query("minutes") ?? 0);
    if (isNaN(start.getTime()) || !Number.isInteger(minutes) || minutes < 30 || minutes > 480) throw new KumiError("error.invalid_input", { details: "court_id, starts_at and minutes" }, 400);
    return c.json(await quote(db, { courtId: c.req.query("court_id") ?? "", start, minutes, personId: pid }));
  });
  // My bookings, as organiser or player: the court and time, what I owe or paid, and the link to share.
  app.get("/my/bookings", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id")
      .innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
      .select(["booking.id", "booking.code", "booking.status", "booking.pay_mode", "booking.players", "booking.price_cents", "booking.organiser_id", "booking.invite_code", "booking.settled_at",
        "booking.balance_cents", "booking_player.id as player_id", "booking_player.share_cents", "court.name as court", "location.name as location", "location.time_zone"])
      .select([sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .select((eb) => [
        eb.selectFrom("payment").select("id").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "pending").limit(1).as("pending_payment_id"),
        eb.selectFrom("payment").select((x) => x.fn.sum<string>("amount_cents").as("c")).whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded").as("paid_cents"),
        eb.selectFrom("booking_player as bp").select((x) => x.fn.countAll<string>().as("n")).whereRef("bp.booking_id", "=", "booking.id").where("bp.removed_at", "is", null).as("joined"),
      ])
      .where("booking_player.person_id", "=", pid).where("booking_player.removed_at", "is", null).where("booking.status", "in", ["held", "confirmed"])
      .where(sql<boolean>`upper(court_time.during) > now() - interval '1 day'`).orderBy(sql`lower(court_time.during)`).execute();
    return c.json(rows.map((r) => ({ ...r, mine: r.organiser_id === pid, paid_cents: Number(r.paid_cents ?? 0), joined: Number(r.joined ?? 0),
      invite_code: r.organiser_id === pid && !r.settled_at ? r.invite_code : null, organiser_id: undefined })));
  });
  // An invitation to share a booking: what it is and what one place costs, before joining.
  app.get("/bookings/invite/:code", async (c) => {
    who(c);
    const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
      .innerJoin("location", "location.id", "court.location_id").leftJoin("person", "person.id", "booking.organiser_id")
      .select(["booking.id", "booking.code", "booking.status", "booking.pay_mode", "booking.players", "booking.price_cents", "booking.settled_at", "court.name as court", "location.name as location",
        "location.time_zone", "person.display_name as organiser", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .where("booking.invite_code", "=", c.req.param("code")).where("court_time.active", "=", true).executeTakeFirst();
    if (!b || b.pay_mode !== "split") throw new KumiError("error.invite_closed", {}, 404);
    const joined = Number((await db.selectFrom("booking_player").select((x) => x.fn.countAll<string>().as("n")).where("booking_id", "=", b.id).where("removed_at", "is", null).executeTakeFirstOrThrow()).n);
    return c.json({ ...b, share_cents: shares(b.price_cents, b.players).each, spots_left: Math.max(0, b.players - joined), open: b.status === "confirmed" && !b.settled_at && joined < b.players });
  });
  // The booking in a phone's calendar.
  app.get("/my/bookings/:id/calendar.ics", async (c) => {
    const pid = who(c);
    const b = await db.selectFrom("booking").innerJoin("booking_player", "booking_player.booking_id", "booking.id").innerJoin("court_time", "court_time.booking_id", "booking.id")
      .innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
      .select(["booking.id", "booking.code", "court.name as court", "location.name as location", "location.address", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .where("booking.id", "=", c.req.param("id")).where("booking_player.person_id", "=", pid).where("court_time.active", "=", true).executeTakeFirst();
    if (!b) throw new KumiError("error.not_found", { thing: { en: "booking", es: "la reserva" } }, 404);
    const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
    const stamp = (d: Date) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
    c.header("content-type", "text/calendar; charset=utf-8"); c.header("content-disposition", `attachment; filename="${b.code}.ics"`);
    return c.body(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kumi//Bookings//EN", "BEGIN:VEVENT", `UID:${b.id}@kumi`, `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(b.start)}`, `DTEND:${stamp(b.end)}`, `SUMMARY:${esc(`${b.court}, ${club.name} (${b.code})`)}`, `LOCATION:${esc([b.location, b.address].filter(Boolean).join(", "))}`,
      "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
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

  // My membership, if I have one, and what it gives me.
  app.get("/my/membership", async (c) => {
    const pid = who(c);
    const m = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
      .select(["membership.id", "membership_plan.name", "membership_plan.description", "membership_plan.price_cents", "membership_plan.period", "membership_plan.days_ahead", "membership.plan_id",
        "membership.status", "membership.started_at", "membership.current_period_end", "membership.cancel_at_period_end", "membership.provider_ref"])
      .where("membership.person_id", "=", pid).where("membership.status", "in", ["active", "past_due"]).executeTakeFirst();
    if (!m) return c.json({ membership: null });
    const prices = await db.selectFrom("price_rule").select("id").where("active", "=", true).where(sql<boolean>`${m.plan_id} = ANY(plan_ids)`).executeTakeFirst();
    const { provider_ref, plan_id, ...rest } = m;
    return c.json({ membership: { ...rest, paid_in_app: Boolean(provider_ref), member_prices: Boolean(prices) } });
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
