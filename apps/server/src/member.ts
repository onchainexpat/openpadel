// What a signed-in member reads about themselves and the club's open programs.
import { Hono, type Context } from "hono";
import type { Lang } from "@kumi/i18n";
import { creditBalance, creditHistory, giftCardsOf, passesFor, passesOf, passProducts, myCompetitions, clubNewsAnswer, icsCalendar, inLang, trSql, lessonCoaches, lessonTimes, levelOptions, importOptions, membersFrom, programPerks, programPrices, checkCardSetup, coveredBy, membershipDue, periodCents, currentWaiver, findFriends, inviteByCode, juniorsOf, manages, householdOf, waiverStatus, friendsOf, personByFriendCode, ENTER_DAYS, isPushEndpoint, levelStakes, pushKeys, subscribePush, unsubscribePush, gameView, joinRule, levelOf, openCardSetup, playerRecord, suggestTeams, TestProvider, currentPolicy, daysAhead, endDay, freeCourts, KumiError, localDate, planCounts, paidFor, paymentProvider, quote, runAsSystem, shares, type Db, approveKidRequest, checkFamilyCard, familyCardFor, openFamilyCardSetup, kidOf, managersOf, monthSpent, paymentsWhat, deleteCheck, exportData, exportRun, mayCheck, searchFacts, factIn, questionList, questionThread, deadlineSql, findPlayers, assistantsOf, memberPlan, seriesOf, promoOff } from "@kumi/core";
import { sql } from "kysely";
import { chatRoutes } from "./chats.ts";
import { clubFileStem } from "./file_names.ts";

type Me = { id: string } | null;
export function memberRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang, opts: { production: boolean; now?: () => Date }) {
  const app = new Hono();
  const now = opts.now ?? (() => new Date());
  const who = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m.id; };
  /** Whom a page is for: the member, or (?for=) one of the juniors they manage. */
  const forWhom = async (c: Context<any>) => {
    const pid = who(c), f = c.req.query("for");
    if (!f || f === pid) return pid;
    if (!(await manages(db, pid, f))) throw new KumiError("error.not_found", { thing: { en: "person", es: "la persona" } }, 404);
    return f;
  };
  // Chats in the games they play in (chats.ts).
  app.route("/", chatRoutes(db, who, lang, now));
  /** The member and the juniors they manage, by id, with each junior's name. */
  const meAndJuniors = async (pid: string) => [{ id: pid, display_name: null as string | null }, ...(await juniorsOf(db, pid)).map((j) => ({ id: j.id, display_name: j.display_name as string | null }))];

  app.get("/open-programs", async (c) => {
    const pid = await forWhom(c), l = lang(c);
    const rows = await db.selectFrom("program").select(["id", trSql("program", "name", l).as("name"), "kind", "format", "capacity", "price_cents", "member_price_cents", "rated", "level_min", "level_max", "refund_window_hours", "refund_inside_window", "min_players", "sign_up"])
      .select((eb) => [
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "booked").as("booked"),
        eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first_start"),
        eb.selectFrom("enrolment").select("status").whereRef("enrolment.program_id", "=", "program.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "in", ["booked", "waitlisted"]).limit(1).as("my_status"),
        eb.selectFrom("enrolment").select(sql<string>`price_cents || ':' || price_basis`.as("x")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "in", ["booked", "waitlisted"]).limit(1).as("my_place_price"),
        eb.selectFrom("waitlist_offer").innerJoin("enrolment", "enrolment.id", "waitlist_offer.enrolment_id").select((x) => x.fn.countAll<string>().as("n"))
          .whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "waitlisted").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", new Date()).as("offered"),
        eb.selectFrom("waitlist_offer").innerJoin("enrolment", "enrolment.id", "waitlist_offer.enrolment_id").select("waitlist_offer.expires_at")
          .whereRef("enrolment.program_id", "=", "program.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "=", "waitlisted").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", new Date()).limit(1).as("my_offer_until"),
        // Asked to hear when a place opens (a full program), and not told yet.
        eb.selectFrom("program_watch").select("program_watch.id").whereRef("program_watch.program_id", "=", "program.id").where("program_watch.person_id", "=", pid)
          .where("program_watch.told_at", "is", null).where("program_watch.ended_at", "is", null).limit(1).as("my_watch"),
      ]).where("status", "=", "published").where("visibility", "in", ["public", "members"]).execute();
    // My own price for each (a member price, or an included session); without a membership, what members pay.
    const now = new Date(), mine = await programPrices(db, rows, pid, now), members = await membersFrom(db, rows);
    const byDate = await datesOpen(rows.filter((r) => r.sign_up === "per_session").map((r) => r.id), pid, now);
    return c.json(rows.filter((r) => r.sign_up === "per_session" ? (byDate.get(r.id) ?? []).length > 0 : !r.first_start || new Date(r.first_start as any) > now).map(({ member_price_cents, my_place_price, sign_up, ...r }) => {
      // Signed up per date: each date still to come with its own places, and where this person stands on it.
      if (sign_up === "per_session") {
        const dates = byDate.get(r.id)!, pr = mine.get(r.id)!;
        return { ...r, first_start: dates[0]!.starts_at, booked: 0, offered: 0, my_status: null, my_offer_until: null, my_watch: null, per_date: true, dates,
          my_price_cents: pr.cents, my_basis: pr.basis, included: pr.included ? { n: pr.included.n, of: pr.included.of } : null, members_cents: pr.basis === "full" ? members.get(r.id) ?? null : null };
      }
      // With a place already: the price it was taken at, not today's.
      const [cents, basis] = my_place_price ? (my_place_price as string).split(":") : [];
      const pr = my_place_price ? { cents: Number(cents), basis: basis as "full", included: null } : mine.get(r.id)!;
      return { ...r, booked: Number(r.booked ?? 0), offered: Number(r.offered ?? 0), my_price_cents: pr.cents, my_basis: pr.basis, included: pr.included ? { n: pr.included.n, of: pr.included.of } : null,
        members_cents: pr.basis === "full" ? members.get(r.id) ?? null : null };
    })
      // Soonest first, by the actual time (not the date's text, which starts with the weekday); undated ones last.
      .sort((a, b) => (a.first_start ? new Date(a.first_start as any).getTime() : Infinity) - (b.first_start ? new Date(b.first_start as any).getTime() : Infinity)));
  });

  /** The dates still to come of programs signed up per date: each one's places, and this person's place, offer or watch on it. */
  async function datesOpen(programIds: string[], pid: string, now: Date) {
    const out = new Map<string, { id: string; starts_at: Date; ends_at: Date; capacity: number; booked: number; offered: number; my_status: string | null; my_offer_until: Date | null; my_watch: string | null }[]>();
    if (!programIds.length) return out;
    const rows = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
      .select(["session.id", "session.program_id", "session.starts_at", "session.ends_at", sql<number>`coalesce(session.capacity_override, program.capacity)`.as("capacity")])
      .select((eb) => [
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.session_id", "=", "session.id").where("enrolment.status", "=", "booked").as("booked"),
        eb.selectFrom("waitlist_offer").innerJoin("enrolment", "enrolment.id", "waitlist_offer.enrolment_id").select((x) => x.fn.countAll<string>().as("n"))
          .whereRef("enrolment.session_id", "=", "session.id").where("enrolment.status", "=", "waitlisted").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", now).as("offered"),
        eb.selectFrom("enrolment").select("status").whereRef("enrolment.session_id", "=", "session.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "in", ["booked", "waitlisted"]).limit(1).as("my_status"),
        eb.selectFrom("waitlist_offer").innerJoin("enrolment", "enrolment.id", "waitlist_offer.enrolment_id").select("waitlist_offer.expires_at")
          .whereRef("enrolment.session_id", "=", "session.id").where("enrolment.person_id", "=", pid).where("enrolment.status", "=", "waitlisted").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", now).limit(1).as("my_offer_until"),
        eb.selectFrom("program_watch").select("program_watch.id").whereRef("program_watch.session_id", "=", "session.id").where("program_watch.person_id", "=", pid)
          .where("program_watch.told_at", "is", null).where("program_watch.ended_at", "is", null).limit(1).as("my_watch"),
      ])
      .where("session.program_id", "in", programIds).where("session.status", "!=", "cancelled").where("session.starts_at", ">", now).orderBy("session.starts_at").execute();
    for (const r of rows) {
      const list = out.get(r.program_id) ?? [];
      list.push({ id: r.id, starts_at: r.starts_at, ends_at: r.ends_at, capacity: Number(r.capacity), booked: Number(r.booked ?? 0), offered: Number(r.offered ?? 0),
        my_status: (r.my_status as string | null) ?? null, my_offer_until: (r.my_offer_until as Date | null) ?? null, my_watch: (r.my_watch as string | null) ?? null });
      out.set(r.program_id, list);
    }
    return out;
  }

  // The in-app inbox: every message Kumi sent this person, newest first. Reading it marks it read
  // (the delivery log, like the outbox, is written by the messages code, not through an action).
  app.get("/my/inbox", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("outbound_message").select(["id", "kind", "subject", "body", "link", "created_at", "read_at"])
      .where("person_id", "=", pid).where("channel", "=", "inbox").orderBy("created_at", "desc").limit(50).execute();
    return c.json({ unread: rows.filter((r) => !r.read_at).length, messages: rows });
  });
  // Their answer to club news by email: yes, no, or never asked (null). Changed with consent.club_news.
  app.get("/my/club-news", async (c) => c.json({ granted: await clubNewsAnswer(db, who(c)) }));
  // Their connected assistants (the MCP door), each with this week's spending and the cap they set for it.
  // Changed with assistant.set_cap and assistant.disconnect.
  app.get("/my/assistants", async (c) => c.json(await assistantsOf(db, who(c), now())));
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
    return c.json({ locations, lengths: p.lengths, days_ahead: await daysAhead(db, pid), split_deadline_hours: p.split_deadline_hours, same_day_cutoff_hours: p.same_day_cutoff_hours,
      free_cancel_hours: p.free_cancel_hours, late_refund_percent: p.late_refund_percent, ...await weeklyOptions() });
  });
  // Booking the same court every week (booking_series.ts): whether the club allows it, and for how many weeks.
  const weeklyOptions = async () => {
    const club = await db.selectFrom("club").select(["weekly_bookings", "weekly_max_weeks"]).executeTakeFirstOrThrow();
    return { weekly: club.weekly_bookings, weekly_max_weeks: club.weekly_max_weeks };
  };
  // The person's weekly courts still running, each with its weeks from today.
  app.get("/my/series", async (c) => c.json(await seriesOf(db, who(c), now())));
  // Gift cards they bought (with the codes, theirs to give) or redeemed (gift_cards.ts).
  // An assistant (mcp.ts my_gift_cards) never gets the codes: what it reads could tell it to pass one on.
  app.get("/my/gift-cards", async (c) => {
    const cards = await giftCardsOf(db, who(c));
    return c.json(c.req.query("codes") === "0" ? cards.map((x) => ({ ...x, code: null })) : cards);
  });
  // Their passes (passes.ts) and the ones the club sells; and which of theirs could pay one payment now.
  app.get("/my/passes", async (c) => c.json({ mine: await passesOf(db, who(c)), on_sale: (await passProducts(db)).map((p) => ({ id: p.id, name: p.name, covers: p.covers, uses: p.uses, price_cents: p.price_cents, max_minutes: p.max_minutes, program_kinds: p.program_kinds, valid_days: p.valid_days })) }));
  app.get("/my/payments/:id/passes", async (c) => c.json(await passesFor(db, who(c), c.req.param("id"), now())));
  // Their club credit (credit.ts): what they hold, and what came and went.
  app.get("/my/credit", async (c) => {
    const id = who(c);
    return c.json({ cents: await creditBalance(db, id), history: (await creditHistory(db, id)).slice(0, 50).map((h) => ({ at: h.at, cents: h.cents, kind: h.kind })) });
  });
  app.get("/quote", async (c) => {
    const pid = who(c);
    const start = new Date(c.req.query("starts_at") ?? ""), minutes = Number(c.req.query("minutes") ?? 0);
    if (isNaN(start.getTime()) || !Number.isInteger(minutes) || minutes < 30 || minutes > 480) throw new KumiError("error.invalid_input", { details: "court_id, starts_at and minutes" }, 400);
    return c.json(await quote(db, { courtId: c.req.query("court_id") ?? "", start, minutes, personId: pid }));
  });
  // ---- Private lessons ----
  // The coaches members can book, with their rates and photo (never their contact details).
  app.get("/my/lessons/coaches", async (c) => {
    who(c);
    const p = await currentPolicy(db);
    return c.json({ coaches: (await lessonCoaches(db)).filter((x) => x.lessons && Object.keys(x.rates).length)
      .map(({ photo_id, translations, ...x }) => ({ ...x, bio: inLang(x.bio, translations, "bio", lang(c)), photo: photo_id ? `/public/photos/${photo_id}` : null })),
      time_zone: (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone, split_deadline_hours: p.split_deadline_hours, free_cancel_hours: p.free_cancel_hours, late_refund_percent: p.late_refund_percent });
  });
  // When a coach gives a lesson of a length on a club date: their hours, less time off and what they're doing, with a court free.
  app.get("/my/lessons/times", async (c) => {
    const pid = await forWhom(c);
    const coachId = c.req.query("coach_id") ?? "", date = c.req.query("date") ?? "", minutes = Number(c.req.query("minutes") ?? 60);
    if (!/^[0-9a-f-]{36}$/.test(coachId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(minutes) || minutes < 30 || minutes > 240) throw new KumiError("error.invalid_input", { details: "coach_id, date (YYYY-MM-DD) and minutes" }, 400);
    return c.json({ times: await lessonTimes(db, { coachId, date, minutes, now: new Date() }), days_ahead: await daysAhead(db, pid) });
  });

  // My bookings, as organiser or player: the court and time, what I owe or paid, and the link to share.
  app.get("/my/bookings", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id")
      .innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
      .leftJoin("person as coach", "coach.id", "booking.coach_id")
      .select(["booking.id", "booking.code", "booking.status", "booking.kind", "booking.pay_mode", "booking.players", "booking.price_cents", "booking.organiser_id", "booking.invite_code", "booking.settled_at", "booking.series_id",
        "booking.balance_cents", "booking_player.id as player_id", "booking_player.share_cents", "court.name as court", "location.name as location", "location.time_zone", "coach.display_name as coach"])
      .select([sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .select((eb) => [
        eb.selectFrom("payment").select("id").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "pending").limit(1).as("pending_payment_id"),
        eb.selectFrom("payment").select("amount_cents").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "pending").limit(1).as("pending_cents"),
        eb.selectFrom("payment").select((x) => x.fn.sum<string>("amount_cents").as("c")).whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded").as("paid_cents"),
        eb.selectFrom("payment").select(sql<string>`coalesce(sum(${promoOff()}), 0)`.as("c")).whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded").as("off_cents"),
        // Paid in Playtomic (a booking the club took over from it): said as such.
        eb.selectFrom("payment").select(sql<string>`coalesce(sum(amount_cents), 0)`.as("c")).whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded")
          .where("payment.method", "=", "playtomic").as("pt_cents"),
        // Several courts paid together: paying one pays them all, for their total.
        eb.selectFrom("payment as p").innerJoin("payment as g", "g.group_id", "p.group_id").select((x) => x.fn.sum<string>("g.amount_cents").as("c"))
          .whereRef("p.booking_player_id", "=", "booking_player.id").where("p.status", "=", "pending").where("g.status", "=", "pending").as("group_cents"),
        eb.selectFrom("booking_player as bp").select((x) => x.fn.countAll<string>().as("n")).whereRef("bp.booking_id", "=", "booking.id").where("bp.removed_at", "is", null).as("joined"),
        eb.selectFrom("open_match").select("open_match.booking_id").whereRef("open_match.booking_id", "=", "booking.id").as("open_match_id"),
      ])
      .select("booking_player.person_id")
      .where("booking_player.person_id", "in", (await meAndJuniors(pid)).map((x) => x.id)).where("booking_player.removed_at", "is", null).where("booking.status", "in", ["held", "confirmed"])
      .where(sql<boolean>`upper(court_time.during) > now() - interval '1 day'`).orderBy(sql`lower(court_time.during)`).execute();
    // A junior's lessons show too, marked with their name: the parent pays for and manages them.
    const people = await meAndJuniors(pid), forName = (id: string | null) => people.find((x) => x.id === id)?.display_name ?? null;
    // The first week of a weekly court being paid: the later weeks going on the same card, and what they come to.
    const later = new Map<string, { count: number; cents: number; hours: number }>();
    for (const id of [...new Set(rows.filter((r) => r.series_id && r.pending_payment_id).map((r) => r.series_id!))]) {
      const w = await db.selectFrom("booking_series_week").select([sql<string>`count(*)`.as("n"), sql<string>`coalesce(sum(price_cents), 0)`.as("c")])
        .where("series_id", "=", id).where("booking_id", "is", null).where("missed", "is", null).executeTakeFirstOrThrow();
      const pol = await db.selectFrom("booking_series").innerJoin("booking_policy", "booking_policy.id", "booking_series.policy_id").select("booking_policy.split_deadline_hours").where("booking_series.id", "=", id).executeTakeFirstOrThrow();
      later.set(id, { count: Number(w.n), cents: Number(w.c), hours: pol.split_deadline_hours });
    }
    return c.json(rows.map(({ person_id, ...r }) => {
      const mine = r.organiser_id === pid || (r.organiser_id === person_id && person_id !== pid);
      return { ...r, mine, weekly_later: r.series_id && r.pending_payment_id ? later.get(r.series_id) ?? null : null, for_name: forName(person_id), paid_cents: Number(r.paid_cents ?? 0), off_cents: Number(r.off_cents ?? 0), pt_cents: Number(r.pt_cents ?? 0), joined: Number(r.joined ?? 0), group_cents: r.group_cents === null ? null : Number(r.group_cents),
        invite_code: mine && !r.settled_at ? r.invite_code : null, organiser_id: undefined };
    }));
  });
  // ---- Open matches ----
  /** One open match as a player sees it: when and where, the band, who's in (with levels), what a place
   *  costs, and what this player can do (join, ask, or not), with their own seat or request. The host also
   *  sees the requests waiting for an answer. */
  async function matchView(bookingId: string, pid: string) {
    const b = await db.selectFrom("booking").leftJoin("open_match", "open_match.booking_id", "booking.id").innerJoin("court_time", "court_time.booking_id", "booking.id")
      .innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id").leftJoin("person", "person.id", "booking.organiser_id")
      .leftJoin("booking_policy", "booking_policy.id", "booking.policy_id")
      .select(["booking.id", "booking.status", "booking.players", "booking.price_cents", "booking.settled_at", "booking.organiser_id", "booking.invite_code", "booking.pay_mode", "open_match.level_min", "open_match.level_max",
        "open_match.outside_band", "open_match.listed", "open_match.note", "court.name as court", "location.name as location", "location.time_zone", "person.display_name as host",
        sql<boolean>`open_match.booking_id IS NOT NULL`.as("is_match"), sql<boolean>`coalesce(open_match.rated, booking.rated)`.as("rated"),
        sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end"),
        // When it has to be full: a same-day match's own cutoff, otherwise the club's deadline.
        deadlineSql.as("full_by"), sql<boolean>`open_match.cutoff_at IS NOT NULL`.as("same_day")])
      // An open match, or any other court booking (its players see who's on it, and enter the score).
      .where("booking.id", "=", bookingId).where((eb) => eb.or([eb("open_match.booking_id", "is not", null), eb("booking.kind", "=", "court")]))
      .orderBy(sql`court_time.active`, "desc").executeTakeFirst();   // a cancelled one still shows, as cancelled
    if (!b) return null;
    const cancelled = b.status === "cancelled";
    const seats = await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id")
      .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "booking_player.person_id").on("rating.sport", "=", "padel"))
      .select(["booking_player.id", "booking_player.person_id", "booking_player.held_until", "booking_player.saved_by", "booking_player.leaving_at", "booking_player.no_show", "booking_player.replaces",
        "booking_player.fill_refund_percent", "booking_player.added_by", "person.display_name", "rating.level"])
      .select((eb) => eb.selectFrom("payment").select("id").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded").limit(1).as("paid_id"))
      .select((eb) => eb.selectFrom("payment").select("id").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "pending").limit(1).as("pending_payment_id"))
      .where("booking_player.booking_id", "=", b.id).where("booking_player.removed_at", "is", null).orderBy("booking_player.id").execute();
    // A sub still paying to take over someone's place sees their own seat; to everyone else it isn't a place.
    const mine = seats.find((x) => x.person_id === pid), host = b.organiser_id === pid, places = seats.filter((x) => !x.replaces), taken = places.filter((x) => !x.leaving_at).length;
    const reopened = places.some((x) => x.leaving_at && x.fill_refund_percent !== null);
    const offer = mine && !mine.replaces ? await db.selectFrom("place_offer").leftJoin("person", "person.id", "place_offer.to_person_id").select(["place_offer.id", "place_offer.code", "person.display_name as to_name"])
      .where("place_offer.booking_player_id", "=", mine.id).where("place_offer.status", "=", "offered").executeTakeFirst() : undefined;
    // The host sees each player's record (no-shows and late leaves, 90 days), and so does anyone asking.
    const record = host ? await playerRecord(db, [...places.map((x) => x.person_id!).filter(Boolean)]) : new Map();
    const now = Date.now(), start = new Date(b.start).getTime();
    const request = await db.selectFrom("join_request").select(["id", "status"]).where("booking_id", "=", b.id).where("person_id", "=", pid).orderBy("created_at", "desc").limit(1).executeTakeFirst();
    // Open to join: before the deadline, or after it when staff opened a late leaver's place again.
    const level = await levelOf(db, pid), open = b.is_match && b.status === "confirmed" && (!b.settled_at || reopened) && new Date(b.start) > new Date();
    const requests = host ? await db.selectFrom("join_request").innerJoin("person", "person.id", "join_request.person_id").select(["join_request.id", "join_request.person_id", "person.display_name", "join_request.level", "join_request.note"])
      .where("join_request.booking_id", "=", b.id).where("join_request.status", "=", "requested").orderBy("join_request.created_at").execute() : [];
    const asking = host ? await playerRecord(db, requests.map((r) => r.person_id)) : new Map();
    // The score, once someone has entered it; before that, the fairest teams for the four.
    const gid = (await db.selectFrom("game").select("id").where("booking_id", "=", b.id).where("status", "!=", "void").executeTakeFirst())?.id;
    const g = gid ? await gameView(db, gid) : null, side = g ? (g.a.some((x) => x.person_id === pid) ? "a" : g.b.some((x) => x.person_id === pid) ? "b" : null) : null;
    const result = g ? { id: g.id, status: g.status, sets: g.sets, a: g.a.map((x) => x.display_name), b: g.b.map((x) => x.display_name), confirm_by: g.confirm_by, rated: g.rated, my_side: side,
      can_confirm: side === "b" && g.status === "awaiting_confirmation",
      can_dispute: Boolean(side) && (g.status === "awaiting_confirmation" || (g.status === "confirmed" && Boolean(g.editable_until && g.editable_until > new Date()))) } : null;
    const four = places.filter((x) => !x.leaving_at && x.person_id);
    const teams = !g && !cancelled && four.length === 4 ? await suggestTeams(db, b.id) : null;
    // A rated match not played yet: what it could do to my level, once the four are known (or I'd make the fourth).
    const playing = mine && !mine.leaving_at && !mine.replaces;
    const stakes = b.rated && !g && !cancelled && now < start && (playing || (!mine && open && taken === b.players - 1)) ? await levelStakes(db, b.id, pid) : null;
    const { organiser_id, invite_code, settled_at, ...rest } = b;
    return { ...rest, host_is_me: host, open, cancelled, share_cents: shares(b.price_cents, b.players).each, spots_left: cancelled ? 0 : Math.max(0, b.players - taken), my_level: level,
      started: now >= start, late_window: !cancelled && now >= start - 3 * 3600_000 && now <= start + 30 * 60_000, no_show_window: !cancelled && now >= start && now <= start + 48 * 3600_000,
      players: places.map((x) => ({ id: host ? x.id : undefined, name: x.display_name, level: x.level === null ? null : Number(x.level), host: x.person_id === organiser_id, ...(b.is_match ? {} : { added: Boolean(x.added_by) }),
        paying: Boolean(x.held_until), saved: Boolean(x.saved_by && !x.paid_id), leaving: Boolean(x.leaving_at), no_show: host ? x.no_show : undefined,
        record: host && x.person_id !== organiser_id ? record.get(x.person_id!) ?? { no_shows: 0, late_leaves: 0 } : undefined })),
      can: mine || !open || taken >= b.players ? null : joinRule({ level_min: b.level_min!, level_max: b.level_max!, outside_band: b.outside_band! }, level),
      // A court booked in full: the booker names the players (or shares the players link), and says whether it counts for levels.
      whole: b.pay_mode === "whole" && !b.is_match, players_link: host && b.pay_mode === "whole" && !b.is_match ? invite_code : null,
      can_name: host && b.pay_mode === "whole" && !b.is_match && !cancelled && !g && taken < b.players && now <= start + ENTER_DAYS * 86400_000,
      can_rate: host && !b.is_match && !cancelled && !g,
      me: mine ? { seat_id: mine.id, added: Boolean(mine.added_by) && !g && !cancelled, pending_payment_id: mine.pending_payment_id, held_until: mine.held_until, leaving: Boolean(mine.leaving_at), saved: Boolean(mine.saved_by && !mine.paid_id), paid: Boolean(mine.paid_id),
        sub: Boolean(mine.replaces), offer: offer ? { id: offer.id, code: offer.code, to_name: offer.to_name } : null } : null, request: request ?? null,
      requests: requests.map(({ person_id, ...r }) => ({ ...r, level: r.level === null ? null : Number(r.level), record: asking.get(person_id) ?? { no_shows: 0, late_leaves: 0 } })),
      invite_code: host ? invite_code : null, result, teams, stakes,
      can_score: Boolean(mine && !cancelled && !mine.leaving_at && !mine.replaces && !g && four.length === 4 && now >= start && now <= start + ENTER_DAYS * 86400_000),
      four: mine ? four.map((x) => ({ person_id: x.person_id, name: x.display_name })) : [] };
  }
  // Friends: the page (friends, who added me, whom I added, people I've played with lately) and my link.
  app.get("/my/friends", async (c) => {
    const pid = who(c);
    const code = (await db.selectFrom("person").select("friend_code").where("id", "=", pid).executeTakeFirstOrThrow()).friend_code;
    return c.json({ ...(await friendsOf(db, pid)), code });
  });
  // Finding a friend to save a place for: friends only, by name, nothing but the name.
  app.get("/my/friends/find", async (c) => {
    const pid = who(c), q = (c.req.query("q") ?? "").trim();
    return c.json(q.length < 2 ? [] : await findFriends(db, pid, q));
  });
  // Finding players to name on a court booked in full: friends first, then members, by name; nothing but the name.
  app.get("/my/players/find", async (c) => {
    const pid = who(c);
    return c.json(await findPlayers(db, pid, c.req.query("q") ?? ""));
  });
  // Someone's friend link: their name (they gave the link out), and where the two of us stand.
  app.get("/my/friends/link/:code", async (c) => {
    const pid = who(c), p = await personByFriendCode(db, c.req.param("code"));
    if (!p) throw new KumiError("error.friend_link_unknown", {}, 404);
    if (p.id === pid) return c.json({ ...p, status: "self" });
    const f = await friendsOf(db, pid), has = (list: { id: string }[]) => list.some((x) => x.id === p.id);
    return c.json({ ...p, status: has(f.friends) ? "friends" : has(f.you_added) ? "waiting" : has(f.added_you) ? "added_you" : "none" });
  });
  app.get("/open-matches", async (c) => {
    const pid = who(c);
    const ids = await db.selectFrom("open_match").innerJoin("booking", "booking.id", "open_match.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id").select("booking.id")
      .where("open_match.listed", "=", true).where("booking.status", "=", "confirmed").where("court_time.active", "=", true)
      .where((eb) => eb.or([eb("booking.settled_at", "is", null), eb.exists(eb.selectFrom("booking_player").select("booking_player.id").whereRef("booking_player.booking_id", "=", "booking.id")
        .where("booking_player.removed_at", "is", null).where("booking_player.leaving_at", "is not", null).where("booking_player.fill_refund_percent", "is not", null))]))
      .where(sql<boolean>`lower(court_time.during) > now()`).orderBy(sql`lower(court_time.during)`).limit(100).execute();
    return c.json((await Promise.all(ids.map((r) => matchView(r.id, pid)))).filter(Boolean));
  });
  // A "take my place" link: the place and match, whose it is, and whether this person can take it.
  app.get("/my/place-offers/:code", async (c) => {
    const pid = who(c);
    const o = await db.selectFrom("place_offer").innerJoin("booking_player", "booking_player.id", "place_offer.booking_player_id").innerJoin("person", "person.id", "booking_player.person_id")
      .select(["place_offer.status", "place_offer.to_person_id", "booking_player.booking_id", "booking_player.share_cents", "booking_player.removed_at", "person.display_name as from"])
      .where("place_offer.code", "=", c.req.param("code")).executeTakeFirst();
    if (!o) throw new KumiError("error.offer_unknown", {}, 404);
    const m = await matchView(o.booking_id, pid);
    if (!m || !m.is_match) throw new KumiError("error.offer_unknown", {}, 404);
    const can = m.me && !m.me.sub ? "in" : o.status !== "offered" || o.removed_at || m.started || m.cancelled ? "closed" : o.to_person_id && o.to_person_id !== pid ? "not_yours"
      : joinRule({ level_min: m.level_min!, level_max: m.level_max!, outside_band: m.outside_band! }, m.my_level) !== "join" ? "outside" : "take";
    return c.json({ from: o.from, share_cents: o.share_cents, can, match: { id: m.id, court: m.court, location: m.location, time_zone: m.time_zone, start: m.start, level_min: m.level_min, level_max: m.level_max,
      rated: m.rated, my_level: m.my_level, me: m.me } });
  });
  // One match: listed ones for anyone signed in; one kept to its link, for its players and whoever has the link.
  app.get("/matches/:id", async (c) => {
    const pid = who(c), m = await matchView(c.req.param("id"), pid);
    const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", c.req.param("id")).executeTakeFirst())?.invite_code;
    if (!m || (!m.listed && !m.me && !m.host_is_me && (!code || c.req.query("code") !== code))) throw new KumiError("error.not_found", { thing: { en: "match", es: "el partido" } }, 404);
    return c.json(m);
  });

  // An invitation to share a booking: what it is and what one place costs, before joining.
  app.get("/bookings/invite/:code", async (c) => {
    who(c);
    const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
      .innerJoin("location", "location.id", "court.location_id").leftJoin("person", "person.id", "booking.organiser_id")
      .leftJoin("person as coach", "coach.id", "booking.coach_id")
      .select(["booking.id", "booking.code", "booking.status", "booking.kind", "booking.pay_mode", "booking.players", "booking.price_cents", "booking.settled_at", "court.name as court", "location.name as location",
        "location.time_zone", "person.display_name as organiser", "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .where("booking.invite_code", "=", c.req.param("code")).where("court_time.active", "=", true).executeTakeFirst();
    // A whole court's link is its players link: nothing to pay, open until the score can't be entered any more.
    const whole = b?.pay_mode === "whole" && b.kind === "court";
    if (!b || (b.pay_mode !== "split" && !whole)) throw new KumiError("error.invite_closed", {}, 404);
    const joined = Number((await db.selectFrom("booking_player").select((x) => x.fn.countAll<string>().as("n")).where("booking_id", "=", b.id).where("removed_at", "is", null).executeTakeFirstOrThrow()).n);
    const om = await db.selectFrom("open_match").select("booking_id").where("booking_id", "=", b.id).executeTakeFirst();
    const until = whole ? Date.now() <= new Date(b.start).getTime() + ENTER_DAYS * 86400_000 : !b.settled_at;
    return c.json({ ...b, share_cents: whole ? 0 : shares(b.price_cents, b.players).each, spots_left: Math.max(0, b.players - joined), open: b.status === "confirmed" && until && joined < b.players, open_match: Boolean(om) });
  });
  // The booking in a phone's calendar.
  app.get("/my/bookings/:id/calendar.ics", async (c) => {
    const pid = who(c);
    const b = await db.selectFrom("booking").innerJoin("booking_player", "booking_player.booking_id", "booking.id").innerJoin("court_time", "court_time.booking_id", "booking.id")
      .innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
      .select(["booking.id", "booking.code", "court.name as court", "location.name as location", "location.address", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .where("booking.id", "=", c.req.param("id")).where("booking_player.person_id", "in", (await meAndJuniors(pid)).map((x) => x.id)).where("court_time.active", "=", true).executeTakeFirst();
    if (!b) throw new KumiError("error.not_found", { thing: { en: "booking", es: "la reserva" } }, 404);
    const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
    c.header("content-type", "text/calendar; charset=utf-8"); c.header("content-disposition", `attachment; filename="${b.code}.ics"`);
    return c.body(icsCalendar({ prodId: "-//Kumi//Bookings//EN", events: [{ uid: `${b.id}@kumi`, start: new Date(b.start), end: new Date(b.end),
      summary: `${b.court}, ${club.name} (${b.code})`, location: [b.location, b.address].filter(Boolean).join(", ") }] }));
  });

  // Tournaments and leagues: invitations, entries, next matches, scores to confirm and the tables.
  app.get("/my/competitions", async (c) => c.json(await myCompetitions(db, who(c))));

  app.get("/my/places", async (c) => {
    const pid = who(c);
    const rows = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
      .select(["enrolment.id", "enrolment.status", "enrolment.waitlist_position", "enrolment.program_id", "enrolment.session_id", trSql("program", "name", lang(c)).as("name"), "enrolment.price_cents"])
      // A place on one date (signed up per date): that date; otherwise the program's first.
      .select((eb) => [sql<Date | null>`coalesce((SELECT starts_at FROM session WHERE session.id = enrolment.session_id), (SELECT min(starts_at) FROM session WHERE session.program_id = program.id))`.as("first_start"),
        eb.selectFrom("waitlist_offer").select("expires_at").whereRef("waitlist_offer.enrolment_id", "=", "enrolment.id").where("outcome", "is", null).where("expires_at", ">", new Date()).limit(1).as("offer_expires_at"),
        eb.selectFrom("payment").select("id").whereRef("payment.enrolment_id", "=", "enrolment.id").where("status", "=", "pending").limit(1).as("pending_payment_id"),
        // What the card is asked for now: the rest, once part was paid at the desk (never the place's whole price).
        eb.selectFrom("payment").select("amount_cents").whereRef("payment.enrolment_id", "=", "enrolment.id").where("status", "=", "pending").limit(1).as("pending_cents")])
      .select("enrolment.person_id")
      .where("enrolment.person_id", "in", (await meAndJuniors(pid)).map((x) => x.id)).where("enrolment.status", "in", ["booked", "waitlisted"]).execute();
    const people = await meAndJuniors(pid);
    return c.json(await Promise.all(rows.map(async ({ person_id, ...r }) => ({ ...r, for_name: people.find((x) => x.id === person_id)?.display_name ?? null, paid_cents: await paidFor(db, r.id) }))));
  });

  // ---- Family: the household, its juniors, and invites to another parent ----
  app.get("/my/household", async (c) => {
    const pid = who(c), hh = await householdOf(db, pid);
    if (!hh) return c.json({ household: null, role: null });
    const rows = await db.selectFrom("household_member").innerJoin("person", "person.id", "household_member.person_id")
      .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "household_member.person_id").on("rating.sport", "=", "padel"))
      .select(["person.id", "person.display_name", "person.birth_year", "household_member.role", "rating.level"]).where("household_member.household_id", "=", hh.household_id)
      .where("household_member.removed_at", "is", null).where("person.status", "=", "active").orderBy("household_member.created_at").execute();
    const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
    const invites = hh.role !== "adult" ? [] : await db.selectFrom("household_invite").select(["id", "code", "expires_at"]).where("household_id", "=", hh.household_id).where("status", "=", "open")
      .where("expires_at", ">", new Date()).orderBy("created_at").execute();
    const juniors = await Promise.all(rows.filter((r) => r.role === "junior").map(async (r) => ({ id: r.id, display_name: r.display_name, birth_year: r.birth_year,
      // A junior's level, for their parents (it's never on a list anyone else sees).
      level: hh.role === "adult" && r.level !== null ? Number(r.level) : null, waiver: hh.role === "adult" ? await waiverStatus(db, r.id) : null })));
    return c.json({ role: hh.role, household: { adults: rows.filter((r) => r.role === "adult").map((r) => ({ id: r.id, display_name: r.display_name, me: r.id === pid })),
      members: rows.filter((r) => r.role === "member").map((r) => ({ id: r.id, display_name: r.display_name, me: r.id === pid })),
      juniors: hh.role === "adult" ? juniors : juniors.map((j) => ({ id: j.id, display_name: j.display_name })),
      invites: invites.map((x) => ({ ...x, until: localDate(x.expires_at, tz) })) } });
  });
  // An invite link, opened: who sent it and the juniors it's for (they shared the link, so that's theirs to show).
  app.get("/my/household/invites/:code", async (c) => {
    const pid = who(c), inv = await inviteByCode(db, c.req.param("code"), new Date());
    if (!inv) throw new KumiError("error.household_invite_closed", {}, 404);
    const mine = await householdOf(db, pid);
    return c.json({ from: inv.from, juniors: inv.juniors, open: inv.open, already: mine?.household_id === inv.household_id });
  });
  // The club's waiver, and where the member and each of their juniors stand with it. A kid with a login of
  // their own sees it too, but a parent accepts it for them.
  app.get("/my/waiver", async (c) => {
    const pid = who(c), w = await currentWaiver(db);
    if (!w) return c.json({ waiver: null, people: [] });
    const kid = Boolean(await kidOf(db, pid));
    const people = await Promise.all((await meAndJuniors(pid)).map(async (p) => ({ id: p.id, display_name: p.display_name, me: p.id === pid, by_parent: kid && p.id === pid,
      accepted_at: (await waiverStatus(db, p.id))?.accepted_at ?? null })));
    return c.json({ waiver: { version_no: w.version_no, body: inLang(w.body, w.translations, "body", lang(c)) }, people });
  });

  // ---- Kids with a login of their own ----
  // A parent's view: each junior (and, with a login, the rules and this month's spending), what the kids are
  // asking for, what's waiting for a parent to pay, and the family card.
  app.get("/my/kids", async (c) => {
    const pid = who(c), l = lang(c), hh = await householdOf(db, pid), now = new Date();
    if (!hh || hh.role !== "adult") return c.json({ kids: [], requests: [], to_pay: [], card: null });
    const juniors = await juniorsOf(db, pid), ids = juniors.map((j) => j.id);
    const kids = await Promise.all(juniors.map(async (j) => {
      const k = await kidOf(db, j.id), p = await db.selectFrom("person").select(["email", "own_login"]).where("id", "=", j.id).executeTakeFirstOrThrow();
      return { id: j.id, display_name: j.display_name, birth_year: j.birth_year, own_login: p.own_login, email: p.own_login ? p.email : null,
        rules: k ? { open_matches: k.open_matches, courts: k.courts, programs: k.programs, lessons: k.lessons, monthly_limit_cents: k.monthly_limit_cents, friends: k.friends, texts: k.texts } : null,
        spent_cents: k ? await monthSpent(db, j.id, now) : 0 };
    }));
    const requests = ids.length ? await db.selectFrom("kid_request").innerJoin("person", "person.id", "kid_request.person_id")
      .select(["kid_request.id", "kid_request.what", "kid_request.cents", "person.display_name as name"]).where("kid_request.person_id", "in", ids).where("kid_request.status", "=", "asked")
      .orderBy("kid_request.created_at").execute() : [];
    // Payments the family card couldn't take, still worth paying (the place or court is still theirs).
    const owed = ids.length ? await db.selectFrom("payment").innerJoin("person", "person.id", "payment.person_id")
      .leftJoin("booking_player", "booking_player.id", "payment.booking_player_id").leftJoin("booking", "booking.id", "booking_player.booking_id").leftJoin("enrolment", "enrolment.id", "payment.enrolment_id")
      .select(["payment.id", "payment.amount_cents", "payment.group_id", "payment.person_id", "payment.booking_player_id", "payment.enrolment_id", "person.display_name as name"])
      .where("payment.person_id", "in", ids).where("payment.status", "=", "pending").where("payment.parent_to_pay_at", "is not", null)
      .where((eb) => eb.or([eb("booking.id", "is", null), eb.and([eb("booking.status", "!=", "cancelled"), eb("booking_player.removed_at", "is", null)])]))
      .where((eb) => eb.or([eb("enrolment.id", "is", null), eb("enrolment.status", "in", ["booked", "waitlisted"])])).orderBy("payment.created_at").execute() : [];
    const groups = new Map<string, typeof owed>();
    for (const o of owed) groups.set(o.group_id ?? o.id, [...(groups.get(o.group_id ?? o.id) ?? []), o]);
    const toPay = await Promise.all([...groups.values()].map(async (g) => ({ payment_id: g[0]!.id, name: g[0]!.name, cents: g.reduce((n, x) => n + x.amount_cents, 0), what: (await paymentsWhat(db, g))[l] })));
    const card = await familyCardFor(db, pid), tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
    return c.json({ kids, requests: requests.map((r) => ({ id: r.id, name: r.name, cents: r.cents, what: (r.what as Record<Lang, string>)[l] })), to_pay: toPay,
      card: card ? { saved_by: card.saved_by_name, saved_on: card.saved_at ? localDate(card.saved_at, tz) : null } : null });
  });
  // A kid's own view: what they can book on their own, this month's spending, and what they've asked for.
  app.get("/my/kid", async (c) => {
    const pid = who(c), l = lang(c), k = await kidOf(db, pid);
    if (!k) return c.json({ kid: null });
    const parents = (await db.selectFrom("person").select("display_name").where("id", "in", await managersOf(db, pid)).execute()).map((p) => p.display_name);
    const requests = await db.selectFrom("kid_request").select(["id", "what", "cents", "status", "error", "created_at"]).where("person_id", "=", pid)
      .where("created_at", ">", new Date(Date.now() - 30 * 864e5)).orderBy("created_at", "desc").limit(20).execute();
    return c.json({ kid: { rules: { open_matches: k.open_matches, courts: k.courts, programs: k.programs, lessons: k.lessons, monthly_limit_cents: k.monthly_limit_cents, friends: k.friends, texts: k.texts },
      spent_cents: await monthSpent(db, pid, new Date()), parents, card: Boolean(await familyCardFor(db, pid)),
      requests: requests.map((r) => ({ id: r.id, cents: r.cents, status: r.status, what: (r.what as Record<Lang, string>)[l], error: r.error ? (r.error as Record<Lang, string>)[l] : null })) } });
  });
  // A parent's yes: the kid's action is run then and there, and paid on the family card.
  app.post("/my/kids/requests/:id/approve", async (c) => {
    const pid = who(c), l = lang(c);
    const r = await approveKidRequest(db, c.req.param("id"), { personId: pid, via: "web", lang: l }, new Date());
    return c.json(r.outcome === "failed" ? { outcome: "failed", message: r.error[l] } : { outcome: "done", paid: r.paid?.status ?? null });
  });

  // ---- Push notifications on this device ----
  // ---- Your data: what stops an account being deleted, and the file a confirmed download gets ----
  app.get("/my/privacy/check", async (c) => {
    const pid = who(c), target = c.req.query("person_id") || pid, at = now(), l = lang(c);
    if (!(await mayCheck(db, pid, target, at))) throw new KumiError("error.not_found", { thing: { en: "person", es: "la persona" } }, 404);
    const r = await deleteCheck(db, target, at);
    return c.json({ blockers: r.blockers.map((b) => ({ kind: b.kind, text: b.text[l], how: b.how[l] })), juniors: r.juniors.map((j) => j.display_name), ends: r.ends.map((e) => e[l]) });
  });
  // Made when it's fetched, from the export the person just confirmed: never stored, and never in Changes.
  app.get("/my/privacy/export/:run", async (c) => {
    const pid = who(c), at = now();
    const target = await exportRun(db, c.req.param("run"), pid, at);
    const data = await exportData(db, target, at, lang(c));
    c.header("content-type", "application/json; charset=utf-8");
    // Named for the club ("kestrel-padel-data-2026-11-07.json"): a member never reads a product's name.
    c.header("content-disposition", `attachment; filename="${await clubFileStem(db)}-data-${at.toISOString().slice(0, 10)}.json"`);
    c.header("cache-control", "no-store");
    return c.body(JSON.stringify(data, null, 2));
  });

  app.get("/my/push/key", async (c) => { who(c); return c.json({ public_key: (await pushKeys(db)).publicKey }); });
  const b64u = /^[A-Za-z0-9_-]+={0,2}$/;
  app.post("/my/push", async (c) => {
    const pid = who(c), body = await c.req.json().catch(() => ({})) as { app?: string; endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const ok = (body.app === "member" || body.app === "staff") && typeof body.endpoint === "string" && body.endpoint.length <= 2000 && isPushEndpoint(body.endpoint)
      && b64u.test(body.keys?.p256dh ?? "") && (body.keys!.p256dh!.length >= 80 && body.keys!.p256dh!.length <= 100) && b64u.test(body.keys?.auth ?? "") && body.keys!.auth!.length >= 16 && body.keys!.auth!.length <= 32;
    if (!ok) throw new KumiError("error.invalid_input", { details: "app, endpoint (a browser push service) and keys.p256dh and keys.auth, as the browser gives them" }, 400);
    await subscribePush(db, pid, body.app as "member" | "staff", { endpoint: body.endpoint!, p256dh: body.keys!.p256dh!, auth: body.keys!.auth! }, c.req.header("user-agent") ?? null);
    return c.json({ ok: true });
  });
  app.post("/my/push/off", async (c) => {
    const pid = who(c), body = await c.req.json().catch(() => ({})) as { endpoint?: string };
    if (typeof body.endpoint === "string") await unsubscribePush(db, pid, body.endpoint);
    return c.json({ ok: true });
  });

  // My membership, if I have one, and what it gives me; when it renews or runs until (a club date); and a
  // payment to make when a renewal didn't go through.
  app.get("/my/membership", async (c) => {
    const pid = who(c), now = new Date(), l = lang(c);
    const q = () => db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person as payer", "payer.id", "membership.person_id")
      .select(["membership.id", "membership.person_id", "payer.display_name as payer", trSql("membership_plan", "name", l).as("name"), trSql("membership_plan", "description", l).as("description"), "membership_plan.price_cents as plan_price_cents", "membership_plan.period as plan_period",
        "membership_plan.days_ahead", "membership.plan_id", "membership.status", "membership.source", "membership.started_at", "membership.current_period_end", "membership.cancel_at_period_end", "membership.price_cents",
        "membership.period", "membership.next_attempt_at", "membership.saved_method", "membership.paused_until", "membership.family_size", "membership.extra_person_cents",
        "membership.balance_cents", "membership_plan.join_in_app", "membership.brought_from"])
      .where("membership.status", "in", ["upcoming", "active", "past_due"]);
    // Mine, or a family plan someone else pays that covers me.
    const m = await q().where("membership.person_id", "=", pid).executeTakeFirst() ?? await q().where((eb) => eb.exists(eb.selectFrom("membership_member").select("membership_member.id")
      .whereRef("membership_member.membership_id", "=", "membership.id").where("membership_member.person_id", "=", pid)
      .where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", now)])))).executeTakeFirst();
    if (!m) return c.json({ membership: null });
    const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone, mine = m.person_id === pid;
    const prices = await planPerks(m.plan_id), perks = await programPerks(db, pid, now);
    const owed = mine && m.status === "past_due" ? await db.selectFrom("payment").select(["id", "amount_cents"]).where("membership_id", "=", m.id).where("status", "=", "pending").executeTakeFirst() : null;
    // A family plan: who it covers, and (for the payer) who else in the family could be added.
    const covered = m.family_size ? await coveredBy(db, m.id, now) : [];
    const candidates = mine && m.family_size ? (await (async () => {
      const hh = await householdOf(db, pid);
      if (!hh) return [];
      return db.selectFrom("household_member").innerJoin("person", "person.id", "household_member.person_id").select(["person.id", "person.display_name"]).where("household_member.household_id", "=", hh.household_id)
        .where("household_member.removed_at", "is", null).where("person.status", "=", "active").where("person.id", "!=", pid).orderBy("household_member.created_at").execute();
    })()).filter((x) => !covered.some((c) => c.person_id === x.id)) : [];
    const family = m.family_size ? { size: m.family_size, extra_cents: m.extra_person_cents, payer: m.payer,
      covered: covered.map((x) => ({ person_id: x.person_id, display_name: x.display_name, until: x.ends_at ? endDay({ current_period_end: x.ends_at, source: "app" }, tz) : null })),
      can_add: candidates.map((x) => ({ id: x.id, display_name: x.display_name })) } : null;
    // From the desk, paid for one period: the next one can be paid here by card when the plan is one joined in the app.
    const due = mine && m.source === "desk" && m.price_cents !== null && m.join_in_app && !m.balance_cents ? await membershipDue(db, m.id, now) : null;
    const { plan_id, plan_price_cents, plan_period, current_period_end, next_attempt_at, saved_method, paused_until, person_id, payer, family_size, extra_person_cents, join_in_app, ...rest } = m;
    return c.json({ membership: { ...rest, mine, covered_by: mine ? null : payer, family,
      // What a period costs: with a family plan, each person beyond its number too.
      price_cents: await periodCents(db, m, plan_price_cents, now), period: m.period ?? plan_period, member_prices: prices, ...programTerms(perks ?? (await planTerms(m.plan_id))),
      included_used: perks?.included_sessions ? perks.used : null,
      starts_on: m.status === "upcoming" ? localDate(m.started_at, tz) : null, card_saved: Boolean(saved_method),
      // A founding member before the start: the plan's prices and discounts may apply already (memberPlan says when).
      perks_now: m.status === "upcoming" && (await memberPlan(db, pid, now))?.membership_id === m.id,
      paused_until: paused_until && paused_until > now ? localDate(new Date(paused_until.getTime() - 1), tz) : null,
      // Carried over from Playtomic, with no card here yet: the last day it's paid for (it ends as that day is over).
      ends_on: current_period_end ? endDay({ current_period_end, source: m.brought_from && !saved_method ? "desk" : m.source }, tz) : null, retry_on: next_attempt_at ? localDate(next_attempt_at, tz) : null,
      pay_now: owed ? { payment_id: owed.id, cents: owed.amount_cents } : null, pay_next: due?.next ? { cents: due.cents } : null } });
  });
  // The plans a member can join here, with what each gives.
  app.get("/membership-plans", async (c) => {
    who(c);
    const l = lang(c);
    const plans = await db.selectFrom("membership_plan").select(["id", trSql("membership_plan", "name", l).as("name"), trSql("membership_plan", "description", l).as("description"), "price_cents", "period", "days_ahead", "max_members", "starts_on",
      "program_percent_off", "program_cents_off", "included_sessions", "included_kinds", "family_size", "extra_person_cents"]).where("active", "=", true).where("join_in_app", "=", true)
      .orderBy("sort").orderBy("price_cents").execute();
    const counts = await planCounts(db), today = localDate(new Date(), (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone);
    // A founding offer: how many places are left, and the start date while it's still ahead.
    return c.json(await Promise.all(plans.map(async ({ max_members, starts_on, ...p }) => ({ ...p, member_prices: await planPerks(p.id),
      places_left: max_members ? Math.max(0, max_members - (counts.get(p.id) ?? 0)) : null, starts_on: starts_on && starts_on > today ? starts_on : null }))));
  });
  /** What a plan gives on programs, as the members' app shows it. */
  const programTerms = (p: { program_percent_off: number | null; program_cents_off: number | null; included_sessions: number | null; included_kinds: string[] }) =>
    ({ program_percent_off: p.program_percent_off, program_cents_off: p.program_cents_off, included_sessions: p.included_sessions, included_kinds: p.included_kinds });
  const planTerms = (planId: string) => db.selectFrom("membership_plan").select(["program_percent_off", "program_cents_off", "included_sessions", "included_kinds"]).where("id", "=", planId).executeTakeFirstOrThrow();
  /** Whether a plan has member prices on courts. */
  const planPerks = async (planId: string) => Boolean(await db.selectFrom("price_rule").select("id").where("active", "=", true).where(sql<boolean>`${planId} = ANY(plan_ids)`).executeTakeFirst());

  app.get("/my/level", async (c) => {
    const pid = who(c), l = lang(c);
    const rating = await db.selectFrom("rating").select(["level", "provisional", "floor", "rated_games"]).where("person_id", "=", pid).where("sport", "=", "padel").executeTakeFirst();
    const events = await db.selectFrom("rating_event").select(["at", "kind", "level_after", "explanation"]).where("person_id", "=", pid).orderBy("id", "desc").limit(30).execute();
    const imports = await importOptions(db, pid);
    return c.json({ rating: rating ?? null, events: events.map((e) => ({ at: e.at, kind: e.kind, level_after: e.level_after, explanation: (e.explanation as Record<string, string>)[l] ?? "" })),
      ...await levelOptions(db, pid, new Date()), ...imports, import: imports.import ? { ...imports.import, explanation: imports.import.explanation[l] } : null });
  });

  // ---- Asking the club ----
  // The club's common questions, the switched-on ones, in the member's language: best match first, or all by topic.
  app.get("/my/facts", async (c) => {
    who(c);
    const l = lang(c), facts = await searchFacts(db, c.req.query("q") ?? "", { limit: 50 });
    return c.json(facts.map((f) => ({ id: f.id, topic: f.topic, ...factIn(f, l) })));
  });
  /** A thread a member may read: one they asked, or one about them or a junior they manage. */
  const myThread = async (pid: string, id: string) => {
    const q = /^[0-9a-f-]{36}$/.test(id) ? await db.selectFrom("question").select(["asked_by", "person_id"]).where("id", "=", id).executeTakeFirst() : undefined;
    if (!q || !(q.asked_by === pid || q.person_id === pid || await manages(db, pid, q.person_id))) throw new KumiError("error.not_found", { thing: { en: "question", es: "la pregunta" } }, 404);
  };
  app.get("/my/questions", async (c) => {
    const pid = who(c), mine = (await meAndJuniors(pid)).map((p) => p.id);
    return c.json((await questionList(db, { mine, askedBy: pid, limit: 50 })).map((q) => ({ id: q.id, status: q.status, first: q.first, created_at: q.created_at, last_side: q.last_side, last_at: q.last_at,
      about: q.person_id === pid ? null : q.about, asked_by_me: q.asked_by === pid })));
  });
  app.get("/my/questions/:id", async (c) => {
    const pid = who(c), id = c.req.param("id");
    await myThread(pid, id);
    // Seen in the app: an automatic answer already shown here isn't emailed as well (messages.ts).
    await db.updateTable("question").set({ member_seen_at: new Date() }).where("id", "=", id).execute();
    const q = await questionThread(db, id);
    // Staff answer as the club: a member sees who answered by name, but nothing else about them.
    return c.json({ id: q.id, status: q.status, created_at: q.created_at, about: q.person_id === pid ? null : q.about, asked_by_me: q.asked_by === pid,
      messages: q.messages.map((m) => ({ id: m.id, side: m.side, body: m.body, at: m.created_at, author: m.side === "club" ? null : m.author, fact: Boolean(m.fact_id) })) });
  });

  // Development only: save a stand-in card for a membership joined before its plan starts.
  if (!opts.production) app.post("/dev/memberships/:id/card", async (c) => {
    const pid = who(c), pv = paymentProvider();
    if (!(pv instanceof TestProvider)) throw new KumiError("error.forbidden", {}, 403);
    await openCardSetup(db, c.req.param("id"), pid);
    const m = await db.selectFrom("membership").select("provider_ref").where("id", "=", c.req.param("id")).executeTakeFirstOrThrow();
    pv.settleSetup(m.provider_ref!);
    return c.json({ status: await checkCardSetup(db, c.req.param("id"), "dev") });
  });
  // Development only: save a stand-in family card, as a parent's card form would.
  if (!opts.production) app.post("/dev/family/card", async (c) => {
    const pid = who(c), pv = paymentProvider();
    if (!(pv instanceof TestProvider)) throw new KumiError("error.forbidden", {}, 403);
    const r = await openFamilyCardSetup(db, { personId: pid, via: "dev", lang: lang(c) });
    pv.settleSetup((await db.selectFrom("family_card").select("provider_ref").where("id", "=", r.cardId).executeTakeFirstOrThrow()).provider_ref!);
    return c.json({ status: await checkFamilyCard(db, r.cardId, "dev") });
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
